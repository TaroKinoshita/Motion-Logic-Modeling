import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getProject, HttpError, projectDir } from './store.ts';
import { sourcePath } from './media.ts';
import { exportVideo } from './export.ts';

const run = promisify(execFile);
export async function compareSegment(id: string, from: number, to: number, width: number) {
  const { project, scene } = getProject(id);
  if (!project.source) throw new HttpError(400, '比較には元動画が必要です');
  if (![from, to, width].every(Number.isFinite) || from < 0 || to <= from || to > Math.min(scene.duration, project.source.duration) || to - from > 120 || !Number.isInteger(width) || width < 160 || width > 1920) {
    throw new HttpError(400, '比較区間は元動画とシーンの範囲内、120秒以内、幅160〜1920pxで指定してください');
  }
  const cache = path.join(projectDir(id), 'cache'); fs.mkdirSync(cache, { recursive: true });
  const statsName = `ssim-${randomUUID()}.log`;
  let rendered: string | undefined;
  try {
    const video = await exportVideo(project, scene, { from, to, width, layout: 'render', withAudio: false, outputTag: randomUUID() });
    rendered = video.path;
    const filter = `[0:v]trim=start=${from}:end=${to},setpts=PTS-STARTPTS,fps=${video.frameRate},scale=${video.width}:${video.height},setsar=1,format=yuv420p[a];[1:v]setsar=1,format=yuv420p[b];[a][b]ssim=stats_file=${statsName}:shortest=1`;
    await run(process.env.MLM_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-nostats', '-i', sourcePath(project), '-i', video.path, '-lavfi', filter, '-frames:v', String(video.frameCount), '-an', '-f', 'null', '-'], { cwd: cache, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    const values = fs.readFileSync(path.join(cache, statsName), 'utf8').split(/\r?\n/).filter(Boolean).map(line => Number(/All:([-\d.e+]+)/i.exec(line)?.[1]));
    if (values.length !== video.frameCount || !values.every(Number.isFinite)) throw new HttpError(422, '比較フレーム数が一致しません', { expected: video.frameCount, actual: values.length });
    return { projectId: id, revision: project.revision, sourceSha256: project.source.sha256, from, to, frameCount: values.length,
      width: video.width, height: video.height, frameRate: video.frameRate,
      ssim: { mean: values.reduce((a,b) => a+b,0) / values.length, min: Math.min(...values), max: Math.max(...values) },
      method: 'FFmpeg SSIM / yuv420p / simplified H.264 CRF18',
      limitations: ['画素類似度であり演出理解の評価ではない', '元動画を出力寸法へ変換して比較', 'カット時刻・要素位置の誤差は含まない'] };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, '区間比較に失敗しました', String(err));
  } finally {
    fs.rmSync(path.join(cache, statsName), { force: true });
    if (rendered) fs.rmSync(rendered, { force: true });
  }
}
