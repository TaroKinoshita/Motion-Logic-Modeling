import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SceneElement } from '@mlm/core';
import { commit, getProject, HttpError, projectDir, REPO_ROOT } from './store.ts';
import { sourcePath } from './media.ts';

const run = promisify(execFile);
export const TrackingRequest = z.strictObject({ baseRevision: z.number().int(), actor: z.string().default('human'),
  from: z.number().nonnegative(), to: z.number().positive(),
  region: z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), w: z.number().int().positive(), h: z.number().int().positive() }),
});
const Sample = z.object({ t: z.number(), x: z.number(), y: z.number(), scale: z.number().positive(), rotation: z.number(), confidence: z.number().min(0).max(1) });
const Observation = z.object({ samples: z.array(Sample).min(2), stoppedReason: z.string().nullable(), stoppedAt: z.number().nullable() }).passthrough();
const Key = z.object({ t: z.number(), value: z.number(), easing: z.literal('linear') });
const Fit = z.object({ tracks: z.object({ x: z.array(Key).min(1), y: z.array(Key).min(1), scale: z.array(Key).min(1), rotation: z.array(Key).min(1) }) }).passthrough();

export async function trackRegion(id: string, input: z.infer<typeof TrackingRequest>) {
  const { project, scene } = getProject(id);
  if (project.revision !== input.baseRevision) throw new HttpError(409, '最新のrevisionを読み直してください');
  const src = project.source;
  if (!src) throw new HttpError(400, '元動画が必要です');
  if (src.variableFrameRate) throw new HttpError(422, '初版の追跡は固定フレームレートの元動画が必要です');
  const { from, to, region } = input;
  if (to <= from || to-from > 10 || to > Math.min(src.duration, scene.duration) || region.x+region.w > src.width || region.y+region.h > src.height) throw new HttpError(400, '追跡は動画・シーン内の10秒以内、領域は元動画内で指定してください');
  const ratio = scene.width/src.width;
  if (Math.abs(ratio-scene.height/src.height) > 1e-6) throw new HttpError(422, '追跡適用には元動画とシーンの縦横比一致が必要です');
  const cache = path.join(projectDir(id), 'cache'); fs.mkdirSync(cache, {recursive:true});
  const token = randomUUID(), stem = path.join(cache, `track-${token}`);
  const clip = `${stem}.avi`, raw = `${stem}-raw.json`, fitted = `${stem}-fit.json`;
  try {
    await run(process.env.MLM_FFMPEG ?? 'ffmpeg', ['-v','error','-i',sourcePath(project),'-vf',`trim=start=${from}:end=${to},setpts=PTS-STARTPTS,fps=${src.frameRate}`,'-an','-c:v','ffv1',clip], {windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
    const worker = path.join(REPO_ROOT,'workers/track');
    await run(process.env.MLM_UV ?? 'uv', ['run','--offline','--frozen','--project',worker,'--directory',worker,'python','-m','track',clip,raw,'--region',String(region.x),String(region.y),String(region.w),String(region.h),'--fps',String(src.fps),'--start-time',String(from),'--fit-output',fitted], {windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
    const observation = Observation.parse(JSON.parse(fs.readFileSync(raw,'utf8')));
    const fit = Fit.parse(JSON.parse(fs.readFileSync(fitted,'utf8')));
    const samples = observation.samples;
    if (samples.some((s,i)=>s.t < from || s.t >= to+1e-8 || (i>0 && s.t<=samples[i-1].t))) throw new Error('追跡時刻が不正です');
    const keys = (field: keyof typeof fit.tracks, scale=1) => ({keys:fit.tracks[field].map(k=>({t:k.t,v:k.value*scale,ease:'linear' as const}))});
    const element: SceneElement = {id:`tracked_${token}`,name:'追跡領域（推定）',type:'rect',width:region.w*ratio,height:region.h*ratio,fill:'none',stroke:'#00ddff',strokeWidth:2,
      inPoint:from,outPoint:Math.min(to,samples.at(-1)!.t+1/src.fps),
      transform:{x:keys('x',ratio),y:keys('y',ratio),scaleX:keys('scale'),scaleY:keys('scale'),rotation:keys('rotation')},note:`observation ${token}; 原点は選択領域中心。輪郭の分解ではない`};
    return commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:`領域追跡 ${samples.length}点 / ${observation.stoppedReason ?? '完走'}`,
      scene:s=>({...s,elements:[...s.elements,element]}),
      documents:d=>({...d,observations:{...(d.observations as object ?? {}),[token]:{...observation,id:token,kind:'region-track',sourceProjectId:id,sourceRevision:project.revision,sourceSha256:src.sha256}},
        simplification:{...(d.simplification as object ?? {}),[token]:{...fit,observationId:token,elementId:element.id,coordinateScale:ratio}}})});
  } catch(err) {
    if(err instanceof HttpError) throw err;
    throw new HttpError(422,'領域追跡に失敗しました。特徴点のある領域と専用環境を確認してください',String(err));
  } finally {for(const f of [clip,raw,fitted,raw.replace(/\.json$/,'.tmp'),fitted.replace(/\.json$/,'.tmp')]) fs.rmSync(f,{force:true});}
}
