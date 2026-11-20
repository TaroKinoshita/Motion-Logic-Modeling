import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {canvasMeasurer,evaluateScene,fontSpec} from '@mlm/core';
import {generatePlannedLyrics,LyricPlanRequest,planLyrics} from '../apps/server/src/lyric-planner.ts';
import {getProject} from '../apps/server/src/store.ts';
import {exportVideo} from '../apps/server/src/export.ts';

const [prior,out]=process.argv.slice(2);
assert.ok(prior&&out);
const folder=path.resolve(out);await mkdir(folder,{recursive:true});
const old=JSON.parse(await readFile(prior,'utf8'));
const source=getProject(old.projectId);
const groups=[
  [0,1.42,[['さあ',0],['皆',.18,true],['舞いな',.40],['空洞で',.92]]],
  [1.42,2.83,[['サンスクリット',1.42],['求道系',2.04,true]]],
  [2.83,5.63,[['抉り抜いた',2.83],['鼓動',3.51,true],['咲かせ',4.22],['咲かせ',4.92]]],
  [5.63,7.02,[['さあ',5.63],['剽悍な',5.94,true],['双眸を',6.47]]],
  [7.02,8.41,[['エーカム',7.02],['そうさ',7.38],['先頭に',7.89,true]]],
  [8.41,11.2,[['真っ赤に',8.41],['濡れた',8.94],['空',9.47,true],['踵',9.90],['鳴らせ',10.25]]],
];
const lines=groups.map(([from,to,words])=>({from,to,tokens:words.map(([text,at,emphasis])=>({text,at,emphasis:!!emphasis}))}));
const replacements=['ほら','遠い地平線','駆け出す','風の中へ','いくつもの街を','追い越して','夜の向こう','光','届けて','届けて','もう','広い世界へ','手を伸ばす','ひとつずつ','確かに','明日へ進む','雨上がり','見上げた','虹','足音','響かせて'];
let cursor=0;
const stress=lines.map(line=>({...line,tokens:line.tokens.map(token=>({...token,text:replacements[cursor++]}))}));
const ctx=createCanvas(1,1).getContext('2d'),measure=canvasMeasurer(ctx);
const results=[];
for(const [key,lyrics] of [['supplied',lines],['replacement',stress]]) {
  const request=LyricPlanRequest.parse({name:'汎用歌詞構成 '+key,baseRevision:source.project.revision,lines:lyrics});
  const built=generatePlannedLyrics(source.project.id,request);
  const scene=built.scene;
  assert.deepEqual(planLyrics(request,{width:scene.width,height:scene.height,fps:scene.fps,duration:scene.duration}).scene,scene);
  const audit={outside:[],overlaps:[],frames:Math.round(scene.duration*scene.fps)};
  for(let frame=0;frame<audit.frames;frame++) {
    const boxes=evaluateScene(scene,frame/scene.fps,measure).filter(ev=>ev.element.type==='text').map(ev=>{
      ctx.font=fontSpec(ev.element);ctx.textAlign='center';ctx.textBaseline='middle';
      const m=ctx.measureText(ev.element.text),[a,b,c,d,x,y]=ev.matrix;
      const points=[-m.actualBoundingBoxLeft,m.actualBoundingBoxRight].flatMap(u=>[-m.actualBoundingBoxAscent,m.actualBoundingBoxDescent]
        .map(v=>[a*u+c*v+x,b*u+d*v+y]));
      const box={id:ev.element.id,l:Math.min(...points.map(p=>p[0])),r:Math.max(...points.map(p=>p[0])),
        t:Math.min(...points.map(p=>p[1])),b:Math.max(...points.map(p=>p[1]))};
      if(box.l<0||box.r>scene.width||box.t<0||box.b>scene.height) audit.outside.push({frame,id:box.id});
      return box;
    });
    for(const [i,a] of boxes.entries()) for(const b of boxes.slice(i+1)) {
      if(Math.min(a.r,b.r)>Math.max(a.l,b.l)+1&&Math.min(a.b,b.b)>Math.max(a.t,b.t)+1) audit.overlaps.push({frame,a:a.id,b:b.id});
    }
  }
  await writeFile(path.join(folder,key+'-audit.json'),JSON.stringify(audit,null,2));
  assert.equal(audit.outside.length,0);
  assert.equal(audit.overlaps.length,0);
  const video=await exportVideo(built.project,scene,{from:0,to:scene.duration,width:1280,layout:'render',withAudio:true,outputTag:'general-planner'});
  await copyFile(video.path,path.join(folder,key+'.mp4'));
  // The blocking stage owns the motion; render it with the same timing for comparison.
  const blockingVideo=await exportVideo(built.blocking.project,built.blocking.scene,{from:0,to:scene.duration,width:1280,layout:'render',withAudio:true,outputTag:'general-planner-blocking'});
  await copyFile(blockingVideo.path,path.join(folder,key+'-blocking.mp4'));
  await writeFile(path.join(folder,key+'-input.json'),JSON.stringify(request,null,2));
  await writeFile(path.join(folder,key+'-scene.json'),JSON.stringify(scene,null,2));
  results.push({key,projectId:built.project.id,revision:built.project.revision,decisions:built.decisions,audit});
}
assert.throws(()=>planLyrics(LyricPlanRequest.parse({baseRevision:1,name:'invalid',lines:[{from:0,to:1,tokens:[{text:'x',at:2}]}]}),
 {width:1920,height:1080,fps:30,duration:11.2}),error=>error.status===422);
execFileSync('ffmpeg',['-v','error','-y','-i',path.join(folder,'supplied.mp4'),'-i',path.join(folder,'replacement.mp4'),
 '-filter_complex','[0:v][1:v]hstack[v]','-map','[v]','-map','0:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy',
 path.join(folder,'comparison.mp4')],{windowsHide:true});
await writeFile(path.join(folder,'report.json'),JSON.stringify({sourceId:source.project.id,
  alignment:'estimated; not vocal-aligned',weightOrigin:'hand-set selection weights; not learned authorship',results},null,2));
console.log('Verified full length and replacements',results.map(r=>({key:r.key,id:r.projectId,arrangements:r.decisions.map(d=>d.arrangement)})));
