import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene,evaluateScene,fontSpec,sampleTrack,worldMatrixOf} from '@mlm/core';
import {getBlocking} from '../apps/server/src/blocking.ts';
import {checkScene,getDocuments,REPO_ROOT} from '../apps/server/src/store.ts';
import {publishPassage} from './passage-review.mjs';

const [sourceId,output]=process.argv.slice(2);
if(!sourceId||!output) throw new Error('Supply the measured Lyricsample1 project and an output folder');
const dir=path.resolve(output),actor='passage-verification';
const {project,design}=getBlocking(sourceId);
const {observations}=getDocuments(sourceId);
assert.ok(project.source&&design&&observations);
const {fps,width,height}=project.source;
const frameFor=id=>{
  const event=design.events.find(e=>e.id===id&&e.status==='confirmed');
  assert.ok(event,id);
  const frame=Math.round(event.t*fps);
  assert.ok(Math.abs(frame/fps-event.t)<1e-8);
  return frame;
};
const first=frameFor('meshi-parts'),merge=frameFor('meshi-combine'),cut=frameFor('polarity:lyrics:82');
const squash=frameFor('meshi-return'),end=frameFor('polarity:lyrics:93');
assert.deepEqual([first,merge,cut,squash,end],[71,81,82,92,93]);
const t=frame=>(frame-first)/fps;
const stages=[
  {from:first,to:merge,label:'部品の距離が開き、止まりかけてから寄る',body:[['left',[74],'木'],['right',[75],'目']],readings:[['left-reading',[76],'き'],['right-reading',[77,78,79,80,81,82],'め']]},
  {from:merge,to:cut,label:'合字',body:[['joined',[83],'相']],readings:[['reading',[84,85,86,87],'そう']]},
  {from:cut,to:squash,label:'白黒反転と拡大からの収束',body:[['joined',[88],'相']],readings:[['reading',[89,90,91,92,93,94,95],'そう']]},
  {from:squash,to:end,label:'つぶれた部品',body:[['flattened',[96],'木目']],readings:[['reading',[97,98],'そう']]},
];
const boxesAt=(ids,frame)=>{
  const boxes=ids.flatMap(id=>{
    const block=design.blocks.items.find(item=>item.id===`track:lyrics:${id}`);
    assert.ok(block,id);
    return block.observationIds.flatMap(key=>{
      const row=observations[key];
      return row?.kind==='block-contour'?row.samples.filter(sample=>sample.frame===frame).map(sample=>sample.box):[];
    });
  });
  assert.ok(boxes.length,`Missing measured box ${ids.join(',')} at ${frame}F`);
  const x=Math.min(...boxes.map(b=>b[0])),y=Math.min(...boxes.map(b=>b[1]));
  const w=Math.max(...boxes.map(b=>b[0]+b[2]))-x,h=Math.max(...boxes.map(b=>b[1]+b[3]))-y;
  return {x:x+w/2,y:y+h/2,w,h};
};
const worker=path.join(REPO_ROOT,'workers','track');
const python=process.env.MLM_TRACK_PYTHON??path.join(worker,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const fitStats=[];
const fit=(id,rows,fields,pinnedFrames)=>{
  if(rows.length===1) return Object.fromEntries(fields.map(field=>[field,rows[0][field]]));
  const tolerances=Object.fromEntries(fields.map(field=>[field,field==='w'||field==='h'?2:1.5]));
  const pins=Object.fromEntries(fields.map(field=>[field,pinnedFrames.map(frame=>rows.findIndex(row=>row.frame===frame))]));
  const payload=[rows.map(({frame,...values})=>({t:t(frame),...values})),tolerances,pins];
  const {linear,eased}=JSON.parse(execFileSync(python,[path.join(worker,'track','motion_vocabulary_fit.py'),JSON.stringify(payload)],{encoding:'utf8',windowsHide:true}));
  const toTrack=entries=>entries.every(key=>key.value===entries[0].value)?entries[0].value:{keys:entries.map(key=>({t:key.t,v:key.value,ease:key.easing}))};
  const count=model=>Object.values(model.tracks).reduce((sum,entries)=>sum+(entries.every(key=>key.value===entries[0].value)?0:entries.length),0);
  fitStats.push({id,observedValues:rows.length*fields.length,linearKeys:count(linear),easedKeys:count(eased),errors:eased.maxSampleError});
  return Object.fromEntries(fields.map(field=>[field,toTrack(eased.tracks[field])]));
};
const light=sampleTrack(design.blocks.backgroundLuma,first/fps,235),dark=sampleTrack(design.blocks.backgroundLuma,cut/fps,34);
const gray=value=>`#${Math.round(Math.max(0,Math.min(255,value))).toString(16).padStart(2,'0').repeat(3)}`;
const common=[{id:'dark-background',name:'白黒反転',type:'rect',inPoint:t(cut),outPoint:t(end),width,height,fill:gray(dark),transform:{x:width/2,y:height/2}}];
const shapes=[],expected=[];
const scale=(track,denominator)=>typeof track==='number'?track/denominator:{keys:track.keys.map(k=>({...k,v:k.v/denominator}))};
const separation=[];
for(const stage of stages) {
  const roles=[...stage.body,...stage.readings];
  const frames=Array.from({length:stage.to-stage.from},(_,i)=>stage.from+i);
  const measured=frames.map(frame=>({frame,boxes:Object.fromEntries(roles.map(([role,ids])=>[role,boxesAt(ids,frame)]))}));
  const average=measured.map(({frame,boxes})=>{
    const bodies=stage.body.map(([role])=>boxes[role]);
    if(bodies.length===2) separation.push({frame,centersApartPx:bodies[1].x-bodies[0].x});
    return {frame,x:bodies.reduce((sum,b)=>sum+b.x,0)/bodies.length,y:bodies.reduce((sum,b)=>sum+b.y,0)/bodies.length};
  });
  const life={inPoint:t(stage.from),outPoint:t(stage.to)};
  const parent=`stage:${stage.from}`;
  const pins=stage.from===first?[76,77]:[];
  common.push({id:parent,type:'group',name:stage.label,...life,transform:fit(parent,average,['x','y'],pins)});
  const polarity=stage.from>=cut;
  // Use a common neutral foreground; geometry is independent of the appearance.
  const fill=gray(polarity?238:34);
  for(const [role,trackIds,text] of roles) {
    const id=`${parent}:${role}`;
    const rows=measured.map(({frame,boxes},i)=>({frame,...boxes[role],x:boxes[role].x-average[i].x,y:boxes[role].y-average[i].y}));
    const fitTracks=fit(id,rows,['x','y','w','h'],role==='left'||role==='right'?pins:[]);
    common.push({id,type:'group',name:`${role} · ${text}`,parentId:parent,...life,
      transform:{x:fitTracks.x,y:fitTracks.y,scaleX:scale(fitTracks.w,100),scaleY:scale(fitTracks.h,100)}});
    shapes.push({id:`${id}:shape`,parentId:id,role,text,fill,...life});
    for(const row of measured) expected.push({frame:row.frame,id,trackIds,...row.boxes[role]});
  }
}
const metricsCtx=createCanvas(1,1).getContext('2d');
const markers=[{t:0,kind:'note',origin:'measured',label:'71F 部品'},
  {t:t(merge),kind:'note',origin:'measured',label:'81F 合字'},{t:t(cut),kind:'cut',origin:'measured',label:'82F 反転・拡大'},
  {t:t(squash),kind:'note',origin:'measured',label:'92F 潰れ'}];
const build=type=>checkScene({...emptyScene(),width,height,fps,duration:t(end),background:gray(light),markers,
  elements:[...common,...shapes.map(({role,text,...shape})=>{
    if(type==='rect') return {...shape,type,width:100,height:100,fill:role.includes('reading')?gray(shape.fill==='#222222'?100:190):shape.fill};
    const element={...shape,type,text,fontSize:100,fontFamily:'MLM Yu Gothic',fontWeight:role.includes('reading')?400:700};
    metricsCtx.font=fontSpec(element);metricsCtx.textAlign='center';metricsCtx.textBaseline='middle';
    const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=metricsCtx.measureText(text);
    assert.ok(l+r>0&&a+b>0);
    const sx=100/(l+r),sy=100/(a+b);
    return {...element,transform:{x:(l-r)*sx/2,y:(a-b)*sy/2,scaleX:sx,scaleY:sy}};
  })],
});
const blocks=build('rect'),replacement=build('text');
const errors=expected.map(({frame,id,x,y,w,h})=>{
  const before=worldMatrixOf(blocks,id,t(frame)),after=worldMatrixOf(replacement,id,t(frame));
  assert.deepEqual(before,after);
  return {frame,id,center:Math.hypot(before[4]-x,before[5]-y),width:Math.abs(before[0]*100-w),height:Math.abs(before[3]*100-h)};
});
const maxError=Object.fromEntries(['center','width','height'].map(field=>[field,Math.max(...errors.map(row=>row[field]))]));
assert.ok(maxError.center<4&&maxError.width<=2.01&&maxError.height<=2.01);
for(let frame=first;frame<end;frame++) {
  const visible=scene=>evaluateScene(scene,t(frame)).map(e=>e.element.id);
  assert.deepEqual(visible(blocks),visible(replacement));
  assert.equal(visible(replacement).includes('dark-background'),frame>=cut);
}
const {frames,outputs}=await publishPassage({dir,project,first,end,actor,title:'Lyricsample1 71–92F',blocks,replacement,replacementLabel:'木＋目 → 相',
  documents:{observations:{passage:{kind:'compound-passage',origin:'measured',sourceProjectId:sourceId,
    sourceRevision:project.revision,sourceSha256:project.source.sha256,frameRange:[first,end],expected}},
    adaptation:{kind:'compound-passage',fitStats,maxError}}});
const report={sourceId,sourceRevision:project.revision,sourceSha:project.source.sha256,fps,frameRange:[first,end],merge,cut,squash,separation,
  intervals:stages.map(({from,to,label})=>({from,to,label})),fitStats,maxError,sourceBoxes:expected,frames,outputs,
  sameGroupsAndVisibility:true,metric:'fit residual against the original contour observations used as input, not independent ground truth'};
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({outputs,maxError,separation,frames,fitStats},null,2));
