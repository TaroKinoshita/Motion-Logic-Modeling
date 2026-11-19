import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { EaseSchema, isActive, resolveTime, worldMatrixOf } from '@mlm/core';
import { z } from 'zod';
import { getBlocking } from './blocking.ts';
import { commit, getDocuments, HttpError, REPO_ROOT } from './store.ts';

const run=promisify(execFile);
const word=z.string().trim().min(1).max(100);
const frame=z.number().int().nonnegative();
const revision=z.number().int().positive();
const kind=z.enum(['slide','squash','rotate','hold','exit','scale-jump']);
const keys=z.array(z.object({t:z.number().min(0).max(1),value:z.number(),easing:EaseSchema})).min(2);
const channel=z.enum(['x','y','scaleX','scaleY','rotation']);
const fit=z.object({tracks:z.partialRecord(channel,keys),maxSampleError:z.partialRecord(channel,z.number().nonnegative())});
const clip=z.strictObject({id:word,label:word,blockId:word,kind,from:frame,to:frame,profile:z.enum(['standard','compact']).optional()});
export const MotionVocabularyRequest=z.strictObject({baseRevision:revision,actor:word.default('human'),clips:z.array(clip).min(1).max(8)});
const template=clip.extend({sourceProjectId:word,sourceRevision:revision,sourceSha256:word,sourceSeconds:z.number().positive(),
  anchor:z.enum(['start','end']),sampleCount:z.number().int().min(2),pinnedFrames:z.array(frame),tracks:fit.shape.tracks,
  stationary:z.object({from:frame,to:frame,seconds:z.number().positive(),maxStepPx:z.number().positive()}).optional(),
  transition:z.object({frame,ratio:z.number().positive()}).optional(),
  linearKeyCount:z.number().int(),cubicKeyCount:z.number().int(),sourceKeyCount:z.number().int(),sampleKeyCount:z.number().int().positive(),maxSampleError:fit.shape.maxSampleError});
const library=z.record(z.string(),template);
export type MotionTemplate=z.infer<typeof template>;

export function readMotionVocabulary(id:string) {
  return library.parse(getDocuments(id).motion_vocabulary??{});
}

export async function saveMotionVocabulary(id:string,input:z.infer<typeof MotionVocabularyRequest>) {
  const {project,scene,design}=getBlocking(id);
  if(project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  const source=project.source;
  if(!design||!source) throw new HttpError(422,'元映像のある工程比較を指定してください');
  if(new Set(input.clips.map(item=>item.id)).size!==input.clips.length) throw new HttpError(422,'型のIDが重複しています');
  const work=path.join(REPO_ROOT,'workers','track');
  const python=process.env.MLM_TRACK_PYTHON??path.join(work,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const templates:MotionTemplate[]=[];
  for(const item of input.clips) {
    const {from,to,blockId}=item;
    const block=design.blocks.items.find(entry=>entry.id===blockId),element=scene.elements.find(entry=>entry.id===blockId);
    if(!block||!element||to-from<3||to-from>96||from/scene.fps<design.blocks.from||to/scene.fps>design.blocks.to) {
      throw new HttpError(422,'対象ブロックと比較範囲内の3〜96フレームを指定してください');
    }
    if(design.events.some(event=>event.status==='confirmed'&&['cut','contact','merge','replace','invert'].includes(event.kind)&&
      (event.kind==='cut'||event.kind==='invert'||[...event.inputs,...event.outputs].includes(blockId))&&event.t>from/scene.fps&&event.t<(to-1)/scene.fps)) {
      throw new HttpError(422,'カットや確定した接触の前後で抽出範囲を分けてください');
    }
    const matrices=Array.from({length:to-from},(_,i)=>{
      const t=(from+i)/scene.fps;
      if(!isActive(element,scene,t)||block.hiddenDuring?.some(gap=>gap.from<=t&&t<gap.to)) throw new HttpError(422,'表示が連続する範囲を指定してください');
      return worldMatrixOf(scene,blockId,t);
    });
    const anchor=item.kind==='rotate'||item.kind==='exit'?'start':'end';
    const [a,b,c,d,x,y]=anchor==='start'?matrices[0]:matrices.at(-1)!;
    const width=Math.hypot(a,b);
    const height=Math.hypot(c,d);
    if(width<1e-8) throw new HttpError(422,'基準コマの横幅を計測できません');
    const baseAngle=Math.atan2(b,a)*180/Math.PI;
    let previous=0;
    const positional=item.kind==='slide'||item.kind==='hold'||item.kind==='exit';
    let stationary:MotionTemplate['stationary'];
    if(item.kind==='hold') {
      const maxStepPx=Math.hypot(scene.width,scene.height)*.002;
      let start=0,bestStart=0,bestEnd=0;
      for(let i=1;i<=matrices.length;i++) {
        if(i<matrices.length&&Math.hypot(matrices[i][4]-matrices[i-1][4],matrices[i][5]-matrices[i-1][5])<=maxStepPx) continue;
        if(i-1-start>bestEnd-bestStart) {bestStart=start;bestEnd=i-1;}
        start=i;
      }
      if(bestEnd-bestStart<3) throw new HttpError(422,'タメには画面上の移動が小さい状態が続く4フレーム以上を選んでください');
      stationary={from:from+bestStart,to:from+bestEnd,seconds:(bestEnd-bestStart)/scene.fps,maxStepPx};
    }
    if(item.kind==='exit'&&Math.hypot(matrices.at(-1)![4]-x,matrices.at(-1)![5]-y)<Math.hypot(scene.width,scene.height)*.015) {
      throw new HttpError(422,'抜けには終点までの位置差が画面対角の1.5%以上ある区間を選んでください');
    }
    const samples=matrices.map(([a,b,c,d,tx,ty],i)=>{
      const t=i/(matrices.length-1);
      if(positional) return {t,x:(tx-x)/scene.width,y:(ty-y)/scene.height};
      if(item.kind==='squash') return {t,scaleX:Math.hypot(a,b)/width};
      if(item.kind==='scale-jump') return {t,scaleX:Math.hypot(a,b)/width,scaleY:Math.hypot(c,d)/height};
      const angle=Math.atan2(b,a)*180/Math.PI-baseAngle;
      previous=angle+360*Math.round((previous-angle)/360);
      return {t,rotation:previous};
    });
    const compact=item.profile==='compact';
    const tolerance=positional?{x:compact ? .0032 : .002,y:compact ? .0032 : .002}:
      item.kind==='squash'?{scaleX:compact ? .025 : .014}:
      item.kind==='scale-jump'?{scaleX:.02,scaleY:.02}:{rotation:compact ? 1.5 : .7};
    let transition:MotionTemplate['transition'];
    if(item.kind==='scale-jump') {
      const effectiveScale=samples.map(sample=>Math.sqrt(sample.scaleX!*sample.scaleY!));
      const steps=effectiveScale.slice(1).map((value,index)=>({frame:from+index+1,ratio:effectiveScale[index]/value}));
      transition=steps.sort((a,b)=>b.ratio-a.ratio)[0];
      if(!Number.isFinite(transition.ratio)||transition.ratio<1.5) throw new HttpError(422,'語全体が1コマで1.5倍以上縮む区間を指定してください');
    }
    const fields=Object.keys(tolerance) as z.infer<typeof channel>[];
    const omitted:Partial<Record<z.infer<typeof channel>,number>>={};
    if(compact&&item.kind==='slide') for(const axis of ['x','y'] as const) {
      const peak=Math.max(...samples.map(sample=>Math.abs(sample[axis]!)));
      if(peak<=tolerance[axis]!) omitted[axis]=peak;
    }
    const active=fields.filter(field=>!(field in omitted));
    if(!active.length) throw new HttpError(422,'許容誤差を超える移動がないため、圧縮する流しの範囲を見直してください');
    const tolerances=Object.fromEntries(active.map(field=>[field,tolerance[field]]));
    const channelPins:Partial<Record<z.infer<typeof channel>,number[]>>={};
    for(const field of active) {
      const pins=new Set([0,samples.length-1]);
      if(transition) {pins.add(transition.frame-from-1);pins.add(transition.frame-from);}
      if(stationary) {pins.add(stationary.from-from);pins.add(stationary.to-from);}
      const values=samples.map(sample=>sample[field]!);
      for(const value of [Math.min(...values),Math.max(...values)]) {
        pins.add(values.indexOf(value));pins.add(values.lastIndexOf(value));
      }
      let still=0;
      for(let i=1;i<=values.length;i++) {
        if(i<values.length&&Math.abs(values[i]-values[i-1])<=tolerances[field]!/3) continue;
        if(i-1-still>=3) {pins.add(still);pins.add(i-1);}
        still=i;
      }
      channelPins[field]=[...pins].sort((a,b)=>a-b);
    }
    const pinIndexes=[...new Set(Object.values(channelPins).flat())].sort((a,b)=>a-b);
    let result;
    try {
      const {stdout}=await run(python,[path.join(work,'track','motion_vocabulary_fit.py'),
        JSON.stringify([samples,tolerances,channelPins])],{windowsHide:true,timeout:30_000});
      result=z.object({linear:fit,eased:fit}).parse(JSON.parse(stdout));
    } catch(error) {throw new HttpError(422,'動きの近似に失敗しました。workers/trackの環境を確認してください',String(error));}
    if(transition) {
      const previous=(transition.frame-from-1)/(samples.length-1);
      for(const track of Object.values(result.eased.tracks)) {
        const key=track.find(row=>Math.abs(row.t-previous)<1e-8);
        if(key) key.easing='hold';
      }
    }
    const count=(model:z.infer<typeof fit>)=>Object.values(model.tracks).reduce((sum,track)=>sum+track.length,0);
    const sourceKeyCount=fields.reduce((sum,field)=>{
      const track=element.transform?.[field];
      return sum+(typeof track==='object'?track.keys.filter(key=>{
        const t=resolveTime(key.t,scene.tempo);
        return t>=from/scene.fps-1e-8&&t<to/scene.fps-1e-8;
      }).length:0);
    },0);
    templates.push({...item,sourceProjectId:id,sourceRevision:project.revision,sourceSha256:source.sha256,anchor,stationary,transition,
      sourceSeconds:(to-from-1)/scene.fps,sampleCount:samples.length,pinnedFrames:pinIndexes.map(i=>i+from),
      tracks:result.eased.tracks,linearKeyCount:count(result.linear),cubicKeyCount:count(result.eased),sourceKeyCount,
      sampleKeyCount:samples.length*fields.length,maxSampleError:{...result.eased.maxSampleError,...omitted}});
  }
  return {...commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:'観察済み区間から動きの型を抽出',
    documents:docs=>({...docs,motion_vocabulary:{...library.parse(docs.motion_vocabulary??{}),...Object.fromEntries(templates.map(item=>[item.id,item]))}})}),templates};
}
