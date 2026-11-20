import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {emptyScene} from '@mlm/core';
import {exportVideo} from '../apps/server/src/export.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {getProject} from '../apps/server/src/store.ts';

const [report,output]=process.argv.slice(2);
assert.ok(report&&output);
const dir=path.resolve(output);
await mkdir(dir,{recursive:true});
const media=JSON.parse(await readFile(report,'utf8'));
const {project:source}=getProject(media.targetProjectId);
const fps=source.source.fps;
const t=frame=>frame/fps;
const input={line:{lead:'風',rest:'をほどいて',entry:0,restCue:10,emphasis:true},
  next:{text:'林',parts:['木','木'],ruby:'はやし',entry:53,decision:82},end:108};
const weights={continuity:5,emphasis:4,compound:5,graphicAgreement:2,complexity:1};

function solve(plan,weight) {
  const alternatives=[];
  const separated=plan.line.restCue-plan.line.entry>=4;
  const hasParts=plan.next.parts?.length===2&&plan.next.decision-plan.next.entry>=8;
  for(let mask=0;mask<16;mask++) {
    const [retain,large,merge,rule]=[1,2,4,8].map(bit=>Boolean(mask&bit));
    if((retain&&!separated)||(large&&!plan.line.emphasis)||(merge&&!hasParts)) continue;
    const scores={
      continuity:retain===separated?weight.continuity:0,
      emphasis:large===plan.line.emphasis?weight.emphasis:0,
      compound:merge===hasParts?weight.compound:0,
      graphicAgreement:rule===(retain||merge)?weight.graphicAgreement:0,
      complexity:-[retain,large,merge,rule].filter(Boolean).length*weight.complexity,
    };
    alternatives.push({retain,large,merge,rule,scores,total:Object.values(scores).reduce((sum,value)=>sum+value,0)});
  }
  alternatives.sort((a,b)=>b.total-a.total);
  return {selected:alternatives[0],alternatives};
}

const track=(...rows)=>({keys:rows.map(([frame,v,ease])=>({t:t(frame),v,ease}))});
const sceneBase={...emptyScene(),width:960,height:540,fps,duration:t(input.end),background:'#eeeae0'};
const ink='#202926',accent='#317d70';
const text=(id,value,start,end,x,y,fontSize,extra={})=>({id,type:'text',name:value,text:value,fontSize,fill:ink,
  inPoint:t(start),outPoint:t(end),transform:{x,y,...extra}});
const rule=(id,start,end,x,y,scaleX)=>({id,type:'rect',width:100,height:3,fill:accent,
  inPoint:t(start),outPoint:t(end),transform:{x,y,scaleX}});

function drawPlan(plan,choice) {
  const {line,next,end}=plan;
  const y=sceneBase.height*.43,firstSize=choice.large?184:74;
  const x=sceneBase.width*.30,side=sceneBase.width*.15,nextCenter=sceneBase.width*.61;
  const shift=Math.max(line.restCue+1,next.entry-Math.round(.5*fps));
  const leadX=choice.retain?track([line.entry,x,'hold'],[shift,x,'easeInOut'],[next.entry,side]):x;
  const fall=choice.large&&choice.retain?track([line.entry,1,'hold'],[shift,1,'easeInOut'],[next.entry,.49]):1;
  const output=choice.retain?[
    text('lead',line.lead,line.entry,end,leadX,y,firstSize,{scaleX:fall,scaleY:fall}),
    text('rest',line.rest,line.restCue,next.entry,
      track([line.restCue,sceneBase.width*.55,'easeOut'],[line.restCue+Math.round(.28*fps),sceneBase.width*.64]),y+35,54),
  ]:[
    text('lead',line.lead,line.entry,line.restCue,x,y,firstSize),
    text('line',line.lead+line.rest,line.restCue,next.entry,sceneBase.width*.50,y,65),
  ];
  if(choice.rule&&choice.retain) {
    output.push(rule('focus-line',line.entry,end,leadX,
      track([line.entry,y+firstSize*.66,'hold'],[shift,y+firstSize*.66,'easeInOut'],[next.entry,y+firstSize*.40]),
      track([line.entry,.15,'easeOut'],[line.entry+Math.round(.25*fps),1.38,'hold'],
        [shift,1.38,'easeInOut'],[next.entry,.46])));
  }
  const resultAt=choice.merge?next.decision:next.entry;
  if(choice.merge) {
    const second=next.entry+Math.round(.2*fps);
    const approach=second+Math.max(1,Math.floor((next.decision-second)/3));
    const offsets=[-1,1];
    for(const [i,piece] of next.parts.entries()) {
      const entry=i?second:next.entry;
      const direction=offsets[i];
      output.push(text('part:'+i,piece,entry,resultAt,track([entry,nextCenter+direction*148,'hold'],
        [approach,nextCenter+direction*148,'easeInOut'],[resultAt-1,nextCenter+direction*61]),y+23,i?104:121));
    }
    if(choice.rule) output.push(rule('join-line',second,resultAt,nextCenter,y+121,
      track([second,2.85,'hold'],[approach,2.85,'easeInOut'],[resultAt-1,1.24])));
  }
  output.push(text('result',next.text,resultAt,end,nextCenter,y+18,choice.large?185:112));
  if(next.ruby) output.push({...text('ruby',next.ruby,resultAt,end,nextCenter,y+150,30),fill:accent});
  return {...sceneBase,elements:output};
}

const enabled=solve(input,weights);
assert.ok(enabled.selected.retain&&enabled.selected.large&&enabled.selected.merge&&enabled.selected.rule);
const withoutContinuity=solve(input,{...weights,continuity:0});
assert.ok(!withoutContinuity.selected.retain&&withoutContinuity.selected.merge);
assert.ok(!solve({...input,next:{...input.next,parts:[]}},weights).selected.merge);

const variants=[];
for(const [key,scoring] of [['weighted',enabled],['without-continuity',withoutContinuity]]) {
  const scene=drawPlan(input,scoring.selected);
  const saved=saveGeneratedProject('制約から構図を選ぶ · '+key,scene,source.id,'constraint-pilot',{
    adaptation:{kind:'constraint-composition-pilot',input,key,proposal:scoring.selected,sourceSha256:source.source.sha256},
  });
  assert.equal(saved.scene.elements.find(el=>el.id==='lead').outPoint,t(scoring.selected.retain?input.end:input.line.restCue));
  assert.ok(saved.scene.elements.filter(el=>el.id.startsWith('part:')).every(el=>el.outPoint===t(input.next.decision)));
  const movie=await exportVideo(saved.project,saved.scene,{from:0,to:scene.duration,width:640,layout:'render',withAudio:true,outputTag:'constraint-pilot'});
  assert.equal(movie.frameCount,input.end);
  const file=key+'.mp4';
  await copyFile(movie.path,path.join(dir,file));
  variants.push({key,file,projectId:saved.project.id,revision:saved.project.revision,scoring});
}
execFileSync('ffmpeg',['-v','error','-y',...variants.flatMap(row=>['-i',path.join(dir,row.file)]),
  '-filter_complex','[0:v][1:v]hstack[v]','-map','[v]','-map','0:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy',
  path.join(dir,'comparison.mp4')],{windowsHide:true});
await writeFile(path.join(dir,'report.json'),JSON.stringify({input,weights,variants,sourceSha256:source.source.sha256,
  type:'enumerated choices and renderer layout templates',weightOrigin:'manually set before rendering; no learned authorship weights',
  frames:input.end,fps},null,2));
