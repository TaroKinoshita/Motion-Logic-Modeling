// Round-trip test of a reference scene through the generator (docs/49).
// (a) the reconstructed original 「食＋反→飯」 (Lyricsample1 71-91F),
// (b) the same scene passed through the generator with the original text and timing,
// (c) the same scene with 「穴＋工→空」.
// Measures on the block layer: part spacing / part height, result height / part height,
// frames from parts vanishing to the result appearing, and the inversion frame.
// Usage: node scripts/verify-scene-roundtrip.mjs <out folder>
import assert from 'node:assert/strict';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {emptyScene,evaluateScene,canvasMeasurer} from '@mlm/core';
import {createCanvas} from '@napi-rs/canvas';
import {PASSAGES} from '../apps/server/src/passage-library.ts';
import {loadPassage,retarget,seeded} from '../apps/server/src/passage-staging.ts';
import {dressLyricBlocks} from '../apps/server/src/lyric-planner.ts';
import {getProject} from '../apps/server/src/store.ts';
import {exportVideo} from '../apps/server/src/export.ts';

const out=path.resolve(process.argv[2]??'data/Scene_Roundtrip');
await mkdir(out,{recursive:true});
const spec=PASSAGES.find(p=>p.id==='L1-meshi');
const p=loadPassage(spec);
const source=getProject(spec.projectId);
const fps=p.fps,W=p.width,H=p.height,from=spec.from,to=spec.to;
const measure=canvasMeasurer(createCanvas(1,1).getContext('2d'));

function build(texts) {
  const tokens=p.textSlots.map((slot,i)=>({text:texts[i],at:Math.max(p.fromSec,slot.inSec),emphasis:i===2}));
  const built=retarget(p,tokens,p.fromSec,p.toSec,'rt',{width:W,height:H,fps,duration:p.toSec,rng:seeded(1),mode:'faithful'});
  const scene={...emptyScene(),width:W,height:H,fps,duration:p.toSec,background:'#eee8dc',elements:[
    {id:'bg',type:'rect',zIndex:-1000,width:W,height:H,fill:'#eee8dc',inPoint:p.fromSec,outPoint:p.toSec,transform:{x:W/2,y:H/2}},
    ...built.darkRanges.map(([a,b],d)=>({id:'dark'+d,type:'rect',zIndex:-999,width:W,height:H,fill:'#1d2a2c',inPoint:a,outPoint:b,transform:{x:W/2,y:H/2}})),
    ...built.elements],markers:[]};
  return {blocks:scene,dressed:dressLyricBlocks(scene,built.bindings),darkRanges:built.darkRanges};
}
const same=build(['食','反','飯']), swapped=build(['穴','工','空']);

// Map slot index -> group id in each version.
const sourceIds=spec.slots.map(s=>s.group), genIds=spec.slots.map((_,i)=>'rt:'+i);
function boxes(scene,ids,frame) {
  const t=(frame+.5)/fps, res={};
  for(const ev of evaluateScene(scene,t,measure)) {
    const k=ids.indexOf(ev.element.parentId); if(k<0||ev.element.type!=='rect') continue;
    const [a,b,c,d,x,y]=ev.matrix, w=ev.element.width??0, h=ev.element.height??0;
    const pts=[[-w/2,-h/2],[w/2,-h/2],[-w/2,h/2],[w/2,h/2]].map(([u,v])=>[a*u+c*v+x,b*u+d*v+y]);
    const xs=pts.map(q=>q[0]),ys=pts.map(q=>q[1]);
    res[k]={cx:(Math.min(...xs)+Math.max(...xs))/2,cy:(Math.min(...ys)+Math.max(...ys))/2,w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
  }
  return res;
}
function metrics(scene,ids,darkStart) {
  const rows=[];
  for(let f=from;f<=to;f++) rows.push({f,b:boxes(scene,ids,f)});
  const pairFrames=rows.filter(r=>r.b[0]&&r.b[1]);
  const mid=pairFrames[Math.floor(pairFrames.length/2)];
  const partH=mid?(mid.b[0].h+mid.b[1].h)/2:NaN;
  const spacing=mid?Math.abs(mid.b[1].cx-mid.b[0].cx)/partH:NaN;
  const lastPart=Math.max(...rows.filter(r=>r.b[0]||r.b[1]).map(r=>r.f));
  const firstResult=Math.min(...rows.filter(r=>r.b[2]).map(r=>r.f));
  const resultRow=rows.filter(r=>r.b[2]).at(-1);
  return {partSpacingOverPartHeight:+spacing.toFixed(3),resultHeightOverPartHeight:+(resultRow.b[2].h/partH).toFixed(3),
    lastPartFrame:lastPart,firstResultFrame:firstResult,partsToResultFrames:firstResult-lastPart,inversionFrame:darkStart,
    partCenters:mid?[[Math.round(mid.b[0].cx),Math.round(mid.b[0].cy)],[Math.round(mid.b[1].cx),Math.round(mid.b[1].cy)]]:null};
}
const result={
  original:metrics(source.scene,sourceIds,spec.dark[0][0]),
  sameInput:metrics(same.blocks,genIds,Math.round(same.darkRanges[0][0]*fps)),
  swapped:metrics(swapped.blocks,genIds,Math.round(swapped.darkRanges[0][0]*fps)),
};
console.log(JSON.stringify(result,null,1));
for(const k of ['partSpacingOverPartHeight','resultHeightOverPartHeight'])
  assert.ok(Math.abs(result.sameInput[k]-result.original[k])<.15*Math.abs(result.original[k]),k+' drifted in the round trip');
for(const k of ['partsToResultFrames','inversionFrame']) assert.ok(Math.abs(result.sameInput[k]-result.original[k])<=1,k+' drifted');

// Three panels: original reconstruction | same input through generator | 穴工空
const opts={from:p.fromSec,to:p.toSec,width:640,layout:'render',withAudio:false};
const files=[];
for(const [name,scene] of [['a-original',source.scene],['b-same',same.dressed],['c-swapped',swapped.dressed]]) {
  const v=await exportVideo(source.project,scene,{...opts,outputTag:'roundtrip-'+name});
  const target=path.join(out,name+'.mp4');await copyFile(v.path,target);files.push(target);
}
execFileSync('ffmpeg',['-v','error','-y',...files.flatMap(f=>['-i',f]),'-filter_complex','[0:v][1:v][2:v]hstack=inputs=3[v]','-map','[v]',
  '-c:v','libx264','-pix_fmt','yuv420p',path.join(out,'roundtrip.mp4')],{windowsHide:true});
await writeFile(path.join(out,'report.json'),JSON.stringify({passage:spec.id,frames:[from,to],result},null,2));
console.log('wrote',path.join(out,'roundtrip.mp4'));
