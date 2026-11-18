import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { BlockingSchema, blockingFrame, resolveTime, sampleTrack, validateBlocking } from '@mlm/core';
import { getBlocking, exportBlocking } from '../apps/server/src/blocking.ts';
import { startBlockJob, blockJobStatus, editBlocking, EditBlockingRequest, SequenceRequest } from '../apps/server/src/block-edit.ts';
import { exportVideo } from '../apps/server/src/export.ts';
import { sourcePath } from '../apps/server/src/media.ts';
import { saveGeneratedProject } from '../apps/server/src/modeling.ts';
import { renderSheet } from '../apps/server/src/render.ts';
import { getDocuments, getProject, getRevisionSnapshot, REPO_ROOT, trashProject } from '../apps/server/src/store.ts';

const [id, earlier, outputPath] = process.argv.slice(2);
if (!id || !earlier || !outputPath) throw new Error('Supply the source project ID, previous phase report and output folder');
const output=path.resolve(outputPath);
await fs.mkdir(output,{recursive:true});
const input=getBlocking(id);
const prior=JSON.parse(await fs.readFile(earlier,'utf8'));
assert.equal(prior.reference,id);
assert.equal(input.project.source.frameCount,183);
const actor='full-sequence-verification';
const stale={baseRevision:input.project.revision+1,actor,engine:'sequence-model'};
assert.throws(()=>startBlockJob(id,SequenceRequest.parse(stale)),error=>error.status===409);
const job=startBlockJob(id,SequenceRequest.parse({...stale,baseRevision:input.project.revision}));
let status;
for(let n=0;n<1000;n++) {
  status=blockJobStatus(id,job.id);
  if(['done','failed','cancelled'].includes(status.state)) break;
  await pause(200);
}
assert.equal(status.state,'done',status.error);
assert.equal(getProject(id).project.revision,input.project.revision);
const automatic=getBlocking(status.resultProjectId);
const docs=getDocuments(automatic.project.id);
assert.ok(automatic.design.appearance.every(binding=>binding.contours===undefined));
assert.deepEqual(automatic.design.events.filter(event=>event.kind!=='shape'),input.design.events);

const scene=structuredClone(automatic.scene),design=structuredClone(automatic.design);
const observations={...docs.observations};
const applied=[];
const overlay=(snapshotKey,oldIds,eventUpdates,prepare)=>{
  const {projectId,revision}=prior[snapshotKey];
  const {snapshot}=getRevisionSnapshot(projectId,revision);
  assert.equal(snapshot.media.source.sha256,input.project.source.sha256);
  const selected=BlockingSchema.parse(snapshot.documents);
  const replacement=prepare?prepare(snapshot.scene,selected):snapshot.scene.elements;
  assert.ok(selected.appearance.every(binding=>binding.contours===undefined));
  const replaced=new Set(oldIds.map(number=>`track:lyrics:${number}`));
  const erased=docs.simplification.fits.filter(fit=>fit.members.some(member=>replaced.has(member)));
  assert.ok(erased.every(fit=>fit.members.every(member=>replaced.has(member))),`${snapshotKey} crosses another fitted track`);
  const removed=new Set(erased.map(fit=>fit.blockId));
  const children=new Set(design.appearance.filter(binding=>removed.has(binding.blockId)).flatMap(binding=>binding.childIds));
  scene.elements=scene.elements.filter(el=>!removed.has(el.id)&&!children.has(el.id)).concat(replacement);
  design.blocks.items=design.blocks.items.filter(block=>!removed.has(block.id)).concat(selected.blocks.items);
  design.appearance=design.appearance.filter(binding=>!removed.has(binding.blockId)).concat(selected.appearance);
  const updates=new Map(selected.events.map(event=>[event.id,event]));
  design.events=design.events.filter(event=>event.kind!=='shape'||!event.inputs.some(ref=>removed.has(ref)))
    .map(event=>eventUpdates.includes(event.id)?updates.get(event.id):event);
  design.events.push(...selected.events.filter(event=>!design.events.some(old=>old.id===event.id)));
  design.events.sort((a,b)=>a.t-b.t);
  Object.assign(observations,snapshot.documents.observations);
  applied.push({projectId,revision,from:selected.blocks.from,to:selected.blocks.to,replaced:[...replaced]});
};
overlay('contact',[1,4,9,10],['kaku-contact','kaku-separation'],(reviewed,selection)=>{
  const fps=scene.fps;
  const layer=(stage,model,number,from,to)=>{
    const id=`track:lyrics:${number}`;
    const parent=stage.elements.find(el=>el.id===id);
    const binding=model.appearance.find(item=>item.blockId===id);
    const children=binding.childIds.map(child=>stage.elements.find(el=>el.id===child));
    return {parent,children,from:from/fps,to:to/fps,width:children[0].width,height:children[0].height,tempo:stage.tempo};
  };
  const before=layer(scene,design,1,3,15),after=layer(scene,design,9,16,27);
  const atContact=layer(reviewed,selection,1,15,16);
  const otherAtContact=layer(reviewed,selection,10,15,16),otherAfter=layer(scene,design,10,16,27);
  const combine=(layers,base)=>{
    const {id}=base.parent;
    const fields=['x','y','scaleX','scaleY','shearX','rotation'];
    const keysFor=(column,part)=>{
      const previous=part.parent.transform?.[column];
      const factor=column==='scaleX'?part.width/base.width:column==='scaleY'||column==='shearX'?part.height/base.height:1;
      const fallback=column.startsWith('scale')?1:0;
      const times=new Map([[part.from,{t:part.from,v:sampleTrack(previous,part.from,fallback,part.tempo)*factor}]]);
      if(previous?.keys) for(const key of previous.keys) {
        const t=resolveTime(key.t,part.tempo);
        if(t>=part.from&&t<part.to) times.set(t,{...key,t,v:key.v*factor});
      }
      const result=[...times.values()].sort((a,b)=>a.t-b.t);
      result.at(-1).ease='hold';
      return result;
    };
    const parent={...base.parent,id,inPoint:layers[0].from,outPoint:layers.at(-1).to,
      transform:Object.fromEntries(fields.map(field=>{
        const keys=layers.flatMap(part=>keysFor(field,part));
        return [field,keys.every(key=>key.v===keys[0].v)?keys[0].v:{keys}];
      }))};
    const children=layers.flatMap(part=>part.children.flatMap(child=>{
      const inPoint=Math.max(part.from,resolveTime(child.inPoint??part.from,part.tempo));
      const outPoint=Math.min(part.to,resolveTime(child.outPoint??part.to,part.tempo));
      if(inPoint>=outPoint) return [];
      assert.ok(!child.transform);
      return [{...child,id:`${id}:shape:${Math.round(inPoint*fps)}`,parentId:id,inPoint,outPoint,width:base.width,height:base.height}];
    }));
    const binding=selection.appearance.find(item=>item.blockId===id);
    binding.childIds=children.map(child=>child.id);
    const block=selection.blocks.items.find(item=>item.id===id);
    block.extent={cx:0,cy:0,width:base.width,height:base.height};
    for(const child of children.slice(1)) {
      if(child.inPoint===15/fps||child.inPoint===16/fps) continue;
      selection.events.push({id:`${child.id}:event`,kind:'shape',t:child.inPoint,label:`${block.label} 外観の切替`,status:'proposed',
        inputs:[id],outputs:[id],observationIds:[...block.observationIds]});
    }
    return [parent,...children];
  };
  return [...combine([before,atContact,after],before),...combine([otherAtContact,otherAfter],otherAfter)];
});
overlay('rotation',[162,163,165,166,167,168,169,170],[]);
validateBlocking(scene,design);
assert.equal(design.blocks.to,input.scene.duration);
assert.ok(design.appearance.every(binding=>!binding.contours));
const combined=saveGeneratedProject('Lyricsample1 · 全編モデル（接触・回転を適用）',scene,id,actor,
  {...design,observations,simplification:{...docs.simplification,reviewedIntervals:applied}});
const testEdition=saveGeneratedProject('Lyricsample1 · 外観差し替え検証',scene,id,actor,{...design,observations});
try {
  const blockId='track:lyrics:1';
  const body={baseRevision:testEdition.project.revision,actor,edit:{kind:'text',blockId,text:'右',frame:6}};
  assert.throws(()=>editBlocking(testEdition.project.id,EditBlockingRequest.parse({...body,edit:{...body.edit,frame:undefined}})),error=>error.status===422);
  const edited=editBlocking(testEdition.project.id,EditBlockingRequest.parse(body));
  assert.deepEqual(edited.scene.elements.find(el=>el.id===blockId),scene.elements.find(el=>el.id===blockId));
  const children=edited.scene.elements.filter(el=>el.parentId===blockId);
  assert.equal(children.filter(el=>el.type==='text').length,1);
  const replacement=children.find(el=>el.type==='text');
  assert.equal(replacement.text,'右');
  assert.ok(replacement.inPoint<=6/scene.fps&&replacement.outPoint>6/scene.fps);
  assert.ok(children.some(el=>el.outline&&el.inPoint===15/scene.fps));
} finally {trashProject(testEdition.project.id,actor);}

const films={};
for(const [name,state,blocking] of [['trace',input,input.design],['automatic',automatic,automatic.design],['combined',combined,design]]) {
  const movie=await exportVideo(state.project,state.scene,{from:0,to:input.scene.duration,width:960,withAudio:true,layout:'render',
    outputTag:'full-sequence',sceneAt:t=>blockingFrame(state.scene,blocking,t,'final')});
  const file=path.join(output,`${name}.mp4`);
  await fs.copyFile(movie.path,file);
  films[name]=file;
}
const grid=await exportBlocking(combined.project.id,960);
const comparison=path.join(output,'full_comparison.mp4');
await fs.copyFile(grid.path,comparison);
for(const file of [...Object.values(films),comparison]) {
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,nb_read_frames,avg_frame_rate','-of','json',file],{encoding:'utf8'}));
  assert.equal(Number(probe.streams.find(stream=>stream.codec_type==='video').nb_read_frames),183,file);
  assert.equal(probe.streams.find(stream=>stream.codec_type==='video').avg_frame_rate,'24/1',file);
  assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'),file);
}
const worker=path.join(REPO_ROOT,'workers','track');
const python=process.env.MLM_TRACK_PYTHON??path.join(worker,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const measured=(before,after)=>JSON.parse(execFileSync(python,[path.join(REPO_ROOT,'scripts','measure-block-sequence.py'),
  sourcePath(input.project),before,after],{encoding:'utf8',windowsHide:true}));
const quality=measured(films.trace,films.combined);
const effectOfReview=measured(films.automatic,films.combined);
const stats=(snapshot,blocking)=>{
  const keys=tracks=>Object.values(tracks??{}).reduce((total,value)=>total+(value?.keys?.length??0),0);
  const byId=new Map(snapshot.elements.map(el=>[el.id,el]));
  return {blocks:blocking.blocks.items.length,
    shortBlocks:blocking.blocks.items.filter(item=>{
      const el=byId.get(item.id);
      return (resolveTime(el.outPoint??snapshot.duration,snapshot.tempo)-resolveTime(el.inPoint??0,snapshot.tempo))*snapshot.fps<=2+1e-7;
    }).length,
    fixedShapes:snapshot.elements.filter(el=>el.outline||el.vector||el.type==='text').length,
    frameContours:blocking.appearance.reduce((total,binding)=>total+(binding.contours?.length??0),0),
    transformKeys:snapshot.elements.reduce((total,el)=>total+keys(el.transform),0),
    extentKeys:blocking.blocks.items.reduce((total,item)=>total+keys(item.extent),0)};
};
const statistics={trace:stats(input.scene,input.design),automatic:stats(automatic.scene,automatic.design),combined:stats(scene,design)};
assert.equal(statistics.combined.frameContours,0);
const reviewFrames=[6,15,16,35,54,81,82,92,130,159,177];
const sheet=await renderSheet(input.project,input.scene,{kind:'source',times:reviewFrames.map(frame=>(frame+.5)/scene.fps),cellWidth:640,columns:3,gridStep:120});
await fs.writeFile(path.join(output,'source_review.jpg'),sheet);
await fs.writeFile(path.join(output,'review_checkpoints.csv'),['frame,subject,visible,x,y,width,height,reviewer,notes',
  ...reviewFrames.map(frame=>`${frame},,,,,,,,`)].join('\r\n')+'\r\n');
const report={inputProjectId:id,inputRevision:input.project.revision,automaticProjectId:automatic.project.id,
  combinedProjectId:combined.project.id,combinedRevision:combined.project.revision,renderedFrames:183,statistics,applied,
  reviewFrames,sourceReview:'source_review.jpg',reviewCheckpoints:'review_checkpoints.csv',
  linkedTracks:docs.simplification.fits.filter(fit=>fit.members.length>1),elapsedSeconds:docs.simplification.elapsedSeconds,
  weakFitIds:docs.simplification.fits.filter(fit=>fit.meanShapeIoU<.6).map(fit=>fit.blockId),quality,effectOfReview};
await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,quality:quality.summary,effectOfReview:effectOfReview.summary},null,2));
