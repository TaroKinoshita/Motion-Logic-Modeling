import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { blockingFrame, validateBlocking } from '@mlm/core';
import { analyzeSequence, sequenceDesign } from '../apps/server/src/block-sequence.ts';
import { exportBlocking, getBlocking } from '../apps/server/src/blocking.ts';
import { exportVideo } from '../apps/server/src/export.ts';
import { sourcePath } from '../apps/server/src/media.ts';
import { commit, createProject, getProject } from '../apps/server/src/store.ts';
import { generateVariant, measureEvents, saveModel } from '../apps/server/src/modeling.ts';

const [sourceId, previousVideo, outputFolder] = process.argv.slice(2);
if(!sourceId||!previousVideo||!outputFolder) throw new Error('Specify the source project, previous final MP4 and output folder');
const out=path.resolve(outputFolder);
fs.mkdirSync(out,{recursive:true});
const {project:reference,scene:base}=getProject(sourceId);
assert.equal(reference.source?.sha256,'251ecc12d05d3f000e8ac473b6c9763e8961a19989a89a519823d941bebe9cb3');
const options={cuts:[15,16,27,71,81,92,93,150,160],ocrFrames:[11,15,16,28,71,80,81,82,92,151,177]};
const sequence=await analyzeSequence(reference,options);
const {scene,design,observations}=sequenceDesign(reference,base,sequence,options,'lyrics');
assert.equal(sequence.frames,183);
const visibleAt=(frame,count)=>{
  return sequence.tracks.flatMap(track=>{
    const sample=track.samples.find(row=>row.frame===frame);
    return sample?[{id:`track:lyrics:${track.id}`,area:sample.box[2]*sample.box[3]}]:[];
  }).sort((a,b)=>b.area-a.area).slice(0,count).map(entry=>entry.id);
};
const timestamp=frame=>frame/scene.fps;
const events=[
  {id:'kaku-appears',kind:'appear',frame:3,label:'「各」が登場',outputs:visibleAt(3,1)},
  {id:'kaku-contact',kind:'contact',frame:15,label:'「田」と「各」が重なり「略」に見える',inputs:visibleAt(14,1),outputs:visibleAt(15,1)},
  {id:'kaku-separation',kind:'appear',frame:16,label:'「田」と「各」が再び離れて見える',outputs:visibleAt(16,2)},
  {id:'ta-cho',kind:'cut',frame:27,label:'「田＋丁」へ切り替わる',outputs:visibleAt(28,2)},
  {id:'meshi-parts',kind:'appear',frame:71,label:'「食」と「反」、ルビが現れる',outputs:visibleAt(71,2)},
  {id:'meshi-combine',kind:'merge',frame:81,label:'「食＋反→飯」',inputs:visibleAt(80,2),outputs:visibleAt(81,1),until:82},
  {id:'meshi-return',kind:'replace',frame:92,label:'つぶれた「食反」が現れる',inputs:visibleAt(91,1),outputs:visibleAt(92,1)},
];
for(const {id,kind,frame,label,inputs=[],outputs=[],until} of events) {
  const observationId=`visual:${id}`;
  observations[observationId]={id:observationId,kind:'visual-timing',origin:'manual',sourceSha256:reference.source.sha256,frame,t:timestamp(frame),note:label};
  design.events.push({id,kind,t:timestamp(frame),until:until===undefined?undefined:timestamp(until),label,status:'confirmed',inputs,outputs,observationIds:[observationId]});
}
for(const event of design.events.filter(event=>event.kind==='invert')) event.status='confirmed';
design.events.sort((a,b)=>a.t-b.t);
validateBlocking(scene,design);

const reportFile=path.join(out,'report.json');
const old=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):undefined;
const {project}=old?getProject(old.projectId):createProject('Lyricsample1 · 輪郭と動きの検証',scene,'codex');
if(!old) fs.copyFileSync(sourcePath(reference),sourcePath({...project,source:reference.source}));
let saved=commit(project.id,{baseRevision:old?.revision??project.revision,actor:'codex',note:'全編の輪郭・動き・出来事を保存',
  scene:()=>scene,meta:meta=>{meta.source=reference.source;meta.audioAnalysis=reference.audioAnalysis;},
  documents:docs=>({...docs,...design,observations}),
});
const timing=design.events.find(event=>event.id==='meshi-combine');
const measured=measureEvents(project.id,{baseRevision:saved.project.revision,actor:'codex',
  events:design.events.map(event=>({label:event.label,t:event.t,origin:'manual'}))});
saved=saveModel(project.id,{baseRevision:measured.project.revision,actor:'codex',mode:'merge',
  hypotheses:[{id:'meshi-timing',status:'accepted',observationIds:timing.observationIds,
    text:'「飯」の出現と白黒の反転は別々のコマで起こる。合字の時刻を変えて見え方を比較する。'}],
  rules:[{id:'meshi-1f',kind:'event_timing',hypothesisId:'meshi-timing',eventId:timing.id,from:72/24,to:92/24}],
});
const grid=await exportBlocking(project.id);
fs.copyFileSync(grid.path,path.join(out,'01_comparison.mp4'));
for(const [view,file] of [['motion','02_motion.mp4'],['events','03_events.mp4'],['final','04_final.mp4']]) {
  const rendered=await exportVideo(saved.project,saved.scene,{from:0,to:scene.duration,width:960,withAudio:true,layout:'render',
    outputTag:`contours-${view}`,sceneAt:t=>blockingFrame(saved.scene,design,t,view)});
  fs.copyFileSync(rendered.path,path.join(out,file));
}
for(const file of ['01_comparison.mp4','02_motion.mp4','03_events.mp4','04_final.mp4']) {
  const measured=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,nb_read_frames,duration,avg_frame_rate',
    '-of','json',path.join(out,file)],{encoding:'utf8'}));
  assert.equal(Number(measured.streams.find(s=>s.codec_type==='video').nb_read_frames),183,file);
  assert.ok(measured.streams.some(s=>s.codec_type==='audio'),file);
}
for(const [frames,file] of [[-1,'06_merge_one_frame_earlier.mp4'],[1,'07_merge_one_frame_later.mp4']]) {
  const edition=generateVariant(project.id,{baseRevision:saved.project.revision,actor:'codex',ruleId:'meshi-1f',seconds:0,mergeOffsetSeconds:frames/24,
    name:`Lyricsample1 · 合字 ${frames>0?'+':''}${frames}Fの比較`});
  const result=getBlocking(edition.project.id);
  const clip=await exportVideo(result.project,result.scene,{from:71/24,to:94/24,width:960,withAudio:true,layout:'render',
    outputTag:'merge-timing',sceneAt:t=>blockingFrame(result.scene,result.design,t,'final')});
  fs.copyFileSync(clip.path,path.join(out,file));
}
const quality=JSON.parse(execFileSync(process.env.MLM_BLOCKING_PYTHON??'python',[
  'scripts/measure-block-sequence.py',sourcePath(reference),previousVideo,path.join(out,'04_final.mp4'),
],{encoding:'utf8'}));
const report={projectId:project.id,revision:saved.project.revision,sourceSha256:reference.source.sha256,frames:sequence.frames,
  tracks:sequence.tracks.length,samples:sequence.tracks.reduce((n,track)=>n+track.samples.length,0),
  cameraCandidates:sequence.cameraCandidates,elapsedSeconds:sequence.runtimeSeconds,quality};
for(const [key,value] of Object.entries({scene,blocks:design.blocks,events:design.events,appearance:design.appearance,observations,report})) {
  fs.writeFileSync(path.join(out,`${key}.json`),JSON.stringify(value)+'\n');
}
console.log(JSON.stringify({...report,cameraCandidates:sequence.cameraCandidates.length,quality:quality.summary,out},null,2));
