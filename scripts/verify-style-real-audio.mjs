import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {emptyScene} from '@mlm/core';
import {detectBeats} from '../apps/server/src/beats.ts';
import {exportVideo} from '../apps/server/src/export.ts';
import {generateLyricStudy,LyricGenerationRequest} from '../apps/server/src/lyric-generation.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {getDocuments,getProject,listProjects} from '../apps/server/src/store.ts';

const [registry,libraryReport,out]=process.argv.slice(2);
assert.ok(registry&&libraryReport&&out,'Supply corpus registry, motion library report, and output folder');
const dir=path.resolve(out),actor='real-audio-style-review';
await mkdir(dir,{recursive:true});
process.env.UV_CACHE_DIR??=path.join(dir,'cache','uv');
process.env.NUMBA_CACHE_DIR??=path.join(dir,'cache','numba');
await mkdir(process.env.NUMBA_CACHE_DIR,{recursive:true});
const load=async file=>JSON.parse(await readFile(file,'utf8'));
const corpus=await load(registry);
const targetRow=corpus.study.works.find(row=>row.group==='control'&&row.title.startsWith('LyricOther2 ·'));
assert.ok(targetRow);
const source=getProject(targetRow.projectId);
assert.equal(source.project.source?.sha256,targetRow.sourceSha256);
assert.ok(source.project.source?.hasAudio&&source.project.source.fps===24);
const name='LyricOther2 · 実音源での構図と合字の比較';
const targetCopy=listProjects().find(p=>p.name===name&&p.source?.sha256===targetRow.sourceSha256);
let target=targetCopy?getProject(targetCopy.id):saveGeneratedProject(name,{
  ...emptyScene(),width:source.scene.width,height:source.scene.height,fps:source.scene.fps,duration:source.scene.duration,
},source.project.id,actor,{adaptation:{sourceProjectId:source.project.id,sourceSha256:source.project.source.sha256}});
if(!target.project.audioAnalysis) {
  await detectBeats(target.project.id,target.project.revision,actor);
  target=getProject(target.project.id);
}
const fps=target.scene.fps;
const beatFrames=[...new Set((target.scene.markers??[]).filter(m=>m.kind==='beat').map(m=>Math.round(m.t*fps)))];
assert.ok(beatFrames.length>=19);
const at=index=>beatFrames[index]/fps;
const {libraryProjectId}=await load(libraryReport);
const library=getProject(libraryProjectId);
assert.ok(getDocuments(libraryProjectId).motion_vocabulary.slide);

const lyrics=[
  {text:'風をほどいて',from:at(0),to:at(4),tags:['line'],layout:{x:.35,y:.39,size:.18,letterSpacing:.10},
    motion:[{id:'slide',duration:.5,strength:.60}]},
  {text:'林',parts:['木','木'],ruby:'はやし',from:at(4),to:at(9),tags:['combine'],
    layout:{x:.50,y:.50,size:.37,readingRatio:.14},partLayouts:[{x:.29,y:.60,size:.35},{x:.70,y:.37,size:.23}],
    compoundShot:{delayFrames:1,layout:{x:.58,y:.49,size:.57}}},
  {text:'朝へ走る',from:at(9),to:at(13),tags:['line'],layout:{x:.64,y:.60,size:.20,letterSpacing:.08},
    motion:[{id:'hold',duration:.42,strength:.7}]},
  {text:'明',parts:['日','月'],ruby:'あかり',from:at(13),to:at(18),tags:['combine'],
    layout:{x:.48,y:.51,size:.40,readingRatio:.14},partLayouts:[{x:.32,y:.42,size:.30},{x:.65,y:.61,size:.37}],
    compoundShot:{delayFrames:1,layout:{x:.43,y:.50,size:.57}}},
];
const study=generateLyricStudy(library.project.id,LyricGenerationRequest.parse({baseRevision:library.project.revision,
  targetProjectId:target.project.id,targetRevision:target.project.revision,actor,name:'対照音源での演出比較',
  comparison:'composition-compound',lyrics,effects:[{kind:'entrance',claimId:'on-entry',tag:'line'},
    {kind:'combine',claimId:'compound',tag:'combine'}]}));
const rows=[];
const end=at(18),count=beatFrames[18];
for(const variant of study.variants) {
  const state=getProject(variant.project.id);
  assert.equal(state.project.source?.sha256,source.project.source.sha256);
  const result=await exportVideo(state.project,state.scene,{from:0,to:end,width:640,layout:'render',withAudio:true,outputTag:'real-audio-style'});
  assert.equal(result.frameCount,count);
  const file=`version-${variant.label}.mp4`;
  await copyFile(result.path,path.join(dir,file));
  rows.push({file,label:variant.label,projectId:state.project.id,revision:state.project.revision,
    editableText:state.scene.elements.filter(el=>el.type==='text').length,
    condition:study.reveal[variant.label],compoundEvents:getDocuments(state.project.id).adaptation.compoundEvents});
}
const compare=path.join(dir,'comparison.mp4');
execFileSync('ffmpeg',['-v','error','-y',...rows.flatMap(row=>['-i',path.join(dir,row.file)]),'-filter_complex_threads','1',
  '-filter_complex','[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|640_0|0_360|640_360[v]',
  '-map','[v]','-map','0:a:0','-frames:v',String(count),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy',compare],{windowsHide:true});
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',compare],{encoding:'utf8'}));
const video=probe.streams.find(s=>s.codec_type==='video');
assert.deepEqual([video.width,video.height,Number(video.nb_read_frames),probe.streams.filter(s=>s.codec_type==='audio').length],
  [1280,720,count,1]);
await writeFile(path.join(dir,'reveal-and-results.json'),JSON.stringify({
  sourceClip:source.project.name,sourceProjectId:source.project.id,sourceSha256:source.project.source.sha256,
  targetProjectId:target.project.id,libraryProjectId:library.project.id,estimatedBpm:target.project.audioAnalysis?.bpm,
  beatFrames:beatFrames.slice(0,19),lyrics,rows,frameCount:count,fps,
  limitations:['lyrics and primary-role cues were authored for the test','source vocals were not transcribed or aligned',
    'this audio is distinct as a file and was part of the attribution comparison; work credits and series are unverified',
    'no independent perception rating has been collected'],
},null,2));
console.log('Render and verify',compare,count,'frames',rows);
