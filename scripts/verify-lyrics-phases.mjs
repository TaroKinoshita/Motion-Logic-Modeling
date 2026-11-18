import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { emptyScene, sampleTrack, validateBlocking } from '@mlm/core';
import { getBlocking, exportBlocking } from '../apps/server/src/blocking.ts';
import { editBlocking } from '../apps/server/src/block-edit.ts';
import { exportVideo } from '../apps/server/src/export.ts';
import { generateLyricStudy, LyricGenerationRequest } from '../apps/server/src/lyric-generation.ts';
import { sourcePath } from '../apps/server/src/media.ts';
import { recordGlyphs } from '../apps/server/src/modeling.ts';
import { importMusic } from '../apps/server/src/music.ts';
import { createRepresentative, RepresentativeRequest } from '../apps/server/src/representative.ts';
import { commit, createProject, getDocuments, getProject } from '../apps/server/src/store.ts';
import { saveStyleStudy, StyleStudyRequest } from '../apps/server/src/style-study.ts';
import { applyOrientation, editTiming, TimingRequest } from '../apps/server/src/timing.ts';

const [sourceId, destination] = process.argv.slice(2);
if (!sourceId || !destination) throw new Error('Supply the Lyricsample1 contour project and output directory');
const output=path.resolve(destination);
await fs.mkdir(output,{recursive:true});
const input=getBlocking(sourceId);
assert.equal(input.project.source.sha256,'251ecc12d05d3f000e8ac473b6c9763e8961a19989a89a519823d941bebe9cb3');
const {fps}=input.scene,actor='phase-verification';
const ref=(state)=>({baseRevision:state.project.revision,actor});
const model=(label,fragmentIds,from,to,shapeFrame,geometry)=>createRepresentative(sourceId,RepresentativeRequest.parse({
  ...ref(input),label,fragmentIds,from,to,shapeFrame,geometry,
}));
const report={reference:input.project.id,revision:input.project.revision};
const outputVideo=async (state,file,count)=>{
  const exported=await exportBlocking(state.project.id,960);
  await fs.copyFile(exported.path,path.join(output,file));
  assert.equal(exported.frameCount,count);
  return {projectId:state.project.id,revision:state.project.revision,file};
};

const fragments=['track:lyrics:1','track:lyrics:9'];
const box=await model('各 · 外接矩形',fragments,3,27,21,'box');
const affine=await model('各 · アフィン',fragments,3,27,21,'affine');
const field=await model('田', ['track:lyrics:10'],16,27,16,'affine');
assert.deepEqual(affine.fit.missingFrames,[15]);
assert.ok(affine.fit.affine.metrics.find(row=>row.frame===6).affineIou>affine.fit.affine.metrics.find(row=>row.frame===6).axisAlignedIou+.08);
report.box=await outputVideo(box,'01_box.mp4',24);
report.affine=await outputVideo(affine,'02_affine.mp4',24);
const paneWidth=960,paneHeight=540;
const rawPane=(file,x,y)=>execFileSync('ffmpeg',['-v','error','-i',path.join(output,file),'-vf',`crop=${paneWidth}:${paneHeight}:${x}:${y},format=gray`,
  '-f','rawvideo','-'],{maxBuffer:16*1024*1024,windowsHide:true});
const foregroundIoU=(source,render,frame,[x0,y0,x1,y1],compareFullRender=true)=>{
  const base=(frame-3)*paneWidth*paneHeight;
  let intersection=0,union=0;
  for(let y=0;y<paneHeight;y++) for(let x=0;x<paneWidth;x++) {
    const inside=x>=x0&&x<x1&&y>=y0&&y<y1;
    const index=base+y*paneWidth+x;
    const a=inside&&source[index]<128,b=(compareFullRender||inside)&&render[index]<128;
    intersection+=Number(a&&b);union+=Number(a||b);
  }
  assert.ok(union);
  return intersection/union;
};
const reference=rawPane(report.box.file,0,40),boxMask=rawPane(report.box.file,960,620),affineMask=rawPane(report.affine.file,960,620);
const originals=getDocuments(input.project.id).observations;
const scores=fragments.flatMap(id=>originals[id.replace('track:','contour:')].samples).map(({frame,box:[left,top,w,h]})=>{
  const region=[Math.floor(left/2),Math.floor(top/2),Math.ceil((left+w)/2),Math.ceil((top+h)/2)];
  return {frame,box:foregroundIoU(reference,boxMask,frame,region),affine:foregroundIoU(reference,affineMask,frame,region)};
});
const average=(key)=>scores.reduce((sum,row)=>sum+row[key],0)/scores.length;
report.shapeIoU={frames:scores.length,box:average('box'),affine:average('affine'),frame6:scores.find(row=>row.frame===6),affineKeys:affine.fit.affine.keyCount};
assert.ok(report.shapeIoU.affine>report.shapeIoU.box);

// Manual landmarks read from the original frames. Frame 15 joins the outlines.
// The model uses the independently movable 16F contour for 田 and a single affine pose at 15F.
const after=[[300,501],[604,456],[316,614]],contact=[[697,506],[835,420],[786,650]];
const fieldRow=field.scene.elements[0], fieldChild=field.scene.elements[1];
const affinePose=(from,to,center)=>{
  const vector=(p,q)=>[q[0]-p[0],q[1]-p[1]];
  const [u,v]=[vector(from[0],from[1]),vector(from[0],from[2])];
  const [r,s]=[vector(to[0],to[1]),vector(to[0],to[2])];
  const determinant=u[0]*v[1]-u[1]*v[0];
  const a=(r[0]*v[1]-s[0]*u[1])/determinant,b=(r[1]*v[1]-s[1]*u[1])/determinant;
  const c=(-r[0]*v[0]+s[0]*u[0])/determinant,d=(-r[1]*v[0]+s[1]*u[0])/determinant;
  const [x,y]=vector(from[0],center);
  const scaleX=Math.hypot(a,b),cos=a/scaleX,sin=b/scaleX;
  return {x:to[0][0]+a*x+c*y,y:to[0][1]+b*x+d*y,scaleX,scaleY:cos*d-sin*c,rotation:Math.atan2(sin,cos)*180/Math.PI,shearX:cos*c+sin*d};
};
const center=[sampleTrack(fieldRow.transform.x,16/fps,0),sampleTrack(fieldRow.transform.y,16/fps,0)];
const face=affinePose(after,contact,center);
fieldRow.inPoint=15/fps;
for(const [key,value] of Object.entries(face)) {
  const old=fieldRow.transform[key];
  fieldRow.transform[key]={keys:[{t:15/fps,v:value,ease:'hold'},...(typeof old==='object'?old.keys:[{t:16/fps,v:old??0}])]};
}
const contactDesign=structuredClone(affine.design);
const contactObservation={id:'contact-landmarks-15',kind:'contact-landmarks',origin:'manual',sourceProjectId:sourceId,sourceRevision:input.project.revision,
  sourceSha256:input.project.source.sha256,frame:15,afterFrame:16,after,contact,notes:'Three approximate vertices read from source. No per-frame drawings are stored.'};
field.design.blocks.items[0].observationIds.push(contactObservation.id);
contactDesign.blocks.items.push(field.design.blocks.items[0]);
contactDesign.appearance.push(...field.design.appearance);
const join=contactDesign.events.find(event=>event.id==='kaku-contact');
join.inputs=[fieldRow.id,...fragments.slice(0,1)];
join.outputs=[...join.inputs];
join.observationIds.push(contactObservation.id);
const separate=contactDesign.events.find(event=>event.id==='kaku-separation');
separate.outputs.push(fieldRow.id);
const contactScene={...affine.scene,elements:[...affine.scene.elements,fieldRow,fieldChild]};
validateBlocking(contactScene,contactDesign);
const assembly=createProject('Lyricsample1 · 田＋各の接触',contactScene,actor);
await fs.copyFile(sourcePath(input.project),sourcePath({...assembly.project,source:input.project.source}));
const combined=commit(assembly.project.id,{...ref(assembly),note:'15Fに田と各を独立した形として合成',
  meta:meta=>{meta.source=input.project.source;meta.audioAnalysis=input.project.audioAnalysis;},
  documents:()=>({...contactDesign,observations:{...getDocuments(affine.project.id).observations,...getDocuments(field.project.id).observations,
    [contactObservation.id]:contactObservation}})});
report.contact=await outputVideo(combined,'03_contact.mp4',24);
const contactMask=rawPane(report.contact.file,960,620);
report.contact.unionIoU=foregroundIoU(reference,contactMask,15,[325,172,600,352],false);
const substitute=editBlocking(combined.project.id,{...ref(combined),edit:{kind:'text',blockId:fragments[0],text:'右'}});
assert.deepEqual(substitute.scene.elements[0],combined.scene.elements[0]);
assert.deepEqual(substitute.design.events,JSON.parse(JSON.stringify(contactDesign.events)));
report.substitution=await outputVideo(substitute,'04_contact_replaced.mp4',24);

const clone=createProject('Lyricsample1 · 計測と生成の検証',input.scene,actor);
await fs.copyFile(sourcePath(input.project),sourcePath({...clone.project,source:input.project.source}));
let evidence=commit(clone.project.id,{...ref(clone),note:'検証対象の元映像と観察を保存',
  meta:meta=>{meta.source=input.project.source;meta.audioAnalysis=input.project.audioAnalysis;},documents:()=>getDocuments(sourceId)});
const timing=(state,data)=>editTiming(state.project.id,TimingRequest.parse({...ref(state),...data}));
evidence=timing(evidence,{operation:'orientation',from:150,to:160,label:'何にも',anchors:[['track:lyrics:162','track:lyrics:166'],['track:lyrics:163','track:lyrics:167']]});
const orientation=evidence.observation;
const rotation=await applyOrientation(evidence.project.id,TimingRequest.parse({...ref(evidence),operation:'apply-orientation',
  observationId:orientation.id,shapeFrame:150,partIds:['track:lyrics:162','track:lyrics:165','track:lyrics:163']}));
const rotationTrack=rotation.scene.elements[0].transform.rotation;
assert.ok(Math.abs(sampleTrack(rotationTrack,159/fps,0)-31.4246)<.01);
report.rotation={...await outputVideo(rotation,'05_rotation.mp4',10),degrees:sampleTrack(rotationTrack,159/fps,0),rotationKeys:rotationTrack.keys.length};
evidence=timing(evidence,{operation:'motion',from:16,to:27,blockId:'track:lyrics:9'});
const motion=evidence.observation;
assert.ok(motion.samples.some(row=>row.occupancyRatio>0));
report.motion={stops:motion.stops,samples:motion.samples.length,maxSpeedPxPerS:Math.max(...motion.samples.map(row=>row.speedPxPerS??0)),rms:motion.rmsComparison};
evidence=timing(evidence,{operation:'measure'});
report.audioShiftControl=evidence.shiftControl.groups;
assert.ok(report.audioShiftControl.beat.shiftedHits.length===5);
evidence=recordGlyphs(evidence.project.id,{...ref(evidence),entries:[{relation:'combine',from:71/fps,to:93/fps,combineAt:81/fps,
  parts:[{text:'食'},{text:'反'}],result:{text:'飯'},note:'画面上の合字を記録'}]});
const glyph=evidence.observations[0];
const visualCheckpoint=timing(affine,{operation:'checkpoint',blockId:fragments[0],frame:15,box:[865,380,280,290],
  note:'元動画を拡大して目視した当回担当者の概算。15Fは近似に使っていない。独立採点待ち。'});
report.checkpoint=visualCheckpoint.observation;

const audio=path.join(output,'demo-tone.wav');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=3','-y',audio]);
const audioProject=createProject('規則比較 · 合成音源',{...emptyScene(),width:960,height:540,fps},actor);
let target=await importMusic(audioProject.project.id,{...ref(audioProject),path:audio});
target=commit(target.project.id,{...ref(target),note:'比較用の拍',scene:scene=>({...scene,markers:[0,.42,.92,1.49,2,2.51].map(t=>({t,kind:'beat',origin:'manual'}))})});
const snapshot={projectId:evidence.project.id,revision:evidence.project.revision};
const claim=(id,axis,observationId,generation)=>({id,axis,label:id,condition:'操作確認用の候補範囲',generation,evidence:[{...snapshot,observationId}]});
const study=saveStyleStudy(evidence.project.id,StyleStudyRequest.parse({...ref(evidence),works:[{...snapshot,group:'author',credit:'ユーザー提供素材',
  creditBasis:'映像制作者のクレジットと追加作品は確認待ち。本項目は生成操作の試験。'}],claims:[
    claim('on-entry','motion',motion.id,{unit:'beats',min:.25,max:.45}),
    claim('pause','motion',motion.id,{unit:'seconds',min:.08,max:.14}),
    claim('letter-spacing-time','motion',motion.id,{unit:'seconds',min:.03,max:.06}),
    claim('contrast','screen',motion.id,{unit:'seconds',min:.16,max:.24}),
    claim('compound','meaning',glyph.id,{unit:'seconds',min:.25,max:.35}),
  ]}));
const metrics=id=>study.study.claims.find(claim=>claim.id===id).summary.author.distributions;
assert.equal(metrics('contrast')['box.occupancyRatio.measured'].n,1);
assert.equal(metrics('compound')['combine.partCount'].median,2);
const variants=generateLyricStudy(evidence.project.id,LyricGenerationRequest.parse({...ref(study),targetProjectId:target.project.id,targetRevision:target.project.revision,
  name:'新しい歌詞 · 比較',lyrics:[{text:'星がほどける',ruby:'ほし',tags:['複数文字'],from:.15,to:1.35},{text:'休',ruby:'やすむ',parts:['亻','木'],tags:['字の見立て'],from:1.45,to:2.9}],
  effects:[{claimId:'on-entry',kind:'entrance'},{claimId:'pause',kind:'hold',tag:'複数文字',metric:'stop.seconds.measured'},
    {claimId:'letter-spacing-time',kind:'stagger',tag:'複数文字'},{claimId:'contrast',kind:'invert'},{claimId:'compound',kind:'combine',tag:'字の見立て'}]}));
assert.equal(variants.variants.length,7);
report.generation=[];
for(const entry of variants.variants) {
  const state=getProject(entry.project.id),condition=variants.reveal[entry.label];
  assert.equal(state.project.source.sha256,target.project.source.sha256);
  assert.equal(state.scene.elements.some(el=>el.id.includes(':invert')),condition!=='baseline'&&condition!=='without:contrast');
  assert.equal(state.scene.elements.some(el=>el.id.includes(':part:')),condition!=='baseline'&&condition!=='without:compound');
  const first=state.scene.elements.find(el=>el.id==='line:1:group').transform.y;
  const second=state.scene.elements.find(el=>el.id==='line:2:group').transform.y;
  assert.equal(typeof second==='object',condition!=='baseline'&&condition!=='without:on-entry');
  assert.equal(first?.keys?.some(key=>key.ease==='hold')??false,condition!=='baseline'&&condition!=='without:pause');
  assert.equal(state.scene.elements.some(el=>el.stagger),condition!=='baseline'&&condition!=='without:letter-spacing-time');
  const render=await exportVideo(state.project,state.scene,{from:0,to:3,width:960,layout:'render',withAudio:true});
  const file=`06_lyric_${entry.label}.mp4`;
  await fs.copyFile(render.path,path.join(output,file));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,nb_read_frames','-of','json',path.join(output,file)],{encoding:'utf8'}));
  assert.equal(Number(probe.streams.find(stream=>stream.codec_type==='video').nb_read_frames),72);
  assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
  report.generation.push({label:entry.label,condition,projectId:entry.project.id,file});
}
const tileWidth=480,tileHeight=270,columns=3,rows=Math.ceil(report.generation.length/columns);
const overlay=createCanvas(columns*tileWidth,rows*tileHeight);
const context=overlay.getContext('2d');
context.font='bold 18px sans-serif';
context.textBaseline='middle';
const slots=report.generation.map((entry,i)=>{
  const x=i%columns*tileWidth,y=Math.floor(i/columns)*tileHeight;
  context.fillStyle='#243247';context.fillRect(x+8,y+8,28,26);
  context.fillStyle='#ffffff';context.fillText(entry.label,x+16,y+21);
  return `${x}_${y}`;
});
const caption=path.join(output,'.comparison-labels.png');
await fs.writeFile(caption,await overlay.encode('png'));
const filters=report.generation.map((_,i)=>`[${i}:v]scale=${tileWidth}:${tileHeight},setsar=1[t${i}]`).join(';');
const ready=report.generation.map((_,i)=>`[t${i}]`).join('');
report.generationComparison='07_lyric_comparison.mp4';
try {
  execFileSync('ffmpeg',['-v','error','-y',...report.generation.flatMap(entry=>['-i',path.join(output,entry.file)]),'-i',caption,
    '-filter_complex_threads','1','-filter_complex',`${filters};${ready}xstack=inputs=${slots.length}:layout=${slots.join('|')}:fill=0x222222:shortest=1[g];[g][${slots.length}:v]overlay[v]`,
    '-map','[v]','-map','0:a:0','-c:a','copy','-c:v','libx264','-pix_fmt','yuv420p','-frames:v','72',path.join(output,report.generationComparison)],{windowsHide:true});
} finally {await fs.rm(caption,{force:true});}
report.studyProjectId=study.project.id;
report.studyRevision=study.project.revision;
assert.equal(getProject(sourceId).project.revision,input.project.revision);
await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(output,'generation_conditions.json'),JSON.stringify(variants.reveal,null,2));
console.log(JSON.stringify({output,report},null,2));
