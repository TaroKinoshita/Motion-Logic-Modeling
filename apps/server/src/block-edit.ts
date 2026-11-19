import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { isActive, resolveTime, sampleTrack, validateBlocking } from '@mlm/core';
import type { Blocking, Scene, Track } from '@mlm/core';
import { analyzeSequence, sequenceDesign } from './block-sequence.ts';
import { exportBlocking, getBlocking } from './blocking.ts';
import { commit, createProject, getDocuments, getProject, HttpError, trashProject } from './store.ts';
import {copyFile} from 'node:fs/promises';
import {sourcePath} from './media.ts';
import {spriteModel} from './sprite-model.ts';
import {createSequenceModel} from './sequence-model.ts';
import {joinTracks} from './track-join.ts';

const revision=z.number().int().positive();
const frame=z.number().int().nonnegative();
const head={baseRevision:revision,actor:z.string().min(1).max(40).default('human')};
export const SequenceRequest=z.strictObject({...head,from:frame.optional(),to:frame.optional(),
  region:z.tuple([frame,frame,revision,revision]).optional(),cuts:z.array(frame).max(300).optional(),ocrFrames:z.array(frame).max(100).optional(),
  blockId:z.string().optional(),engine:z.enum(['sprite','sequence-model']).optional(),profile:z.enum(['flat-color','framed-type','type-only']).optional(),
});
export const BlockExportRequest=z.strictObject(head);
export const EditBlockingRequest=z.strictObject({...head,edit:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('event'),id:z.string(),frame,label:z.string().min(1).max(120),
    status:z.enum(['proposed','confirmed','rejected']),beatRelative:z.boolean().optional()}),
  z.strictObject({kind:z.literal('add-event'),frame,label:z.string().min(1).max(120),blockId:z.string().optional()}),
  z.strictObject({kind:z.literal('box'),blockId:z.string(),frame,cx:z.number(),cy:z.number(),
    width:z.number().positive(),height:z.number().positive(),rotation:z.number().optional()}),
  z.strictObject({kind:z.literal('split'),blockId:z.string(),frame}),
  z.strictObject({kind:z.literal('join-tracks'),firstId:z.string().min(1),secondId:z.string().min(1)}),
  z.strictObject({kind:z.literal('text'),blockId:z.string(),text:z.string().trim().min(1).max(120),frame:frame.optional(),
    reading:z.string().trim().min(1).max(120).nullable().optional(),readingPosition:z.enum(['below','above','right']).optional(),
    rubySourceIds:z.array(z.string().min(1)).max(20).optional()}),
  z.strictObject({kind:z.literal('camera'),from:frame,to:frame}),
  z.strictObject({kind:z.literal('group'),blockIds:z.array(z.string()).min(2).max(20),label:z.string().min(1).max(120)}),
  z.strictObject({kind:z.literal('ungroup'),blockId:z.string()}),
])});

function checkRevision(current:number,expected:number) {
  if(current!==expected) throw new HttpError(409,'工程のリビジョンが変更されました。表示を更新してください');
}

function at(track:Track|undefined,scene:Scene,t:number,v:number):Track {
  if(track&&typeof track==='object'&&track.repeat) throw new HttpError(422,'反復トラックの上書きには通常のシーン編集を使ってください');
  const keys=typeof track==='object'?track.keys.filter(key=>Math.abs(resolveTime(key.t,scene.tempo)-t)>1e-8):[];
  return {keys:[...keys,{t,v}].sort((a,b)=>resolveTime(a.t,scene.tempo)-resolveTime(b.t,scene.tempo))};
}

function patchFrame(track:Track|undefined,scene:Scene,t:number,value:number,fallback=0) {
  let next=track;
  for(const neighbor of [t-1/scene.fps,t+1/scene.fps]) {
    if(neighbor<0||neighbor>=scene.duration) continue;
    if(typeof next==='object'&&next.keys.some(key=>Math.abs(resolveTime(key.t,scene.tempo)-neighbor)<1e-8)) continue;
    next=at(next,scene,neighbor,sampleTrack(track,neighbor,fallback,scene.tempo));
  }
  return at(next,scene,t,value);
}

export function editBlocking(id:string,input:z.infer<typeof EditBlockingRequest>) {
  const {scene,project,design:current}=getBlocking(id);
  checkRevision(project.revision,input.baseRevision);
  if(!current) throw new HttpError(404,'先に工程を解析してください');
  const design=structuredClone(current),edit=input.edit;
  const added:Record<string,unknown>={};
  const hasFrame='frame' in edit&&edit.frame!==undefined;
  const t=hasFrame?edit.frame!/scene.fps:0;
  if(hasFrame&&(t<design.blocks.from||t>=design.blocks.to)) throw new HttpError(422,'比較範囲内のフレームを指定してください');
  const block='blockId' in edit&&edit.blockId?design.blocks.items.find(entry=>entry.id===edit.blockId):undefined;
  if('blockId' in edit&&edit.blockId&&!block) throw new HttpError(404,'ブロックがありません');
  if(edit.kind==='join-tracks') {
    const joined=joinTracks(scene,design,edit.firstId,edit.secondId),observationId=`join:${randomUUID()}`;
    added[observationId]={id:observationId,kind:'track-join',origin:'manual',sourceRevision:project.revision,sourceSha256:project.source?.sha256,...joined};
    design.blocks.items.find(item=>item.id===joined.survivingId)!.observationIds.push(observationId);
  } else if(edit.kind==='group') {
    groupBlocks(scene,design,edit.blockIds,edit.label);
  } else if(edit.kind==='camera') {
    const derived=attachCamera(scene,design,getDocuments(id).observations as Record<string,unknown>??{},edit.from,edit.to);
    added[derived.id]=derived;
  } else if(edit.kind==='event') {
    const event=design.events.find(entry=>entry.id===edit.id);
    if(!event) throw new HttpError(404,'出来事がありません');
    const until=event.until===undefined?undefined:Math.min(design.blocks.to,event.until+t-event.t);
    Object.assign(event,{t,until,label:edit.label,status:edit.status,beatRelative:edit.beatRelative});
  } else if(edit.kind==='add-event') {
    design.events.push({id:randomUUID(),kind:'contact',t,label:edit.label,status:'proposed',inputs:block?[block.id]:[],outputs:[],observationIds:[]});
  } else if(block) {
    const group=scene.elements.find(el=>el.id===block.id)!;
    const appearance=design.appearance.find(binding=>binding.blockId===block.id);
    if(edit.kind==='ungroup') {
      if(!block.members) throw new HttpError(422,'まとめたブロックを選んでください');
      const members=block.members;
      if(group.transform?.rotation||group.transform?.scaleX||group.transform?.scaleY) throw new HttpError(422,'回転・拡縮を外してからまとめを解除してください');
      for(const child of scene.elements.filter(el=>members.includes(el.id))) {
        const x=child.transform?.x,y=child.transform?.y;
        const times=new Set<number>();
        for(const track of [x,y,group.transform?.x,group.transform?.y]) {
          if(typeof track==='object') for(const key of track.keys) times.add(resolveTime(key.t,scene.tempo));
        }
        if(!times.size) times.add(0);
        const sum=(a:Track|undefined,b:Track|undefined)=>({keys:[...times].sort((a,b)=>a-b).map(t=>({t,
          v:sampleTrack(a,t,0,scene.tempo)+sampleTrack(b,t,0,scene.tempo)}))});
        child.transform={...child.transform,x:sum(x,group.transform?.x),y:sum(y,group.transform?.y)};
        child.parentId=group.parentId;
      }
      scene.elements=scene.elements.filter(el=>el.id!==block.id);
      design.blocks.items=design.blocks.items.filter(item=>item.id!==block.id);
      const replace=(ids:string[])=>[...new Set(ids.flatMap(id=>id===block.id?members:[id]))];
      for(const event of design.events) {event.inputs=replace(event.inputs);event.outputs=replace(event.outputs);}
    } else if(edit.kind==='box') {
      if(!isActive(group,scene,t)) throw new HttpError(422,'表示中のフレームで修正してください');
      group.transform={...group.transform,x:patchFrame(group.transform?.x,scene,t,edit.cx),y:patchFrame(group.transform?.y,scene,t,edit.cy)};
      if(edit.rotation!==undefined) group.transform.rotation=patchFrame(group.transform.rotation,scene,t,edit.rotation);
      block.extent.width=patchFrame(block.extent.width,scene,t,edit.width);
      block.extent.height=patchFrame(block.extent.height,scene,t,edit.height);
    } else if(edit.kind==='split') {
      if(block.members||design.blocks.items.some(item=>item.members?.includes(block.id))) throw new HttpError(422,'まとめたブロックは個別に分割できません。まとめる前の履歴に戻してから分割してください');
      const inPoint=resolveTime(group.inPoint??0,scene.tempo),outPoint=resolveTime(group.outPoint??scene.duration,scene.tempo);
      if(!(inPoint<t&&t<outPoint)) throw new HttpError(422,'表示区間の途中で分割してください');
      const newId=`track:${randomUUID()}`;
      scene.elements.push({...structuredClone(group),id:newId,inPoint:t,name:`${block.label}（後半）`});
      group.outPoint=t;
      const gaps=block.hiddenDuring??[];
      block.hiddenDuring=gaps.filter(gap=>gap.from<t).map(gap=>({...gap,to:Math.min(t,gap.to)}));
      design.blocks.items.push({...structuredClone(block),id:newId,hiddenDuring:gaps.filter(gap=>gap.to>t).map(gap=>({...gap,from:Math.max(t,gap.from)}))});
      if(appearance) {
        const childIds=appearance.childIds.flatMap(childId=>{
          const child=scene.elements.find(el=>el.id===childId)!;
          const begin=resolveTime(child.inPoint??inPoint,scene.tempo),end=resolveTime(child.outPoint??outPoint,scene.tempo);
          if(end<=t) return [];
          if(begin>=t) {
            child.parentId=newId;
            return [childId];
          }
          const next={...structuredClone(child),id:`${newId}:${childId}`,parentId:newId,inPoint:t};
          child.outPoint=t;
          scene.elements.push(next);
          return [next.id];
        });
        appearance.childIds=appearance.childIds.filter(id=>scene.elements.find(el=>el.id===id)?.parentId===block.id);
        const contours=appearance.contours?.filter(sample=>sample.t>=t);
        if(appearance.contours) appearance.contours=appearance.contours.filter(sample=>sample.t<t);
        if(childIds.length) design.appearance.push({blockId:newId,childIds,contours});
        if(!appearance.childIds.length) design.appearance=design.appearance.filter(binding=>binding!==appearance);
      }
      for(const event of design.events) {
        if(event.t>=t) event.outputs=event.outputs.map(id=>id===block.id?newId:id);
        if(event.t>t) event.inputs=event.inputs.map(id=>id===block.id?newId:id);
      }
    } else if(edit.kind==='text') {
      const available=appearance&&scene.elements.filter(el=>appearance.childIds.includes(el.id));
      const shown=available?.length===1?available:available?.filter(el=>hasFrame&&isActive(el,scene,t));
      if(available&&available.length>1&&shown?.length!==1) throw new HttpError(422,'外観が一つ表示されるコマを指定してください');
      const child=shown?.[0];
      if(!appearance||!child) throw new HttpError(422,'外観を割り当てる子要素がありません');
      const start=resolveTime(group.inPoint??0,scene.tempo);
      const from=Math.max(design.blocks.from,start,resolveTime(child.inPoint??start,scene.tempo));
      const until=Math.min(design.blocks.to,resolveTime(group.outPoint??scene.duration,scene.tempo),resolveTime(child.outPoint??scene.duration,scene.tempo));
      const hiddenRuby=[...new Set(edit.rubySourceIds??[])];
      for(const id of hiddenRuby) {
        const rubyBlock=design.blocks.items.find(item=>item.id===id);
        const owner=scene.elements.find(el=>el.id===id);
        if(id===block.id||!rubyBlock||!owner||rubyBlock.members) throw new HttpError(422,'独立した旧ルビのブロックを指定してください');
        const lo=Math.max(from,resolveTime(owner.inPoint??0,scene.tempo));
        const hi=Math.min(until,resolveTime(owner.outPoint??scene.duration,scene.tempo));
        if(hi<=lo) throw new HttpError(422,'旧ルビの表示期間が本文と重なっていません');
        rubyBlock.hiddenDuring=[...rubyBlock.hiddenDuring??[],{from:lo,to:hi}];
      }
      const previousReading=child.ruby;
      const ink=appearance.contours?.[0]?.luma;
      const fixed=!appearance.contours?.length&&child.width!==undefined&&child.height!==undefined;
      const fill=fixed?child.fill:ink!==undefined&&ink>=128?'#eeeeee':'#242424';
      const fontSize=fixed?100:Math.max(10,sampleTrack(block.extent.height,start,60,scene.tempo));
      if(fixed) {
        const ctx=createCanvas(1,1).getContext('2d');
        ctx.font=`700 ${fontSize}px "MLM Yu Gothic"`;
        ctx.textAlign='center';
        ctx.textBaseline='middle';
        const {actualBoundingBoxLeft:left,actualBoundingBoxRight:right,actualBoundingBoxAscent:top,actualBoundingBoxDescent:bottom}=ctx.measureText(edit.text);
        if(!(left+right>0&&top+bottom>0)) throw new HttpError(422,'描画できる文字を指定してください');
        const scaleX=child.width!/(left+right),scaleY=child.height!/(top+bottom);
        // Keep the nominal center across successive substitutions.
        const x=sampleTrack(block.extent.cx,start,0,scene.tempo);
        const y=sampleTrack(block.extent.cy,start,0,scene.tempo);
        child.transform={opacity:child.transform?.opacity,x:x+(left-right)*scaleX/2,y:y+(top-bottom)*scaleY/2,scaleX,scaleY};
      }
      Object.assign(child,{type:'text',text:edit.text,fontFamily:'MLM Yu Gothic',fontWeight:700,fill,
        fontSize,outline:undefined,vector:undefined,ruby:edit.reading??undefined,
        rubyPosition:edit.reading?edit.readingPosition??child.rubyPosition:undefined});
      appearance.contours=undefined;
      if(appearance.childIds.length===1) block.label=edit.text;
      else child.name=edit.text;
      const evidence= `reading:${randomUUID()}`;
      added[evidence]={id:evidence,kind:fixed?'appearance-substitution':'glyph-reading',origin:'manual',blockId:block.id,text:edit.text,sourceSha256:project.source?.sha256,
        sourceRevision:project.revision,frame:edit.frame,childId:child.id,previousObservations:[...block.observationIds],
        reading:edit.reading,readingPosition:child.rubyPosition,
        readingStatus:edit.reading===null?'removed':edit.reading?'confirmed':'needs-review',previousReading,hiddenRuby};
      block.observationIds.push(evidence);
    }
  }
  design.events.sort((a,b)=>a.t-b.t);
  try {validateBlocking(scene,design);} catch(error) {throw new HttpError(422,String(error));}
  return {...commit(id,{...headInput(input),note:'工程比較を編集',scene:()=>scene,
    documents:documents=>({...documents,...design,observations:{...documents.observations as object,...added}})}),design};
}

function groupBlocks(scene:Scene,design:Blocking,ids:string[],label:string) {
  const blocks=ids.map(id=>design.blocks.items.find(block=>block.id===id));
  const elements=ids.map(id=>scene.elements.find(el=>el.id===id));
  if(new Set(ids).size!==ids.length||blocks.some(block=>!block||block.members)||elements.some(el=>!el||el.parentId!==elements[0]?.parentId)) {
    throw new HttpError(422,'同じ親を持つ別々のブロックを選んでください');
  }
  if(design.blocks.items.some(block=>block.members?.some(member=>ids.includes(member)))) throw new HttpError(422,'すでにまとめられたブロックはこの操作の対象外です');
  const current=elements.map(el=>el!);
  const from=Math.min(...current.map(el=>resolveTime(el.inPoint??0,scene.tempo)));
  const to=Math.max(...current.map(el=>resolveTime(el.outPoint??scene.duration,scene.tempo)));
  const coordinates:{t:number;x:number;y:number;width:number;height:number}[]=[];
  const id=`group:${randomUUID()}`;
  for(let frame=Math.ceil(from*scene.fps-1e-8);frame/scene.fps<to;frame++) {
    const t=frame/scene.fps;
    const value=(track:Track|undefined)=>sampleTrack(track,t,0,scene.tempo);
    const boxes=current.flatMap((el,i)=>{
      if(!isActive(el,scene,t)||blocks[i]!.hiddenDuring?.some(gap=>gap.from<=t&&t<gap.to)) return [];
      const b=blocks[i]!.extent;
      const x=value(el.transform?.x)+value(b.cx),y=value(el.transform?.y)+value(b.cy);
      const w=value(b.width),h=value(b.height);
      return [{left:x-w/2,right:x+w/2,top:y-h/2,bottom:y+h/2}];
    });
    if(!boxes.length) {
      if(coordinates.length) coordinates.push({...coordinates.at(-1)!,t,width:0,height:0});
      continue;
    }
    const left=Math.min(...boxes.map(box=>box.left)),right=Math.max(...boxes.map(box=>box.right));
    const top=Math.min(...boxes.map(box=>box.top)),bottom=Math.max(...boxes.map(box=>box.bottom));
    coordinates.push({t,x:(left+right)/2,y:(top+bottom)/2,width:right-left,height:bottom-top});
  }
  if(!coordinates.length) throw new HttpError(422,'共通の表示範囲で位置を取れるブロックを選んでください');
  const track=(field:'x'|'y'|'width'|'height')=>({keys:coordinates.map(row=>({t:row.t,v:row[field]}))});
  const x=track('x'),y=track('y');
  scene.elements.push({id,name:label,type:'group',parentId:current[0].parentId,inPoint:from,outPoint:to,transform:{x,y}});
  for(const el of current) {
    el.parentId=id;
    const subtract=(field:'x'|'y',parent:Track)=>({keys:coordinates.map(({t})=>({t,
      v:sampleTrack(el.transform?.[field],t,0,scene.tempo)-sampleTrack(parent,t,0,scene.tempo)}))});
    el.transform={...el.transform,x:subtract('x',x),y:subtract('y',y)};
  }
  design.blocks.items.push({id,label,color:blocks[0]!.color,extent:{cx:0,cy:0,width:track('width'),height:track('height')},
    members:ids,observationIds:[...new Set(blocks.flatMap(block=>block!.observationIds))]});
}

function attachCamera(scene:Scene,design:Blocking,observations:Record<string,unknown>,from:number,to:number) {
  const schema=z.object({id:z.string(),kind:z.literal('camera-candidate'),frame:z.number().int(),
    movement:z.tuple([z.number(),z.number()]),support:z.number().int().min(3),medianResidual:z.number().nonnegative()});
  const entries=Object.values(observations).flatMap(value=>{
    const parsed=schema.safeParse(value);
    return parsed.success&&parsed.data.frame>from&&parsed.data.frame<to?[parsed.data]:[];
  }).sort((a,b)=>a.frame-b.frame);
  if(to-from<4||entries.length!==to-from-1||entries.some((entry,i)=>entry.frame!==from+i+1)) throw new HttpError(422,'共通移動の候補が連続する4コマ以上の区間を選んでください');
  const dt=1/scene.fps;
  const ids=new Set(design.blocks.items.map(block=>block.id));
  const roots=scene.elements.filter(el=>ids.has(el.id)&&!el.parentId&&resolveTime(el.inPoint??0,scene.tempo)<to*dt&&resolveTime(el.outPoint??scene.duration,scene.tempo)>from*dt);
  if(roots.length<3) throw new HttpError(422,'3つ以上の画面座標のブロックを含む区間が必要です');
  const cameraId=`camera:${randomUUID()}`;
  const translate=(axis:0|1)=>{
    let position=0;
    return {keys:[{t:from*dt,v:0},...entries.map(entry=>({t:entry.frame*dt,v:position+=entry.movement[axis]}))]};
  };
  const camera={x:translate(0),y:translate(1)};
  scene.elements.push({id:cameraId,type:'group',name:`共通移動 ${from}–${to-1}F`,transform:camera});
  for(const root of roots) {
    const start=resolveTime(root.inPoint??0,scene.tempo);
    const end=resolveTime(root.outPoint??scene.duration,scene.tempo);
    const times=new Set<number>([start,end]);
    for(let index=Math.ceil(start*scene.fps);index/scene.fps<end;index++) times.add(index/scene.fps);
    const subtract=(axis:'x'|'y')=>({keys:[...times].sort((a,b)=>a-b).map(t=>({t,
      v:sampleTrack(root.transform?.[axis],t,0,scene.tempo)-sampleTrack(camera[axis],t,0,scene.tempo)}))});
    root.transform={...root.transform,x:subtract('x'),y:subtract('y')};
    root.parentId=cameraId;
  }
  return {id:cameraId,kind:'camera-confirmed',origin:'manual',from,to,observationIds:entries.map(entry=>entry.id),blocks:roots.map(el=>el.id)};
}

const headInput=(input:{actor:string;baseRevision:number})=>({actor:input.actor,baseRevision:input.baseRevision});

type SequenceInput=z.infer<typeof SequenceRequest>;
type Job={
  id:string;projectId:string;state:'queued'|'measuring'|'saving'|'exporting'|'done'|'cancelled'|'failed';
  operation:'measure'|'export';
  revision?:number;error?:string;progress?:number;updatedAt:number;controller:AbortController;input:SequenceInput;
  output?:Awaited<ReturnType<typeof exportBlocking>>;
  resultProjectId?:string;
};
const jobs=new Map<string,Job>();
const jobStatus=({controller:_,input:__,...status}:Job)=>status;
export function getBlockJob(projectId:string,id:string) {
  const job=jobs.get(id);
  if(!job||job.projectId!==projectId) throw new HttpError(404,'解析ジョブがありません');
  return job;
}
export function blockJobStatus(projectId:string,id:string) {return jobStatus(getBlockJob(projectId,id));}
export function latestBlockJob(projectId:string) {
  const job=[...jobs.values()].filter(job=>job.projectId===projectId).at(-1);
  return {job:job?jobStatus(job):null};
}
export function cancelBlockJob(projectId:string,id:string) {
  const job=getBlockJob(projectId,id);
  job.controller.abort();
  return jobStatus(job);
}
export function retryBlockJob(projectId:string,id:string) {
  const previous=getBlockJob(projectId,id);
  if(previous.state!=='failed'&&previous.state!=='cancelled') throw new HttpError(409,'失敗または中断した解析を選んでください');
  return previous.operation==='export'?startBlockExport(projectId,previous.input):startBlockJob(projectId,previous.input);
}

export function startBlockJob(id:string,input:SequenceInput) {
  const {project,scene,design}=getBlocking(id);
  checkRevision(project.revision,input.baseRevision);
  if(input.engine==='sequence-model') {
    if(!design?.appearance.some(binding=>binding.contours?.length)) throw new HttpError(422,'先に輪郭を計測してください');
    return schedule(id,input,'measure',async job=>{
      job.state='measuring';
      const saved=await createSequenceModel(id,input,job.controller.signal);
      job.revision=saved.project.revision;
      job.resultProjectId=saved.project.id;
    });
  }
  if(input.engine==='sprite') {
    const {from,to,region}=input;
    if(from===undefined||to===undefined||!region) throw new HttpError(422,'Fast Spriteの区間と開始フレームの領域を指定してください');
    return schedule(id,input,'measure',async job=>{
      job.state='measuring';
      const next=await spriteModel(project,scene,{from,to,region},job.controller.signal);
      job.controller.signal.throwIfAborted();
      checkRevision(getProject(id).project.revision,input.baseRevision);
      job.state='saving';
      const created=createProject(`${project.name.slice(0,75)} · Fast Sprite`,next.scene,input.actor);
      try {
        await copyFile(sourcePath(project),sourcePath({...created.project,source:project.source}));
        const saved=commit(created.project.id,{baseRevision:created.project.revision,actor:input.actor,note:'Fast SpriteとVTracerの代表形・変形を保存',
          meta:meta=>{meta.source=project.source;meta.audioAnalysis=project.audioAnalysis;},documents:()=>({...next.design,observations:next.observations})});
        job.revision=saved.project.revision;
        job.resultProjectId=saved.project.id;
      } catch(error) {trashProject(created.project.id,input.actor);throw error;}
    });
  }
  if(design&&!input.blockId) throw new HttpError(409,'工程がある場合は再計測するブロックを指定してください');
  if(input.blockId&&(!design?.blocks.items.some(item=>item.id===input.blockId)||!input.region)) throw new HttpError(422,'対象ブロックと計測範囲が必要です');
  return schedule(id,input,'measure',async job=>{
      job.state='measuring';
      const raw=await analyzeSequence(project,input,job.controller.signal,progress=>{job.progress=progress;});
      job.controller.signal.throwIfAborted();
      job.state='saving';
      checkRevision(getProject(id).project.revision,input.baseRevision);
      const next=sequenceDesign(project,scene,raw,input);
      if(input.blockId&&design) refine(scene,design,input.blockId,next);
      const saved=commit(id,{...headInput(input),note:'輪郭と動きを計測',scene:()=>input.blockId?scene:next.scene,
        documents:docs=>({...docs,...(input.blockId?design:next.design),observations:{...docs.observations as object,...next.observations}})});
      job.revision=saved.project.revision;
  });
}

export function startBlockExport(id:string,input:z.infer<typeof BlockExportRequest>) {
  const {project,design}=getBlocking(id);
  checkRevision(project.revision,input.baseRevision);
  if(!design) throw new HttpError(422,'書き出す工程比較がありません');
  return schedule(id,input,'export',async job=>{
    job.state='exporting';
    job.output=await exportBlocking(id,960,job.controller.signal,progress=>{job.progress=progress;});
    job.revision=job.output.revision;
  });
}

function schedule(id:string,input:SequenceInput,operation:Job['operation'],work:(job:Job)=>Promise<void>) {
  const active=(job:Job)=>['queued','measuring','saving','exporting'].includes(job.state);
  for(const [key,job] of jobs) {
    if(Date.now()-job.updatedAt>3_600_000&&!active(job)) jobs.delete(key);
    if(job.projectId===id&&active(job)) throw new HttpError(409,'同じプロジェクトで解析または書き出しを実行中です');
    if(input.engine==='sprite'&&job.input.engine==='sprite'&&active(job)) throw new HttpError(409,'GPUで別のFast Sprite処理を実行中です');
  }
  const job:Job={id:randomUUID(),projectId:id,state:'queued',operation,updatedAt:Date.now(),controller:new AbortController(),input};
  jobs.set(job.id,job);
  queueMicrotask(async()=>{
    try {
      job.controller.signal.throwIfAborted();
      await work(job);
      job.state='done';
    } catch(error) {
      job.state=job.controller.signal.aborted?'cancelled':'failed';
      if(job.state==='failed') job.error=error instanceof HttpError&&error.detail? `${error.message}\n${String(error.detail)}` :
        error instanceof Error?error.message:String(error);
    } finally {job.updatedAt=Date.now();}
  });
  return jobStatus(job);
}

function refine(scene:Scene,design:Blocking,id:string,next:ReturnType<typeof sequenceDesign>) {
  const group=scene.elements.find(el=>el.id===id)!;
  if(group.parentId) throw new HttpError(422,'再計測は画面座標のブロックを選んでください');
  const target=design.blocks.items.find(item=>item.id===id)!;
  const binding=design.appearance.find(item=>item.blockId===id);
  if(!binding?.contours?.length) throw new HttpError(422,'輪郭付きの外観を指定してください');
  const frame=1/scene.fps;
  const from=next.design.blocks.from,to=next.design.blocks.to;
  const frames=binding.contours.filter(sample=>sample.t>=from-1e-8&&sample.t<to-1e-8);
  const score=(binding:Blocking['appearance'][number])=>{
    const candidate=next.scene.elements.find(el=>el.id===binding.blockId)!;
    return binding.contours!.reduce((total,sample)=>{
      if(!frames.some(old=>Math.abs(old.t-sample.t)<frame/2)) return total;
      const gap=Math.hypot(sampleTrack(group.transform?.x,sample.t,0,scene.tempo)-sampleTrack(candidate.transform?.x,sample.t,0,scene.tempo),
        sampleTrack(group.transform?.y,sample.t,0,scene.tempo)-sampleTrack(candidate.transform?.y,sample.t,0,scene.tempo));
      return total+Math.max(0,1-gap/Math.max(12,sampleTrack(target.extent.width,sample.t,0,scene.tempo)));
    },0);
  };
  const source=next.design.appearance.map(binding=>({binding,score:score(binding)})).sort((a,b)=>b.score-a.score)[0];
  if(!frames.length||source.score<frames.length*.65) throw new HttpError(422,'元の軌道と重なりのある一つのブロックを選んでください');
  const fresh=next.design.blocks.items.find(item=>item.id===source.binding.blockId)!;
  const freshGroup=next.scene.elements.find(el=>el.id===source.binding.blockId)!;
  const kept=source.binding.contours!.filter(sample=>frames.some(old=>Math.abs(old.t-sample.t)<frame/2));
  const replaceAt=(original:Track|undefined,incoming:Track|undefined)=>{
    let result=original;
    for(const sample of kept) result=patchFrame(result,scene,sample.t,sampleTrack(incoming,sample.t,0,scene.tempo));
    return result;
  };
  group.transform={...group.transform,x:replaceAt(group.transform?.x,freshGroup.transform?.x),y:replaceAt(group.transform?.y,freshGroup.transform?.y)};
  target.extent.width=replaceAt(target.extent.width,fresh.extent.width)!;
  target.extent.height=replaceAt(target.extent.height,fresh.extent.height)!;
  target.observationIds.push(...fresh.observationIds);
  binding.contours=binding.contours.map(sample=>kept.find(row=>Math.abs(row.t-sample.t)<frame/2)??sample);
  validateBlocking(scene,design);
}
