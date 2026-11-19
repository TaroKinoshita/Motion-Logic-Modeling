import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene,evaluateScene,fontSpec,sampleTrack,worldMatrixOf} from '@mlm/core';
import {sourcePath} from '../apps/server/src/media.ts';
import {checkScene,commit,getDocuments,getEvidenceSnapshot,getProject,REPO_ROOT} from '../apps/server/src/store.ts';
import {saveStyleStudy,StyleStudyRequest} from '../apps/server/src/style-study.ts';
import {publishPassage} from './passage-review.mjs';

const [intake,output]=process.argv.slice(2);
if(!intake||!output) throw new Error('Supply the corpus intake JSON and output folder');
const corpus=JSON.parse(await readFile(intake,'utf8')),dir=path.resolve(output),actor='corpus-motion-review';
await mkdir(dir,{recursive:true});
const worker=path.join(REPO_ROOT,'workers','track');
const python=process.env.MLM_TRACK_PYTHON??path.join(worker,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const run=(file,...args)=>JSON.parse(execFileSync(python,[path.join(worker,'track',file),...args],{encoding:'utf8',windowsHide:true}));
const source=sample=>{
  const work=corpus.works.find(entry=>entry.sample===sample);
  assert.ok(work&&sample<=6);
  const {project,scene}=getProject(work.projectId);
  assert.equal(project.source.sha256,work.sourceSha256);
  const {observations}=getEvidenceSnapshot(work.projectId,work.revision);
  const contours=new Map(Object.values(observations).filter(row=>row.kind==='block-contour').map(row=>[
    Number(row.id.split(':').at(-1)),new Map(row.samples.map(({frame,box})=>[frame,box])),
  ]));
  return {work,project,scene,contours};
};
function silhouette({contours},ids,frame) {
  const boxes=ids.flatMap(id=>{const found=contours.get(id)?.get(frame);return found?[found]:[];});
  if(!boxes.length) return undefined;
  const l=Math.min(...boxes.map(box=>box[0])),r=Math.max(...boxes.map(box=>box[0]+box[2]));
  const t=Math.min(...boxes.map(box=>box[1])),b=Math.max(...boxes.map(box=>box[1]+box[3]));
  return {frame,x:(l+r)/2,y:(t+b)/2,w:r-l,h:b-t};
}
const collect=(material,ids,first,end)=>Array.from({length:end-first},(_,i)=>silhouette(material,ids,first+i)).filter(Boolean);
const materials=[1,2,3,4,5,6].map(source);
const [one,two,three,four,five,six]=materials;

// Select contexts from the development clips. Registration is visual: a tracker may reuse an ID after a hard cut.
const baseEntries=[20,21,58,57,61].map(id=>collect(one,[id],49,60));
const blueSmall=collect(two,[110],68,76),blueLarge=collect(two,[126,127],77,91),sky=collect(two,[110,125],76,91);
const anchor=collect(four,[140],72,116),connector=collect(four,[151],78,116);
const second=collect(four,[165],104,116),suffix=collect(four,[166],104,116);
assert.equal(blueSmall.length,8);
assert.equal(anchor.length,44);
const narrowest=(rows,key)=>rows.reduce((best,next)=>next[key]<best[key]?next:best);
const checkSteps=(rows,key,from,to)=>rows.flatMap((row,i)=>i>0&&row.frame>=from&&row.frame<=to?
  [Math.abs(row[key]-rows[i-1][key])]:[]);
const measures=[
  {sample:1,key:'lead-settle',frames:[49,54,55,56,59],detail:'大きな先行字が小さくなり、55Fと56Fに後続が加わる。',values:{
    leadHeightDrop:baseEntries[1][0].h/baseEntries[1].at(-1).h,entryLagSeconds:(baseEntries[4][0].frame-baseEntries[2][0].frame)/24}},
  {sample:2,key:'whole-line-jump',frames:[75,76,77,78,82,87,90],detail:'76Fに大きな空、77Fに大きな青が現れる。小さい青の追跡IDが空に続くため位置合わせを切った。',values:{
    heightRatio:blueLarge.find(row=>row.frame===82).h/blueSmall.at(-1).h,arrivalDxPx:blueLarge[1].x-blueLarge[0].x,
    settledMaxDxPx:Math.max(...checkSteps(blueLarge,'x',82,87)),settledSpanSeconds:5/30}},
  {sample:3,key:'frame-unit',frames:[99,106,112],detail:'縦枠の中の表記が変わる。輪郭は枠と字を一体で追跡している。',values:{
    tallFrameHeightBeforePx:silhouette(three,[1],99).h,tallFrameHeightAfterPx:silhouette(three,[1],112).h},limitations:'枠と本文の個別キーは計測できない'},
  {sample:4,key:'persistent-anchor',frames:[72,84,96,104,112],detail:'先行のどが横に薄くなって戻り、別の小字と第二の大字が加わる。',values:{
    narrowestWidthRatio:narrowest(anchor,'w').w/anchor[0].w,narrowestFrame:narrowest(anchor,'w').frame,
    secondToCompanionHeightRatio:second.find(row=>row.frame===112).h/suffix.find(row=>row.frame===112).h,
    secondEntrySeconds:(second[0].frame-anchor[0].frame)/24}},
  {sample:5,key:'cut-contrast',frames:[12,24,132],detail:'小字の表示から大字の表示に切り替わる。24Fの最大輪郭は文字と周辺を含む。',values:{
    smallGlyphHeightPx:silhouette(five,[24],12).h,largeForegroundHeightPx:silhouette(five,[3],24).h},limitations:'大字の高さの比は字の輪郭だけの比較ではない'},
];

// Apply the preselected size threshold without fitting thresholds or tracks on sample 6.
const criteria={scaleContrastMinRatio:1.5,roleGrowth:'保持する先行要素と、別の時刻に加わる後続要素が必要',
  verification:'検証素材の概要は初回に閲覧済み。計測と補間の学習には使っていない。'};
const holdout=run('corpus_foreground.py',sourcePath(six.project),'120','142',JSON.stringify([0,300,1920,520]));
const peak=Math.max(...holdout.slice(0,7).map(row=>row.box[3])),settled=Math.max(...holdout.slice(11).map(row=>row.box[3]));
const validation={sample:6,frames:[120,142],text:'やめろよ',peakHeightPx:peak,settledHeightPx:settled,heightRatio:peak/settled,
  scaleContrast:peak/settled>=criteria.scaleContrastMinRatio,roleGrowth:false,reason:'この区間では4文字全体が一緒に縮む。後続字が加わる条件には該当しない。',samples:holdout};
assert.equal(validation.scaleContrast,true);

const sampleCases=[
  {material:two,slug:'02-jump',label:'風→風音',first:68,end:91,background:'#f8eed8',cues:[76,77,82],
    roles:[['early','風','#507c7e',blueSmall],['late-right','音','#507c7e',sky],['late-left','風','#507c7e',blueLarge]]},
  {material:four,slug:'04-anchor',label:'風が吹く',first:72,end:116,background:'#1c3138',cues:[78,82,104],
    roles:[['lead','風','#ca9f63',anchor],['connector','が','#eee8d9',connector],['second','吹','#5893a5',second],['suffix','く','#eee8d9',suffix]]},
];
const ctx=createCanvas(1,1).getContext('2d');
const normalized=(text,fill)=>{
  const element={type:'text',text,fill,fontFamily:'MLM Yu Gothic',fontWeight:700,fontSize:100};
  ctx.font=fontSpec(element);ctx.textAlign='center';ctx.textBaseline='middle';
  const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=ctx.measureText(text);
  assert.ok(l+r>0&&a+b>0);
  const sx=100/(l+r),sy=100/(a+b);
  return {...element,transform:{x:(l-r)*sx/2,y:(a-b)*sy/2,scaleX:sx,scaleY:sy}};
};
const outputs=[];
for(const {material,slug,label,first,end,background,cues,roles} of sampleCases) {
  const {work,project}=material,{fps,width,height}=project.source,t=frame=>(frame-first)/fps;
  const groups=[],leaves=[],fitStats=[];
  for(const [role,text,fill,rows] of roles) {
    const segments=[];
    for(const row of rows) {
      if(row.frame!==segments.at(-1)?.at(-1)?.frame+1) segments.push([]);
      segments.at(-1).push(row);
    }
    for(const [index,part] of segments.entries()) {
      const id=`${role}:${index}`,life={inPoint:t(part[0].frame),outPoint:t(part.at(-1).frame+1)};
      const samples=part.map(({frame,...row})=>({t:t(frame),...row}));
      const tolerance={x:3,y:3,w:3,h:3};
      const pins={x:[],y:[],w:[],h:[]};
      if(role==='lead') pins.w=[part.findIndex(row=>row.frame===narrowest(part,'w').frame)];
      const {eased}=part.length===1?{eased:{tracks:Object.fromEntries(Object.keys(tolerance).map(key=>[key,[{t:samples[0].t,value:samples[0][key]}]]))}}:
        run('motion_vocabulary_fit.py',JSON.stringify([samples,tolerance,pins]));
      const value=(key,unit=1)=>{
        const keys=eased.tracks[key].map(row=>({t:row.t,v:row.value/unit,ease:row.easing}));
        return keys.every(key=>key.v===keys[0].v)?keys[0].v:{keys};
      };
      const transform={x:value('x'),y:value('y'),scaleX:value('w',100),scaleY:value('h',100)};
      groups.push({id,name:`${role} · ${text}`,type:'group',...life,transform});
      leaves.push({id:`${id}:appearance`,parentId:id,text,fill,...life});
      const errors=Object.keys(tolerance).map(key=>Math.max(...part.map(row=>Math.abs(row[key]-sampleTrack(
        transform[{x:'x',y:'y',w:'scaleX',h:'scaleY'}[key]],t(row.frame),0)*(['w','h'].includes(key)?100:1)))));
      assert.ok(Math.max(...errors)<=3.001);
      fitStats.push({id,from:part[0].frame,to:part.at(-1).frame+1,sampledValues:part.length*4,
        keys:Object.values(transform).reduce((sum,track)=>sum+(typeof track==='number'?0:track.keys.length),0),maxErrorsPx:errors});
    }
  }
  const shared={...emptyScene(),width,height,fps,duration:t(end),background,markers:cues.map(frame=>({t:t(frame),kind:'note',origin:'measured',label:`元 ${frame}F`}))};
  const blocks=checkScene({...shared,elements:[...groups,...leaves.map(({text,...leaf})=>({...leaf,type:'rect',width:100,height:100}))]});
  const replacement=checkScene({...shared,elements:[...groups,...leaves.map(({text,fill,...leaf})=>({...leaf,...normalized(text,fill)}))]});
  for(let frame=first;frame<end;frame++) {
    const visible=scene=>evaluateScene(scene,t(frame)).map(entry=>entry.element.id);
    assert.deepEqual(visible(blocks),visible(replacement));
    for(const group of groups) assert.deepEqual(worldMatrixOf(blocks,group.id,t(frame)),worldMatrixOf(replacement,group.id,t(frame)));
  }
  const provenance={kind:'corpus-role-motion',sourceProjectId:project.id,sourceRevision:work.revision,sourceSha256:project.source.sha256,
    frameRange:[first,end],roles:roles.map(([role,text,fill,rows])=>({role,text,trace:rows})),fitStats,
    scope:'Selected roles and their axis-aligned envelopes. Background ornaments and the rest of the source sentence are omitted.'};
  const published=await publishPassage({dir:path.join(dir,slug),project,first,end,actor,title:`Lyricsample${work.sample} · ${label}`,
    blocks,replacement,replacementLabel:label,documents:{adaptation:provenance}});
  outputs.push({sample:work.sample,slug,...published,fitStats});
}

const evaluated=[...measures,{sample:6,key:'size-check',frames:[120,126,129,132,141],detail:validation.reason,
  values:{heightRatio:validation.heightRatio},criteria,findings:{scaleContrast:validation.scaleContrast,roleGrowth:validation.roleGrowth}}];
for(const entry of evaluated) {
  const {work,project}=materials[entry.sample-1];
  const id=`corpus-motion:${entry.sample}:${entry.key}`;
  const row={...entry,id,kind:'corpus-motion-measurement',origin:'measured',sourceRevision:work.revision,sourceSha256:project.source.sha256};
  const saved=commit(project.id,{baseRevision:project.revision,actor,note:'作例の動きと比較結果を保存',documents:docs=>({
    ...docs,observations:{...docs.observations,[id]:row},
  })});
  entry.observationId=id;
  entry.revision=saved.project.revision;
}
const revisions=new Map(corpus.works.map(work=>[work.projectId,getProject(work.projectId).project.revision]));
const reference=entry=>({projectId:materials[entry.sample-1].project.id,revision:entry.revision,observationId:entry.observationId});
const refs=items=>items.map(ref=>({...ref,revision:revisions.get(ref.projectId)}));
const host=corpus.hostProjectId;
const currentStudy=getDocuments(host).style_study;
const claims=currentStudy.claims.filter(claim=>!['jump-then-settle','focus-and-next-entry'].includes(claim.id))
  .map(({summary,...claim})=>({...claim,evidence:refs(claim.evidence),exceptions:refs(claim.exceptions)}));
claims.push({id:'jump-then-settle',axis:'motion',label:'急に入ってから止まりに近づく',
  condition:'Lyricsample2の「青空」の例。別作品で繰り返されるかは未確認。',evidence:[reference(measures[1])]},
{id:'focus-and-next-entry',axis:'screen',label:'先行の主役を残して次の主役を加える',
  condition:'Lyricsample4の「ど」「分」の例。主役を残さず切り替える場合とは別に点検する。',evidence:[reference(measures[3])]});
const study=saveStyleStudy(host,StyleStudyRequest.parse({baseRevision:revisions.get(host),actor,
  works:currentStudy.works.map(({title,sourceSha256,...work})=>({...work,revision:revisions.get(work.projectId)})),claims}));
const report={criteria,measures,validation,outputs,study:{projectId:host,revision:study.project.revision,claims:study.study.claims.map(item=>item.id)},
  excluded:{sample:7,reason:'effect reproduction excluded at user request'}};
await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({measures,validation:{...validation,samples:undefined},outputs},null,2));
