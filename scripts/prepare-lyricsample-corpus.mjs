import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {emptyScene} from '@mlm/core';
import {analyzeSequence,sequenceDesign} from '../apps/server/src/block-sequence.ts';
import {detectCuts,mediaTarget,probe} from '../apps/server/src/media.ts';
import {getPassages} from '../apps/server/src/passage-study.ts';
import {commit,createProject,getDocuments,getProject,listProjects,trashProject} from '../apps/server/src/store.ts';
import {saveStyleStudy,StyleStudyRequest} from '../apps/server/src/style-study.ts';

const [baseId,inventoryFile,reviewFile]=process.argv.slice(2);
if(!baseId||!inventoryFile||!reviewFile) throw new Error('Supply the baseline project, media inventory and visual review');
const read=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const inventory=await read(inventoryFile),review=await read(reviewFile),actor='corpus-intake';
const dir=path.dirname(path.resolve(inventoryFile));
assert.equal(new Set(inventory.map(item=>item.sha256)).size,inventory.length);
const base=getProject(baseId);
assert.equal(base.project.source.sha256,inventory.find(item=>item.sample===1).sha256);
const existing=listProjects();
const results=[];
for(const item of inventory) {
  const {sample,sha256}=item;
  const plan=review.works.find(entry=>entry.sample===sample);
  assert.ok(plan);
  const name=`Lyricsample${sample} · 作家性レビュー`;
  const matching=existing.find(project=>project.name===name&&project.source?.sha256===sha256);
  let state=matching?getProject(matching.id):undefined;
  if(!state) {
    const created=createProject(name,emptyScene(),actor);
    try {
      const media=mediaTarget(created.project.id,item.path);
      await copyFile(item.path,media.file);
      const manifest=await probe(media.file,media.fileName);
      assert.equal(manifest.sha256,sha256);
      state=commit(created.project.id,{baseRevision:created.project.revision,actor,note:'同じ映像担当の参考断片として登録',
        meta:project=>{project.source=manifest;},scene:scene=>({...scene,width:manifest.width,height:manifest.height,fps:manifest.fps,duration:manifest.duration})});
    } catch(error) {trashProject(created.project.id,actor); throw error;}
  }
  let {project,scene}=state;
  const docs=getDocuments(project.id);
  let trackReport=null;
  let design,measuredObservations;
  if(plan.scope==='development') {
    if(sample===1) {
      const baseline=getDocuments(baseId);
      design={blocks:baseline.blocks,events:baseline.events,appearance:baseline.appearance};
      measuredObservations=baseline.observations;
      scene=base.scene;
    } else if(!docs.blocks) {
      const cuts=(await detectCuts(project,18)).map(cut=>Math.round(cut.t*project.source.fps)).filter(frame=>frame>0&&frame<project.source.frameCount);
      const options={cuts:[...new Set(cuts)]};
      const sequence=await analyzeSequence(project,options);
      const derived=sequenceDesign(project,scene,sequence,options,`corpus${sample}`);
      ({scene,design,observations:measuredObservations}=derived);
      trackReport={tracks:sequence.tracks.length,commonMotionFrames:sequence.cameraCandidates.length,cutCandidates:options.cuts.length,
        elapsedSeconds:sequence.runtimeSeconds,polarityCandidates:design.events.length};
    } else trackReport=docs.adaptation?.tracking??null;
  }
  const observations=Object.fromEntries(plan.notes.map(note=>{
    assert.ok(note.frames.length&&note.frames.every(frame=>Number.isInteger(frame)&&frame>=0&&frame<project.source.frameCount));
    const id=`visual-corpus:${sample}:${note.key}`;
    return [id,{...note,id,kind:'corpus-visual-observation',origin:'manual',sourceSha256:sha256,sourceRevision:project.revision,
      seconds:note.frames.map(frame=>frame/project.source.fps),scope:plan.scope,evidenceStatus:'initial-review'}];
  }));
  state=commit(project.id,{baseRevision:project.revision,actor,note:'元コマに対応する初見の観察を登録',
    scene:()=>({...scene,markers:[...scene.markers??[]].filter(marker=>!marker.label?.startsWith('作品比較 ')).concat(Object.values(observations).map(note=>({
      t:note.seconds[0],kind:'note',origin:'manual',label:`作品比較 ${note.label}`,
    })))}),
    documents:old=>({...old,...design,observations:{...old.observations,...measuredObservations,...observations},
      adaptation:{kind:'corpus-intake',scope:plan.scope,reconstructEffects:false,credit:'ユーザー提供・同じ映像担当',tracking:trackReport}})});
  const passageCandidates=plan.scope==='development'?getPassages(state.project.id).candidates.map(({id,pattern,from,to})=>({id,pattern,from,to})):[];
  results.push({sample,projectId:state.project.id,revision:state.project.revision,sourceSha256:sha256,scope:plan.scope,tracking:trackReport,
    passageCandidates,observations:Object.values(observations)});
  console.log(JSON.stringify({sample,projectId:state.project.id,tracking:trackReport,candidates:passageCandidates.length}));
}
const bySample=new Map(results.map(item=>[item.sample,item]));
const reference=([sample,key])=>{
  const work=bySample.get(sample),observation=work.observations.find(note=>note.key===key);
  assert.ok(observation);
  assert.equal(work.scope,'development');
  return {projectId:work.projectId,revision:work.revision,observationId:observation.id};
};
const host=bySample.get(1);
const request=StyleStudyRequest.parse({baseRevision:host.revision,actor,
  works:results.map(row=>({projectId:row.projectId,revision:row.revision,group:'author',credit:'氏名未提供（同じ映像担当）',creditBasis:'ユーザー申告'})),
  claims:review.claims.map(claim=>({...claim,evidence:claim.evidence.map(reference),exceptions:(claim.exceptions??[]).map(reference)}))});
const saved=saveStyleStudy(host.projectId,request);
await writeFile(path.join(dir,'app-corpus.json'),JSON.stringify({hostProjectId:host.projectId,hostRevision:saved.project.revision,
  works:results,study:saved.study,limitations:['同じ制作者という情報はユーザー申告','7ファイルのSHAは別々。収録元の作品単位の独立性は未照合',
    '初見の観察。フレーム間の緩急、歌との対応、作家固有性は未判定','自動抽出結果は候補。色のある映像は輪郭の欠落を含みうる']},null,2));
console.log(JSON.stringify({hostProjectId:host.projectId,revision:saved.project.revision,claims:saved.study.claims.length}));
