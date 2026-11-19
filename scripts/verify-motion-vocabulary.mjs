import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { blockingFrame, canvasMeasurer, emptyScene, evaluateScene, fontSpec, sampleTrack, worldMatrixOf } from '@mlm/core';
import { editBlocking, EditBlockingRequest } from '../apps/server/src/block-edit.ts';
import { getBlocking } from '../apps/server/src/blocking.ts';
import { exportVideo } from '../apps/server/src/export.ts';
import { generateLyricStudy, LyricGenerationRequest } from '../apps/server/src/lyric-generation.ts';
import { saveGeneratedProject } from '../apps/server/src/modeling.ts';
import { importMusic } from '../apps/server/src/music.ts';
import { MotionVocabularyRequest, readMotionVocabulary, saveMotionVocabulary } from '../apps/server/src/motion-vocabulary.ts';
import { commit, createProject, getDocuments, getProject, revertTo } from '../apps/server/src/store.ts';

const [sourceId,styleId,output]=process.argv.slice(2);
if(!sourceId||!styleId||!output) throw new Error('Supply the Lyricsample1 model, style study project and output folder');
const dir=path.resolve(output),actor='motion-vocabulary-verification';
await fs.mkdir(dir,{recursive:true});
const base=getProject(sourceId);
const rotation=base.scene.elements.find(el=>el.type==='group'&&el.id.startsWith('rotation:'));
assert.ok(rotation);
const {style_study}=getDocuments(styleId);
assert.ok(style_study);
const copied=saveGeneratedProject('Lyricsample1 · 動きの型',base.scene,sourceId,actor,{...getDocuments(sourceId),style_study});
const clips=[{id:'slide',label:'横へ流す',blockId:'track:lyrics:1',kind:'slide',from:16,to:27},
  {id:'squash',label:'横につぶす',blockId:'track:lyrics:1',kind:'squash',from:3,to:15},
  {id:'rotate',label:'親グループの回転',blockId:rotation.id,kind:'rotate',from:150,to:160}];
const vocabularyRequest=(baseRevision)=>MotionVocabularyRequest.parse({baseRevision,actor,clips});
const library=await saveMotionVocabulary(copied.project.id,vocabularyRequest(copied.project.revision));
await assert.rejects(()=>saveMotionVocabulary(copied.project.id,vocabularyRequest(copied.project.revision)),e=>e.status===409);
const templates=readMotionVocabulary(copied.project.id);
assert.equal(Object.keys(templates).length,3);
assert.ok(Math.min(...templates.squash.tracks.scaleX.map(k=>k.value))<.35);
assert.ok(Math.abs(templates.rotate.tracks.rotation.at(-1).value-31.4)<.2);

const audio=path.join(dir,'test-audio.wav');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=5','-y',audio]);
const empty=createProject('型と配置の比較 · 合成音源',{...emptyScene(),width:960,height:540,fps:24},actor);
let target=await importMusic(empty.project.id,{baseRevision:empty.project.revision,actor,path:audio});
target=commit(target.project.id,{baseRevision:target.project.revision,actor,note:'不等間隔の比較用拍を記録',
  scene:scene=>({...scene,markers:[0,.4,.93,1.45,1.92,2.47,2.93,3.5,4,4.5].map(t=>({t,kind:'beat',origin:'manual'}))})});
const input=LyricGenerationRequest.parse({baseRevision:library.project.revision,targetProjectId:target.project.id,targetRevision:target.project.revision,
  actor,name:'動きと配置の比較',comparison:'motion-layout',effects:[{claimId:'on-entry',kind:'entrance'},{claimId:'contrast',kind:'invert'},
    {claimId:'letter-spacing-time',kind:'stagger',tag:'文字別'}],lyrics:[
    {text:'夜',ruby:'よる',from:.08,to:1.58,motion:[{id:'slide',duration:1.2,unit:'beats',strength:.7},{id:'squash',duration:.65}],layout:{x:.55,y:.53,size:.58,readingRatio:.24}},
    {text:'まだ遠い',from:1.58,to:3.12,motion:[{id:'rotate',duration:.85,offset:.48}],layout:{x:.52,y:.48,size:.19,letterSpacing:.08}},
    {text:'明日へ走り出す',from:3.12,to:4.92,motion:[{id:'slide',duration:.46,strength:.55}],layout:{x:.5,y:.61,size:.095,letterSpacing:.33},
      tags:['文字別'],glyphMotion:[{index:0,motion:[{id:'squash',duration:.37,strength:.72}]},
        {index:3,motion:[{id:'rotate',duration:.4,strength:.8}]},{index:6,motion:[{id:'slide',duration:.4,strength:.34}]}]},
  ]});
const invalidGlyph=(index)=>({...input,lyrics:input.lyrics.map((line,i)=>i===2?{...line,glyphMotion:[{index,motion:line.glyphMotion[0].motion}]}:line)});
assert.throws(()=>generateLyricStudy(copied.project.id,invalidGlyph(7)),e=>e.status===422);
assert.throws(()=>generateLyricStudy(copied.project.id,{...input,lyrics:input.lyrics.map((line,i)=>i===2?{...line,glyphMotion:[line.glyphMotion[0],line.glyphMotion[0]]}:line)}),e=>e.status===422);
const generated=generateLyricStudy(copied.project.id,input);
assert.equal(generated.variants.length,4);
assert.ok(Math.abs(generated.motions[0][0].to-.612)<1e-9);
const result=[];
let common,glyphScene;
for(const entry of generated.variants) {
  const state=getProject(entry.project.id),tag=generated.reveal[entry.label];
  const layout=tag==='layout'||tag==='motion-layout',motion=tag==='motion'||tag==='motion-layout';
  const transformations=state.scene.elements.filter(el=>/^line:\d+:motion$/.test(el.id));
  assert.equal(transformations.length,motion?3:0);
  const first=state.scene.elements.find(el=>el.id==='line:1:group');
  assert.equal(first.transform.x,layout?528:480);
  assert.equal(state.project.source.sha256,target.project.source.sha256);
  if(motion) assert.ok(sampleTrack(transformations[1].transform.rotation,3,0)>31);
  const glyphTransforms=state.scene.elements.filter(el=>el.id.startsWith('line:3:glyph:')&&el.id.endsWith(':motion'));
  assert.equal(glyphTransforms.length,motion?3:0);
  if(tag==='motion-layout') glyphScene=state.scene;
  const cues=state.scene.elements.filter(el=>el.type==='text'||el.id.endsWith(':invert')).map(el=>[el.id,el.inPoint,el.outPoint]);
  common??=cues;
  assert.deepEqual(cues,common);
  const media=await exportVideo(state.project,state.scene,{from:0,to:5,width:960,layout:'render',withAudio:true});
  const file=`${entry.label}.mp4`;
  await fs.copyFile(media.path,path.join(dir,file));
  result.push({label:entry.label,tag,file,projectId:entry.project.id});
}
const canvas=createCanvas(960,540),ctx=canvas.getContext('2d');
ctx.font='bold 18px sans-serif';ctx.textBaseline='middle';
for(const [i,entry] of result.entries()) {
  const x=i%2*480,y=Math.floor(i/2)*270;
  ctx.fillStyle='#26374b';ctx.fillRect(x+8,y+8,28,26);
  ctx.fillStyle='#fff';ctx.fillText(entry.label,x+16,y+21);
}
const caption=path.join(dir,'.labels.png');await fs.writeFile(caption,await canvas.encode('png'));
const filters=result.map((_,i)=>`[${i}:v]scale=480:270,setsar=1[t${i}]`).join(';');
const comparison=path.join(dir,'comparison.mp4');
try {
  execFileSync('ffmpeg',['-v','error','-y',...result.flatMap(entry=>['-i',path.join(dir,entry.file)]),'-i',caption,
    '-filter_complex_threads','1','-filter_complex',`${filters};[t0][t1][t2][t3]xstack=inputs=4:layout=0_0|480_0|0_270|480_270:shortest=1[g];[g][4:v]overlay[v]`,
    '-map','[v]','-map','0:a:0','-c:a','copy','-c:v','libx264','-pix_fmt','yuv420p','-frames:v','120',comparison]);
} finally {await fs.rm(caption,{force:true});}
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,nb_read_frames','-of','json',comparison],{encoding:'utf8'}));
assert.equal(Number(probe.streams.find(stream=>stream.codec_type==='video').nb_read_frames),120);
assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
const lineOnly=generateLyricStudy(copied.project.id,{...input,name:'行単位の動き',lyrics:input.lyrics.map(({glyphMotion,...line})=>line)});
const control=lineOnly.variants.find(entry=>lineOnly.reveal[entry.label]==='motion-layout');
const controlScene=getProject(control.project.id).scene;
const auditCtx=createCanvas(1,1).getContext('2d'),measure=canvasMeasurer(auditCtx);
const renderedGlyphs=(scene,t)=>evaluateScene(scene,t,measure).filter(v=>v.element.type==='text'&&v.element.id.startsWith('line:3:')&&v.opacity>0);
const inkBox=({element,matrix})=>{
  auditCtx.font=fontSpec(element);
  auditCtx.textAlign='center';
  auditCtx.textBaseline='middle';
  const ink=auditCtx.measureText(element.text);
  const [a,b,c,d,x,y]=matrix;
  const corners=[-ink.actualBoundingBoxLeft,ink.actualBoundingBoxRight].flatMap(u=>[-ink.actualBoundingBoxAscent,ink.actualBoundingBoxDescent]
    .map(v=>[a*u+c*v+x,b*u+d*v+y]));
  const xs=corners.map(point=>point[0]),ys=corners.map(point=>point[1]);
  return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
};
const audit={firstFrames:{},outside:[],overlap:[],changed:[]},changed=new Set();
for(let frame=75;frame<119;frame++) {
  const t=frame/24;
  const before=renderedGlyphs(controlScene,t),after=renderedGlyphs(glyphScene,t);
  assert.deepEqual(after.map(v=>v.element.text),before.map(v=>v.element.text));
  const boxes=after.map((glyph,index)=>{
    const character=Number(glyph.element.id.split(':')[3]);
    audit.firstFrames[character]??=frame;
    if(glyph.matrix.some((value,i)=>Math.abs(value-before[index].matrix[i])>1e-6)) changed.add(character);
    const box=inkBox(glyph);
    if(box.left<0||box.top<0||box.right>glyphScene.width||box.bottom>glyphScene.height) audit.outside.push({frame,character});
    return {character,...box};
  });
  for(const [i,a] of boxes.entries()) for(const b of boxes.slice(i+1)) {
    const w=Math.min(a.right,b.right)-Math.max(a.left,b.left),h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
    if(w>1&&h>1) audit.overlap.push({frame,characters:[a.character,b.character],width:w,height:h});
  }
}
audit.changed=[...changed].sort((a,b)=>a-b);
assert.deepEqual(audit.changed,[0,3,6]);
assert.equal(Object.keys(audit.firstFrames).length,7);
assert.equal(audit.outside.length,0);
assert.equal(audit.overlap.length,0);
const glyphFirst=generated.glyphMotions[2][0];
assert.equal(glyphFirst.motions[0].from,input.lyrics[2].from+1/24);
const anchorTime=3.38;
assert.deepEqual(worldMatrixOf(glyphScene,'line:3:glyph:1',anchorTime).slice(0,4),[1,0,0,1]);
const previous=await exportVideo(control.project,controlScene,{from:3.125,to:4.875,width:960,layout:'render',withAudio:true});
const withGlyph=await exportVideo(getProject(generated.variants.find(entry=>generated.reveal[entry.label]==='motion-layout').project.id).project,
  glyphScene,{from:3.125,to:4.875,width:960,layout:'render',withAudio:true});
const glyphComparison=path.join(dir,'line-and-glyph.mp4');
execFileSync('ffmpeg',['-v','error','-y','-i',previous.path,'-i',withGlyph.path,'-filter_complex_threads','1',
  '-filter_complex','[0:v][1:v]hstack[v]','-map','[v]','-map','0:a:0','-c:a','copy','-c:v','libx264','-pix_fmt','yuv420p',glyphComparison]);
const reference=saveGeneratedProject('Lyricsample1 · 合字の読み差し替え',base.scene,sourceId,actor,getDocuments(sourceId));
let annotated=reference;
const replace=(blockId,frame,text,reading,rubySourceIds,readingPosition)=>editBlocking(annotated.project.id,EditBlockingRequest.parse({
  baseRevision:annotated.project.revision,actor,edit:{kind:'text',blockId:`track:lyrics:${blockId}`,frame,text,reading,readingPosition,
    rubySourceIds:rubySourceIds?.map(id=>`track:lyrics:${id}`)},
}));
annotated=replace(74,75,'木','き',[76]);
annotated=replace(75,75,'目','め',[77,78,79,81,82]);
annotated=replace(83,81,'相','そう',[84,85,86,87]);
annotated=replace(88,85,'相','そう',[89,90,91,92,93,94,95],'right');
const baseOwner=annotated.scene.elements.find(el=>el.id==='track:lyrics:74');
assert.deepEqual(baseOwner.transform,base.scene.elements.find(el=>el.id===baseOwner.id).transform);
assert.equal(annotated.scene.elements.find(el=>el.parentId===baseOwner.id).ruby,'き');
assert.equal(annotated.scene.elements.find(el=>el.parentId==='track:lyrics:88').rubyPosition,'right');
assert.ok(!blockingFrame(annotated.scene,annotated.design,75/24,'final').elements.some(el=>el.parentId==='track:lyrics:76'));
const preview=await exportVideo(annotated.project,annotated.scene,{from:71/24,to:92/24,width:960,layout:'render',withAudio:true,
  outputTag:'ruby-attachment',sceneAt:t=>blockingFrame(annotated.scene,annotated.design,t,'final')});
await fs.copyFile(preview.path,path.join(dir,'ruby.mp4'));
const restored=revertTo(reference.project.id,reference.project.revision,annotated.project.revision,actor);
const original=getBlocking(restored.project.id);
assert.equal(original.scene.elements.find(el=>el.parentId===baseOwner.id).ruby,undefined);
assert.ok(blockingFrame(original.scene,original.design,75/24,'final').elements.some(el=>el.parentId==='track:lyrics:76'));
const report={sourceId,libraryProjectId:library.project.id,libraryRevision:library.project.revision,targetProjectId:target.project.id,
  templates,result,combinations:generated.reveal,glyph:{file:'line-and-glyph.mp4',controlProjectId:control.project.id,audit},
  ruby:{projectId:reference.project.id,demonstrationRevision:annotated.project.revision,restoreRevision:restored.project.revision},
  verified:{commonTiming:true,commonAudio:true,frames:120,rubyRestored:true}};
await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({result,templates:Object.values(templates).map(({id,sourceKeyCount,sampleKeyCount,linearKeyCount,cubicKeyCount,maxSampleError})=>
  ({id,sourceKeyCount,sampleKeyCount,linearKeyCount,cubicKeyCount,maxSampleError}))}));
