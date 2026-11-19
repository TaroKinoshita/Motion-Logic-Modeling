import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene,evaluateScene,fontSpec,sampleTrack,worldMatrixOf} from '@mlm/core';
import {exportVideo} from '../apps/server/src/export.ts';
import {probe} from '../apps/server/src/media.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {checkScene,commit,getEvidenceSnapshot,getProject,REPO_ROOT} from '../apps/server/src/store.ts';
import {publishPassage} from './passage-review.mjs';
import {detectPhraseDrop,phraseScalePolicy} from './assess-phrase-scale.mjs';

const [intakeFile,motionFile,output,repeatFile]=process.argv.slice(2);
if(!intakeFile||!motionFile||!output) throw new Error('Supply corpus intake, motion report and destination');
const [intake,motion]=await Promise.all([intakeFile,motionFile].map(async file=>JSON.parse(await readFile(file,'utf8'))));
const sample=intake.works.find(work=>work.sample===6);
assert.equal(sample.scope,'check-only');
const {project}=getProject(sample.projectId),dir=path.resolve(output),actor='collective-scale-review';
assert.equal(project.source.sha256,sample.sourceSha256);
assert.equal(motion.validation.sample,sample.sample);
const {fps,width,height}=project.source;
const [first,end]=motion.validation.frames;
const t=frame=>(frame-first)/fps;
const rows=motion.validation.samples.map(({frame,box:[left,top,w,h]})=>({frame,x:left+w/2,y:top+h/2,w,h}));
assert.deepEqual(rows.map(row=>row.frame),Array.from({length:end-first},(_,i)=>first+i));
assert.equal(phraseScalePolicy.threshold,motion.criteria.scaleContrastMinRatio);
const policy={revision:1,...phraseScalePolicy,timingUnit:'source-frame',
  foreground:'box of the same text group; validate the text identity visually',
  wholePhrase:'the same set of displayed characters persists on both sides of the size change'};
const drops=detectPhraseDrop(rows);
assert.equal(drops.length,1);
const change=drops[0];
assert.equal(change.frame,129);
const relative=(a,b,q)=>a+(b-a)*q;
const linearBaseline=rows.map((row,i)=>Object.fromEntries(['x','y','w','h'].map(key=>[key,
  relative(rows[0][key],rows.at(-1)[key],i/(rows.length-1))]))).map((row,i)=>({...row,frame:rows[i].frame}));
assert.equal(detectPhraseDrop(linearBaseline).length,0);
const repeat=repeatFile?JSON.parse(await readFile(repeatFile,'utf8')):null;
if(repeat) {
  assert.equal(repeat.sourceSha256,project.source.sha256);
  assert.equal(repeat.identityAssessment,'same-phrase');
  assert.equal(repeat.result,'present');
  assert.deepEqual(repeat.rule,phraseScalePolicy);
  assert.ok(repeat.frameRange[1]<=first||repeat.frameRange[0]>=end);
}
const repeatObservation=repeat?.found.map(drop=>({frameRange:repeat.frameRange,...drop}))??[];
const python=process.env.MLM_TRACK_PYTHON??path.join(REPO_ROOT,'workers','track','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const fitter=path.join(REPO_ROOT,'workers','track','track','motion_vocabulary_fit.py');
const tolerance={x:1,y:1,w:2,h:2};
const parts=[rows.filter(row=>row.frame<change.frame),rows.filter(row=>row.frame>=change.frame)];
const fitted=parts.map(part=>JSON.parse(execFileSync(python,[fitter,JSON.stringify([part.map(({frame,...row})=>({t:t(frame),...row})),
  tolerance,{x:[],y:[],w:[],h:[]}])],{encoding:'utf8',windowsHide:true})).eased.tracks);
const modelSize=rows.find(row=>row.frame===change.beforeFrame);
const fittedTrack=(key,unit=1)=>{
  const keys=fitted.flatMap((fit,index)=>fit[key].map((row,i)=>({t:row.t,v:row.value/unit,
    ease:index===0&&i===fit[key].length-1?'hold':row.easing})));
  return keys.every(key=>key.v===keys[0].v)?keys[0].v:{keys};
};
const owner={id:'collective-scale',name:'語全体・大きさと切り替え',type:'group',inPoint:0,outPoint:t(end),transform:{
  x:fittedTrack('x'),y:fittedTrack('y'),scaleX:fittedTrack('w',modelSize.w),scaleY:fittedTrack('h',modelSize.h),
}};
const common={...emptyScene(),width,height,fps,duration:t(end),background:'#ededed',markers:[
  {t:t(change.frame),kind:'cut',origin:'measured',label:`元 ${change.frame}F 大きさ切り替え`},
]};
const child={id:'appearance',parentId:owner.id,fill:'#454545',inPoint:0,outPoint:t(end)};
const blocks=checkScene({...common,elements:[owner,{...child,type:'rect',width:modelSize.w,height:modelSize.h}]});
const context=createCanvas(1,1).getContext('2d');
const asText=text=>{
  const node={...child,type:'text',text,fontFamily:'MLM Yu Gothic',fontSize:100,fontWeight:700};
  context.font=fontSpec(node);context.textAlign='center';context.textBaseline='middle';
  const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=context.measureText(text);
  assert.ok(l+r>0&&a+b>0);
  const scale=Math.min(modelSize.w/(l+r),modelSize.h/(a+b));
  const scene=checkScene({...common,elements:[owner,{...node,transform:{x:(l-r)*scale/2,y:(a-b)*scale/2,scaleX:scale,scaleY:scale}}]});
  return {scene,text,inkSize:{w:(l+r)*scale,h:(a+b)*scale}};
};
const phrases=['待ってて','静かに','ひとやすみ'].map(asText);
for(const {scene,text} of phrases) for(const row of rows) {
  const time=t(row.frame),hit=evaluateScene(scene,time);
  assert.equal(hit.length,1);
  assert.equal(hit[0].element.text,text);
  assert.deepEqual(worldMatrixOf(scene,owner.id,time),worldMatrixOf(blocks,owner.id,time));
}
const max=Math.max;
const sampled=rows.map(row=>{
  const [a,,,d,x,y]=worldMatrixOf(blocks,owner.id,t(row.frame));
  return {frame:row.frame,x,y,w:a*modelSize.w,h:d*modelSize.h};
});
assert.deepEqual(detectPhraseDrop(sampled).map(item=>item.frame),[change.frame]);
const summary={};
for(const key of ['x','y','w','h']) {
  summary[key]={fittedMaxPx:max(...rows.map((row,i)=>Math.abs(row[key]-sampled[i][key]))),
    linearMaxPx:max(...rows.map((row,i)=>Math.abs(row[key]-linearBaseline[i][key])))};
  assert.ok(summary[key].fittedMaxPx<=tolerance[key]+1e-8);
}
const evidenceRevision=getProject(project.id).project.revision;
const {observations}=getEvidenceSnapshot(project.id,evidenceRevision);
assert.ok(observations['corpus-motion:6:size-check']);
const provenance={sourceProjectId:project.id,sourceRevision:evidenceRevision,sourceSha256:project.source.sha256,
  frameRange:[first,end],observedEvent:change,practice:'one shared parent; no motion or reveal per glyph'};
const observationId='corpus-motion:6:collective-cut';
const evidence={...provenance,id:observationId,kind:'corpus-motion-measurement',key:'collective-cut',origin:'measured',
  values:{heightRatio:change.ratio},policy,body:'やめろよ',fit:summary,identityAssessment:'同じ文字列を目視確認',
  otherPassagesWithinSource:repeatObservation};
const saved=commit(project.id,{baseRevision:evidenceRevision,actor,note:'語全体の縮小と切り替えの検証を保存',
  documents:docs=>({...docs,observations:{...docs.observations,[observationId]:evidence}})});
const primary=phrases[0];
const published=await publishPassage({dir,project,first,end,actor,title:'Lyricsample6 · 語全体の縮小',
  blocks,replacement:primary.scene,replacementLabel:primary.text,documents:{adaptation:{kind:'collective-scale',...provenance}}});
const alternatives=[];
for(const [i,phrase] of phrases.slice(1).entries()) {
  const baselineId=published.outputs.find(output=>output.file==='replacement.mp4').id;
  const generated=saveGeneratedProject(`Lyricsample6 · ${phrase.text}`,phrase.scene,baselineId,actor,{adaptation:{
    kind:'collective-scale',...provenance,text:phrase.text,
  }});
  const movie=await exportVideo(generated.project,generated.scene,{width:640,from:0,to:t(end),layout:'render',withAudio:false});
  const file=`replacement-${i+2}.mp4`;
  await copyFile(movie.path,path.join(dir,file));
  assert.equal((await probe(path.join(dir,file),file)).frameCount,end-first);
  alternatives.push({text:phrase.text,inkSize:phrase.inkSize,projectId:generated.project.id,file});
}
const report={policy,source:provenance,change,otherPassagesWithinSource:repeatObservation,summary,checks:{sameVisibility:true,sharedRecordedTransform:true,
  linearShrinkHasNoOneFrameDrop:true,observedSourceFrames:end-first},capture:'semiautomatic; original phrase continuity checked visually',
  observationRevision:saved.project.revision,primary:{text:primary.text,inkSize:primary.inkSize,...published},alternatives};
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
