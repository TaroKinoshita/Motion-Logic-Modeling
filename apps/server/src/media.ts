// 入力動画の取り込み・情報取得・フレーム抽出。FFmpeg / ffprobe を子プロセスで呼ぶ。
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectMeta, SourceManifest } from '@mlm/core';
import { HttpError, projectDir } from './store.ts';

const FFMPEG = process.env.MLM_FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.MLM_FFPROBE ?? 'ffprobe';

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(
          new HttpError(
            500,
            missing ? `${cmd} が見つかりません。PATHか環境変数 MLM_FFMPEG / MLM_FFPROBE を確認してください` : `${cmd} が失敗しました`,
            stderr.toString('utf8').slice(-2000),
          ),
        );
      } else resolve(stdout);
    });
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n;
}

export async function probe(file: string, fileName: string): Promise<SourceManifest> {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out.toString('utf8')) as {
    format?: { duration?: string };
    streams?: Array<Record<string, string | number | undefined>>;
  };
  const video = info.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new HttpError(422, '映像ストリームが見つかりません');
  const frameRate = String(video.r_frame_rate ?? video.avg_frame_rate ?? '0/1');
  const fps = parseRate(frameRate) || parseRate(String(video.avg_frame_rate));
  if (!fps) throw new HttpError(422, 'フレームレートを取得できません');
  const duration = Number(video.duration ?? info.format?.duration ?? 0);
  const frames = Number(video.nb_frames);
  const avg = parseRate(String(video.avg_frame_rate ?? ''));
  return {
    avgFrameRate: String(video.avg_frame_rate ?? ''),
    variableFrameRate: avg > 0 && Math.abs(avg - fps) / fps > 0.01,
    fileName,
    sha256: await sha256(file),
    sizeBytes: fs.statSync(file).size,
    width: Number(video.width),
    height: Number(video.height),
    frameRate,
    fps,
    duration,
    frameCount: Number.isFinite(frames) && frames > 0 ? frames : null,
    hasAudio: !!info.streams?.some((s) => s.codec_type === 'audio'),
    importedAt: new Date().toISOString(),
  };
}

export function sourcePath(project: ProjectMeta): string {
  if (!project.source) throw new HttpError(400, 'このプロジェクトには元動画が取り込まれていません');
  return path.join(projectDir(project.id), 'media', project.source.fileName);
}

/** media/ に置く安全なファイル名にする。 */
export function mediaTarget(projectId: string, originalName: string): { file: string; fileName: string } {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
  const fileName = `source-${randomUUID()}${ext}`;
  return { file: path.join(projectDir(projectId), 'media', fileName), fileName };
}

export function clearCache(projectId: string): void {
  const dir = path.join(projectDir(projectId), 'cache');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 音声の波形（区間ごとの最大振幅 0..1）。表示用の粗い値で、拍などの解析結果ではない。
 * 結果は cache/ に保存する。
 */
export async function waveform(project: ProjectMeta, buckets: number): Promise<{ duration: number; peaks: number[] }> {
  const file = sourcePath(project);
  if (!project.source?.hasAudio) throw new HttpError(400, 'この動画には音声がありません');
  const cached = path.join(projectDir(project.id), 'cache', `waveform_${buckets}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  const rate = 8000;
  const pcm = await run(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-']);
  const samples = Math.floor(pcm.length / 2);
  const per = Math.max(1, Math.ceil(samples / buckets));
  const peaks: number[] = [];
  for (let start = 0; start < samples; start += per) {
    let max = 0;
    for (let i = start; i < Math.min(start + per, samples); i++) max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)));
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  const result = { duration: samples / rate, peaks };
  fs.writeFileSync(cached, JSON.stringify(result));
  return result;
}

/**
 * カットの候補を FFmpeg の scdet フィルタで検出する。
 * 画面全体の変化量を見るだけなので、フラッシュや強い動きも拾う。結果は「候補」として扱うこと。
 * threshold は 0〜100（小さいほど多く拾う。FFmpeg の既定は 10）。
 */
export function detectCuts(project: ProjectMeta, threshold: number): Promise<Array<{ t: number; score: number }>> {
  const file = sourcePath(project);
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-nostats', '-v', 'info', '-i', file, '-an', '-vf', `scdet=threshold=${threshold}`, '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) return reject(new HttpError(500, 'ffmpeg でのカット検出に失敗しました', stderr.slice(-2000)));
        const cuts = [...stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g)].map((m) => ({
          score: Number(m[1]),
          t: Number(m[2]),
        }));
        resolve(cuts);
      },
    );
  });
}

/** 元動画の時刻 t（秒）のフレームをJPEGで返す。結果は cache/ に保存する。 */
export async function sourceFrame(project: ProjectMeta, t: number, width: number): Promise<Buffer> {
  const file = sourcePath(project);
  const cached = path.join(projectDir(project.id), 'cache', `src_${Math.round(t * 1000)}_${width}.jpg`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  const out = await run(FFMPEG, [
    '-v', 'error',
    '-ss', Math.max(0, t).toFixed(4),
    '-i', file,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    '-q:v', '4',
    '-',
  ]);
  if (!out.length) throw new HttpError(400, `時刻 ${t} 秒のフレームを取得できません（動画の長さ ${project.source?.duration} 秒）`);
  fs.writeFileSync(cached, out);
  return out;
}
