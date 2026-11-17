// 簡略シーンをMP4に書き出す。フレームを順に描いて生のRGBAをFFmpegへ流す。
// いまは同期処理（短い区間向け）。長尺・進捗・キャンセルはジョブ管理を入れる段階で対応する。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { drawFrame } from '@mlm/core';
import type { ProjectMeta, Scene } from '@mlm/core';
import { sourcePath } from './media.ts';
import { HttpError, projectDir } from './store.ts';

const FFMPEG = process.env.MLM_FFMPEG ?? 'ffmpeg';
export const MAX_EXPORT_SECONDS = 120;

export interface ExportOptions {
  /** Server-internal unique suffix for concurrent analysis exports. */
  outputTag?: string;
  from: number;
  to: number;
  /** 出力の幅。高さは縦横比から決まる（偶数に丸める）。 */
  width: number;
  /** 元動画の音声を同じ区間で付ける。 */
  withAudio: boolean;
  /** render=簡略版だけ / compare=左に元動画・右に簡略版を並べる。 */
  layout: 'render' | 'compare';
}

export interface ExportResult {
  fileName: string;
  path: string;
  revision: number;
  from: number;
  to: number;
  frameCount: number;
  frameRate: string;
  width: number;
  height: number;
  hasAudio: boolean;
  sizeBytes: number;
  elapsedMs: number;
}

export async function exportVideo(project: ProjectMeta, scene: Scene, opts: ExportOptions): Promise<ExportResult> {
  const started = Date.now();
  const from = Math.max(0, opts.from);
  const to = Math.min(scene.duration, opts.to);
  if (!(to > from)) throw new HttpError(400, `区間が不正です（from ${opts.from} / to ${opts.to} / 長さ ${scene.duration}）`);
  if (to - from > MAX_EXPORT_SECONDS) {
    throw new HttpError(400, `一度に書き出せるのは ${MAX_EXPORT_SECONDS} 秒までです。from / to で区間を分けてください`);
  }
  // 元動画があればそのフレームレート（有理数表記）に合わせ、フレーム単位で元動画と揃える。
  const frameRate = project.source?.frameRate ?? String(scene.fps);
  const fps = project.source?.fps ?? scene.fps;
  const width = Math.round(opts.width / 2) * 2;
  const height = Math.round((width * scene.height) / scene.width / 2) * 2;
  const frameCount = Math.max(1, Math.round((to - from) * fps));
  const hasAudio = opts.withAudio && !!project.source?.hasAudio;

  const dir = path.join(projectDir(project.id), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const compare = opts.layout === 'compare';
  if (compare && !project.source) throw new HttpError(400, '比較動画には元動画の取り込みが必要です');
  if (opts.outputTag && !/^[a-zA-Z0-9-]+$/.test(opts.outputTag)) throw new HttpError(400, '不正な書き出し識別子です');
  const fileName = `${compare ? 'compare' : 'simplified'}_r${project.revision}_${Math.round(from * 1000)}-${Math.round(to * 1000)}${opts.outputTag ? '_' + opts.outputTag : ''}.mp4`;
  const out = path.join(dir, fileName);

  const src = sourcePath(project);
  const f = from.toFixed(6);
  const t = to.toFixed(6);
  // 元動画の区間は入力の -ss/-t ではなくフィルターの trim/atrim で切る（入力側で切ると端数で短くなった）。
  const audioFilter = (input: number) => `[${input}:a]atrim=start=${f}:end=${t},asetpts=PTS-STARTPTS[a]`;
  // 長さは映像のフレーム数で決める（-shortest だと音声の端数に合わせて映像が数フレーム削られる）。
  const encode = ['-frames:v', String(frameCount), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

  // 出力はいつも一時ファイル名に書き、最後に正式な名前へ置き換える。OneDrive 配下で同名ファイルを
  // FFmpeg の -y で上書きすると、ときどき数フレーム短いファイルになった（別名なら10回とも正確。実測）。
  const tmp = (tag: string) => path.join(dir, `.tmp_${randomUUID()}_${tag}.mp4`);
  const finalTmp = tmp('out');
  // 1段目：簡略版をパイプでFFmpegへ流してMP4にする。比較動画ではこれを2段目で元動画と並べる。
  const renderOut = compare ? tmp('render') : finalTmp;
  const temps = [renderOut, finalTmp];
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', frameRate, '-i', 'pipe:0'];
  if (hasAudio && !compare) args.push('-i', src, '-filter_complex', audioFilter(1), '-map', '0:v', '-map', '[a]', '-c:a', 'aac');
  else args.push('-map', '0:v');
  args.push(...encode, '-crf', compare ? '10' : '18', renderOut);

  try {
    await runFfmpeg(args, async (stdin, done) => {
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const scale = width / scene.width;
      for (let i = 0; i < frameCount; i++) {
        ctx.setTransform(scale, 0, 0, height / scene.height, 0, 0);
        drawFrame(ctx as unknown as CanvasRenderingContext2D, scene, from + i / fps);
        // FFmpegが先に終わると stdin に 'error' が出て once が reject する。終了コードで報告するので握りつぶす。
        if (!stdin.write(canvas.data())) await Promise.race([once(stdin, 'drain').catch(() => {}), done]);
        if (stdin.destroyed) break;
      }
    });

    if (compare) {
      // 2段目：元動画の区間を、簡略版と同じフレーム数・サイズのファイルとして単独で切り出す。
      // 区間の端数で足りない分は最後のコマを延ばす。（元動画と簡略版を1つのフィルターグラフで tpad＋hstack すると、
      // 入力の終わりの処理順で長さが実行ごとに最大十数フレーム変わった。FFmpeg単体でも再現。実測）
      const sourceClip = tmp('source');
      temps.push(sourceClip);
      await runFfmpeg([
        '-v', 'error', '-y', '-i', src,
        '-vf', `trim=start=${f}:end=${t},setpts=PTS-STARTPTS,fps=${frameRate},scale=${width}:${height},setsar=1,tpad=stop_mode=clone:stop_duration=2`,
        '-an', ...encode, '-crf', '10', sourceClip,
      ]);
      // 3段目：同じフレーム数のファイル同士を左右に並べる。
      const stacked = hasAudio ? tmp('stacked') : finalTmp;
      temps.push(stacked);
      await runFfmpeg([
        '-v', 'error', '-y', '-i', sourceClip, '-i', renderOut,
        '-filter_complex', '[0:v]setsar=1[s];[1:v]setsar=1[r];[s][r]hstack=inputs=2[v]',
        '-map', '[v]', ...encode, '-crf', '18', stacked,
      ]);
      // 4段目：映像はコピーのまま音声を足す（フレームは増減しない）。音声と同時に処理すると長さが変わることがあった。
      if (hasAudio) {
        await runFfmpeg(['-v', 'error', '-y', '-i', stacked, '-i', src, '-filter_complex', audioFilter(1), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', finalTmp]);
      }
    }
    await replaceFile(finalTmp, out);
  } finally {
    for (const p of temps) fs.rmSync(p, { force: true });
  }

  return {
    fileName,
    path: out,
    revision: project.revision,
    from,
    to,
    frameCount,
    frameRate,
    width: compare ? width * 2 : width,
    height,
    hasAudio,
    sizeBytes: fs.statSync(out).size,
    elapsedMs: Date.now() - started,
  };
}

/** from を to へ置き換える。同期ソフト等が一時的につかんでいると失敗するので、少し待って数回やり直す。 */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 9) throw new HttpError(500, `書き出したファイルを ${path.basename(to)} に置き換えられませんでした（別のアプリが開いている可能性）`, String(err));
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** FFmpegを起動して終了を待つ。feed を渡すと stdin へ書き込み、終わったら閉じる。失敗は HttpError にする。 */
async function runFfmpeg(
  args: string[],
  feed?: (stdin: NodeJS.WritableStream & { destroyed: boolean }, done: Promise<number>) => Promise<void>,
): Promise<void> {
  const ff = spawn(FFMPEG, args, { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  ff.stderr?.on('data', (d) => (stderr += d));
  const done = new Promise<number>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => resolve(code ?? 1));
  });
  if (feed && ff.stdin) {
    ff.stdin.on('error', () => {}); // FFmpegが先に落ちた場合は終了コードで報告する
    await feed(ff.stdin, done);
    ff.stdin.end();
  }
  const code = await done.catch((err: NodeJS.ErrnoException) => {
    throw new HttpError(500, err.code === 'ENOENT' ? 'ffmpeg が見つかりません' : `ffmpeg の起動に失敗: ${err.message}`);
  });
  if (code !== 0) throw new HttpError(500, 'ffmpeg での書き出しに失敗しました', stderr.slice(-2000));
}


