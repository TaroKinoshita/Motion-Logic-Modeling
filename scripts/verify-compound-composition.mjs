import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {canvasMeasurer,evaluateScene,fontSpec,sampleTrack} from '@mlm/core';
import {exportVideo} from '../apps/server/src/export.ts';
import {generateLyricStudy,LyricGenerationRequest} from '../apps/server/src/lyric-generation.ts';
import {getProject} from '../apps/server/src/store.ts';

const [libraryId,targetId,output]=process.argv.slice(2);
if(!libraryId||!targetId||!output) throw new Error('Supply the motion library, synthetic audio project and output folder');
const dir=path.resolve(output);
await mkdir(dir,{recursive:true});
const library=getProject(libraryId),target=getProject(targetId);
const input=LyricGenerationRequest.parse({baseRevision:library.project.revision,targetProjectId:targetId,targetRevision:target.project.revision,
  actor:'composition-verification',name:'歌詞映像 · 構図と合字の比較',comparison:'composition-compound',effects:[
    {kind:'entrance',claimId:'on-entry',tag:'歌詞'},{kind:'combine',claimId:'compound',tag:'合字'},
  ],lyrics:[
    {text:'木目をたどる',from:.08,to:.94,tags:['歌詞'],layout:{x:.34,y:.41,size:.115,letterSpacing:.1},
      motion:[{id:'slide',duration:.42,strength:.7}]},
    {text:'相',ruby:'そう',parts:['木','目'],from:.96,to:2.36,tags:['合字'],layout:{x:.48,y:.49,size:.31,readingRatio:.14},
      partLayouts:[{x:.39,y:.46,size:.32},{x:.67,y:.56,size:.22}],compoundShot:{delayFrames:1,layout:{x:.54,y:.58,size:.65}},
      glyphMotion:[{index:0,motion:[{id:'squash',duration:.38,strength:.36}]}]},
    {text:'明',ruby:'めい',parts:['日','月'],from:2.4,to:3.82,tags:['合字'],layout:{x:.54,y:.49,size:.32,readingRatio:.14},
      partLayouts:[{x:.29,y:.45,size:.22},{x:.62,y:.49,size:.34}],compoundShot:{delayFrames:1,layout:{x:.43,y:.57,size:.69}},
      glyphMotion:[{index:0,motion:[{id:'rotate',duration:.4,strength:.32,offset:.18}]}]},
    {text:'朝が来る',from:3.86,to:4.95,tags:['歌詞'],layout:{x:.65,y:.62,size:.15,letterSpacing:.14},
      glyphMotion:[{index:3,motion:[{id:'exit',duration:.38,strength:.8}]}]},
  ]});
const invalid=(patch)=>({...input,lyrics:input.lyrics.map((line,i)=>i===1?{...line,...patch}:line)});
assert.throws(()=>generateLyricStudy(libraryId,invalid({partLayouts:input.lyrics[1].partLayouts.slice(0,1)})),e=>e.status===422);
assert.throws(()=>generateLyricStudy(libraryId,invalid({to:1.65,compoundShot:{delayFrames:24}})),e=>e.status===422);
assert.throws(()=>generateLyricStudy(libraryId,{...input,comparison:'motion-layout'}),e=>e.status===422);
const generated=generateLyricStudy(libraryId,input);
assert.deepEqual(generated.compoundEvents.filter(Boolean).map(({resultFrame,shotFrame})=>[resultFrame,shotFrame]),[[31,32],[65,66]]);
const ctx=createCanvas(1,1).getContext('2d'),measure=canvasMeasurer(ctx);
const results=[];
let sequences;
for(const variant of generated.variants) {
  const {project,scene}=getProject(variant.project.id);
  const condition=generated.reveal[variant.label];
  const composed=['composition','composition-compound'].includes(condition);
  const reversed=['compound-cut','composition-compound'].includes(condition);
  assert.equal(project.source.sha256,target.project.source.sha256);
  const signature=[];
  let outside=0,bodyOverlap=0,readingOverlap=0;
  for(let frame=0;frame<120;frame++) {
    const t=frame/scene.fps,shown=evaluateScene(scene,t,measure).filter(element=>element.opacity>0);
    const glyphs=shown.filter(element=>element.element.type==='text');
    signature.push(glyphs.map(element=>element.element.text).join('|'));
    const boxes=glyphs.map(({element,matrix})=>{
      ctx.font=fontSpec(element);ctx.textAlign='center';ctx.textBaseline='middle';
      const ink=ctx.measureText(element.text);
      const [a,b,c,d,x,y]=matrix;
      const corners=[-ink.actualBoundingBoxLeft,ink.actualBoundingBoxRight].flatMap(u=>[-ink.actualBoundingBoxAscent,ink.actualBoundingBoxDescent]
        .map(v=>[a*u+c*v+x,b*u+d*v+y]));
      return {element,l:Math.min(...corners.map(p=>p[0])),r:Math.max(...corners.map(p=>p[0])),
        t:Math.min(...corners.map(p=>p[1])),b:Math.max(...corners.map(p=>p[1]))};
    });
    outside+=boxes.filter(box=>box.l<0||box.t<0||box.r>scene.width||box.b>scene.height).length;
    for(const [index,a] of boxes.entries()) for(const b of boxes.slice(index+1)) {
      if(Math.min(a.r,b.r)-Math.max(a.l,b.l)<=1||Math.min(a.b,b.b)-Math.max(a.t,b.t)<=1) continue;
      if([a,b].some(box=>box.element.id.includes(':ruby:'))) readingOverlap++;
      else if(![a,b].every(box=>box.element.id.includes(':part:'))) bodyOverlap++;
    }
  }
  sequences??=signature;
  assert.deepEqual(signature,sequences);
  const shots=generated.compoundEvents.filter(Boolean).map(({line,resultFrame,shotFrame})=>{
    const camera=scene.elements.find(e=>e.id===`line:${line}:camera`);
    assert.equal(!!camera,composed);
    const inverted=(frame)=>evaluateScene(scene,frame/scene.fps,measure).some(e=>e.element.id.startsWith(`line:${line}:invert`));
    assert.equal(inverted(resultFrame),false);
    assert.equal(inverted(shotFrame),reversed);
    assert.equal(sampleTrack(camera?.transform?.scaleX,resultFrame/scene.fps,1),1);
    const scale=sampleTrack(camera?.transform?.scaleX,shotFrame/scene.fps,1);
    assert.equal(scale>1.9,composed);
    return {line,resultFrame,shotFrame,scale};
  });
  assert.equal(outside,0,`${condition}: visible ink extends off frame`);
  assert.equal(bodyOverlap,0,`${condition}: lyric overlap`);
  assert.equal(readingOverlap,0,`${condition}: ruby overlap`);
  const movie=await exportVideo(project,scene,{from:0,to:5,width:960,layout:'render',withAudio:true});
  assert.equal(movie.frameCount,120);
  assert.ok(movie.hasAudio);
  const file=`${variant.label}.mp4`;
  await copyFile(movie.path,path.join(dir,file));
  results.push({label:variant.label,condition,projectId:project.id,file,shots,outside,bodyOverlap,readingOverlap});
}
const captions=createCanvas(1920,1080),labelCtx=captions.getContext('2d');
labelCtx.font='700 25px Arial';labelCtx.textBaseline='middle';
for(const [i,result] of results.entries()) {
  const x=i%2*960+16,y=Math.floor(i/2)*540+16;
  labelCtx.fillStyle='#354252';labelCtx.fillRect(x,y,41,35);
  labelCtx.fillStyle='#fafafa';labelCtx.fillText(result.label,x+12,y+18);
}
const overlay=path.join(dir,'.review-labels.png');
await writeFile(overlay,await captions.encode('png'));
try {
  execFileSync('ffmpeg',['-v','error','-y',...results.flatMap(r=>['-i',path.join(dir,r.file)]),'-i',overlay,'-filter_complex_threads','1',
    '-filter_complex','[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|960_0|0_540|960_540:shortest=1[q];[q][4:v]overlay[v]',
    '-map','[v]','-map','0:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy','-frames:v','120',path.join(dir,'comparison.mp4')]);
} finally {await rm(overlay,{force:true});}
const full=results.find(result=>result.condition==='composition-compound');
await copyFile(path.join(dir,full.file),path.join(dir,'full.mp4'));
const report={libraryId,libraryRevision:library.project.revision,targetId,targetRevision:target.project.revision,compoundEvents:generated.compoundEvents,
  results,frameCount:120,commonTextTiming:true,commonMusic:true,overlapMethod:'transformed per-element ink bounds; excludes intentional part-to-part convergence'};
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
