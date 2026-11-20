// Verify passage retargeting (docs/45) and render Test_audio1 with it.
// 1. Identity: each passage re-timed to its own source timing reproduces the source transform keys.
// 2. Full generation (supplied and replacement lyrics) with the passage method; blocking and final videos.
// 3. Three-panel comparison: rules baseline | blocking | passage final.
// Usage: node scripts/verify-passage-staging.mjs <Test_audio1_Production/report.json> <rules folder> <out folder>
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {PASSAGES} from '../apps/server/src/passage-library.ts';
import {loadPassage,retarget} from '../apps/server/src/passage-staging.ts';
import {generatePlannedLyrics,LyricPlanRequest,buildLyrics} from '../apps/server/src/lyric-planner.ts';
import {getProject} from '../apps/server/src/store.ts';
import {sourcePath} from '../apps/server/src/media.ts';
import {exportVideo} from '../apps/server/src/export.ts';

const [prior,rulesFolder,out]=process.argv.slice(2);
assert.ok(prior&&rulesFolder&&out);
const folder=path.resolve(out);await mkdir(folder,{recursive:true});

// 1. Identity
const identity=[];
for(const spec of PASSAGES) {
  const p=loadPassage(spec);
  const tokens=p.textSlots.map(slot=>({text:'字',at:Math.max(p.fromSec,slot.inSec),emphasis:false}));
  const built=retarget(p,tokens,p.fromSec,p.toSec,'id',{width:p.width,height:p.height,fps:p.fps,duration:p.toSec});
  // Identity covers the position/rotation/shear keys; text scale is rewritten by the recovery rule.
  let compared=0,maxError=0;
  for(const slot of p.slots) {
    const copy=built.elements.find(e=>e.id===`id:${slot.index}`);
    if(!copy) continue;
    for(const name of (slot.role==='text'?['x','y','rotation']:['x','y','scaleX','scaleY','rotation'])) {
      const a=slot.group.transform?.[name],b=copy.transform?.[name];
      if(a===undefined) continue;
      const keysA=typeof a==='number'?[{t:0,v:a}]:a.keys.filter(k=>k.t>=p.fromSec-1e-9&&k.t<=p.toSec+1e-9);
      const value=(track,t)=>{
        if(typeof track==='number') return track;
        const ks=track.keys;let v=ks[0].v;for(const k of ks) if(k.t<=t+1e-9) v=k.v;return v;
      };
      for(const k of keysA) {compared++;maxError=Math.max(maxError,Math.abs(value(b,typeof a==='number'?p.fromSec:k.t)-k.v));}
    }
  }
  identity.push({passage:spec.id,comparedKeys:compared,maxKeyError:maxError});
  assert.ok(maxError<1e-6,`${spec.id} identity error ${maxError}`);
}

// 2. Full generation
const old=JSON.parse(await readFile(prior,'utf8'));
const source=getProject(old.projectId);
const inputs={
  supplied:JSON.parse(await readFile(path.join(rulesFolder,'supplied-input.json'),'utf8')),
  replacement:JSON.parse(await readFile(path.join(rulesFolder,'replacement-input.json'),'utf8')),
};
const results=[];
for(const [key,raw] of Object.entries(inputs)) {
  const request=LyricPlanRequest.parse({...raw,method:'passage',baseRevision:source.project.revision,name:'参考パッセージ構成 '+key});
  const built=generatePlannedLyrics(source.project.id,request);
  const scene=built.scene;
  const again=buildLyrics(request,{width:scene.width,height:scene.height,fps:scene.fps,duration:scene.duration,audioPath:sourcePath(source.project)});
  assert.deepEqual(again.scene,scene);
  const video=await exportVideo(built.project,scene,{from:0,to:scene.duration,width:1280,layout:'render',withAudio:true,outputTag:'passage'});
  await copyFile(video.path,path.join(folder,key+'.mp4'));
  const blocking=await exportVideo(built.blocking.project,built.blocking.scene,{from:0,to:scene.duration,width:1280,layout:'render',withAudio:true,outputTag:'passage-blocking'});
  await copyFile(blocking.path,path.join(folder,key+'-blocking.mp4'));
  await writeFile(path.join(folder,key+'-scene.json'),JSON.stringify(scene,null,1));
  results.push({key,projectId:built.project.id,blockingProjectId:built.blocking.project.id,decisions:built.decisions,audit:built.audit,entrances:again.entrances,loudness:again.loudness});
}

// 3. Comparison
for(const key of ['supplied','replacement']) {
  execFileSync('ffmpeg',['-v','error','-y','-i',path.join(rulesFolder,key+'.mp4'),'-i',path.join(folder,key+'-blocking.mp4'),'-i',path.join(folder,key+'.mp4'),
    '-filter_complex','[0:v]scale=854:480[a];[1:v]scale=854:480[b];[2:v]scale=854:480[c];[a][b][c]hstack=inputs=3[v]',
    '-map','[v]','-map','2:a','-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-c:a','aac',path.join(folder,key+'-rules-blocking-passage.mp4')],{windowsHide:true});
}
await writeFile(path.join(folder,'report.json'),JSON.stringify({identity,results,
  note:'passages curated from reconstructions; selection scores are design values; timing estimated, not vocal-aligned'},null,2));
console.log('identity',identity.map(r=>`${r.passage}:${r.comparedKeys}`).join(' '));
for(const r of results) console.log(r.key,r.decisions.map(d=>`(${d.intensity.toFixed(2)} ${d.camera.join(',')}) `+d.chunks.map(c=>`${c.passage}[${c.tokens.join('/')}]${c.reasons.length?'{'+c.reasons.join(',')+'}':''}`).join(' + ')).join(' | '));
