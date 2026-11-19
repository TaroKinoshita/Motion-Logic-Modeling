import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sampleTrack} from '@mlm/core';
import {exportVideo} from '../apps/server/src/export.ts';
import {generateLyricStudy,LyricGenerationRequest} from '../apps/server/src/lyric-generation.ts';
import {sourcePath} from '../apps/server/src/media.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {MotionVocabularyRequest,saveMotionVocabulary} from '../apps/server/src/motion-vocabulary.ts';
import {getDocuments,getProject,REPO_ROOT} from '../apps/server/src/store.ts';
import {saveStyleStudy,StyleStudyRequest} from '../apps/server/src/style-study.ts';
import {editTiming,TimingRequest} from '../apps/server/src/timing.ts';

const [intakeFile,fullReferenceId,libraryId,outDir]=process.argv.slice(2);
if(!intakeFile||!fullReferenceId||!libraryId||!outDir) throw new Error('Supply intake, sample 1, motion library and comparison output folder');
const dir=path.resolve(outDir),actor='corpus-review';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const intake=await read(intakeFile);
const corpus=await Promise.all([2,3,4,5,6,7].map(n=>read(path.join(dir,`Lyricsample${n}`,'report.json'))));
const m4=await read(path.join(dir,'M4-Real-Audio','report.json'));
const reference=getProject(fullReferenceId);
const previous=getDocuments(intake.hostProjectId);
const host=saveGeneratedProject('Lyricsample · 7本の全編モデルと演出観察',reference.scene,fullReferenceId,actor,
  {...getDocuments(fullReferenceId),observations:{...getDocuments(fullReferenceId).observations,...previous.observations}});
const bySample=new Map([[1,{projectId:host.project.id,revision:host.project.revision}],...corpus.map(row=>[row.sample,row])]);
const oldSample=new Map(intake.works.map(row=>[row.projectId,row.sample]));
const ref=(sample,observationId)=>{
  const {projectId,revision}=bySample.get(sample);
  assert.ok(getDocuments(projectId).observations[observationId],`${sample}: ${observationId}`);
  return {projectId,revision,observationId};
};
const reports=corpus.map(row=>{
  const project=getProject(row.projectId).project;
  const video=path.join(dir,`Lyricsample${row.sample}`,'04-editable.mp4');
  const quality=JSON.parse(execFileSync(process.env.MLM_BLOCKING_PYTHON??'python',
    [path.join(REPO_ROOT,'scripts','measure-corpus-render.py'),sourcePath(project),video,row.profile],
    {encoding:'utf8',windowsHide:true,timeout:120000}));
  assert.equal(quality.frames,row.frames);
  assert.equal(row.remainingFrameContours,0);
  const {sample,frames,fps,projectId,revision,variantId,rawKeys,transformKeys,rawContourFrames,attachedFixedShapes,blockCount,shortBlocks}=row;
  const substitutions=row.substitutions.map(({original,text,frames,rubyOf})=>({
    original,text,from:frames[0],to:frames.at(-1)+1,observedFrames:frames.length,ruby:!!rubyOf,
  }));
  return {sample,frames,fps,projectId,revision,variantId,rawKeys,transformKeys,rawContourFrames,attachedFixedShapes,blockCount,shortBlocks,
    substitutions,estimatedBpm:project.audioAnalysis?.bpm??null,estimatedBeats:row.estimatedBeatCount,beatMethod:project.audioAnalysis?.params?.beatTracker??null,
    timing:row.timing&&{events:row.timing.events.map(({event,matches,assessment})=>({event,assessment,
      beatDeltaMs:matches.beat.length?matches.beat[0].offsetSeconds*1000:null,onsetDeltaMs:matches.onset.length?matches.onset[0].offsetSeconds*1000:null})),
    shift:row.timing.shiftControl},quality};
});

const works=[...bySample.values()].map(({projectId,revision})=>({projectId,revision,group:'author',
  credit:'ユーザー提供の同じ映像担当',creditBasis:'ユーザー申告。抜粋の完成作品・担当クレジットの照合は未実施'}));
const claims=previous.style_study.claims.map(({id,axis,label,condition,evidence,exceptions,generation})=>({id,axis,label,condition,generation,
  evidence:evidence.map(row=>ref(oldSample.get(row.projectId),row.observationId)),
  exceptions:exceptions.map(row=>ref(oldSample.get(row.projectId),row.observationId)),
}));
const extra=(id,evidence)=>claims.find(row=>row.id===id)?.evidence.push(...evidence);
extra('size-hierarchy',[ref(6,'review-event:6:129:evidence'),ref(7,'review-event:7:210:evidence'),ref(7,'review-event:7:240:evidence')]);
extra('phrase-assembly',[ref(2,'review-event:2:76:evidence'),ref(4,'review-event:4:104:evidence')]);
claims.find(row=>row.id==='phrase-assembly')?.exceptions.push(ref(6,'review-event:6:129:evidence'));
extra('graphic-partners',[ref(3,'review-event:3:101:evidence'),ref(4,'review-event:4:148:evidence')]);
extra('visual-wordplay',[ref(3,'review-event:3:110:evidence')]);
claims.push({id:'collective-scale',axis:'motion',label:'語全体の1コマ縮小',
  condition:'文字が増減せず、前後で同じ語を共有する区間。現時点の反復はLyricsample6内の2区間。',
  evidence:[ref(6,'review-event:6:129:evidence'),ref(6,'review-event:6:274:evidence')],exceptions:[]});
const study=saveStyleStudy(host.project.id,StyleStudyRequest.parse({baseRevision:host.project.revision,actor,works,claims}));

const group=bySample.get(6);
const vocabulary=await saveMotionVocabulary(group.projectId,MotionVocabularyRequest.parse({
  baseRevision:getProject(group.projectId).project.revision,actor,clips:[
    {id:'phrase-drop-a',label:'やめろよ・全体の縮小',kind:'scale-jump',blockId:'review:6:0',from:124,to:137},
    {id:'phrase-drop-b',label:'回った・全体の縮小',kind:'scale-jump',blockId:'review:6:1',from:269,to:283},
  ]}));
assert.deepEqual(vocabulary.templates.map(row=>row.transition.frame),[129,274]);
for(const item of vocabulary.templates) {
  assert.ok(item.tracks.scaleX.some(key=>key.easing==='hold'));
  assert.ok(item.tracks.scaleY.some(key=>key.easing==='hold'));
}
const scaleAndAudio=[];
for(const template of vocabulary.templates) {
  const result=editTiming(group.projectId,TimingRequest.parse({baseRevision:getProject(group.projectId).project.revision,actor,
    operation:'motion',blockId:template.blockId,from:template.from,to:template.to}));
  scaleAndAudio.push({template:template.id,observation:result.observation});
}

const base=getProject(libraryId),baseDocs=getDocuments(libraryId);
const reuse=saveGeneratedProject('Lyricsample · 複数素材の型で別の語を生成',base.scene,libraryId,actor,{
  ...baseDocs,motion_vocabulary:{...baseDocs.motion_vocabulary,...Object.fromEntries(vocabulary.templates.map(row=>[row.id,row]))},
});
const soundtrack=getProject(m4.audio.soundtrackProjectId);
const beats=soundtrack.scene.markers.filter(marker=>marker.kind==='beat');
const lyrics=[
  {text:'待ってて',from:beats[2].t,to:beats[9].t,layout:{x:.5,y:.45,size:.155},
    motion:[{id:'phrase-drop-a',duration:1.75,unit:'beats',offset:.28}]},
  {text:'光がほどける',from:beats[10].t,to:beats[19].t,layout:{x:.5,y:.55,size:.108},
    motion:[{id:'phrase-drop-b',duration:2,unit:'beats',offset:.38}]},
];
const variation=generateLyricStudy(reuse.project.id,LyricGenerationRequest.parse({baseRevision:reuse.project.revision,
  targetProjectId:soundtrack.project.id,targetRevision:soundtrack.project.revision,actor,name:'語ごとの瞬間縮小 · 実音源',
  comparison:'motion-layout',lyrics,effects:[{claimId:'on-entry',kind:'entrance'}]}));
const jumpFiles=[];
for(const condition of ['layout','motion-layout']) {
  const variant=variation.variants.find(row=>variation.reveal[row.label]===condition);
  const {scene,project}=getProject(variant.project.id);
  const groups=scene.elements.filter(el=>el.id.endsWith(':motion')&&el.transform?.scaleX&&el.transform?.scaleY);
  assert.equal(groups.length,condition==='motion-layout'?2:0);
  const scaleJumps=groups.map(group=>{
    const at=frame=>Math.sqrt(sampleTrack(group.transform.scaleX,frame/scene.fps,1,scene.tempo)*
      sampleTrack(group.transform.scaleY,frame/scene.fps,1,scene.tempo));
    const first=Math.ceil(group.inPoint*scene.fps),last=Math.ceil(group.outPoint*scene.fps)-1;
    const row=Array.from({length:last-first},(_,i)=>{
      const frame=first+i+1;
      return {frame,ratio:at(frame-1)/at(frame)};
    }).sort((a,b)=>b.ratio-a.ratio)[0];
    assert.ok(row.ratio>1.5);
    return {elementId:group.id,...row};
  });
  const rendered=await exportVideo(project,scene,{from:0,to:scene.duration,width:640,layout:'render',withAudio:true,outputTag:'corpus-scale'});
  const file=`scale-${variant.label}.mp4`;
  await fs.copyFile(rendered.path,path.join(dir,'M4-Real-Audio',file));
  jumpFiles.push({condition,file,id:project.id,frameCount:rendered.frameCount,scaleJumps});
}
execFileSync('ffmpeg',['-v','error','-y',...jumpFiles.flatMap(row=>['-i',path.join(dir,'M4-Real-Audio',row.file)]),
  '-filter_complex','[0:v][1:v]hstack[v]','-map','[v]','-map','0:a:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','copy',
  path.join(dir,'M4-Real-Audio','whole-phrase-comparison.mp4')],{windowsHide:true});

const filter=corpus.map((_,i)=>`[${i}:v]fps=30,setsar=1[v${i}];[${i}:a]aresample=48000[a${i}]`).join(';');
const tracks=corpus.map((_,i)=>`[v${i}][a${i}]`).join('');
execFileSync('ffmpeg',['-v','error','-y',...corpus.flatMap(row=>['-i',path.join(dir,`Lyricsample${row.sample}`,'01-comparison.mp4')]),
  '-filter_complex_threads','1','-filter_complex',`${filter};${tracks}concat=n=6:v=1:a=1[v][a]`,'-map','[v]','-map','[a]',
  '-c:v','libx264','-preset','fast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path.join(dir,'all-six-comparison.mp4')],{windowsHide:true});

const app=process.env.MLM_REVIEW_URL??'http://localhost:5173/';
const appLink=id=>`${app}?compare=1#${id}`;
const summary={hostProjectId:host.project.id,hostRevision:study.project.revision,
  corpus:reports,vocabulary:vocabulary.templates,scaleAndAudio,claims:study.study.claims,m4:{...m4,wholePhraseVariants:jumpFiles},
  scope:['Six source-length reconstructions; selected verified text substitutions','No independent control authors or blind verdict',
    'Estimated beat and onset values do not identify the cause of a visual decision','Soundtracks only; lyric alignment and instrument stems were unavailable'],
  app:appLink(host.project.id)};
await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(summary,null,2));
const table=reports.map(row=>{
  const figure=row.quality.areaWeightedIoU?.toFixed(3)??'—';
  return `| Lyricsample${row.sample} | [開く](${appLink(row.projectId)}) | [4画面](Lyricsample${row.sample}/01-comparison.mp4) | [差し替え](Lyricsample${row.sample}/05-replacement.mp4) | ${row.frames} | ${row.substitutions.length} | ${figure} |`;
}).join('\n');
await fs.writeFile(path.join(dir,'INDEX.md'),`# Lyricsample2〜7 全編比較

[6本連続の4画面比較](all-six-comparison.mp4) / [アプリの作品比較](${summary.app}) / [計測結果](report.json)

| 素材 | アプリ | 動画 | 文字違い | 元のコマ数 | 置換箇所（ルビ込み） | 前景IoU |
| --- | --- | --- | --- | ---: | ---: | ---: |
${table}

- 02-motion.mp4 は中間①、03-events.mp4 は中間②、04-editable.mp4 は最終調整。すべて元動画の長さ。
- [M4 区間転用と比較基準](M4-Real-Audio/sections-vs-baselines.mp4) は左上が区間転用、右上が全体速度、左下が拍の両端、右下が固定テンプレート。局所拍合わせも個別に保存。
- [M4 語全体を縮める条件比較](M4-Real-Audio/whole-phrase-comparison.mp4) は右にLyricsample6から取った2種類の縮小を適用。両方ともLyricsample7の音声を使用。

IoUは輪郭の診断値。欠測と誤差はJSONに収録。図形や未確認の文字は固定輪郭が残り、文字として編集できる箇所は表の本数です。7のエフェクトは再現対象外です。
`);
console.log(JSON.stringify({host:summary.hostProjectId,revision:summary.hostRevision,corpus:reports.map(row=>[
  row.sample,row.frames,row.substitutions.length,row.quality.areaWeightedIoU,row.transformKeys,row.shortBlocks,row.estimatedBpm,
]),jumpFiles}));
