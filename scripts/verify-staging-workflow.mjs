import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { blockingFrame, canvasMeasurer, evaluateScene, fontSpec, resolveTime, textUnits } from '@mlm/core';
import { editBlocking, EditBlockingRequest } from '../apps/server/src/block-edit.ts';
import { getBlocking } from '../apps/server/src/blocking.ts';
import { exportVideo } from '../apps/server/src/export.ts';
import { generateLyricStudy, LyricGenerationRequest } from '../apps/server/src/lyric-generation.ts';
import { saveGeneratedProject } from '../apps/server/src/modeling.ts';
import { saveMotionVocabulary, MotionVocabularyRequest } from '../apps/server/src/motion-vocabulary.ts';
import { getDocuments, getProject } from '../apps/server/src/store.ts';

const [sourceId,styleId,targetId,output]=process.argv.slice(2);
if(!sourceId||!styleId||!targetId||!output) throw new Error('Supply source, style study, audio target and output folder');
const dir=path.resolve(output),actor='staging-verification';
await mkdir(dir,{recursive:true});
const initial=getBlocking(sourceId);
const {style_study}=getDocuments(styleId);
assert.ok(style_study);
let state=saveGeneratedProject('Lyricsample1 · 接続と演出の検証',initial.scene,sourceId,actor,{...getDocuments(sourceId),style_study});
const selected=[[12,15,'Ru'],[52,53,'Ta'],[69,71,'Ta'],[79,80,'Shiのiの点'],[114,116,'A'],[124,126,'Riのiの縦画'],[181,183,'FuのF']];
const apply=(first,second)=>editBlocking(state.project.id,EditBlockingRequest.parse({baseRevision:state.project.revision,actor,
  edit:{kind:'join-tracks',firstId:`track:lyrics:${first}`,secondId:`track:lyrics:${second}`}}));
assert.throws(()=>apply(88,96),e=>e.status===422&&e.message.includes('確定'));
assert.throws(()=>apply(188,179),e=>e.status===422);
for(const [first,second] of selected) state=apply(first,second);

const auditCtx=createCanvas(1,1).getContext('2d'),measure=canvasMeasurer(auditCtx);
const finalAt=(value,time)=>evaluateScene(blockingFrame(value.scene,value.design,time,'final'),time,measure);
const definedShort=({scene,design})=>design.blocks.items.filter(block=>{
  const owner=scene.elements.find(el=>el.id===block.id);
  return Math.round((resolveTime(owner.outPoint??scene.duration,scene.tempo)-resolveTime(owner.inPoint??0,scene.tempo))*scene.fps)<=2;
}).length;
let maxTransformDifference=0;
const frameCount=Math.round(initial.scene.duration*initial.scene.fps);
for(let n=0;n<frameCount;n++) {
  const t=n/initial.scene.fps,before=finalAt(initial,t),after=finalAt(state,t);
  assert.deepEqual(after.map(x=>[x.element.id,x.opacity]),before.map(x=>[x.element.id,x.opacity]));
  for(const [i,entry] of before.entries()) for(const [j,value] of entry.matrix.entries()) {
    maxTransformDifference=Math.max(maxTransformDifference,Math.abs(value-after[i].matrix[j]));
  }
}
assert.ok(maxTransformDifference<1e-7);
assert.deepEqual(state.design.events.filter(e=>e.status==='confirmed'),initial.design.events.filter(e=>e.status==='confirmed'));
const tracking={pairs:selected,projectId:state.project.id,before:initial.design.blocks.items.length,after:state.design.blocks.items.length,
  shortBefore:definedShort(initial),shortAfter:definedShort(state),frameCount,maxTransformDifference,protected92:true,
  unresolved:[{id:31,reason:'点が続くが次の追跡IDを特定できない'},{id:151,reason:'近接する複数の粒子の同一性を確定できない'},
    {id:188,reason:'179の寿命内にあり隣接接続の対象外'}]};

const rotation=initial.scene.elements.find(el=>el.type==='group'&&el.id.startsWith('rotation:'));
assert.ok(rotation);
const originalClips=[{id:'slide',label:'横へ流す',blockId:'track:lyrics:1',kind:'slide',from:16,to:27},
  {id:'squash',label:'横につぶす',blockId:'track:lyrics:1',kind:'squash',from:3,to:15},
  {id:'rotate',label:'共通回転',blockId:rotation.id,kind:'rotate',from:150,to:160}];
const extractionStart=performance.now();
const library=await saveMotionVocabulary(state.project.id,MotionVocabularyRequest.parse({baseRevision:state.project.revision,actor,clips:[
  ...originalClips,{id:'hold',label:'各のタメ',blockId:'track:lyrics:1',kind:'hold',from:19,to:26},
  {id:'exit',label:'各の右への抜け',blockId:'track:lyrics:1',kind:'exit',from:22,to:27},
  ...originalClips.map(clip=>({...clip,id:`${clip.id}-compact`,profile:'compact'})),
]}));
const extractionMs=performance.now()-extractionStart;
const hold=library.templates.find(x=>x.id==='hold'),exit=library.templates.find(x=>x.id==='exit');
assert.ok(hold.stationary.seconds>=3/24);
assert.equal(exit.tracks.x[0].value,0);
assert.ok(exit.tracks.x.at(-1).value>0);
const target=getProject(targetId);
const staging=[{tag:'主役行',target:'line',motion:[{id:'hold',duration:.42,strength:.6}]},
  {tag:'主役行',target:'focus',motion:[{id:'squash',duration:.45,strength:.82}]},
  {tag:'主役行',target:'last',motion:[{id:'exit',duration:.46,unit:'beats',strength:.9}]}];
const phrases=[{text:'春へ歩き出す',from:.17,to:1.59},{text:'雲を追いかける',from:1.68,to:3.12},
  {text:'ひかりを見つける',from:3.18,to:4.9,focus:4}];
const baseLyrics=phrases.map(phrase=>({...phrase,tags:['主役行'],layout:{x:.5,y:.55,size:.13,letterSpacing:.33}}));
const metadata={baseRevision:library.project.revision,targetProjectId:targetId,targetRevision:target.project.revision,actor,
  comparison:'motion-layout',effects:[{claimId:'on-entry',kind:'entrance'},{claimId:'letter-spacing-time',kind:'stagger',tag:'主役行'}]};
const build=(name,lyrics,staging)=>generateLyricStudy(library.project.id,LyricGenerationRequest.parse({...metadata,name,lyrics,staging}));
const measurements=[];
const startManual=performance.now();
const explicit=baseLyrics.map(line=>{
  const chars=textUnits({id:'line',type:'text',text:line.text});
  return {...line,motion:staging[0].motion,glyphMotion:[{index:line.focus??chars.findIndex(glyph=>/\p{Script=Han}/u.test(glyph)),motion:staging[1].motion},
    {index:chars.length-1,motion:staging[2].motion}]};
});
const manual=build('文字の動きを行ごとに手指定',explicit);
measurements.push({mode:'explicit',lineAssignments:3,glyphAssignments:6,sharedRules:0,authorFocusOverrides:1,attempts:1,scriptAndGenerationMs:performance.now()-startManual});
const startRules=performance.now();
const ruled=build('タグで動きを割り当て',baseLyrics,staging);
measurements.push({mode:'staging',lineAssignments:0,glyphAssignments:0,sharedRules:staging.length,authorFocusOverrides:1,attempts:1,
  scriptAndGenerationMs:performance.now()-startRules});
assert.equal(ruled.selections.length,9);
assert.equal(ruled.selections.find(s=>s.reason==='authored-focus')?.index,4);
for(const item of ruled.glyphMotions) {
  const out=item.find(entry=>entry.motions[0].motion.kind==='exit').motions[0];
  assert.ok(out.to>out.from&&out.to-out.from<.46);
}
const find=(set,condition)=>getProject(set.variants.find(v=>set.reveal[v.label]===condition).project.id);
for(const condition of Object.values(ruled.reveal)) assert.deepEqual(find(ruled,condition).scene,find(manual,condition).scene);

const rendererAudit={outOfFrame:0,overlap:0,checkedFrames:0,minConfirmedGapPx:Infinity};
const composed=find(ruled,'motion-layout');
for(let n=0;n<120;n++) {
  const glyphs=evaluateScene(composed.scene,n/24,measure).filter(x=>x.opacity>0&&x.element.type==='text');
  if(!glyphs.length) continue;
  rendererAudit.checkedFrames++;
  const boxes=glyphs.map(({matrix,element})=>{
    auditCtx.font=fontSpec(element);auditCtx.textAlign='center';auditCtx.textBaseline='middle';
    const ink=auditCtx.measureText(element.text);
    const [a,b,c,d,x,y]=matrix;
    const corners=[-ink.actualBoundingBoxLeft,ink.actualBoundingBoxRight].flatMap(u=>[-ink.actualBoundingBoxAscent,ink.actualBoundingBoxDescent]
      .map(v=>[a*u+c*v+x,b*u+d*v+y]));
    return [Math.min(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[1]))];
  });
  rendererAudit.outOfFrame+=boxes.filter(([l,r,t,b])=>l<0||r>composed.scene.width||t<0||b>composed.scene.height).length;
  for(const [i,[l,r,t,b]] of boxes.entries()) for(const [L,R,T,B] of boxes.slice(i+1)) {
    const xGap=Math.max(l,L)-Math.min(r,R),yGap=Math.max(t,T)-Math.min(b,B);
    if(yGap<0) rendererAudit.minConfirmedGapPx=Math.min(rendererAudit.minConfirmedGapPx,xGap);
    if(xGap< -1&&yGap< -1) rendererAudit.overlap++;
  }
}
const versions=[];
for(const [i,condition] of ['motion-layout','layout'].entries()) {
  const v=find(ruled,condition);
  const file=`review-${String.fromCharCode(65+i)}.mp4`;
  const clip=await exportVideo(v.project,v.scene,{from:0,to:5,width:960,layout:'render',withAudio:true});
  assert.equal(clip.frameCount,120);
  await copyFile(clip.path,path.join(dir,file));
  versions.push({file,condition,projectId:v.project.id});
}
execFileSync('ffmpeg',['-v','error','-y',...versions.flatMap(v=>['-i',path.join(dir,v.file)]),'-filter_complex_threads','1',
  '-filter_complex','[0:v][1:v]hstack[v]','-map','[v]','-map','0:a:0','-c:a','copy','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,'review-comparison.mp4')]);
const motionAudit=library.templates.map(({id,from,to,sourceKeyCount,cubicKeyCount,maxSampleError,stationary})=>
  ({id,from,to,sourceKeyCount,cubicKeyCount,maxSampleError,stationary}));
const report={sourceId,sourceRevision:initial.project.revision,targetId,libraryProjectId:library.project.id,libraryRevision:library.project.revision,
  tracking,extractionMs,motionAudit,measurements,rendererAudit,versions,selections:ruled.selections,
  limitations:['work time of Node runs, not human editing time','source review is not independent','synthetic audio']};
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({tracking,motionAudit,measurements,rendererAudit},null,2));
