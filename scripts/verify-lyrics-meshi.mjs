import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
import {fontSpec, sampleTrack, isActive, snapTime} from '../packages/core/src/index.ts';

const root=path.resolve(import.meta.dirname,'..');
const original=path.join(root,'data/projects/p_mwl57hkcq4dc');
const data=process.env.MLM_DATA_DIR=path.join(root,'data/lyrics-validation');
const {createProject,commit,projectDir,getDocuments}=await import('../apps/server/src/store.ts');
const {compareSegment}=await import('../apps/server/src/compare.ts');
const {exportVideo}=await import('../apps/server/src/export.ts');
const {TrackingRequest,trackRegion}=await import('../apps/server/src/tracking.ts');
const {GlyphRequest,recordGlyphs,ModelRequest,saveModel,VariantRequest,generateVariant}=await import('../apps/server/src/modeling.ts');
const source=JSON.parse(fs.readFileSync(path.join(original,'project.json'),'utf8'));
const scene=JSON.parse(fs.readFileSync(path.join(original,'scene.json'),'utf8'));
const fps=24, start=71/fps, join=81/fps, invert=82/fps, squash=92/fps, end=93/fps;

function clone(name, scene) {
  const created=createProject(name,scene,'validation');
  fs.copyFileSync(path.join(original,'media',source.source.fileName),path.join(projectDir(created.project.id),'media',source.source.fileName));
  return commit(created.project.id,{baseRevision:created.project.revision,actor:'validation',note:'Lyricsample1の検証用コピー',meta:p=>{p.source=source.source;}});
}
const byId=(scene,id)=>scene.elements.find(e=>e.id===id);
const baselineScene=structuredClone(scene);
for(const element of baselineScene.elements) for(const prop of ['inPoint','outPoint']) {
  if(typeof element[prop]==='number') element[prop]=snapTime(baselineScene,element[prop],'cut');
}
const baseline=clone('Meshi: previous cut-aligned motion',baselineScene);
const staged=structuredClone(baselineScene);
const bright=byId(staged,'meshi');
bright.outPoint=squash;
const ruby=byId(staged,'lMeshi');
ruby.fill='#f0f0f0';
ruby.transform={...ruby.transform,y:{keys:[{t:invert,v:961},{t:89/fps,v:976},{t:92/fps,v:936}]}};
for(const id of ['shokuE','hanE','meE','shiE']) Object.assign(byId(staged,id),{inPoint:start,outPoint:join});
staged.elements.push(
  {...bright,id:'meshi_join',name:'飯の合体（反転前の1コマ）',fontSize:340,fill:'#222222',inPoint:join,outPoint:invert,transform:{x:937,y:456,scaleX:1.36,scaleY:1}},
  {...byId(staged,'lMeshi'),id:'lMeshi_join',name:'ルビ MeShi（合体時）',text:'MeShi',fontSize:104,inPoint:join,outPoint:invert,transform:{x:937,y:795}},
  {...bright,id:'meshi_squash',name:'食反に戻る（反転末尾の1コマ）',text:'食反',fontSize:340,inPoint:squash,outPoint:end,transform:{x:956,y:540,scaleX:1,scaleY:.25}},
);
const manualScene=structuredClone(staged);
const manual=byId(manualScene,'meshi');
// Four boxes read by eye from the 480 px/frame grid, 01:04:13–01:04:19 UTC.
// Independent of the threshold data. Columns: frame, box center x/y, width, height (source px).
const manualBoxes=[[82,956,488,792,784],[83,956,488,576,776],[87,956,492,552,760],[91,956,504,552,620]];
const ctx=createCanvas(1,1).getContext('2d');
ctx.font=fontSpec(manual);ctx.textAlign='center';ctx.textBaseline='middle';
const ink=ctx.measureText(manual.text);
const inkWidth=ink.actualBoundingBoxLeft+ink.actualBoundingBoxRight;
const inkHeight=ink.actualBoundingBoxAscent+ink.actualBoundingBoxDescent;
manual.anchorX=(ink.actualBoundingBoxRight-ink.actualBoundingBoxLeft)/2;
manual.anchorY=(ink.actualBoundingBoxDescent-ink.actualBoundingBoxAscent)/2;
const track=(col,divisor=1)=>({keys:manualBoxes.map(row=>({t:row[0]/fps,v:row[col]/divisor,ease:'linear'}))});
manual.transform={x:track(1),y:track(2),scaleX:track(3,inkWidth),scaleY:track(4,inkHeight)};
const manuallyKeyed=clone('Meshi: four manually estimated boxes',manualScene);

const draft=clone('Meshi: measured motion and glyph rule',staged);
const started=performance.now();
const measured=await trackRegion(draft.project.id,TrackingRequest.parse({baseRevision:draft.project.revision,actor:'validation',targetElementId:'meshi',from:invert,to:squash,region:{x:535,y:68,w:850,h:830},method:'silhouette',polarity:'light'}));
const pipelineMs=performance.now()-started;
const documents=getDocuments(measured.project.id);
const raw=Object.values(documents.observations)[0];
const fitted=Object.values(documents.simplification)[0];
assert.equal(raw.samples.length,10);
assert.deepEqual(raw.gapTimes,[]);
assert.equal(fitted.elementId,'meshi');
assert.equal(measured.scene.elements.length,staged.elements.length);
const animated=byId(measured.scene,'meshi');
const absoluteError=(element)=>{
  const evalTrack=(prop,t)=>sampleTrack(element.transform[prop],t,0);
  return Object.fromEntries(['x','y','w','h'].map(field=>{
    const errors=raw.samples.map(({t,bounds})=>{
      const sx=evalTrack('scaleX',t),sy=evalTrack('scaleY',t);
      const values={x:evalTrack('x',t)+(manual.anchorX-element.anchorX)*sx,y:evalTrack('y',t)+(manual.anchorY-element.anchorY)*sy,w:sx*inkWidth,h:sy*inkHeight};
      const expected=field==='x'?bounds.x+bounds.w/2:field==='y'?bounds.y+bounds.h/2:bounds[field];
      return Math.abs(values[field]-expected);
    });
    return [field,{mae:errors.reduce((a,b)=>a+b)/errors.length,max:Math.max(...errors)}];
  }));
};

const recorded=recordGlyphs(measured.project.id,GlyphRequest.parse({baseRevision:measured.project.revision,actor:'validation',entries:[{
  relation:'combine',from:start,to:end,combineAt:join,
  parts:[{text:'食',elementId:'shokuE'},{text:'反',elementId:'hanE'}],result:{text:'飯',elementId:'meshi_join'},
  note:'81fで小さい黒字の飯、82fで反転して白字の飯、92fで食反に戻る。',
}]}));
const evidence=recorded.observations[0];
const hypothesis={id:'h-meshi-formation',observationIds:[evidence.id],status:'accepted',text:'二つの文字を読める状態で見せ、先に小さい飯へ切り替えることで、反転より前に合体を伝えるという演出仮説。比較試験に採用。'};
const rule={id:'r-meshi-formation',kind:'glyph_combine',hypothesisId:hypothesis.id,observationId:evidence.id,
  partCompanions:{shokuE:['meE'],hanE:['shiE']},resultCompanions:['lMeshi_join','meshi','dark1','lMeshi','meshi_squash']};
const modeled=saveModel(measured.project.id,ModelRequest.parse({baseRevision:recorded.project.revision,actor:'validation',hypotheses:[hypothesis],rules:[rule]}));
const variant=(name,parameters)=>generateVariant(modeled.project.id,VariantRequest.parse({baseRevision:modeled.project.revision,actor:'validation',ruleId:rule.id,name,...parameters}));
const faithful=variant('Meshi: observed switch', {seconds:0});
const reverse=variant('Meshi: reverse reveal order', {seconds:2/fps,order:'reverse'});
const early=variant('Meshi: combine one frame early', {seconds:0,mergeOffsetSeconds:-1/fps});
assert.equal(byId(faithful.scene,'meshi_join').inPoint,join);
assert.equal(byId(faithful.scene,'dark1').inPoint,invert);
assert.equal(byId(reverse.scene,'shiE').inPoint,start);
assert.ok(!isActive(byId(reverse.scene,'shokuE'),reverse.scene,start+1/fps));
assert.ok(isActive(byId(reverse.scene,'hanE'),reverse.scene,start+1/fps));
assert.equal(byId(early.scene,'meshi_join').inPoint,80/fps);
assert.equal(byId(early.scene,'dark1').inPoint,81/fps);
assert.equal(byId(modeled.scene,'meshi_join').inPoint,81/fps);
assert.throws(()=>variant('Out of range', {seconds:1}),/合体より先/);

const report={sourceProject:source.id,sourceRevision:source.revision,frames:{start:71,join:81,invert:82,squash:92,endExclusive:93},
  benchmark:{from:invert,to:squash,manualBoxes,manualOperator:'Codex visual reading from grid, one pass',manualReadWallSeconds:6,manualScalarEntries:16,
    assisted:{pipelineMs,glyphMotionValuesEntered:0,regionCoordinatesEntered:4,polarity:'light',samples:raw.samples.length,gaps:raw.gapTimes},
    keys:{previous:4,manual:16,measured:Object.values(animated.transform).reduce((n,t)=>n+(t?.keys?.length??0),0)},
    boxErrorVsThresholdPx:{manual:absoluteError(manual),assisted:absoluteError(animated)},elementCounts:{previous:scene.elements.length,manual:manualScene.elements.length,assisted:measured.scene.elements.length}},
  evidenceId:evidence.id,ruleId:rule.id,modelProject:modeled.project.id,comparisons:{}};
for(const [label,state] of Object.entries({previous:baseline,manual:manuallyKeyed,measured:faithful,reverse,early})) {
  const full=await compareSegment(state.project.id,start,end,640);
  const tracked=await compareSegment(state.project.id,invert,squash,640);
  report.comparisons[label]={projectId:state.project.id,scene:ssimResult(full),tracked:ssimResult(tracked)};
  if(label==='manual') continue;
  const from=label==='measured'?0:start;
  const to=label==='measured'?scene.duration:end;
  const mp4=await exportVideo(state.project,state.scene,{from,to,width:640,layout:'compare',withAudio:true});
  fs.copyFileSync(mp4.path,path.join(data,`meshi-${label}.mp4`));
}
function ssimResult(result) {return {frames:result.frameCount,...result.ssim};}
fs.writeFileSync(path.join(data,'meshi-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
