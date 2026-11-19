import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {evaluateScene,worldMatrixOf} from '@mlm/core';
import {getBlocking} from '../apps/server/src/blocking.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {editPassage,getPassages,PassageRequest} from '../apps/server/src/passage-study.ts';
import {getDocuments,getProject} from '../apps/server/src/store.ts';
import {saveStyleStudy,StyleStudyRequest} from '../apps/server/src/style-study.ts';

const [sourceId,output]=process.argv.slice(2);
if(!sourceId||!output) throw new Error('Supply the edited Lyricsample1 project and output folder');
const initial=getBlocking(sourceId),actor='passage-study-verification';
const copied=saveGeneratedProject('Lyricsample1 · 作品比較の準備',initial.scene,sourceId,actor,getDocuments(sourceId));
const id=copied.project.id;
const {candidates}=getPassages(id);
const sequential=candidates.find(row=>row.pattern==='sequential-entry'&&row.from===55);
const common=candidates.find(row=>row.pattern==='common-translation'&&row.from===97);
const falsePositive=candidates.find(row=>row.pattern==='sequential-entry'&&row.from===71);
assert.ok(sequential&&common&&falsePositive);
const request=(body,baseRevision=getProject(id).project.revision)=>editPassage(id,PassageRequest.parse({baseRevision,actor,...body}));
const review=(candidate,status,patch={})=>request({operation:'review',candidateId:candidate.id,pattern:candidate.pattern,
  from:candidate.from,to:candidate.to,blockIds:candidate.blockIds,status,...patch});
const track=n=>`track:lyrics:${n}`;
const seq=review(sequential,'confirmed',{from:49,blockIds:[20,21,58,57,61].map(track),note:'先行する2字を含め、55Fと56Fの登場を確認'});
const shared=review(common,'confirmed',{note:'同方向への移動を確認。実際のカメラ操作は不明'});
const rejected=review(falsePositive,'rejected',{note:'71Fの候補はルビとその断片で、文字本文の順次出現ではない'});
assert.throws(()=>request({operation:'assemble',reviewId:rejected.observation.id,name:'却下された候補',text:'赤い空'}),error=>error.status===422);
assert.throws(()=>request({operation:'assemble',reviewId:seq.observation.id,name:'古いリビジョン',text:'春風そよぐ'},seq.project.revision),error=>error.status===409);
assert.throws(()=>request({operation:'assemble',reviewId:seq.observation.id,name:'文字数違い',text:'四文字だ'}),error=>error.status===422);
const rendered=[];
for(const [entry,name,text] of [[seq,'順次出現・春風そよぐ','春風そよぐ'],[shared,'共通移動・木陰','木陰']]) {
  const result=request({operation:'assemble',reviewId:entry.observation.id,name,text});
  const show={};
  for(let frame=entry.observation.from;frame<entry.observation.to;frame++) {
    const t=frame/initial.scene.fps;
    const shown=evaluateScene(result.scene,t).filter(element=>element.element.id.startsWith('passage-text:'));
    for(const {element} of shown) {
      const sourceElement=element.id.slice('passage-text:'.length),anchor=`passage-anchor:${sourceElement}`;
      const a=worldMatrixOf(initial.scene,sourceElement,t),b=worldMatrixOf(result.scene,anchor,t);
      assert.ok(a.every((value,index)=>Math.abs(value-b[index])<1e-8));
    }
    show[frame]=shown.map(value=>value.element.text).join('');
  }
  assert.equal(show[entry.observation.to-1],text);
  rendered.push({projectId:result.project.id,reviewId:entry.observation.id,show});
}
assert.deepEqual([54,55,56].map(frame=>rendered[0].show[frame]),['春風','春風そよ','春風そよぐ']);
const evidenceRevision=getProject(id).project.revision;
const ref=entry=>({projectId:id,revision:evidenceRevision,observationId:entry.observation.id});
const corpus={baseRevision:evidenceRevision,actor,
  works:[{projectId:id,revision:evidenceRevision,group:'author',credit:'映像担当未確認',creditBasis:'ユーザー提供の原素材。担当者名の照合は追加素材の受領時'}],
  claims:[{id:'sequential-entry',axis:'timing',label:'順次出現',condition:'既存文字に後続の文字が加わる',evidence:[ref(seq)],exceptions:[ref(rejected)]},
    {id:'common-translation',axis:'motion',label:'共通移動',condition:'別々の文字が近い方向に同時に移動する',evidence:[ref(shared)]}]};
assert.throws(()=>saveStyleStudy(id,StyleStudyRequest.parse({...corpus,claims:[{...corpus.claims[0],evidence:[ref(rejected)],exceptions:[]}]})),error=>error.status===422);
assert.throws(()=>saveStyleStudy(id,StyleStudyRequest.parse({...corpus,works:[...corpus.works,{...corpus.works[0],projectId:sourceId,revision:initial.project.revision}]})),error=>error.status===422);
const {study,project}=saveStyleStudy(id,StyleStudyRequest.parse(corpus));
assert.equal(study.claims[0].summary.author.works,1);
assert.equal(study.claims[0].summary.author.exceptionCount,1);
assert.equal(study.claims[0].summary.author.distributions['sequential-entry.entrySpanSeconds'].median,1/24);
assert.equal(study.claims[1].summary.control.works,0);
const dir=path.resolve(output);
await mkdir(dir,{recursive:true});
await writeFile(path.join(dir,'phase3-report.json'),JSON.stringify({projectId:id,revision:project.revision,candidates,rendered,study,
  available:{author:1,control:0,unseenRealTrack:0},pending:['同じ担当の別作品','別担当の対照作品','転用先の実曲音源']},null,2));
console.log(JSON.stringify({projectId:id,revision:project.revision,rendered}));
