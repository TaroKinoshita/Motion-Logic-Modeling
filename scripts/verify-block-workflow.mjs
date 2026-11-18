import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { blockingFrame, emptyScene, evaluateScene, sampleTrack } from '@mlm/core';

const output=path.resolve(process.argv[2]??'data/Lyricsample1_Contour_Output');
const report=JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8'));
const originalMedia=path.resolve('data/projects',report.projectId,'media/source.mp4');
const probeSource=JSON.parse(fs.readFileSync(path.resolve('data/projects',report.projectId,'project.json'),'utf8')).source;
process.env.MLM_DATA_DIR=fs.mkdtempSync(path.resolve('data','block-workflow-'));
const {createProject,commit,getDocuments,getProject,listHistory,projectDir,revertTo}=await import('../apps/server/src/store.ts');
const {getBlocking,exportBlocking}=await import('../apps/server/src/blocking.ts');
const {editBlocking,startBlockJob,blockJobStatus,cancelBlockJob,retryBlockJob,startBlockExport}=await import('../apps/server/src/block-edit.ts');
const {saveModel,generateVariant,generateAdaptation,generateBaselines}=await import('../apps/server/src/modeling.ts');
const {importMusic}=await import('../apps/server/src/music.ts');
const read=file=>JSON.parse(fs.readFileSync(path.join(output,`${file}.json`),'utf8'));
const reference=createProject('Workflow fixture',read('scene'),'test');
const id=reference.project.id;
fs.copyFileSync(originalMedia,path.join(projectDir(id),'media',probeSource.fileName));
let saved=commit(id,{baseRevision:reference.project.revision,actor:'test',note:'Fixture',
  meta:project=>{project.source=probeSource;},
  documents:()=>Object.fromEntries(['blocks','events','appearance','observations'].map(key=>[key,read(key)])),
});
const scene=getBlocking(id).scene;
const t=11/scene.fps;
const selected=getBlocking(id).design.appearance.find(item=>item.contours.some(sample=>sample.t===t&&sample.paths.some(polygon=>polygon.length>=24)));
assert.ok(selected);
const shape=selected.childIds[0],blockId=selected.blockId;
const rendered=(state,time)=>evaluateScene(blockingFrame(state.scene,state.design,time,'final'),time).find(x=>x.element.id===shape);
const initial=getBlocking(id);
const x=rendered(initial,t).cx+.5,y=rendered(initial,t).cy+.5;
const fix={kind:'box',blockId,frame:11,cx:x+10,cy:y,width:rendered(initial,t).width+1,height:rendered(initial,t).height+1};
saved=editBlocking(id,{baseRevision:saved.project.revision,actor:'test',edit:fix});
assert.ok(Math.abs(rendered(getBlocking(id),t).cx-rendered(initial,t).cx-10)<1e-6);
assert.equal(rendered(getBlocking(id),10/24)?.cx,rendered(initial,10/24)?.cx);
assert.throws(()=>editBlocking(id,{baseRevision:initial.project.revision,actor:'test',edit:fix}),/リビジョン/);

const analysis={baseRevision:saved.project.revision,actor:'test',blockId,region:[900,345,530,365],from:10,to:13};
const wait=async(job)=>{
  for(let i=0;i<160;i++) {
    const state=blockJobStatus(id,job.id);
    if(['done','cancelled','failed'].includes(state.state)) return state;
    await pause(100);
  }
  throw new Error('Job did not finish');
};
const cancelled=startBlockJob(id,analysis);
cancelBlockJob(id,cancelled.id);
assert.equal((await wait(cancelled)).state,'cancelled');
const restarted=await wait(retryBlockJob(id,cancelled.id));
assert.equal(restarted.state,'done',restarted.error);
saved=getBlocking(id);
assert.ok(Math.abs(rendered(saved,t).cx-rendered(initial,t).cx)<1);
assert.equal(saved.design.events.length,initial.design.events.length);

saved=editBlocking(id,{baseRevision:saved.project.revision,actor:'test',edit:{kind:'split',blockId,frame:11}});
assert.equal(getBlocking(id).design.blocks.items.length,initial.design.blocks.items.length+1);
saved=revertTo(id,initial.project.revision,saved.project.revision,'test');
assert.equal(getBlocking(id).design.blocks.items.length,initial.design.blocks.items.length);

const preCamera=getBlocking(id);
const cameraTimes=[97,98,103,104,115,160].map(frame=>frame/24);
const position=(state,time)=>evaluateScene(blockingFrame(state.scene,state.design,time,'final'),time).map(el=>[el.element.id,el.cx,el.cy]);
const priorPositions=cameraTimes.map(time=>position(preCamera,time));
const camera=editBlocking(id,{baseRevision:saved.project.revision,actor:'test',edit:{kind:'camera',from:97,to:104}});
for(const [i,time] of cameraTimes.entries()) {
  const after=position(getBlocking(id),time);
  assert.equal(after.length,priorPositions[i].length);
  for(const [index,row] of after.entries()) {
    assert.equal(row[0],priorPositions[i][index][0]);
    assert.ok(Math.hypot(row[1]-priorPositions[i][index][1],row[2]-priorPositions[i][index][2])<1e-7);
  }
}
saved=revertTo(id,preCamera.project.revision,camera.project.revision,'test');

const preGroup=getBlocking(id);
const members=preGroup.design.events.find(item=>item.id==='meshi-combine').inputs;
const grouped=editBlocking(id,{baseRevision:saved.project.revision,actor:'test',edit:{kind:'group',blockIds:members,label:'部品のまとまり'}});
const memberGroup=grouped.design.blocks.items.find(item=>item.members);
assert.deepEqual(memberGroup.members,members);
const f80=80/24;
const groupMotion=evaluateScene(blockingFrame(grouped.scene,grouped.design,f80,'motion'),f80);
assert.ok(groupMotion.some(element=>element.element.id===`box:${memberGroup.id}`));
assert.ok(groupMotion.every(element=>!members.some(id=>element.element.id===`box:${id}`)));
assert.deepEqual(position(grouped,f80),position(preGroup,f80));
const separated=editBlocking(id,{baseRevision:grouped.project.revision,actor:'test',edit:{kind:'ungroup',blockId:memberGroup.id}});
assert.deepEqual(position(separated,f80),position(preGroup,f80));
saved=revertTo(id,preGroup.project.revision,separated.project.revision,'test');

const event=getBlocking(id).design.events.find(event=>event.id==='meshi-combine');
const hypothesis={id:'f81',text:'The timing of the visible compound is part of this transition.',status:'accepted',observationIds:event.observationIds};
saved=saveModel(id,{baseRevision:saved.project.revision,actor:'test',mode:'merge',hypotheses:[hypothesis],
  rules:[{id:'shift',hypothesisId:hypothesis.id,kind:'event_timing',eventId:event.id,from:72/24,to:92/24}]});
for(const delta of [-1,1]) {
  const variant=generateVariant(id,{baseRevision:saved.project.revision,actor:'test',ruleId:'shift',seconds:0,mergeOffsetSeconds:delta/24,name:`Contact ${delta}F`});
  const moved=getBlocking(variant.project.id);
  const result=moved.design.events.find(item=>item.id===event.id);
  assert.equal(Math.round(result.t*24),81+delta);
  const output=moved.design.appearance.find(item=>item.blockId===result.outputs[0]);
  assert.ok(Math.abs(output.contours[0].t-result.t)<1e-8);
}
assert.equal(getProject(id).project.revision,saved.project.revision);

const audio=path.join(process.env.MLM_DATA_DIR,'synthetic.wav');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8',audio]);
let target=createProject('Synthetic target', {...emptyScene(),width:960,height:540,fps:24},'test');
target=await importMusic(target.project.id,{baseRevision:target.project.revision,path:audio,actor:'test'});
target=commit(target.project.id,{baseRevision:target.project.revision,actor:'test',note:'Irregular comparison beats',scene:state=>({
  ...state,markers:[.14,.5,1.15,1.7,2.11,2.6,3.1,3.7,4.4,4.8,5.6,6.1,7.1].map(t=>({t,kind:'beat',origin:'manual'})),
})});
const elementIds=saved.scene.elements.map(el=>el.id);
const adapted=generateAdaptation(id,{baseRevision:saved.project.revision,targetProjectId:target.project.id,targetRevision:target.project.revision,actor:'test',
  name:'Synthetic target adapted',sections:[
    {sourceFrom:0,sourceTo:3,targetFrom:0,targetTo:4,elementIds,reason:'Stretch the introduction'},
    {sourceFrom:3,sourceTo:saved.scene.duration,targetFrom:4,targetTo:target.scene.duration,elementIds,reason:'Fit the conclusion'},
  ]});
const mapped=getBlocking(adapted.project.id);
assert.equal(mapped.design.blocks.sourceSha256,target.project.source.sha256);
assert.notEqual(mapped.design.blocks.sourceSha256,probeSource.sha256);
assert.deepEqual(getDocuments(adapted.project.id).observations,getDocuments(id).observations);
const adaptedEvent=mapped.design.events.find(item=>item.id===event.id);
assert.ok(adaptedEvent.t>4);
const adaptedBlock=mapped.design.blocks.items.find(item=>item.id===adaptedEvent.outputs[0]);
assert.ok(sampleTrack(adaptedBlock.extent.width,adaptedEvent.t,0,mapped.scene.tempo)>0);
const exported=await exportBlocking(adapted.project.id,320);
assert.equal(exported.frameCount,192);
const baseline=generateBaselines(id,{baseRevision:saved.project.revision,targetProjectId:target.project.id,targetRevision:target.project.revision,actor:'test',
  name:'Synthetic comparison',includeLocalBeat:true});
assert.equal(baseline.projects.length,4);
const [global,,,local]=baseline.projects;
assert.ok(getBlocking(global.project.id).design.appearance.some(item=>item.contours?.length));
assert.notEqual(getBlocking(global.project.id).design.events.find(item=>item.id===event.id).t,
  getBlocking(local.project.id).design.events.find(item=>item.id===event.id).t);
assert.ok(fs.readdirSync(path.join(projectDir(id),'history')).some(file=>file.endsWith('.gz')));
assert.equal(listHistory(id).at(-1).revision,saved.project.revision);
const cancelledExport=startBlockExport(id,{baseRevision:saved.project.revision,actor:'test'});
await pause(120);
cancelBlockJob(id,cancelledExport.id);
const cancelledOutput=await wait(cancelledExport);
assert.equal(cancelledOutput.state,'cancelled');
const exportedSource=await wait(retryBlockJob(id,cancelledExport.id));
assert.equal(exportedSource.state,'done',exportedSource.error);
assert.equal(exportedSource.output.frameCount,183);
console.log(JSON.stringify({data:process.env.MLM_DATA_DIR,checks:['frame-local box edit','stale revision rejection','cancel and retry',
  'partial remeasurement','split and compressed history restore','camera parenting preserves screen geometry','group and ungroup preserve geometry',
  'confirmed merge -1F/+1F variants','source preserved','synthetic M4 retiming and MP4','four M4 baselines with separate local beat timing','MP4 export cancel and retry'],
  adapted:adapted.project.id,frames:exported.frameCount},null,2));
