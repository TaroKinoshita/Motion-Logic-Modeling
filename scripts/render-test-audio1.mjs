import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene,evaluateScene,canvasMeasurer,fontSpec} from '@mlm/core';
import {createProject,commit,getProject,listProjects} from '../apps/server/src/store.ts';
import {importMusic} from '../apps/server/src/music.ts';
import {exportVideo} from '../apps/server/src/export.ts';
import '../apps/server/src/fonts.ts';

const [audioFile,out]=process.argv.slice(2);
assert.ok(audioFile&&out);
const folder=path.resolve(out);
await mkdir(folder,{recursive:true});
const sourceSha256=createHash('sha256').update(await readFile(audioFile)).digest('hex');
const fps=30,W=1920,H=1080,duration=336/fps;
const actor='test-audio1-production';
const existing=listProjects().find(p=>p.name==='Test_audio1 · 歌詞映像 第一稿');
let state=existing?getProject(existing.id):createProject('Test_audio1 · 歌詞映像 第一稿',{...emptyScene(),width:W,height:H,fps,duration},actor);
if(!state.project.source) state=await importMusic(state.project.id,{baseRevision:state.project.revision,path:path.resolve(audioFile),actor});
const C={paper:'#eae5d9',ink:'#172e30',red:'#c94631',muted:'#83928a'};
const T=(rows)=>({keys:rows.map(([t,v,ease='hold'])=>({t:Math.round(t*fps)/fps,v,ease}))});
const ctx=createCanvas(1,1).getContext('2d');
const elements=[], cues=[];
const sections=[
  {a:0,b:1.42,bg:C.paper,ink:C.ink},
  {a:1.42,b:2.83,bg:C.ink,ink:C.paper},
  {a:2.83,b:5.63,bg:C.paper,ink:C.ink},
  {a:5.63,b:7.02,bg:C.red,ink:C.paper},
  {a:7.02,b:8.41,bg:C.paper,ink:C.ink},
  {a:8.41,b:duration,bg:C.ink,ink:C.paper},
];
const F=t=>Math.round(t*fps)/fps;
for(const [i,s] of sections.entries()) {
  s.a=F(s.a);s.b=F(s.b);s.id='section-'+i;
  elements.push({id:s.id,type:'group',inPoint:s.a,outPoint:s.b,
    transform:{x:0,y:0}});
  elements.push({id:s.id+'-background',type:'rect',width:W,height:H,fill:s.bg,inPoint:s.a,outPoint:s.b,
    transform:{x:W/2,y:H/2}});
}
function text(s,key,body,start,x,y,size,maxWidth,opts={}) {
  start=F(start);
  const stop=F(opts.stop??s.b);
  const font={fontFamily:'MLM BIZ UD Gothic',fontWeight:700,fontSize:size};
  ctx.font=fontSpec(font);
  size*=Math.min(1,maxWidth/ctx.measureText(body).width);
  font.fontSize=size;
  const id=s.id+'-'+key;
  const end=F(Math.min(stop-1/fps,start+(opts.entry??.20)));
  const inkWidth=ctx.measureText(body).width*Math.min(1,maxWidth/ctx.measureText(body).width);
  const initialX=Math.max(45+inkWidth/2,Math.min(1875-inkWidth/2,x+(opts.dx??130)));
  const tx=T([[start,initialX,'easeOut'],[end,x]]);
  const ty=T([[start,y+(opts.dy??35),'easeOut'],[end,y]]);
  const scale=T([[start,opts.squash??.80,'easeOut'],[end,1]]);
  const rotation=opts.rotation?T([[start,opts.rotation+7,'easeOut'],[end,opts.rotation]]):0;
  elements.push({id,type:'text',name:body,text:body,...font,fontSize:size,fill:opts.fill??s.ink,parentId:s.id,
    inPoint:start,outPoint:stop,transform:{x:tx,y:ty,scaleX:scale,scaleY:1,rotation}});
  cues.push({text:body,t:start,to:stop,id,confidence:'estimated from phrase lengths and audio pulse'});
  return id;
}
function rule(s,key,x,y,length,start,vertical=false,color=C.red) {
  start=F(start);
  const end=F(Math.min(start+.23,s.b-1/fps));
  elements.push({id:s.id+'-'+key,parentId:s.id,type:'rect',fill:color,width:vertical?5:length,height:vertical?length:5,
    inPoint:start,outPoint:s.b,transform:{x,y,scaleX:vertical?1:T([[start,.01,'easeOut'],[end,1]]),
      scaleY:vertical?T([[start,.01,'easeOut'],[end,1]]):1}});
}
// One visual grammar per phrase, with a persistent anchor and changing scale.
let s=sections[0];
text(s,'cue','さあ',.0,265,200,72,280,{dx:-50,fill:C.red});
text(s,'lead','皆',.18,405,545,445,490,{dx:-160,squash:.42});
text(s,'phrase','舞いな',.40,1045,484,216,920,{dx:230,rotation:-5});
text(s,'answer','空洞で',.92,1240,803,148,790,{dy:130,dx:0,fill:C.red});
rule(s,'underline',1040,655,810,.4);
rule(s,'pillar',760,495,390,.2,true,C.muted);
s=sections[1];
text(s,'mantra','サンスクリット',1.42,855,331,161,1470,{dx:-260,squash:.65});
text(s,'way','求道',2.04,697,690,337,970,{dx:180,squash:.55});
text(s,'system','系',2.30,1392,731,228,490,{dy:-200,dx:0,fill:'#e3a875'});
rule(s,'divider',932,457,1480,1.42,false,'#e3a875');
s=sections[2];
text(s,'cut','抉り抜いた',2.83,567,213,117,970,{dx:-190,fill:C.red});
text(s,'heart','鼓動',3.51,702,542,375,1110,{dy:140,dx:0,squash:.50});
text(s,'bloom1','咲かせ',4.22,1400,780,176,760,{dx:240,rotation:-7});
text(s,'bloom2','咲かせ',4.92,1453,337,176,700,{dy:-160,dx:0,rotation:7,fill:C.red});
rule(s,'cutline',704,823,1060,3.51);
rule(s,'axis',1172,510,620,4.22,true,C.muted);
// Pulse only the parent of the anchored word, with a held recovery.
const heart=elements.find(e=>e.id===s.id+'-heart');
heart.transform.scaleY=T([[3.51,.58,'easeOut'],[3.72,1],[4.20,1],[4.23,.88,'easeOut'],[4.36,1]]);
s=sections[3];
text(s,'cue','さあ',5.63,246,188,70,300,{fill:C.ink,dx:-70});
text(s,'fierce','剽悍な',5.94,626,459,226,1120,{dx:-180,squash:.65});
text(s,'eyes','双眸を',6.47,1195,790,224,1090,{dy:150,dx:0});
rule(s,'upper',1000,224,1170,5.94,false,C.ink);
rule(s,'middle',951,610,1500,6.47,false,C.paper);
s=sections[4];
text(s,'ekam','エーカム',7.02,558,326,182,960,{dx:-190});
text(s,'yes','そうさ',7.38,1391,434,105,640,{dx:170,fill:C.red,rotation:-8});
text(s,'front','先頭に',7.89,1090,767,278,1370,{dy:90,dx:0,squash:.65});
rule(s,'forward',538,564,650,7.38);
s=sections[5];
text(s,'scarlet','真っ赤に',8.41,559,237,152,960,{dx:-170,fill:'#ee7954'});
text(s,'wet','濡れた',8.94,562,462,176,970,{dy:80,dx:0});
text(s,'sky','空',9.47,1398,345,379,680,{dx:180,squash:.50});
text(s,'heel','踵',9.90,515,771,306,640,{dy:80,dx:0,fill:'#ee7954'});
text(s,'ring','鳴らせ',10.25,1200,817,241,1130,{dx:230,squash:.62});
rule(s,'horizon',1160,563,1210,9.47,false,'#ee7954');
rule(s,'last',1210,974,1090,10.25,false,'#ee7954');
const last=elements.find(e=>e.id==='section-5-ring');
last.transform.scaleY=T([[10.27,.72,'easeOut'],[10.43,1],[10.90,1,'easeIn'],[11.17,.94]]);
const scene={...emptyScene(),width:W,height:H,fps,duration,background:C.paper,elements,
 markers:cues.map(c=>({t:c.t,kind:'note',label:c.text+'（時刻は仮合わせ）',origin:'estimated'}))};
state=commit(state.project.id,{baseRevision:state.project.revision,actor,note:'新曲の全6行を構成・変形キーとして保存',
 scene:()=>scene,documents:()=>({adaptation:{kind:'new-song-designed-lyrics',sourceAudioSha256:sourceSha256,
  lyrics:['さあ 皆舞いな 空洞で','サンスクリット求道系','抉り抜いた鼓動咲かせ咲かせ','さあ 剽悍な双眸を','エーカム そうさ 先頭に','真っ赤に濡れた空 踵鳴らせ'],
  cues,alignment:'pulse-based authored timing; vocal forced alignment unavailable',design:'hand-designed motion and layout'}})});
const measure=canvasMeasurer(ctx);
const audit=[];
for(let f=0;f<336;f++) {
 for(const ev of evaluateScene(scene,f/fps,measure).filter(e=>e.element.type==='text')) {
  ctx.font=fontSpec(ev.element);
  const ink=ctx.measureText(ev.element.text);
  const [a,b,c,d,x,y]=ev.matrix;
  ctx.textAlign='center';ctx.textBaseline='middle';
  const centered=ctx.measureText(ev.element.text);
  const points=[-centered.actualBoundingBoxLeft,centered.actualBoundingBoxRight].flatMap(u=>[-centered.actualBoundingBoxAscent,centered.actualBoundingBoxDescent]
    .map(v=>[a*u+c*v+x,b*u+d*v+y]));
  if(points.some(([px,py])=>px<30||px>W-30||py<30||py>H-30)) audit.push({frame:f,id:ev.element.id});
 }
}
await writeFile(path.join(folder,'layout-audit.json'),JSON.stringify(audit,null,2));
assert.equal(audit.length,0,'Text crosses the safe frame; adjust the composition before export');
await writeFile(path.join(folder,'scene.json'),JSON.stringify(scene,null,2));
const movie=await exportVideo(state.project,scene,{from:0,to:duration,width:1920,layout:'render',withAudio:false,outputTag:'song-designed'});
assert.equal(movie.frameCount,336);
execFileSync('ffmpeg',['-v','error','-y','-i',movie.path,'-i',path.resolve(audioFile),'-map','0:v:0','-map','1:a:0',
 '-c:v','copy','-c:a','aac','-b:a','320k',path.join(folder,'Test_audio1_lyric.mp4')],{windowsHide:true});
await writeFile(path.join(folder,'report.json'),JSON.stringify({projectId:state.project.id,revision:state.project.revision,
 audioSha256:sourceSha256,frames:336,fps,width:W,height:H,cues,alignmentVerified:false,layoutViolations:audit.length},null,2));
console.log('Completed',state.project.id,folder);
