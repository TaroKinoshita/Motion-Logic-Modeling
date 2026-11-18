import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { BlockingSchema, blockingFrame, elementSize, fontSpec, resolveTime, validateBlocking } from '@mlm/core';
import { exportBlocking } from '../apps/server/src/blocking.ts';
import { exportVideo } from '../apps/server/src/export.ts';
import '../apps/server/src/fonts.ts';
import { sourcePath } from '../apps/server/src/media.ts';
import { commit, createProject, DATA_DIR, getProject, projectDir } from '../apps/server/src/store.ts';

const [sourceId, templateFile, outputFolder] = process.argv.slice(2);
if (!sourceId || !templateFile || !outputFolder) {
  throw new Error('node scripts/verify-blocking-lyrics.mjs <source project id> <previous scene.json> <output folder>');
}
const out = path.resolve(outputFolder);
const model = path.join(DATA_DIR, 'models', 'pp-ocrv5-mobile-rec');
const fixtureFile = path.join(import.meta.dirname, 'fixtures', 'lyrics-blocking.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const previousReport = path.join(out,'report.json');
const previous = fs.existsSync(previousReport) ? read(previousReport) : undefined;
const {project: source} = getProject(sourceId);
const sourceVideo = sourcePath(source);
assert.equal(sha256(sourceVideo), source.source.sha256);
assert.equal(source.source.sha256, '251ecc12d05d3f000e8ac473b6c9763e8961a19989a89a519823d941bebe9cb3');
const template = read(templateFile), fixture = read(fixtureFile);
assert.deepEqual([template.width, template.height, template.fps, template.duration], [1920,1080,24,7.625]);
const time = frame => frame / template.fps;
const end = time(fixture.toFrame);
fs.mkdirSync(out, {recursive:true});
const rawFile = path.join(out, 'observed.json');
execFileSync(process.env.MLM_BLOCKING_PYTHON ?? 'python', [
  'workers/track/track/blocking_sample.py', sourceVideo, fixtureFile, rawFile, '--ocr-model', model,
], {stdio:'inherit'});
const measured = read(rawFile);
assert.equal(measured.framesDecoded, source.source.frameCount);
const rows = measured.frames.map(row => ({...row, observationId:`silhouette:${row.id}:${row.frame}`}));
const byId = id => rows.filter(row => row.id === id && row.measurement && !row.measurement.touchesRoi);
const track = (items, value) => ({keys:items.map(row => ({t:time(row.frame),v:value(row.measurement.box)}))});
const boxCenter = ([x,y,w,h]) => [x+w/2,y+h/2];
const localExtents = (width,height) => ({cx:0,cy:0,width,height});
const scene = {...template,elements:[]};
const items = [], appearance = [];
const ctx = createCanvas(1,1).getContext('2d');
const glyphs = [
  {key:'kaku', glyph:'各', fill:'#222222', color:'#60c9ec', from:3, to:27, hidden:[[15,16]]},
  {key:'ta', glyph:'田', fill:'#242424', color:'#f2b05e', from:16, to:27},
  {key:'contact', glyph:'略', fill:'#222222', color:'#be97f7', from:15, to:16},
  {key:'ru', glyph:'る', fill:'#252525', color:'#77d1b0', from:15, to:27},
];
for (const {key,glyph,fill,color,from,to,hidden} of glyphs) {
  const samples = byId(key);
  assert.ok(samples.length > 0, key);
  const blockId = `block:${key}`, childId = `glyph:${key}`;
  const life = {inPoint:time(from),outPoint:time(to)};
  const parent = {id:blockId,name:`${glyph} の動き`,type:'group',...life,transform:{
    x:track(samples,box => boxCenter(box)[0]), y:track(samples,box => boxCenter(box)[1]),
  }};
  const width = track(samples, box => box[2]), height = track(samples, box => box[3]);
  const child = {id:childId,parentId:blockId,name:glyph,type:'text',text:glyph,fill,
    fontFamily:'MLM Yu Gothic',fontSize:300,fontWeight:700,...life};
  ctx.font = fontSpec(child);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ink = ctx.measureText(glyph);
  const inkWidth = ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight;
  const inkHeight = ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent;
  assert.ok(inkWidth > 0 && inkHeight > 0);
  const sx = track(samples, box => box[2]/inkWidth), sy = track(samples, box => box[3]/inkHeight);
  child.anchorX = (ink.actualBoundingBoxRight-ink.actualBoundingBoxLeft)/2;
  child.anchorY = (ink.actualBoundingBoxDescent-ink.actualBoundingBoxAscent)/2;
  child.transform = {scaleX:sx,scaleY:sy};
  if (hidden) child.transform.opacity = {keys:[{t:time(from),v:1,ease:'hold'},{t:time(15),v:0,ease:'hold'},{t:time(16),v:1}]};
  scene.elements.push(parent,child);
  items.push({id:blockId,label:glyph,color,extent:localExtents(width,height),observationIds:samples.map(row=>row.observationId),
    hiddenDuring:hidden?.map(([from,to])=>({from:time(from),to:time(to)}))});
  appearance.push({blockId,childIds:[childId]});
}

// Retain independent ruby timing from the prior scene for the opener.
for (const id of ['lKaku','lHaka','lRu']) {
  const ruby = template.elements.find(el=>el.id===id);
  const key = id==='lRu'?'ru':'kaku';
  const oldGroup = template.elements.find(el=>el.id===ruby.parentId);
  if (!scene.elements.some(el=>el.id===oldGroup.id)) scene.elements.push(oldGroup);
  scene.elements.push({...ruby,outPoint:Math.min(end,resolveTime(ruby.outPoint,template.tempo)),note:`既存のルビ近似（${key}）`});
}

// Wrap prior scene layers to share their transforms with the proxy, preserving draw order.
const colors = ['#60c9ec','#f2b05e','#be97f7','#77d1b0'];
for (const element of template.elements) {
  const start = resolveTime(element.inPoint??0,template.tempo);
  if (start < 1.15) continue;
  const inPoint = start===1.15 ? end : element.inPoint;
  if (element.type==='group' || /^dark[12]$/.test(element.id)) {
    scene.elements.push({...element,inPoint});
    continue;
  }
  const {opacity,...motion} = element.transform??{};
  const blockId = `block:prior:${element.id}`;
  scene.elements.push({id:blockId,name:`${element.name??element.text??element.id} の動き`,type:'group',
    parentId:element.parentId,inPoint,outPoint:element.outPoint,anchorX:element.anchorX,anchorY:element.anchorY,
    zIndex:element.zIndex,transform:motion});
  scene.elements.push({...element,parentId:blockId,inPoint,anchorX:undefined,anchorY:undefined,transform:{opacity}});
  const {width,height} = elementSize(element);
  items.push({id:blockId,label:element.text??element.name??element.id,color:colors[items.length%colors.length],
    extent:localExtents(width,height),observationIds:[]});
  appearance.push({blockId,childIds:[element.id]});
}
const observed = Object.fromEntries(rows.map(row=>[row.observationId,{...row,t:time(row.frame),kind:'block-silhouette'}]));
const event = (id,kind,frame,label,inputs=[],outputs=[],observationIds=[],status='confirmed') =>
  ({id,kind,t:time(frame),label,inputs,outputs,observationIds,status});
const splitEvidence = ['silhouette:ta:16','silhouette:kaku:16'];
const transitions = measured.inversions.map(({frame,background})=>{
  const id = `polarity:${frame}`;
  observed[id] = {id,kind:'background-polarity',t:time(frame),frame,background};
  return event(id,'invert',frame,background==='dark'?'白から黒へ反転':'黒から白へ反転',[],[],[id]);
});
assert.deepEqual(measured.inversions.map(entry=>entry.frame),[82,93,150,160]);
const design = BlockingSchema.parse({
  blocks:{from:0,to:template.duration,measuredTo:end,sourceSha256:source.source.sha256,items},
  events:[
    event('first-kaku','appear',3,'「各」が登場',[],['block:kaku'],['silhouette:kaku:3']),
    event('kaku-contact','contact',15,'「田」と「各」が重なる',['block:ta','block:kaku'],['block:contact'],['silhouette:contact:15']),
    event('kaku-reappear','appear',16,'「田」と「各」が再び離れて見える',[],['block:ta','block:kaku'],splitEvidence),
    event('next-scene','cut',27,'「田＋丁」へ切り替え',[],['block:prior:taB','block:prior:cho']),
    event('meshi-proposed','merge',81,'「食＋反 → 飯」の読み',['block:prior:shokuE','block:prior:hanE'],['block:prior:meshi_join'],[],'proposed'),
    ...transitions,
  ].sort((a,b)=>a.t-b.t),appearance,
});
validateBlocking(scene,design);
const coverage = rows.filter(row => row.measurement && !row.measurement.touchesRoi).length;
assert.equal(coverage, rows.length);
const errors = [];
for (const [key, refs] of Object.entries(fixture.reference).filter(([key])=>key!=='note')) {
  for (const [frame, reference] of Object.entries(refs)) {
    const actual = byId(key).find(row=>row.frame===Number(frame))?.measurement.box;
    if (!actual) continue;
    const center = boxCenter(actual), expected = boxCenter(reference);
    errors.push({key,frame:Number(frame),reference,actual,center:Math.hypot(center[0]-expected[0],center[1]-expected[1]),
      width:Math.abs(actual[2]-reference[2]),height:Math.abs(actual[3]-reference[3])});
  }
}
const stats = key => {
  const values = errors.map(row=>row[key]).sort((a,b)=>a-b);
  const middle = Math.floor(values.length/2);
  return {median:values.length%2?values[middle]:(values[middle-1]+values[middle])/2,max:values.at(-1)};
};
assert.equal(errors.length,35);
assert.ok(stats('center').median < Math.hypot(scene.width,scene.height)*.01);
const {project} = previous ? getProject(previous.projectId) : createProject('Lyricsample1 · 工程比較',scene,'codex');
if(previous) assert.equal(project.source.sha256,source.source.sha256);
else fs.copyFileSync(sourceVideo, path.join(projectDir(project.id),'media',source.source.fileName));
const saved = commit(project.id,{
  baseRevision:previous?.revision??project.revision, actor:'codex',note:'実素材の輪郭計測と工程比較を保存',
  scene:()=>scene,
  meta:meta=>{meta.source=source.source;meta.audioAnalysis=source.audioAnalysis;},
  documents:documents=>({...documents,...design,observations:observed}),
});
const grid = await exportBlocking(project.id);
const gridFile = path.join(out, '01_comparison.mp4');
fs.copyFileSync(grid.path, gridFile);
for (const [view,file] of [['motion','02_motion.mp4'],['events','03_events.mp4'],['final','04_final.mp4']]) {
  const result = await exportVideo(saved.project,saved.scene,{from:0,to:scene.duration,width:960,layout:'render',withAudio:true,
    outputTag:`blocking-${view}`,sceneAt:t=>blockingFrame(saved.scene,design,t,view)});
  fs.copyFileSync(result.path,path.join(out,file));
}
for (const file of ['01_comparison.mp4','02_motion.mp4','03_events.mp4','04_final.mp4']) {
  const verification = JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_entries',
    'stream=codec_type,width,height,avg_frame_rate,nb_read_frames,duration','-of','json',path.join(out,file)],{encoding:'utf8'}));
  const video = verification.streams.find(stream=>stream.codec_type==='video');
  assert.equal(Number(video.nb_read_frames),source.source.frameCount,file);
  assert.equal(video.avg_frame_rate,source.source.frameRate,file);
  assert.ok(verification.streams.some(stream=>stream.codec_type==='audio'),file);
}
write('scene.json',saved.scene);
for (const [name,value] of Object.entries(design)) write(`${name}.json`,value);
write('report.json',{
  projectId:project.id,revision:saved.project.revision,sourceSha256:source.source.sha256,
  decodedFrames:measured.framesDecoded,measuredFrames:[0,fixture.toFrame],validMeasurements:coverage,requestedMeasurements:rows.length,
  annotatedSamples:errors.length,reference:fixture.reference.note,
  errorPx:{center:stats('center'),width:stats('width'),height:stats('height')},errors,
  ocr:{...measured.ocrRuntime,model:'PaddlePaddle/PP-OCRv5_mobile_rec_onnx',revision:'ed152b8',
    modelSha256:sha256(path.join(model,'inference.onnx')),dictionarySha256:sha256(path.join(model,'inference.yml')),
    candidates:rows.filter(row=>row.ocr).map(({id,frame,ocr})=>({id,frame,...ocr}))},
  inversions:measured.inversions,workerSeconds:measured.elapsedSeconds,
});
fs.writeFileSync(path.join(out,'README.md'),[
  '# Lyricsample1 工程比較','',`MLM のプロジェクトIDは \`${project.id}\`。プロジェクトを開いて「工程比較」を選ぶ。`,'',
  '- 01_comparison.mp4 に元動画・動き・関係と時刻・最終調整を収録。',
  '- 02_motion.mp4、03_events.mp4、04_final.mp4 は各工程の単独版。',
  '- 動きの実測は0〜26F。27F以降は既存シーンの動きと外観を使用。背景の反転時刻は全編から計測。',
  '- 箱の採点は目視の概算。人手の削減時間と独立した人による採点は未計測。',
  '- 15Fの「略」は目視による近似。OCRは「路」と読んだため、IDの交代は未確定。',
].join('\n')+'\n');
console.log(JSON.stringify({projectId:project.id,out,coverage,errorPx:{center:stats('center'),width:stats('width'),height:stats('height')},grid},null,2));
