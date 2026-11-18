import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { retimeSections, varyHold, varyHoldGroup, demoScene } from '@mlm/core';
import type { Scene } from '@mlm/core';
import { checkScene, commit, createProject, getDocuments, getProject, HttpError, projectDir, trashProject } from './store.ts';
import type { ProjectDocuments } from './store.ts';
import { sourcePath } from './media.ts';

const Revision = z.number().int().positive();
const fingerprint=(scene:Scene)=>createHash('sha256').update(JSON.stringify(scene)).digest('hex');
const Actor = z.string().min(1).max(40).default('human');
export const MeasureRequest = z.strictObject({baseRevision:Revision,actor:Actor,events:z.array(z.strictObject({label:z.string().min(1),t:z.number().nonnegative(),origin:z.enum(['manual','measured','estimated']),elementId:z.string().optional()})).min(1).max(1000)});
const Hypothesis = z.strictObject({id:z.string().min(1),text:z.string().min(1),observationIds:z.array(z.string()).min(1),status:z.enum(['proposed','accepted','rejected'])});
const HoldTarget=z.strictObject({elementId:z.string(),property:z.enum(['x','y','scaleX','scaleY','rotation','opacity']),keyIndex:z.number().int().nonnegative()});
const Rule = z.discriminatedUnion('kind',[
  z.strictObject({id:z.string().min(1),hypothesisId:z.string(),kind:z.literal('hold_group'),targets:z.array(HoldTarget).min(1).max(100)}),
  z.strictObject({id:z.string().min(1),hypothesisId:z.string(),kind:z.literal('stagger'),elementId:z.string()}),
  z.strictObject({id:z.string().min(1),hypothesisId:z.string(),kind:z.literal('hold'),elementId:z.string(),property:z.enum(['x','y','scaleX','scaleY','rotation','opacity']),keyIndex:z.number().int().nonnegative()}),
]);
export const ModelRequest = z.strictObject({baseRevision:Revision,actor:Actor,mode:z.enum(['merge','replace']).default('merge'),hypotheses:z.array(Hypothesis).max(100),rules:z.array(Rule).max(100)});
export const VariantRequest = z.strictObject({baseRevision:Revision,actor:Actor,ruleId:z.string(),seconds:z.number().nonnegative(),name:z.string().min(1).max(100)});
const Section = z.strictObject({sourceFrom:z.number().nonnegative(),sourceTo:z.number().positive(),targetFrom:z.number().nonnegative(),targetTo:z.number().positive(),elementIds:z.array(z.string()).min(1),reason:z.string().min(1)});
export const AdaptRequest = z.strictObject({baseRevision:Revision,actor:Actor,targetProjectId:z.string(),targetRevision:Revision,name:z.string().min(1).max(100),sections:z.array(Section).min(1).max(100)});
export const BaselineRequest = AdaptRequest.omit({sections:true});

function current(id:string,revision:number) {
  const state=getProject(id);
  if(state.project.revision!==revision) throw new HttpError(409,'最新のrevisionを読み直してください');
  return state;
}
export function measureEvents(id:string,input:z.infer<typeof MeasureRequest>) {
  const {project,scene}=current(id,input.baseRevision);
  const beats=(scene.markers??[]).filter(m=>m.kind==='beat').sort((a,b)=>a.t-b.t);
  if(!beats.length) throw new HttpError(422,'拍マーカーがありません');
  const rows=input.events.map(e=>{
    if(e.t>scene.duration || (e.elementId && !scene.elements.some(x=>x.id===e.elementId))) throw new HttpError(422,'イベントの時刻または要素が不正です');
    const beat=beats.reduce((a,b)=>Math.abs(a.t-e.t)<=Math.abs(b.t-e.t)?a:b);
    return {id:randomUUID(),kind:'event-beat',event:e,beat:{...beat},offsetSeconds:e.t-beat.t,sourceProjectId:id,sourceRevision:project.revision,sourceSha256:project.source?.sha256,method:'nearest beat; negative=event leads; tie=earlier beat'};
  });
  const result=commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:`イベントと拍の差を${rows.length}件計測`,documents:d=>({...d,observations:{...(d.observations as object??{}),...Object.fromEntries(rows.map(r=>[r.id,r]))}})});
  return {...result,measurements:rows};
}
export function saveModel(id:string,input:z.infer<typeof ModelRequest>) {
  const {scene}=current(id,input.baseRevision), docs=getDocuments(id);
  const observations=docs.observations as Record<string,unknown>??{};
  if(new Set(input.hypotheses.map(h=>h.id)).size!==input.hypotheses.length || new Set(input.rules.map(r=>r.id)).size!==input.rules.length) throw new HttpError(422,'IDが重複しています');
  if(input.mode==='merge') {
    const previous=z.object({rules:z.array(Rule),sceneSha256:z.string()}).optional().parse(docs.motion_rules);
    if(previous && previous.sceneSha256!==fingerprint(scene) && previous.rules.some(r=>!input.rules.some(n=>n.id===r.id))) throw new HttpError(409,'シーン変更後の既存規則を再確認し、全規則を送信してください');
    const merge=<T extends {id:string}>(old:T[],incoming:T[])=>[...new Map([...old,...incoming].map(v=>[v.id,v])).values()];
    input={...input,hypotheses:merge(z.array(Hypothesis).parse(docs.hypotheses??[]),input.hypotheses),rules:merge(previous?.rules??[],input.rules)};
    if(input.hypotheses.length>100||input.rules.length>100) throw new HttpError(422,'仮説・規則は各100件以内です');
  }
  for(const h of input.hypotheses) for(const key of h.observationIds) if(!observations[key]) throw new HttpError(422,`観察 ${key} がありません`);
  for(const rule of input.rules) {
    if(!input.hypotheses.some(h=>h.id===rule.hypothesisId && h.status==='accepted')) throw new HttpError(422,'規則にはacceptedの仮説が必要です（採用は真偽の証明ではありません）');
    if(rule.kind==='hold_group') {
      try { varyHoldGroup(scene,rule.targets,0); } catch(err) {throw new HttpError(422,String(err));}
      continue;
    }
    if(!scene.elements.some(e=>e.id===rule.elementId)) throw new HttpError(422,'規則の対象要素がありません');
    const element=scene.elements.find(e=>e.id===rule.elementId)!;
    if(rule.kind==='stagger' && (!element.split||!element.stagger)) throw new HttpError(422,'stagger規則には分割文字と時間差が必要です');
    if(rule.kind==='hold') {
      const track=element.transform?.[rule.property];
      if(typeof track!=='object'||track.repeat||!track.keys[rule.keyIndex+1]||track.keys[rule.keyIndex].v!==track.keys[rule.keyIndex+1].v) throw new HttpError(422,'hold規則には同じ値の連続キーが必要です');
    }
  }
  return commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:'観察に紐づく仮説・規則を保存',documents:d=>({...d,hypotheses:input.hypotheses,motion_rules:{rules:input.rules,sceneSha256:fingerprint(scene),sourceRevision:input.baseRevision}})});
}
function generated(name:string,scene:Scene,mediaId:string,actor:string,documents:ProjectDocuments) {
  checkScene(scene);
  const source=getProject(mediaId).project.source;
  const media=source?sourcePath(getProject(mediaId).project):undefined;
  if(media && !fs.existsSync(media)) throw new HttpError(422,'入力メディアがありません');
  const created=createProject(name,scene,actor);
  try {
    if(source && media) fs.copyFileSync(media,path.join(projectDir(created.project.id),'media',source.fileName));
    return commit(created.project.id,{baseRevision:created.project.revision,actor,note:'生成条件と入力の出典を保存',meta:p=>{if(source)p.source=structuredClone(source);},documents:()=>documents});
  } catch(err) {trashProject(created.project.id,actor);throw err;}
}
export function generateVariant(id:string,input:z.infer<typeof VariantRequest>) {
  const {scene}=current(id,input.baseRevision),docs=getDocuments(id);
  const saved=z.object({rules:z.array(Rule),sceneSha256:z.string()}).safeParse(docs.motion_rules);
  if(!saved.success) throw new HttpError(422,'規則を保存してください');
  if(saved.data.sceneSha256!==fingerprint(scene)) throw new HttpError(409,'規則の保存後にシーンが変わっています。規則と根拠を再確認して保存してください');
  const rule=saved.data.rules.find(r=>r.id===input.ruleId);
  if(!rule) throw new HttpError(422,'規則がありません');
  let next=structuredClone(scene);
  try {
    if(rule.kind==='hold') next=varyHold(scene,rule.elementId,rule.property,rule.keyIndex,input.seconds);
    else if(rule.kind==='hold_group') next=varyHoldGroup(scene,rule.targets,input.seconds);
    else {
      const e=next.elements.find(e=>e.id===rule.elementId);
      if(!e?.split || !e.stagger) throw new Error('文字分割とstaggerのある要素が必要です');
      e.stagger.interval=input.seconds;
    }
  } catch(err) {throw new HttpError(422,String(err));}
  return generated(input.name,next,id,input.actor,{...docs,adaptation:{kind:'variant',sourceProjectId:id,sourceRevision:input.baseRevision,rule,seconds:input.seconds,limitations:['指定した規則のパラメータだけを変更。演出の優劣は未判定']}});
}
export function generateAdaptation(id:string,input:z.infer<typeof AdaptRequest>) {
  const source=current(id,input.baseRevision),target=current(input.targetProjectId,input.targetRevision);
  let scene:Scene;
  try {scene=retimeSections(source.scene,target.scene,input.sections);} catch(err) {throw new HttpError(422,String(err));}
  return generated(input.name,scene,input.targetProjectId,input.actor,{...getDocuments(id),adaptation:{kind:'sections',sourceProjectId:id,sourceRevision:input.baseRevision,targetProjectId:input.targetProjectId,targetRevision:input.targetRevision,sourceSha256:source.project.source?.sha256,targetSha256:target.project.source?.sha256,sections:input.sections,beatMapping:'区間先頭に最も近い新曲の拍から拍番号を対応。揺れはoffsetSecondsに保持',limitations:['区間対応は明示指定。楽曲構成を自動推定していない','図形と文字内容を保持。文字数変更は既存の編集操作で行う','秒キーは区間ごとに変換。区間をまたぐ補間曲線の厳密な再パラメータ化はしない','反復周期・staggerの拍数は保持するが、不規則な拍ごとの周期変化は未対応']}});
}

export function generateBaselines(id:string,input:z.infer<typeof BaselineRequest>) {
  const source=current(id,input.baseRevision),target=current(input.targetProjectId,input.targetRevision);
  const map=(scene:Scene,sourceFrom:number,sourceTo:number,targetFrom:number,targetTo:number,reason:string)=>retimeSections(scene,target.scene,[{sourceFrom,sourceTo,targetFrom,targetTo,elementIds:scene.elements.map(e=>e.id),reason}],false);
  const beats=(s:Scene)=>[...new Set((s.markers??[]).filter(m=>m.kind==='beat'&&m.t>=0&&m.t<=s.duration).map(m=>m.t))].sort((a,b)=>a-b);
  const a=beats(source.scene),b=beats(target.scene);
  if(a.length<2||b.length<2) throw new HttpError(422,'拍基準の比較版には両方のシーンに2拍以上必要です');
  let candidates:{kind:string;scene:Scene;reason:string}[];
  try {
    const template=demoScene();
    candidates=[
      {kind:'global-speed',scene:map(source.scene,0,source.scene.duration,0,target.scene.duration,'全体尺だけを合わせる'),reason:'全体尺の比率で時間を一律変更'},
      {kind:'beat-endpoints',scene:map(source.scene,a[0],a.at(-1)!,b[0],b.at(-1)!,'最初と最後の拍を合わせる'),reason:'最初と最後の拍だけを対応させる一定倍率の基準。各拍の局所補正はしない'},
      {kind:'fixed-template',scene:map(template,0,template.duration,0,target.scene.duration,'固定demoテンプレート'),reason:'参考映像に依存しない固定テンプレートの全体尺を合わせる'},
    ];
    candidates.forEach(c=>checkScene(c.scene));
  } catch(err) {throw new HttpError(422,'比較用シーンを生成できません',String(err));}
  return {projects:candidates.map(c=>generated(`${input.name} ${c.kind}`,c.scene,input.targetProjectId,input.actor,{adaptation:{kind:c.kind,reason:c.reason,sourceProjectId:id,sourceRevision:input.baseRevision,targetProjectId:input.targetProjectId,targetRevision:input.targetRevision}}))};
}
