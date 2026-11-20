// Diagnose the bar scene (L4-bar) in three versions (docs/50 step 2):
// (a) the reconstructed original, (b) the same words through the generator, (c) new words.
// For every frame, the squash of each text element = horizontal / vertical scale of its world matrix.
// Reports the normal (median) squash, the extreme, frames beyond 1.5x, and frames from the last strong
// squash (>1.3x) to the element leaving.
// Usage: node scripts/diagnose-bar-scene.mjs <out folder>
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {canvasMeasurer,emptyScene,evaluateScene} from '@mlm/core';
import {PASSAGES} from '../apps/server/src/passage-library.ts';
import {loadPassage,retarget,seeded} from '../apps/server/src/passage-staging.ts';
import {dressLyricBlocks} from '../apps/server/src/lyric-planner.ts';
import {getProject} from '../apps/server/src/store.ts';
import {exportVideo} from '../apps/server/src/export.ts';

const out=path.resolve(process.argv[2]??'data/Bar_Diagnosis');
await mkdir(out,{recursive:true});
const spec=PASSAGES.find(p=>p.id==='L4-bar');
const p=loadPassage(spec);
const source=getProject(spec.projectId);
const measure=canvasMeasurer(createCanvas(1,1).getContext('2d'));
function build(texts) {
  const tokens=p.textSlots.map((slot,i)=>({text:texts[i],at:Math.max(p.fromSec,slot.inSec),emphasis:false}));
  const built=retarget(p,tokens,p.fromSec,p.toSec,'bar',{width:p.width,height:p.height,fps:p.fps,duration:p.toSec,rng:seeded(1),mode:'faithful'});
  const scene={...emptyScene(),width:p.width,height:p.height,fps:p.fps,duration:p.toSec,background:'#eee8dc',elements:[
    {id:'bg',type:'rect',zIndex:-1000,width:p.width,height:p.height,fill:'#eee8dc',inPoint:p.fromSec,outPoint:p.toSec,transform:{x:p.width/2,y:p.height/2}},...built.elements],markers:[]};
  return dressLyricBlocks(scene,built.bindings);
}
const textGroups=new Set(spec.slots.filter(s=>s.role==='text').map(s=>s.group));
function squash(scene,isText) {
  const per=new Map();
  for(let f=spec.from;f<=spec.to;f++) for(const ev of evaluateScene(scene,(f+.5)/p.fps,measure)) {
    if(ev.element.type!=='text'||!isText(ev.element)) continue;
    const [a,b,c,d]=ev.matrix, r=Math.hypot(a,b)/Math.max(1e-9,Math.hypot(c,d));
    const key=ev.element.id;const list=per.get(key)??[];list.push({f,r});per.set(key,list);
  }
  return [...per.entries()].map(([id,list])=>{
    const rs=list.map(x=>x.r).sort((x,y)=>x-y);
    const lastStrong=Math.max(-1,...list.filter(x=>x.r>1.3||x.r<1/1.3).map(x=>x.f));
    const lastFrame=list.at(-1).f;
    return {id,frames:list.length,median:+rs[Math.floor(rs.length/2)].toFixed(3),max:+Math.max(...rs.map(r=>Math.max(r,1/r))).toFixed(3),
      over1_5:list.filter(x=>x.r>1.5||x.r<1/1.5).length,framesReadableBeforeExit:lastStrong<0?list.length:lastFrame-lastStrong};
  });
}
// Source text children may be split into character units: group them by element id.
const original=squash(source.scene,e=>textGroups.has(e.parentId));
const same=squash(build(['行き詰まって','行き詰まって 時が']),e=>e.id.startsWith('bar:'));
const fresh=squash(build(['咲かせ','咲かせ']),e=>e.id.startsWith('bar:'));
const result={original,same,fresh};
console.log(JSON.stringify(result,null,1));
const files=[];
for(const [name,scene] of [['a-original',source.scene],['b-same',build(['行き詰まって','行き詰まって 時が'])],['c-new',build(['咲かせ','咲かせ'])]]) {
  const v=await exportVideo(source.project,scene,{from:p.fromSec,to:p.toSec,width:640,layout:'render',withAudio:false,outputTag:'bar-'+name});
  const target=path.join(out,name+'.mp4');await copyFile(v.path,target);files.push(target);
}
execFileSync('ffmpeg',['-v','error','-y',...files.flatMap(f=>['-i',f]),'-filter_complex','[0:v][1:v][2:v]hstack=inputs=3[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',path.join(out,'bar-three.mp4')],{windowsHide:true});
await writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));
