import assert from 'node:assert/strict';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {emptyScene,sampleTrack} from '@mlm/core';
import {exportVideo} from '../apps/server/src/export.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {getProject} from '../apps/server/src/store.ts';

const [sourceReport,output]=process.argv.slice(2);
assert.ok(sourceReport&&output);
const dir=path.resolve(output);
await mkdir(dir,{recursive:true});
const inputs=JSON.parse(await readFile(sourceReport,'utf8'));
const {project:target}=getProject(inputs.targetProjectId);
const fps=24;
assert.equal(target.source?.fps,fps);
const t=frame=>frame/fps;
const duration=t(108);
const keys=(...points)=>({keys:points.map(([frame,v,ease])=>({t:t(frame),v,ease}))});
const scene={...emptyScene(),width:960,height:540,fps,duration,background:'#eeeae0',
  markers:[
    {t:t(0),kind:'note',label:'風を先に表示',origin:'manual'},
    {t:t(10),kind:'note',label:'風を保持して続きの文を追加',origin:'manual'},
    {t:t(53),kind:'note',label:'木を追加',origin:'manual'},
    {t:t(82),kind:'note',label:'林に切り替え',origin:'manual'},
  ]};
const text=(id,value,from,to,x,y,size,fill='#1d2826')=>({
  id,name:value,type:'text',text:value,fontSize:size,fill,inPoint:t(from),outPoint:t(to),transform:{x,y},
});
const rule=(id,from,to,x,y,sx,fill='#317d70')=>({id,type:'rect',width:100,height:3,
  fill,inPoint:t(from),outPoint:t(to),transform:{x,y,scaleX:sx}});
const accent='#317d70';
const leadX=keys([0,257,'easeOut'],[8,288,'hold'],[41,288,'easeInOut'],[50,143]);
const leadScale=keys([0,1,'hold'],[41,1,'easeInOut'],[50,91/188]);
const lead=text('lead','風',0,108,leadX,222,188);
lead.transform={...lead.transform,scaleX:leadScale,scaleY:leadScale};
scene.elements=[
  lead,
  text('follow','をほどいて',10,53,keys([10,517,'easeOut'],[17,590,'hold']),267,58),
  rule('lead-underline',0,108,leadX,keys([0,345,'hold'],[41,345,'easeInOut'],[50,292]),
    keys([0,.02,'easeOut'],[8,1.54,'hold'],[41,1.54,'easeInOut'],[50,.46])),
  text('wood-left','木',53,82,keys([53,435,'hold'],[67,435,'easeInOut'],[81,526]),246,123),
  text('wood-right','木',58,82,keys([58,795,'easeOut'],[65,732,'hold'],[67,732,'easeInOut'],[81,642]),246,102),
  rule('between-parts',58,82,590,355,keys([58,.06,'easeOut'],[65,2.96,'hold'],[68,2.96,'easeIn'],[81,.23])),
  text('result','林',82,108,586,248,199),
  text('reading','はやし',82,108,584,389,31,accent),
  rule('result-underline',82,108,585,364,keys([82,.20,'easeOut'],[91,1.53])),
];
const saved=saveGeneratedProject('語の受け渡しと図形 · 作画試作',scene,target.id,'staged-composition',{
  adaptation:{kind:'authored-staged-composition',sourceProjectId:target.id,sourceSha256:target.source.sha256,
    cueFrames:{lead:0,follow:10,left:53,right:58,compound:82},purpose:'main word persists during the introduction of the next words'},
});
const visible=(ids,frame)=>ids.every(id=>saved.scene.elements.some(el=>el.id===id&&el.inPoint<=t(frame)&&el.outPoint>t(frame)));
assert.ok(visible(['lead','follow'],10));
assert.ok(visible(['lead','wood-left','wood-right','between-parts'],75));
assert.ok(visible(['lead','result','reading','result-underline'],82));
assert.ok(!visible(['wood-left'],82));
const left=saved.scene.elements.find(el=>el.id==='wood-left');
assert.equal(sampleTrack(left.transform.x,t(58),0),435);
assert.equal(sampleTrack(left.transform.x,t(81),0),526);
const render=await exportVideo(saved.project,saved.scene,{from:0,to:duration,width:960,layout:'render',withAudio:true,outputTag:'staged-composition'});
assert.equal(render.frameCount,108);
await copyFile(render.path,path.join(dir,'composition-pilot.mp4'));
await writeFile(path.join(dir,'composition-pilot.json'),JSON.stringify({
  projectId:saved.project.id,revision:saved.project.revision,fps,frames:108,
  cues:saved.scene.markers,sourceSha256:target.source.sha256,
  limitations:['hand-authored demonstration','placeholder words are not aligned to singing'],
},null,2));
