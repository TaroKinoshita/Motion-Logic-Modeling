import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene,evaluateScene,fontSpec,worldMatrixOf} from '@mlm/core';
import {sourcePath} from '../apps/server/src/media.ts';
import {checkScene,getProject,REPO_ROOT} from '../apps/server/src/store.ts';
import {publishPassage} from './passage-review.mjs';

const [projectId,output]=process.argv.slice(2);
if(!projectId||!output) throw new Error('Supply the measured Lyricsample3 project and output folder');
const {project}=getProject(projectId),{fps,width,height}=project.source;
const dir=path.resolve(output),actor='frame-layer-review',first=94,end=118,time=n=>(n-first)/fps;
const python=process.env.MLM_TRACK_PYTHON??path.join(REPO_ROOT,'workers','track','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const rows=JSON.parse(execFileSync(python,[path.join(REPO_ROOT,'scripts','measure-lyricsample3-frame.py'),sourcePath(project)],{encoding:'utf8'}));
assert.deepEqual(rows.map(row=>row.frame),Array.from({length:end-first},(_,i)=>first+i));
await mkdir(dir,{recursive:true});
const frameElements=[],glyphs=[];
const track=(samples,read)=>{
  const keys=samples.map(row=>({t:time(row.frame),v:read(row)}));
  return keys.every(key=>key.v===keys[0].v)?keys[0].v:{keys:keys.filter((key,i)=>!i||i===keys.length-1||
    Math.abs(key.v-(keys[i-1].v+keys[i+1].v)/2)>1e-8)};
};
const group=(id,name,samples,box)=>{
  const transform={x:track(samples,row=>box(row)[0]+box(row)[2]/2),y:track(samples,row=>box(row)[1]+box(row)[3]/2),
    scaleX:track(samples,row=>box(row)[2]/100),scaleY:track(samples,row=>box(row)[3]/100)};
  return {id,name,type:'group',inPoint:time(samples[0].frame),outPoint:time(samples.at(-1).frame+1),transform};
};
const stages=[{from:94,to:101,text:['に','な','る'],axis:'vertical'},{from:101,to:110,text:['兵','器'],axis:'horizontal'},
  {from:110,to:118,text:['に','成','る'],axis:'vertical'}];
for(const stage of stages) {
  const samples=rows.filter(row=>row.frame>=stage.from&&row.frame<stage.to),horizontal=stage.axis==='horizontal';
  const outer=group(`frame:${stage.from}`,'外枠',samples,row=>row.outer);
  const divider=group(`divider:${stage.from}`,'区切り線',samples,row=>horizontal?
    [row.divider-1,row.outer[1],2,row.outer[3]]:[row.outer[0],row.divider-1,row.outer[2],2]);
  frameElements.push(outer,{id:`${outer.id}:border`,parentId:outer.id,type:'rect',width:100,height:100,fill:'none',stroke:'#9f9f9f',
    strokeWidth:.35,inPoint:outer.inPoint,outPoint:outer.outPoint},divider,
  {id:`${divider.id}:stroke`,parentId:divider.id,type:'rect',width:100,height:100,fill:'#a4a4a4',inPoint:divider.inPoint,outPoint:divider.outPoint});
  for(const [index,text] of stage.text.entries()) {
    const box=row=>row.cells[index];
    const shown=samples.filter(row=>box(row)&&box(row)[2]>=8&&box(row)[3]>=8);
    if(!shown.length) continue;
    assert.ok(shown.every((row,i)=>!i||row.frame===shown[i-1].frame+1));
    const owner=group(`glyph:${stage.from}:${index}`,`文字 ${text}`,shown,box);
    frameElements.push(owner);
    glyphs.push({id:`${owner.id}:appearance`,parentId:owner.id,text,fill:'#ececec',inPoint:owner.inPoint,outPoint:owner.outPoint});
  }
}
const context=createCanvas(1,1).getContext('2d');
const fittedText=leaf=>{
  const element={...leaf,type:'text',fontSize:100,fontFamily:'MLM Yu Gothic',fontWeight:400};
  context.font=fontSpec(element);context.textAlign='center';context.textBaseline='middle';
  const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=context.measureText(leaf.text);
  assert.ok(l+r>0&&a+b>0);
  const sx=100/(l+r),sy=100/(a+b);
  return {...element,transform:{x:(l-r)*sx/2,y:(a-b)*sy/2,scaleX:sx,scaleY:sy}};
};
const shared={...emptyScene(),width,height,fps,duration:time(end),background:'#080808',markers:[
  {t:time(101),kind:'cut',origin:'measured',label:'元101F 縦枠から横枠'},
  {t:time(110),kind:'cut',origin:'measured',label:'元110F 縦枠と別表記へ'},
]};
const blocks=checkScene({...shared,elements:[...frameElements,...glyphs.map(({text,...leaf})=>({...leaf,type:'rect',width:100,height:100}))]});
const textScene=checkScene({...shared,elements:[...frameElements,...glyphs.map(fittedText)]});
for(let frame=first;frame<end;frame++) {
  const t=time(frame),visible=scene=>evaluateScene(scene,t).map(element=>element.element.id);
  assert.deepEqual(visible(blocks),visible(textScene));
  for(const shape of glyphs) assert.deepEqual(worldMatrixOf(blocks,shape.parentId,t),worldMatrixOf(textScene,shape.parentId,t));
}
assert.deepEqual([96,104,112].map(frame=>evaluateScene(textScene,time(frame)).filter(row=>row.element.type==='text').map(row=>row.element.text).join('')),
  ['になる','兵器','に成る']);
const derivation={kind:'independent-frame-letters',sourceSha256:project.source.sha256,sourceProjectId:projectId,sourceRevision:project.revision,
  frameRange:[first,end],stages,notes:'Frame sides and divider measured separately; text is editable and fitted to foreground. Font strokes, dashed pattern and tiny footnotes are simplified.'};
const published=await publishPassage({dir,project,first,end,actor,title:'Lyricsample3 · 枠と字を分ける',blocks,replacement:textScene,
  replacementLabel:'復元・編集できる文字',documents:{adaptation:derivation}});
await writeFile(path.join(dir,'report.json'),JSON.stringify({...derivation,...published,rows},null,2));
console.log(JSON.stringify(published));
