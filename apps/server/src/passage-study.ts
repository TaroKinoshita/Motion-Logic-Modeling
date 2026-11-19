import {randomUUID} from 'node:crypto';
import {createCanvas} from '@napi-rs/canvas';
import {fontSpec, isActive, resolveTime, sampleTrack, textUnits, worldMatrixOf} from '@mlm/core';
import type {SceneElement} from '@mlm/core';
import {z} from 'zod';
import {getBlocking} from './blocking.ts';
import {saveGeneratedProject} from './modeling.ts';
import {commit, getDocuments, HttpError} from './store.ts';

const kind=z.enum(['sequential-entry','common-translation']);
const frame=z.number().int().nonnegative();
const id=z.string().trim().min(1).max(160);
const range={from:frame,to:frame};
const head={baseRevision:z.number().int().positive(),actor:z.string().trim().min(1).max(40).default('human')};
const camera=z.object({id,kind:z.literal('camera-candidate'),frame,movement:z.tuple([z.number(),z.number()]),support:z.number().int().min(3),medianResidual:z.number().nonnegative()});
const metrics=z.record(z.string(),z.number());
const review=z.object({id,kind:z.literal('motion-passage-review'),pattern:kind,...range,blockIds:z.array(id),status:z.enum(['confirmed','rejected']),
  sourceSha256:id,sourceRevision:head.baseRevision,candidateId:id,metrics,observationIds:z.array(id),note:z.string(),origin:z.literal('manual')});
export const PassageRequest=z.discriminatedUnion('operation',[
  z.strictObject({...head,operation:z.literal('review'),candidateId:id,pattern:kind,...range,
    blockIds:z.array(id).min(2).max(12),status:review.shape.status,note:z.string().trim().max(500).default('')}),
  z.strictObject({...head,operation:z.literal('assemble'),reviewId:id,name:z.string().trim().min(1).max(80),text:z.string().trim().min(1).max(100)}),
]);
type BlockingState=ReturnType<typeof getBlocking>;
type State=BlockingState&{design:NonNullable<BlockingState['design']>};
type Pattern=z.infer<typeof kind>;
type Candidate={id:string;pattern:Pattern;from:number;to:number;blockIds:string[];observationIds:string[];metrics:Record<string,number>};

function roles({scene,design}:State) {
  const byId=new Map(scene.elements.map(element=>[element.id,element]));
  return design.blocks.items.flatMap(block=>{
    const element=byId.get(block.id);
    if(!element||block.members) return [];
    const ownerFrom=Math.max(design.blocks.from,resolveTime(element.inPoint??0,scene.tempo));
    const ownerTo=Math.min(design.blocks.to,resolveTime(element.outPoint??scene.duration,scene.tempo));
    const from=Math.ceil(ownerFrom*scene.fps-1e-8),to=Math.ceil(ownerTo*scene.fps-1e-8);
    const [, ,c,d,x,y]=worldMatrixOf(scene,element.id,from/scene.fps);
    const height=sampleTrack(block.extent.height,from/scene.fps,0,scene.tempo)*Math.hypot(c,d);
    return [{id:block.id,from,to,x,y,height,observationIds:block.observationIds}];
  });
}

function findCandidates(state:State,observations:Record<string,unknown>) {
  const {scene,design}=state;
  const all=roles(state),confirmed=design.events.filter(item=>item.status==='confirmed'&&['cut','invert','merge','replace'].includes(item.kind));
  const crosses=(from:number,to:number)=>confirmed.some(event=>from/scene.fps<event.t&&event.t<to/scene.fps)||
    scene.markers?.some(marker=>marker.kind==='cut'&&from/scene.fps<marker.t&&marker.t<to/scene.fps);
  const output:Candidate[]=[];
  const add=(pattern:Pattern,from:number,to:number,blockIds:string[],observationIds:string[],metrics:Candidate['metrics'])=>{
    output.push({id:`${pattern}:${from}:${to}`,pattern,from,to,blockIds,observationIds:[...new Set(observationIds)],metrics});
  };
  const births=all.filter(row=>row.height>=scene.height*.035&&row.to-row.from>=4).sort((a,b)=>a.from-b.from||a.x-b.x);
  for(const lead of births) {
    const cohort=births.filter(row=>row.from>=lead.from&&row.from-lead.from<=6&&Math.abs(row.x-lead.x)<=scene.width*.35&&Math.abs(row.y-lead.y)<=scene.height*.13);
    const last=Math.max(...cohort.map(row=>row.from)),to=last+4;
    if(cohort.length<3||cohort.length>12||last===lead.from||!cohort.some(row=>row.from===last&&row.to>=to)||crosses(lead.from,to)||
      output.some(item=>item.from===lead.from)) continue;
    add('sequential-entry',lead.from,to,cohort.map(row=>row.id),cohort.flatMap(row=>row.observationIds),{
      roleCount:cohort.length,entrySpanFrames:last-lead.from,entrySpanSeconds:(last-lead.from)/scene.fps,
    });
  }
  const cameraRows=Object.values(observations).flatMap(value=>{
    const parsed=camera.safeParse(value);
    return parsed.success?[parsed.data]:[];
  }).sort((a,b)=>a.frame-b.frame||b.support-a.support||a.medianResidual-b.medianResidual);
  const runs:z.infer<typeof camera>[][]=[];
  const seen=new Set<number>();
  for(const row of cameraRows) {
    if(seen.has(row.frame)) continue;
    seen.add(row.frame);
    const last=runs.at(-1)?.at(-1);
    const matches=last&&last.frame+1===row.frame&&last.movement[0]*row.movement[0]+last.movement[1]*row.movement[1]>0;
    if(matches) runs.at(-1)!.push(row);
    else runs.push([row]);
  }
  for(const run of runs) {
    const from=run[0].frame-1,to=run.at(-1)!.frame+1;
    const x=run.reduce((sum,row)=>sum+row.movement[0],0),y=run.reduce((sum,row)=>sum+row.movement[1],0);
    const peers=all.filter(row=>row.from<=from&&row.to>=to&&row.height>=scene.height*.03)
      .sort((a,b)=>worldMatrixOf(scene,a.id,from/scene.fps)[4]-worldMatrixOf(scene,b.id,from/scene.fps)[4]).slice(0,12);
    if(from<0||run.length<3||Math.hypot(x,y)<scene.width*.015||peers.length<2||crosses(from,to)) continue;
    add('common-translation',from,to,peers.map(row=>row.id),run.map(row=>row.id),{
      roleCount:peers.length,dxPx:x,dyPx:y,displacementRatio:Math.hypot(x,y)/scene.width,minSupport:Math.min(...run.map(row=>row.support)),
      meanResidualPx:run.reduce((sum,row)=>sum+row.medianResidual,0)/run.length,
    });
  }
  return output.sort((a,b)=>a.from-b.from);
}

export function getPassages(projectId:string) {
  const state=getBlocking(projectId);
  if(!state.design||!state.project.source) throw new HttpError(422,'元動画のブロックを計測してください');
  const observations=getDocuments(projectId).observations as Record<string,unknown>??{};
  const reviews=Object.values(observations).flatMap(value=>{
    const parsed=review.safeParse(value);
    return parsed.success&&parsed.data.sourceSha256===state.project.source?.sha256?[parsed.data]:[];
  });
  const ready={...state,design:state.design};
  return {state:ready,observations,candidates:findCandidates(ready,observations),reviews};
}

export function editPassage(projectId:string,input:z.infer<typeof PassageRequest>) {
  const {state,candidates,reviews,observations}=getPassages(projectId);
  const {scene,design,project}=state;
  if(project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  if(input.operation==='review') {
    const candidate=candidates.find(item=>item.id===input.candidateId&&item.pattern===input.pattern);
    if(!candidate) throw new HttpError(422,'現在の計測から候補を読み直してください');
    const {from,to,blockIds}=input;
    const active=roles(state).filter(row=>row.from<to&&row.to>from);
    if(to<=from||to-from>96||from/scene.fps<design.blocks.from||to/scene.fps>design.blocks.to||
      new Set(blockIds).size!==blockIds.length||blockIds.some(key=>!active.some(block=>block.id===key))) {
      throw new HttpError(422,'比較範囲内の有効な区間と、その区間にある別々のブロックを指定してください');
    }
    const births=blockIds.map(key=>active.find(item=>item.id===key)!.from);
    const frames=births.map(birth=>Math.max(from,birth));
    const within=births.filter(birth=>birth>=from);
    const evidence=input.pattern==='common-translation'?candidate.observationIds.filter(key=>{
      const row=camera.safeParse(observations[key]);
      return row.success&&row.data.frame>from&&row.data.frame<to;
    }):active.filter(role=>blockIds.includes(role.id)).flatMap(role=>role.observationIds);
    const shifts=evidence.flatMap(key=>{const parsed=camera.safeParse(observations[key]);return parsed.success?[parsed.data]:[];});
    const dx=shifts.reduce((sum,row)=>sum+row.movement[0],0),dy=shifts.reduce((sum,row)=>sum+row.movement[1],0);
    const span=within.length>1?Math.max(...within)-Math.min(...within):0;
    if(input.status==='confirmed'&&(input.pattern==='common-translation'?shifts.length<3:span===0)) {
      throw new HttpError(422,'順次出現には異なる登場時刻、共通移動には3コマ以上の移動観測が必要です');
    }
    const record={id:`passage:${randomUUID()}`,kind:'motion-passage-review',origin:'manual',pattern:input.pattern,from,to,blockIds,starts:frames,
      status:input.status,candidateId:candidate.id,note:input.note,sourceSha256:project.source!.sha256,sourceRevision:project.revision,
      observationIds:[...new Set(evidence)],metrics:{roleCount:blockIds.length,...(input.pattern==='sequential-entry'?
        {entrySpanFrames:span,entrySpanSeconds:span/scene.fps,preexistingRoleCount:births.length-within.length}:
        {dxPx:dx,dyPx:dy,displacementRatio:Math.hypot(dx,dy)/scene.width})}};
    return {...commit(projectId,{baseRevision:input.baseRevision,actor:input.actor,note:'演出候補の判定を保存',
      documents:docs=>({...docs,observations:{...observations,[record.id]:record}})}),observation:record};
  }
  const accepted=reviews.find(item=>item.id===input.reviewId&&item.status==='confirmed');
  if(!accepted) throw new HttpError(422,'先に候補を確定してください');
  if(reviews.some(item=>item.candidateId===accepted.candidateId&&item.sourceRevision>accepted.sourceRevision)) {
    throw new HttpError(422,'この候補の最新の判定を使ってください');
  }
  const glyphs=textUnits({id:'replacement',type:'text',text:input.text}).filter(text=>!/^\s+$/u.test(text));
  if(glyphs.length!==accepted.blockIds.length) throw new HttpError(422,`この演出には${accepted.blockIds.length}文字を指定してください`);
  const from=accepted.from/scene.fps,to=accepted.to/scene.fps;
  const byId=new Map(scene.elements.map(element=>[element.id,element]));
  const additions:SceneElement[]=[];
  const ctx=createCanvas(1,1).getContext('2d');
  const originals=new Map<string,SceneElement>();
  for(const [index,blockId] of accepted.blockIds.entries()) {
    const block=design.blocks.items.find(item=>item.id===blockId),group=byId.get(blockId);
    const appearance=design.appearance.find(item=>item.blockId===blockId);
    if(!block||!group||!appearance||appearance.contours?.length||block.hiddenDuring?.some(gap=>gap.from<to&&gap.to>from)) {
      throw new HttpError(422,'欠測のない固定外観のブロックを指定してください');
    }
    let count=0;
    for(const childId of appearance.childIds) {
      const shape=byId.get(childId)!;
      const start=Math.max(from,resolveTime(group.inPoint??0,scene.tempo),resolveTime(shape.inPoint??0,scene.tempo));
      const end=Math.min(to,resolveTime(group.outPoint??scene.duration,scene.tempo),resolveTime(shape.outPoint??scene.duration,scene.tempo));
      if(end<=start) continue;
      if(!shape.width||!shape.height) throw new HttpError(422,`固定の寸法がありません: ${blockId}`);
      if(!isActive(group,scene,start)) throw new HttpError(422,'現在のブロックと判定の表示期間が一致しません');
      count++;
      const owner=`passage-anchor:${shape.id}`;
      additions.push({id:owner,type:'group',parentId:shape.parentId,inPoint:start,outPoint:end,transform:shape.transform,
        anchorX:shape.anchorX,anchorY:shape.anchorY});
      const child:SceneElement={id:`passage-text:${shape.id}`,type:'text',parentId:owner,inPoint:start,outPoint:end,
        text:glyphs[index],fontSize:100,fontFamily:'MLM Yu Gothic',fontWeight:700,fill:shape.fill,zIndex:shape.zIndex};
      ctx.font=fontSpec(child);ctx.textAlign='center';ctx.textBaseline='middle';
      const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=ctx.measureText(child.text!);
      if(!(l+r>0&&a+b>0)) throw new HttpError(422,'描画できる文字を指定してください');
      const sx=shape.width/(l+r),sy=shape.height/(a+b);
      child.transform={x:(l-r)*sx/2,y:(a-b)*sy/2,scaleX:sx,scaleY:sy,opacity:shape.transform?.opacity};
      additions.push(child);
      originals.set(childId,shape);
    }
    if(!count) throw new HttpError(422,`区間内に外観がありません: ${blockId}`);
  }
  const elements=scene.elements.flatMap(element=>{
    if(!originals.has(element.id)) return [element];
    const start=resolveTime(element.inPoint??0,scene.tempo),end=resolveTime(element.outPoint??scene.duration,scene.tempo);
    const before=start<from?[{...element,outPoint:from}]:[];
    const after=end>to?[{...element,id:before.length?`passage-after:${element.id}`:element.id,inPoint:to}]:[];
    return [...before,...after];
  });
  const next={...scene,elements:[...elements,...additions],markers:[...scene.markers??[],{t:from,kind:'note' as const,origin:'manual' as const,label:'差し替え開始'}]};
  return saveGeneratedProject(input.name,next,projectId,input.actor,{adaptation:{kind:'passage-role-substitution',sourceProjectId:projectId,
    sourceRevision:project.revision,sourceSha256:project.source!.sha256,reviewId:accepted.id,pattern:accepted.pattern,from,to,blockIds:accepted.blockIds,text:input.text}});
}
