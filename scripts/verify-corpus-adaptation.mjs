import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {blockingFrame,emptyScene,resolveTime} from '@mlm/core';
import {getBlocking} from '../apps/server/src/blocking.ts';
import {exportVideo} from '../apps/server/src/export.ts';
import {sourcePath} from '../apps/server/src/media.ts';
import {generateAdaptation,AdaptRequest,generateBaselines,BaselineRequest,saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {importMusic} from '../apps/server/src/music.ts';
import {createProject,getDocuments,getProject} from '../apps/server/src/store.ts';
import {generateLyricStudy,LyricGenerationRequest} from '../apps/server/src/lyric-generation.ts';

const [referenceId,targetId,libraryId,outDir]=process.argv.slice(2);
if(!referenceId||!targetId||!libraryId||!outDir) throw new Error('Supply the source model, target corpus model, motion library and output folder');
const folder=path.resolve(outDir),actor='corpus-audio-transfer';
await fs.mkdir(folder,{recursive:true});
const reference=getBlocking(referenceId),target=getBlocking(targetId),library=getProject(libraryId);
assert.notEqual(reference.project.source.sha256,target.project.source.sha256);
const targetAudio=path.join(folder,'target-audio.wav');
execFileSync('ffmpeg',['-v','error','-y','-i',sourcePath(target.project),'-map','0:a:0','-vn','-ar','48000','-ac','2',targetAudio],{windowsHide:true});

const {width,height,fps}=reference.scene;
const media=createProject('コーパス内音源でのM4検証', {...emptyScene(),width,height,fps},actor);
const imported=await importMusic(media.project.id,{baseRevision:media.project.revision,path:targetAudio,actor});
// These estimates come from the same original audio. The black wrapper is for playback.
const audio=target.project.audioAnalysis;
assert.equal(audio?.sourceSha256,target.project.source.sha256);
const beats=clip=>(clip.scene.markers??[]).filter(marker=>marker.kind==='beat').map(marker=>marker.t);
const targetBeats=beats(target).filter(t=>t<imported.scene.duration);
assert.ok(targetBeats.length>=8);
const {commit}=await import('../apps/server/src/store.ts');
const soundtrack=commit(imported.project.id,{baseRevision:imported.project.revision,actor,note:'コーパス音源の拍と出典をコピー',
  scene:scene=>({...scene,markers:target.scene.markers.filter(marker=>marker.t<scene.duration&&['beat','downbeat','section'].includes(marker.kind))}),
  documents:()=>({adaptation:{kind:'audio-extract',sourceProjectId:targetId,sourceRevision:target.project.revision,
    sourceSha256:target.project.source.sha256,originalBeatMethod:audio.params,estimatedBpm:audio.bpm}})});

const docs=getDocuments(referenceId);
const anchor=reference.design.events.find(event=>event.id==='meshi-combine'&&event.status==='confirmed');
assert.ok(anchor);
const {t:sourceAnchor}=anchor;
const outputAnchor=targetBeats.reduce((best,t)=>Math.abs(t-3.6)<Math.abs(best-3.6)?t:best);
const pinnedDesign=structuredClone(reference.design);
pinnedDesign.events.find(event=>event.id===anchor.id).beatRelative=true;
const pinned=saveGeneratedProject('Lyricsample1 · 実音源へ転用する拍指定',reference.scene,referenceId,actor,{...docs,...pinnedDesign});
const elementIds=reference.scene.elements.map(el=>el.id);
const params={baseRevision:pinned.project.revision,targetProjectId:soundtrack.project.id,targetRevision:soundtrack.project.revision,actor};
const adaptation=generateAdaptation(pinned.project.id,AdaptRequest.parse({...params,name:'実音源 · 合字を指定拍へ合わせる',
  sections:[
    {sourceFrom:0,sourceTo:sourceAnchor,targetFrom:0,targetTo:outputAnchor,elementIds,reason:'合字までの寸法・曲線を保持し、指定拍で切り替える'},
    {sourceFrom:sourceAnchor,sourceTo:reference.scene.duration,targetFrom:outputAnchor,targetTo:soundtrack.scene.duration,elementIds,
      reason:'合字後の反転と回転、終端までの順序を保つ'},
  ]}));
const bases=generateBaselines(pinned.project.id,BaselineRequest.parse({...params,name:'実音源 · 比較基準',includeLocalBeat:true}));
const candidates=[adaptation,...bases.projects];
const files=[];
for(const [i,candidate] of candidates.entries()) {
  const state=getBlocking(candidate.project.id);
  const kind=getDocuments(candidate.project.id).adaptation.kind;
  const hit=state.design?.events.find(event=>event.id===anchor.id);
  const owner=hit&&state.scene.elements.find(el=>el.id===hit.outputs[0]);
  if(i===0) {
    assert.equal(typeof owner.inPoint,'object');
    assert.ok(Math.abs(hit.t-outputAnchor)<1e-8);
    assert.ok(Math.abs(resolveTime(owner.inPoint,state.scene.tempo)-hit.t)<1e-8);
    for(const id of hit.inputs) assert.ok(Math.abs(resolveTime(state.scene.elements.find(el=>el.id===id).outPoint,state.scene.tempo)-hit.t)<1e-8);
  }
  const file=`${i}-${kind}.mp4`;
  const duration=state.project.source.frameCount/state.project.source.fps;
  const clip=await exportVideo(state.project,state.scene,{from:0,to:duration,width:640,layout:'render',withAudio:true,
    ...(state.design?{sceneAt:t=>blockingFrame(state.scene,state.design,t,'final')}:{}),outputTag:'audio-transfer'});
  assert.equal(clip.frameCount,state.project.source.frameCount);
  await fs.copyFile(clip.path,path.join(folder,file));
  files.push({kind,file,id:state.project.id,revision:state.project.revision,frameCount:clip.frameCount,
    anchorSeconds:hit?.t??null,anchorDeltaMs:hit?(hit.t-outputAnchor)*1000:null,
    tempo:state.scene.tempo??null,beatLinkedTime:owner?.inPoint??null});
}
assert.notEqual(files[0].anchorSeconds,files[1].anchorSeconds);
const output=path.join(folder,'sections-vs-baselines.mp4');
execFileSync('ffmpeg',['-v','error','-y',...files.slice(0,4).flatMap(file=>['-i',path.join(folder,file.file)]),
  '-filter_complex_threads','1','-filter_complex','[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|640_0|0_360|640_360[v]',
  '-map','[v]','-map','0:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy',output],{windowsHide:true});

const from=n=>Math.round(targetBeats[n]*fps)/fps;
const lines=[
  {text:'星を拾う',from:from(0),to:from(4),tags:['line'],layout:{x:.32,y:.41,size:.12},motion:[{id:'slide',duration:.55,strength:.6}]},
  {text:'晶',parts:['日','日','日'],ruby:'しょう',from:from(5),to:from(9),tags:['combine'],layout:{x:.53,y:.48,size:.3,readingRatio:.14},
    partLayouts:[{x:.47,y:.36,size:.22},{x:.31,y:.62,size:.22},{x:.68,y:.62,size:.22}],
    compoundShot:{delayFrames:1,layout:{x:.61,y:.58,size:.62}}},
  {text:'夜を越える',from:from(10),to:from(14),tags:['line'],layout:{x:.64,y:.57,size:.13},motion:[{id:'hold',duration:.42,strength:.7}]},
  {text:'明',parts:['日','月'],ruby:'あかり',from:from(15),to:from(19),tags:['combine'],layout:{x:.44,y:.49,size:.3,readingRatio:.14},
    partLayouts:[{x:.31,y:.46,size:.24},{x:.65,y:.53,size:.29}],compoundShot:{delayFrames:1,layout:{x:.43,y:.57,size:.62}}},
];
const generated=generateLyricStudy(libraryId,LyricGenerationRequest.parse({baseRevision:library.project.revision,
  targetProjectId:soundtrack.project.id,targetRevision:soundtrack.project.revision,actor,name:'実音源 · 別の文字と合字の比較',
  comparison:'composition-compound',lyrics:lines,effects:[{kind:'entrance',claimId:'on-entry',tag:'line'},{kind:'combine',claimId:'compound',tag:'combine'}]}));
const newLyrics=[];
for(const variation of generated.variants) {
  const state=getProject(variation.project.id);
  assert.equal(state.project.source.sha256,soundtrack.project.source.sha256);
  const result=await exportVideo(state.project,state.scene,{from:0,to:state.scene.duration,width:640,layout:'render',withAudio:true,outputTag:'corpus-lyrics'});
  const file=`lyrics-${variation.label}.mp4`;
  await fs.copyFile(result.path,path.join(folder,file));
  newLyrics.push({id:state.project.id,file,label:variation.label,condition:generated.reveal[variation.label],frameCount:result.frameCount});
}
await fs.writeFile(path.join(folder,'report.json'),JSON.stringify({
  source:{id:referenceId,revision:reference.project.revision,sha256:reference.project.source.sha256,estimateBpm:reference.project.audioAnalysis?.bpm},
  audio:{id:targetId,revision:target.project.revision,sha256:target.project.source.sha256,estimateBpm:audio.bpm,beats:targetBeats,
    soundtrackProjectId:soundtrack.project.id},
  anchor:{id:anchor.id,sourceSeconds:sourceAnchor,targetSeconds:outputAnchor,mode:'authored sync to a selected estimated beat'},files,newLyrics,
  limitations:['Same credited corpus, musical work identity unchecked','The lyric lines were invented for the mechanics test and do not transcribe the target vocal','No independent perception result'],
},null,2));
console.log(JSON.stringify({files,newLyrics}));
