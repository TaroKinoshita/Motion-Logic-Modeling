import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { commit, getProject, HttpError, projectDir, REPO_ROOT } from './store.ts';
import { sourcePath } from './media.ts';

const run = promisify(execFile);
const Result = z.object({ bpm: z.number().nonnegative(), beats: z.array(z.number().nonnegative()), onsets: z.array(z.number().nonnegative()),
  downbeats:z.array(z.number().nonnegative()).default([]),sectionBoundaries:z.array(z.number().nonnegative()).default([]),
  duration: z.number().positive(), tool: z.literal('librosa'), version: z.string(), params: z.record(z.string(), z.unknown()) }).passthrough();

export async function detectBeats(id: string, baseRevision: number, actor: string) {
  const { project } = getProject(id);
  if (project.revision !== baseRevision) throw new HttpError(409, '最新のリビジョンを読み直してください');
  if (!project.source?.hasAudio) throw new HttpError(400, '元動画に音声がありません');
  const cache = path.join(projectDir(id), 'cache'); fs.mkdirSync(cache, { recursive: true });
  const stem = path.join(cache, `beats-${randomUUID()}`);
  const wav = `${stem}.wav`, json = `${stem}.json`;
  try {
    await run(process.env.MLM_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-y', '-i', sourcePath(project), '-vn', '-ac', '1', '-ar', '22050', wav], { windowsHide: true, timeout: 120000 });
    // Deployment/setup installs dependencies. Analysis itself never downloads them.
    const worker=path.join(REPO_ROOT,'workers/beats');
    const command=['run','--offline','--frozen','--project',worker,'--directory',worker,'python','-m','beats',wav,json];
    const options={windowsHide:true,timeout:180_000,maxBuffer:4*1024*1024};
    try {
      await run(process.env.MLM_UV??'uv',command,options);
    } catch(error) {
      // Numba's native beat DP can fault on some finite real-audio envelopes on Windows.
      if(process.platform!=='win32'||![-1073741819,3221225477].includes(Number((error as {code?:unknown}).code))) throw error;
      await run(process.env.MLM_UV??'uv',[...command,'--portable'],options);
    }
    const analysis = Result.parse(JSON.parse(fs.readFileSync(json, 'utf8')));
    if ([...analysis.beats,...analysis.downbeats,...analysis.sectionBoundaries].some(t => t >= analysis.duration)) throw new Error('解析時刻が音声範囲外です');
    const estimates=[
      ...analysis.beats.map(t=>({t,kind:'beat' as const,label:'beat?'})),
      ...analysis.downbeats.map(t=>({t,kind:'downbeat' as const,label:'小節頭候補（4拍仮定）'})),
      ...analysis.sectionBoundaries.map(t=>({t,kind:'section' as const,label:'音の変化点候補'})),
    ].map(marker=>({...marker,origin:'estimated' as const}));
    const result = commit(id, { baseRevision, actor, note: `拍推定 ${analysis.tool} ${analysis.version} / ${analysis.bpm.toFixed(2)} BPM`,
      meta: p => { p.audioAnalysis = { ...analysis, sourceSha256: project.source!.sha256 }; },
      scene: s => ({ ...s, markers: [...(s.markers ?? []).filter(m => !(m.origin==='estimated'&&
        (m.kind==='beat'||m.label==='小節頭候補（4拍仮定）'||m.label==='音の変化点候補'))),
        ...estimates.filter(marker=>marker.t<s.duration)].sort((a,b) => a.t-b.t) }) });
    return { project: result.project, bpm: analysis.bpm, beats: analysis.beats, onsets: analysis.onsets,downbeats:analysis.downbeats,sectionBoundaries:analysis.sectionBoundaries };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, '拍推定に失敗しました。workers/beatsのuv syncと音声を確認してください', String(err));
  } finally { for (const file of [wav, json]) fs.rmSync(file, { force: true }); }
}
