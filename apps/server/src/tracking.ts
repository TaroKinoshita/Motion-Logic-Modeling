import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createCanvas } from '@napi-rs/canvas';
import { EaseSchema, fontSpec, resolveTime } from '@mlm/core';
import type { SceneElement } from '@mlm/core';
import { commit, getProject, HttpError, projectDir, REPO_ROOT } from './store.ts';
import { sourcePath } from './media.ts';

const run = promisify(execFile);
export const TrackingRequest = z.strictObject({ baseRevision: z.number().int(), actor: z.string().default('human'),
  from: z.number().nonnegative(), to: z.number().positive(),
  region: z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), w: z.number().int().positive(), h: z.number().int().positive() }),
  method: z.enum(['features','silhouette']).default('features'),
  polarity: z.enum(['dark','light']).default('dark'),
  threshold: z.number().int().min(1).max(254).default(125),
  targetElementId: z.string().min(1).optional(),
});
const Bounds=z.object({x:z.number(),y:z.number(),w:z.number().positive(),h:z.number().positive()});
const Sample = z.object({ t: z.number(), x: z.number(), y: z.number(), scale: z.number().positive(), rotation: z.number(), confidence: z.number().min(0).max(1),
  bounds:Bounds.optional(),widthScale:z.number().positive().optional() });
const Observation = z.object({ samples: z.array(Sample).min(2), stoppedReason: z.string().nullable(), stoppedAt: z.number().nullable(),
  gapTimes:z.array(z.number()).optional(), initialBounds:Bounds.optional() }).passthrough();
const Key = z.object({ t: z.number(), value: z.number(), easing: EaseSchema });
const Fit = z.object({ tracks: z.object({ x: z.array(Key).min(1), y: z.array(Key).min(1), scale: z.array(Key).min(1), rotation: z.array(Key).min(1),widthScale:z.array(Key).min(1).optional() }) }).passthrough();

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
  const startFrame = Math.ceil(from*src.fps-1e-8);
  const endFrame = Math.ceil(to*src.fps-1e-8);
  if(endFrame-startFrame<2) throw new HttpError(400,'追跡区間には2フレーム以上が必要です');
  const startTime=startFrame/src.fps;
  const target=input.targetElementId?scene.elements.find(e=>e.id===input.targetElementId):undefined;
  if (input.targetElementId && (input.method!=='silhouette'||!target||target.type!=='text'||target.split||target.parentId||!target.text?.trim())) {
    throw new HttpError(422,'直接適用には親と文字分割のないテキスト要素とsilhouette方式が必要です');
  }
  if (target && (Math.abs(startTime-resolveTime(target.inPoint??0,scene.tempo))>1e-8 || Math.abs(endFrame/src.fps-resolveTime(target.outPoint??scene.duration,scene.tempo))>1e-8)) {
    throw new HttpError(422,'直接適用する追跡区間はテキスト要素の表示区間と揃えてください');
  }
  try {
    await run(process.env.MLM_FFMPEG ?? 'ffmpeg', ['-v','error','-i',sourcePath(project),'-vf',`trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS,fps=${src.frameRate}`,'-an','-c:v','ffv1',clip], {windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
    const worker = path.join(REPO_ROOT,'workers/track');
    await run(process.env.MLM_UV ?? 'uv', ['run','--offline','--frozen','--project',worker,'--directory',worker,'python','-m','track',clip,raw,'--region',String(region.x),String(region.y),String(region.w),String(region.h),'--fps',String(src.fps),'--start-time',String(startTime),'--method',input.method,'--polarity',input.polarity,'--threshold',String(input.threshold),'--fit-output',fitted], {windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
    const observation = Observation.parse(JSON.parse(fs.readFileSync(raw,'utf8')));
    const fit = Fit.parse(JSON.parse(fs.readFileSync(fitted,'utf8')));
    const samples = observation.samples;
    if (samples.some((s,i)=>s.t < from || s.t >= to+1e-8 || (i>0 && s.t<=samples[i-1].t))) throw new Error('追跡時刻が不正です');
    const keys = (field: keyof typeof fit.tracks, scale=1) => ({keys:fit.tracks[field]!.map(k=>({t:k.t,v:k.value*scale,ease:k.easing}))});
    const bounds=observation.initialBounds??region;
    const pivot=observation.initialBounds?{anchorX:(samples[0].x-bounds.x-bounds.w/2)*ratio,anchorY:(samples[0].y-bounds.y-bounds.h/2)*ratio}:{};
    let element: SceneElement = {id:`tracked_${token}`,name:'追跡領域（推定）',type:'rect',width:bounds.w*ratio,height:bounds.h*ratio,fill:'none',stroke:'#00ddff',strokeWidth:2,
      ...pivot,
      inPoint:startTime,outPoint:Math.min(to,samples.at(-1)!.t+1/src.fps),
      transform:{x:keys('x',ratio),y:keys('y',ratio),scaleX:keys(fit.tracks.widthScale?'widthScale':'scale'),scaleY:keys('scale'),rotation:keys('rotation')},note:`observation ${token}; ${input.method==='silhouette'?'前景重心と外接寸法。欠測フレームは補間。':'原点は選択領域中心。'}`};
    if (target) {
      const lastFrame=endFrame-1;
      if (observation.stoppedReason || !observation.initialBounds || !fit.tracks.widthScale || Math.abs(samples.at(-1)!.t-lastFrame/src.fps)>1e-8) {
        throw new HttpError(422,'表示区間の最後まで追跡できなかったため、文字への直接適用を中止しました');
      }
      const ctx=createCanvas(1,1).getContext('2d');
      ctx.font=fontSpec(target);
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      const ink=ctx.measureText(target.text!);
      const width=ink.actualBoundingBoxLeft+ink.actualBoundingBoxRight;
      const height=ink.actualBoundingBoxAscent+ink.actualBoundingBoxDescent;
      if (!(width>0 && height>0)) throw new HttpError(422,'テキストの描画寸法を求められません');
      const scaleX=bounds.w*ratio/width, scaleY=bounds.h*ratio/height;
      element={...target,
        anchorX:(ink.actualBoundingBoxRight-ink.actualBoundingBoxLeft)/2+(pivot.anchorX??0)/scaleX,
        anchorY:(ink.actualBoundingBoxDescent-ink.actualBoundingBoxAscent)/2+(pivot.anchorY??0)/scaleY,
        transform:{...target.transform,x:keys('x',ratio),y:keys('y',ratio),scaleX:keys('widthScale',scaleX),scaleY:keys('scale',scaleY),rotation:0},
      };
    }
    return commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:`領域追跡 ${samples.length}点 / ${target?`文字 ${target.id} へ適用`:observation.stoppedReason ?? '完走'}`,
      scene:s=>({...s,elements:target?s.elements.map(e=>e.id===target.id?element:e):[...s.elements,element]}),
      documents:d=>({...d,observations:{...(d.observations as object ?? {}),[token]:{...observation,id:token,kind:'region-track',sourceProjectId:id,sourceRevision:project.revision,sourceSha256:src.sha256}},
        simplification:{...(d.simplification as object ?? {}),[token]:{...fit,observationId:token,elementId:element.id,coordinateScale:ratio}}})});
  } catch(err) {
    if(err instanceof HttpError) throw err;
    throw new HttpError(422,'領域追跡に失敗しました。初期領域・追跡方式・専用環境を確認してください',String(err));
  } finally {for(const f of [clip,raw,fitted,raw.replace(/\.json$/,'.tmp'),fitted.replace(/\.json$/,'.tmp')]) fs.rmSync(f,{force:true});}
}
