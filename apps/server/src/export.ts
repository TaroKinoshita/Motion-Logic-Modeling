// 簡略シーンをMP4に書き出す。フレームを順に描いて生のRGBAをFFmpegへ流す。
// いまは同期処理（短い区間向け）。長尺・進捗・キャンセルはジョブ管理を入れる段階で対応する。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
  const fileName = `${compare ? 'compare' : 'simplified'}_r${project.revision}_${Math.round(from * 1000)}-${Math.round(to * 1000)}.mp4`;
  const out = path.join(dir, fileName);

  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', frameRate, '-i', 'pipe:0'];
  if (hasAudio || compare) args.push('-ss', from.toFixed(4), '-t', (to - from).toFixed(4), '-i', sourcePath(project));
  if (compare) {
    args.push(
      '-filter_complex',
      `[1:v]fps=${frameRate},scale=${width}:${height},setsar=1[s];[0:v]setsar=1[r];[s][r]hstack=inputs=2[v]`,
      '-map', '[v]',
    );
  } else {
    args.push('-map', '0:v');
  }
  if (hasAudio) args.push('-map', '1:a', '-c:a', 'aac');
  // 長さは映像のフレーム数で決める（-shortest だと音声の端数に合わせて映像が数フレーム削られる）。
  args.push('-frames:v', String(frameCount), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out);

  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<number>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => resolve(code ?? 1));
  });
  ff.stdin.on('error', () => {}); // FFmpegが先に落ちた場合は終了コードで報告する

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const scale = width / scene.width;
  for (let i = 0; i < frameCount; i++) {
    ctx.setTransform(scale, 0, 0, height / scene.height, 0, 0);
    drawFrame(ctx as unknown as CanvasRenderingContext2D, scene, from + i / fps);
    if (!ff.stdin.write(canvas.data())) await Promise.race([once(ff.stdin, 'drain'), done]);
    if (ff.exitCode !== null) break;
  }
  ff.stdin.end();
  const code = await done.catch((err: NodeJS.ErrnoException) => {
    throw new HttpError(500, err.code === 'ENOENT' ? 'ffmpeg が見つかりません' : `ffmpeg の起動に失敗: ${err.message}`);
  });
  if (code !== 0) throw new HttpError(500, 'ffmpeg での書き出しに失敗しました', stderr.slice(-2000));

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


