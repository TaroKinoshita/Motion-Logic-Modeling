import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
const root=path.resolve(import.meta.dirname,'..');
const original=path.join(root,'data/projects/p_mwl57hkcq4dc');
process.env.MLM_DATA_DIR=path.join(root,'data/lyrics-validation');
const {createProject,commit,projectDir}=await import('../apps/server/src/store.ts');
const {compareSegment}=await import('../apps/server/src/compare.ts');
const {exportVideo}=await import('../apps/server/src/export.ts');
const {renderSheet}=await import('../apps/server/src/render.ts');
const {snapTime,sampleTrack,fontSpec}=await import('../packages/core/src/index.ts');
const {TrackingRequest,trackRegion}=await import('../apps/server/src/tracking.ts');
const {GlyphRequest,recordGlyphs}=await import('../apps/server/src/modeling.ts');
const {getDocuments}=await import('../apps/server/src/store.ts');
const source=JSON.parse(fs.readFileSync(path.join(original,'project.json')));
const scene=JSON.parse(fs.readFileSync(path.join(original,'scene.json')));
async function clone(label,scene) {
  let state=createProject(label,scene,'validation');
  fs.copyFileSync(path.join(original,'media',source.source.fileName),path.join(projectDir(state.project.id),'media',source.source.fileName));
  return commit(state.project.id,{baseRevision:state.project.revision,actor:'validation',note:'Lyricsample1の検証用コピー',meta:p=>{p.source=source.source;}});
}
const baseline=await clone('Lyrics: baseline',scene);
const fontScene=structuredClone(scene);
for(const e of fontScene.elements) if(e.type==='text'&&/[^\u0000-\u007f]/.test(e.text??'')) {e.fontFamily='MLM Yu Gothic';e.fontWeight=e.fontWeight===400?400:700;}
const candidate=await clone('Lyrics: registered Japanese font',fontScene);
const snapScene=structuredClone(scene);
let snappedBounds=0;
for(const element of snapScene.elements) for(const prop of ['inPoint','outPoint']) {
  const old=element[prop];
  if(typeof old!=='number') continue;
  const next=snapTime(snapScene,old,'cut');
  if(next!==old) {element[prop]=next; snappedBounds++;}
}
const snapped=await clone('Lyrics: aligned cut boundaries',snapScene);
const styledScene=structuredClone(snapScene);
for(const element of styledScene.elements) {
  if(element.type!=='text'||!/[\u3000-\u9fff]/.test(element.text??'')) continue;
  element.fontFamily='MLM BIZ UD Gothic';
  element.fontWeight=element.fontWeight===400?400:700;
  if(['田んぼの田','当たり'].includes(element.text)) {element.split??='char';element.letterSpacing=12;}
}
const styled=await clone('Lyrics: BIZ Gothic and wider spacing',styledScene);
const cases=[[2.05,2.95],[3.42,3.875],[6.67,7.625],[0,7.625]];
const report={originalProject:source.id,originalRevision:source.revision,baseline:baseline.project.id,candidate:candidate.project.id,snapped:snapped.project.id,styled:styled.project.id,comparisons:[],snappedBounds,elementCount:scene.elements.length};
for(const [from,to] of cases) {
  const before=await compareSegment(baseline.project.id,from,to,640),after=await compareSegment(candidate.project.id,from,to,640);
  const aligned=await compareSegment(snapped.project.id,from,to,640);
  const formatted=await compareSegment(styled.project.id,from,to,640);
  assert.equal(before.frameCount,before.endFrame-before.startFrame);
  report.comparisons.push({requested:[from,to],actual:[before.from,before.to],frames:before.frameCount,before:before.ssim,yuGothic:after.ssim,aligned:aligned.ssim,bizAndSpacing:formatted.ssim});
}
for(const state of [baseline,styled]) fs.writeFileSync(path.join(process.env.MLM_DATA_DIR,`${state.project.id}.jpg`),await renderSheet(state.project,state.scene,{kind:'compare',times:[.5,2.5,3.5,4.6],cellWidth:480,columns:2}));
const start=performance.now();
const tracked=await trackRegion(styled.project.id,TrackingRequest.parse({baseRevision:styled.project.revision,from:.5,to:26/24,region:{x:1060,y:345,w:344,h:345},method:'silhouette'}));
const elapsedMs=performance.now()-start;
const docs=getDocuments(styled.project.id);
const measured=Object.values(docs.observations).at(-1), fit=Object.values(docs.simplification).at(-1);
const rect=tracked.scene.elements.find(e=>e.id===fit.elementId);
assert.equal(measured.samples.length,13);
assert.deepEqual(measured.gapTimes,[.625]);
assert.equal(measured.stoppedReason,null);
assert.ok(measured.samples[0].x-measured.samples.at(-1).x>400);
assert.ok(Math.max(...measured.samples.map(s=>s.scale))>1.08);
const fields={x:'x',y:'y',scaleX:'widthScale',scaleY:'scale'};
const rendererError=Object.fromEntries(Object.entries(fields).map(([prop,field])=>[prop,Math.max(...measured.samples.map(s=>Math.abs(sampleTrack(rect.transform[prop],s.t,0)-s[field])))]));
for(const [prop,field] of Object.entries(fields)) assert.ok(rendererError[prop]<=fit.tolerances[field]+1e-6);
report.tracking={elapsedMs,observationId:measured.id,gaps:measured.gapTimes,samples:measured.samples.length,rendererError,keys:Object.fromEntries(Object.entries(fit.tracks).map(([k,v])=>[k,{count:v.length,cubic:v.filter(q=>typeof q.easing==='object').length}]))};
// Use this proxy's world-space motion on the actual simplified glyph for the measured interval.
const glyphScene=structuredClone(snapScene);
const glyph=glyphScene.elements.find(e=>e.id==='kaku');
const ctx=createCanvas(1,1).getContext('2d');
ctx.font=fontSpec(glyph);ctx.textAlign='center';ctx.textBaseline='middle';
const ink=ctx.measureText(glyph.text);
const inkWidth=ink.actualBoundingBoxLeft+ink.actualBoundingBoxRight;
const inkHeight=ink.actualBoundingBoxAscent+ink.actualBoundingBoxDescent;
const scaleX=rect.width/inkWidth,scaleY=rect.height/inkHeight;
delete glyph.parentId;
glyph.anchorX=(ink.actualBoundingBoxRight-ink.actualBoundingBoxLeft)/2+rect.anchorX/scaleX;
glyph.anchorY=(ink.actualBoundingBoxDescent-ink.actualBoundingBoxAscent)/2+rect.anchorY/scaleY;
const rescale=(track,factor)=>({keys:track.keys.map(k=>({...k,v:k.v*factor}))});
glyph.transform={x:rect.transform.x,y:rect.transform.y,scaleX:rescale(rect.transform.scaleX,scaleX),scaleY:rescale(rect.transform.scaleY,scaleY)};
const measuredGlyph=await clone('Lyrics: measured 各 (0.500–1.083 s)',glyphScene);
const manualMotion=await compareSegment(snapped.project.id,.5,26/24,640);
const measuredMotion=await compareSegment(measuredGlyph.project.id,.5,26/24,640);
report.tracking.appliedGlyph={projectId:measuredGlyph.project.id,elementCount:glyphScene.elements.length,manual:manualMotion.ssim,measured:measuredMotion.ssim};
for(const [state,from,to,label] of [[snapped,0,7.625,'aligned-cuts'],[measuredGlyph,.5,26/24,'measured-kaku']]) {
  const video=await exportVideo(state.project,state.scene,{from,to,width:640,layout:'compare',withAudio:true});
  report[label]={frames:video.frameCount,hasAudio:video.hasAudio};
  fs.copyFileSync(video.path,path.join(process.env.MLM_DATA_DIR,`${label}.mp4`));
}
const times=[.5,.625,16/24,20/24,25/24].map(t=>t+1e-7);
fs.writeFileSync(path.join(process.env.MLM_DATA_DIR,'kaku-tracked.jpg'),await renderSheet(measuredGlyph.project,measuredGlyph.scene,{kind:'compare',times,cellWidth:420,columns:2}));
const glyphs=recordGlyphs(styled.project.id,GlyphRequest.parse({baseRevision:tracked.project.revision,entries:[
  {relation:'combine',from:1.15,to:1.72,parts:[{text:'田',elementId:'taB'},{text:'丁',elementId:'cho'}],result:{text:'町'}},
  {relation:'combine',from:2.95,to:3.875,parts:[{text:'食',elementId:'shokuE'},{text:'反',elementId:'hanE'}],result:{text:'飯',elementId:'meshi'}},
  {relation:'ruby',from:.2,to:.6,base:{text:'各',elementId:'kaku'},ruby:{text:'Kaku',elementId:'lKaku'}},
]}));
report.glyphObservations=glyphs.observations.map(o=>({id:o.id,relation:o.relation}));
fs.writeFileSync(path.join(process.env.MLM_DATA_DIR,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
