import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { EaseSchema, sampleTrack, validateBlocking } from '@mlm/core';
import type { SceneElement, Transform } from '@mlm/core';
import { z } from 'zod';
import { getBlocking } from './blocking.ts';
import { saveGeneratedProject } from './modeling.ts';
import { contourObservation } from './representative.ts';
import { getDocuments, getProject, HttpError, projectDir, REPO_ROOT } from './store.ts';

const run=promisify(execFile);
const key=z.object({t:z.number(),value:z.number(),easing:EaseSchema});
const fitted=z.object({shapeFrame:z.number().int(),geometry:z.enum(['box','affine']),meanShapeIoU:z.number(),minShapeIoU:z.number(),members:z.array(z.string()).min(1),
  poses:z.array(z.object({shapeFrame:z.number().int(),fromFrame:z.number().int()})).min(1).max(4),
  tracks:z.object({x:z.array(key).min(1),y:z.array(key).min(1),scaleX:z.array(key).min(1),scaleY:z.array(key).min(1),
    rotation:z.array(key).min(1).optional(),shearX:z.array(key).min(1).optional()})});

export async function createSequenceModel(id:string,input:{baseRevision:number;actor:string},signal?:AbortSignal) {
  const start=performance.now();
  const {project,scene,design}=getBlocking(id);
  if(project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  if(!design||!project.source) throw new HttpError(422,'輪郭を計測したプロジェクトを指定してください');
  const observations=getDocuments(id).observations as Record<string,unknown>??{};
  const next=structuredClone(scene);
  const byId=new Map(next.elements.map(el=>[el.id,el]));
  const protectedIds=new Set(design.events.flatMap(event=>[...event.inputs,...event.outputs]));
  const cuts=new Set(design.events.filter(event=>event.kind==='cut'||event.kind==='invert').map(event=>Math.round(event.t*scene.fps)));
  const cutEvidence=z.object({inputs:z.object({cuts:z.array(z.number().int()).optional()})});
  const shapes=design.appearance.flatMap(binding=>{
    if(!binding.contours?.length) return [];
    const block=design.blocks.items.find(item=>item.id===binding.blockId)!;
    const group=byId.get(block.id)!;
    const child=byId.get(binding.childIds[0])!;
    if(group.parentId||group.anchorX||group.anchorY||Object.keys(group.transform??{}).some(key=>key!=='x'&&key!=='y') ||
      binding.childIds.length!==1||Object.keys(child.transform??{}).length||child.anchorX||child.anchorY) {
      throw new HttpError(422,`座標や外観を編集済みの輪郭があります。計測版を使ってください: ${block.id}`);
    }
    const boxes=new Map(block.observationIds.flatMap(key=>{
      const obs=contourObservation.safeParse(observations[key]);
      const options=cutEvidence.safeParse(observations[key]);
      if(options.success) options.data.inputs.cuts?.forEach(frame=>cuts.add(frame));
      return obs.success?obs.data.samples.map(sample=>[sample.frame,sample.box] as const):[];
    }));
    const locked=protectedIds.has(block.id)||!!block.hiddenDuring?.length||next.elements.some(el=>el.parentId===block.id&&el.id!==child.id);
    return [{id:block.id,block,binding,group,child,protected:locked,samples:binding.contours.map(shape=>{
      const frame=Math.round(shape.t*scene.fps),raw=boxes.get(frame);
      if(!raw||!shape.paths.length) throw new HttpError(422,`輪郭の座標がありません: ${block.id} ${frame}F`);
      const value=(track:Parameters<typeof sampleTrack>[0],fallback:number)=>sampleTrack(track,shape.t,fallback,scene.tempo);
      const width=value(block.extent.width,raw[2]),height=value(block.extent.height,raw[3]);
      const box=[value(group.transform?.x,raw[0]+raw[2]/2)+value(block.extent.cx,0)-width/2,
        value(group.transform?.y,raw[1]+raw[3]/2)+value(block.extent.cy,0)-height/2,width,height];
      if(width<=0||height<=0) throw new HttpError(422,`輪郭の寸法が不正です: ${block.id} ${frame}F`);
      return {...shape,frame,box};
    })}];
  });
  if(!shapes.length) throw new HttpError(422,'先に輪郭を計測してください');
  const scratch=await mkdtemp(path.join(projectDir(id),'cache','sequence-model-'));
  let model:Record<string,z.infer<typeof fitted>>;
  try {
    const work=path.join(REPO_ROOT,'workers','track');
    const python=process.env.MLM_TRACK_PYTHON??path.join(work,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const source=path.join(scratch,'observed.json'),target=path.join(scratch,'model.json');
    await writeFile(source,JSON.stringify({tracks:shapes.map(({id,samples,protected:locked})=>({id,samples,protected:locked})),cuts:[...cuts]}));
    await run(python,[path.join(work,'track','sequence_representative.py'),source,target],{windowsHide:true,timeout:180_000,signal});
    model=z.record(z.string(),fitted).parse(JSON.parse(await readFile(target,'utf8')));
  } catch(error) {
    signal?.throwIfAborted();
    throw new HttpError(422,'輪郭の固定形状化に失敗しました。workers/trackの環境を確認してください',String(error));
  } finally {await rm(scratch,{recursive:true,force:true});}
  signal?.throwIfAborted();
  if(getProject(id).project.revision!==input.baseRevision) throw new HttpError(409,'処理中に元のリビジョンが変わりました');

  const converted=new Map(shapes.map(shape=>[shape.id,shape]));
  const used=new Set<string>(),removedBlocks=new Set<string>(),removedElements=new Set<string>();
  const results=Object.entries(model).map(([id,result])=>{
    const entry=converted.get(id);
    const members=result.members.map(member=>converted.get(member));
    if(!entry||result.members[0]!==id||members.some(member=>!member||used.has(member.id)||result.members.length>1&&member.protected)) {
      throw new HttpError(422,`接続された軌道が不正です: ${id}`);
    }
    const {block,binding,group,child}=entry;
    const samples=members.flatMap(member=>{
      used.add(member!.id);
      if(member!.id!==id) {removedBlocks.add(member!.id);removedElements.add(member!.id);removedElements.add(member!.child.id);}
      return member!.samples;
    });
    if(samples.some((sample,i)=>i>0&&sample.frame<=samples[i-1].frame)) throw new HttpError(422,`軌道の時刻が重複しています: ${id}`);
    const shape=samples.find(row=>row.frame===result.shapeFrame);
    if(!shape) throw new HttpError(422,`代表形が見つかりません: ${id}`);
    const [, ,w,h]=shape.box;
    const width=Math.max(.01,w-1),height=Math.max(.01,h-1);
    const geometry=Object.fromEntries(Object.entries(result.tracks).map(([name,rows])=>{
      const keys=rows.map(row=>({t:row.t,v:row.value,ease:row.easing}));
      return [name,keys.every(row=>row.v===keys[0].v)?keys[0].v:{keys}];
    })) as Transform;
    group.transform=geometry;
    if(members.length>1) {
      group.outPoint=members.at(-1)!.group.outPoint;
      child.outPoint=group.outPoint;
      block.hiddenDuring=samples.flatMap((sample,i)=>i>0&&sample.frame-samples[i-1].frame>1?
        [{from:(samples[i-1].frame+1)/scene.fps,to:sample.t}]:[]);
      block.observationIds=[...new Set(members.flatMap(member=>member!.block.observationIds))];
    }
    const starts=result.poses.map(pose=>samples.findIndex(row=>row.frame===pose.fromFrame));
    if(starts[0]!==0||starts.some((index,i)=>i>0&&index<=starts[i-1])) throw new HttpError(422,`外観の区間が不正です: ${id}`);
    binding.childIds=result.poses.map((pose,index)=>{
      const appearance=samples.find(row=>row.frame===pose.shapeFrame);
      const end=starts[index+1]??samples.length;
      if(!appearance||!samples.slice(starts[index],end).includes(appearance)) throw new HttpError(422,`区間内の代表形が見つかりません: ${id}`);
      const shade=appearance.luma.toString(16).padStart(2,'0');
      const inPoint=index===0?group.inPoint:pose.fromFrame/scene.fps;
      const outPoint=samples[end]?.t??group.outPoint;
      const outline:SceneElement={...child,id:index===0?child.id:`${child.id}:pose:${index+1}`,inPoint,outPoint,
        outline:appearance.paths,fill:`#${shade.repeat(3)}`,width,height};
      if(index===0) Object.assign(child,outline);
      else {
        next.elements.push(outline);
        design.events.push({id:`${child.id}:shape:${index}`,kind:'shape',t:pose.fromFrame/scene.fps,label:`${block.label} 外観の切替`,
          status:'proposed',inputs:[id],outputs:[id],observationIds:[...block.observationIds]});
      }
      return outline.id;
    });
    binding.contours=undefined;
    block.extent={cx:0,cy:0,width,height};
    return {blockId:id,members:result.members,sampleCount:samples.length,shapeFrame:shape.frame,poses:result.poses,
      geometry:result.geometry,meanShapeIoU:result.meanShapeIoU,minShapeIoU:result.minShapeIoU};
  });
  if(used.size!==shapes.length) throw new HttpError(422,'一部の輪郭が変換結果にありません');
  next.elements=next.elements.filter(element=>!removedElements.has(element.id));
  design.blocks.items=design.blocks.items.filter(block=>!removedBlocks.has(block.id));
  design.appearance=design.appearance.filter(binding=>!removedBlocks.has(binding.blockId));
  design.events.sort((a,b)=>a.t-b.t);
  design.blocks.derived=true;
  design.blocks.measuredTo=undefined;
  validateBlocking(next,design);
  const simplification={kind:'sequence-representative',sourceProjectId:id,sourceRevision:project.revision,sourceSha256:project.source.sha256,
    method:'representative silhouette by normalized overlap; bounded transforms and optional affine fit',fits:results,elapsedSeconds:(performance.now()-start)/1000};
  const saved=saveGeneratedProject(`${project.name.slice(0,75)} · 全編の代表形`,next,id,input.actor,{...design,observations,simplification});
  return {...saved,design,simplification};
}
