import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const [output='data/Lyricsample_Theory_Study']=process.argv.slice(2);
const measurements=JSON.parse(await fs.readFile(path.join(output,'measurements.json'),'utf8'));
const cases=[
  {id:'meshi',sample:1,frame:81,components:true,units:1,beatReliable:false,
    labels:['飯を直接表示','食と反を別々に表示','食と反を出して飯へ合体']},
  {id:'blue-sky',sample:2,frame:77,components:false,units:2,beatReliable:false,
    stagingOpportunity:'separate-cues',labels:['青空を直接表示','小さい青を切り替え、空と青を順に大字へ']},
  {id:'anchor',sample:4,frame:104,components:false,units:2,beatReliable:false,
    stagingOpportunity:'separate-cues',retainAllowed:true,labels:['文を一度に表示','先行のどを保持して分を追加']},
  {id:'whole-phrase',sample:6,frame:129,components:false,units:1,beatReliable:false,
    labels:['やめろよをそのまま表示','やめろよを保持し、語全体を縮小']},
  {id:'kana-counterexample',components:false,units:3,beatReliable:false,stagingOpportunity:'single-cue',
    labels:['かなだけの行を表示','かなを順に表示']},
  {id:'kana-separate-cues',components:false,units:3,beatReliable:false,stagingOpportunity:'separate-cues',
    labels:['かなだけの行を表示','個別の提示指示に合わせてかなを順に表示']},
  {id:'kana-missing-cues',components:false,units:3,beatReliable:false,stagingOpportunity:'unknown',
    labels:['かなだけの行を表示','かなを順に表示']},
  {id:'single-counterexample',components:false,units:1,oneGlyph:true,beatReliable:true,labels:['一文字を表示']},
  {id:'unreliable-beat-counterexample',components:true,units:1,beatReliable:false,labels:['合字可能な字を表示','部品を順に表示','部品を出して合体']},
];
const actual={meshi:'combine','blue-sky':'successive',anchor:'successive','whole-phrase':'shrink'};
assert.equal(measurements.anchors.merge.frame,81);
assert.equal(measurements.anchors.settle.values.arrivalDxPx,162);
assert.equal(measurements.anchors.shrink.frames[0],120);

function candidates(input) {
  const list=[{id:'direct',actions:['lyric']}];
  if(input.oneGlyph) return list;
  if(input.components) return list.concat([
    {id:'separate',actions:['lyric','parts']},
    {id:'combine',actions:['lyric','parts','combine','emphasis']},
  ]);
  if(input.units>=2) return list.concat({id:'successive',actions:['lyric','entry','emphasis',...(input.retainAllowed?['retain']:[])]});
  return list.concat({id:'shrink',actions:['lyric','retain','emphasis','shrink']});
}
const weights={combine:3,entry:2,shrink:1};
const constraints=[
  {a:'parts',b:'combine',weight:2},
  {a:'entry',b:'emphasis',weight:1},
  {a:'shrink',b:'retain',weight:1},
  {a:'combine',b:'emphasis',weight:1},
];
function scoreA(candidate,input,parameters) {
  const has=action=>candidate.actions.includes(action);
  const reward=Object.entries(parameters).reduce((sum,[action,w])=>sum+(has(action)?w:0),0);
  const available=new Set(candidates(input).flatMap(c=>c.actions));
  const total=constraints.filter(c=>available.has(c.a)&&available.has(c.b))
    .reduce((sum,{a,b,weight})=>sum+(has(a)===has(b)?weight:0),0);
  return reward+total;
}
function scoreB(candidate,parameters) {
  const has=action=>candidate.actions.includes(action);
  const interactions=[['parts','combine',1],['entry','emphasis',1],['shrink','retain',1]];
  return Object.entries(parameters).reduce((sum,[action,w])=>sum+(has(action)?w:0),0)+
    interactions.reduce((sum,[a,b,w])=>sum+(has(a)&&has(b)?w:0),0);
}
const archetypes=cases.filter(c=>c.sample);
const distance=(a,b)=>Number(a.components!==b.components)+Math.min(2,Math.abs(a.units-b.units))+
  Number(a.beatReliable!==b.beatReliable)+Number(a.stagingOpportunity!==b.stagingOpportunity);
const contextualWeights=(input,parameters=weights)=>({...parameters,entry:input.stagingOpportunity==='separate-cues'?parameters.entry:-2});
const scores=cases.map(input=>{
  const options=candidates(input);
  const comparisons=options.map((candidate,i)=>({id:candidate.id,label:input.labels[i],A:scoreA(candidate,input,weights),
    B:scoreB(candidate,weights),conditionalA:scoreA(candidate,input,contextualWeights(input)),
    conditionalB:scoreB(candidate,contextualWeights(input)),actions:candidate.actions,
    AWithoutPreference:scoreA(candidate,input,{combine:0,entry:0,shrink:0})}));
  const rank=field=>[...comparisons].sort((a,b)=>b[field]-a[field]).map(row=>({candidate:row.id,score:row[field]}));
  const neighbors=archetypes.filter(other=>other.sample!==input.sample)
    .map(other=>({id:other.id,distance:distance(input,other),candidate:actual[other.id]})).sort((a,b)=>a.distance-b.distance);
  const compatible=neighbors.filter(row=>options.some(c=>c.id===row.candidate));
  const nearest=compatible.filter(row=>row.distance===compatible[0].distance);
  const transfer=nearest.length?{candidates:[...new Set(nearest.map(row=>row.candidate))],examples:nearest.map(row=>row.id)}:{candidates:['direct'],examples:[],fallback:true};
  return {id:input.id,sample:input.sample,frame:input.frame,observed:actual[input.id]??null,input:{
    components:input.components,units:input.units,oneGlyph:input.oneGlyph??false,beatReliable:input.beatReliable,
    stagingOpportunity:input.stagingOpportunity??null},comparisons,
    A:rank('A'),B:rank('B'),C:transfer,conditionalA:rank('conditionalA'),conditionalB:rank('conditionalB'),
    AWithoutPreference:rank('AWithoutPreference')};
});
for(const example of scores) {
  assert.ok(example.comparisons.some(row=>row.id==='direct'));
  if(!example.input.components) assert.ok(example.comparisons.every(row=>row.id!=='combine'));
}
assert.deepEqual(scores.find(row=>row.id==='single-counterexample').A,[{candidate:'direct',score:0}]);
assert.ok(scores.find(row=>row.id==='whole-phrase').AWithoutPreference.every(row=>row.score===1));
for(const model of ['conditionalA','conditionalB']) {
  assert.equal(scores.find(row=>row.id==='kana-counterexample')[model][0].candidate,'direct');
  assert.equal(scores.find(row=>row.id==='kana-separate-cues')[model][0].candidate,'successive');
  assert.equal(scores.find(row=>row.id==='kana-missing-cues')[model][0].candidate,'direct');
}
const caseOf=id=>scores.find(row=>row.id===id).comparisons.find(row=>row.id==='successive');
assert.equal(caseOf('blue-sky').actions.includes('retain'),false);
assert.equal(caseOf('anchor').actions.includes('retain'),true);
const grid=[0,1,2].flatMap(combine=>[0,1,2].flatMap(entry=>[0,1,2].map(shrink=>({combine,entry,shrink}))));
function topCandidates(input, parameters) {
  const scored=candidates(input).map(candidate=>({id:candidate.id,score:scoreA(candidate,input,contextualWeights(input,parameters))}));
  const best=Math.max(...scored.map(row=>row.score));
  return scored.filter(row=>row.score===best).map(row=>row.id);
}
const sensitivity=archetypes.map(heldOut=>{
  const fit=archetypes.filter(row=>row.sample!==heldOut.sample);
  const admissible=grid.filter(parameters=>fit.every(input=>{
    const top=topCandidates(input,parameters);
    return top.length===1&&top[0]===actual[input.id];
  }));
  const picks=admissible.map(parameters=>topCandidates(heldOut,parameters));
  return {heldOut:heldOut.id,fitCases:fit.map(input=>input.id),admissibleWeightCount:admissible.length,
    ranges:Object.fromEntries(Object.keys(weights).map(key=>[key,[...new Set(admissible.map(row=>row[key]))].sort()])),
    observedAsUniqueTop:picks.filter(ids=>ids.length===1&&ids[0]===actual[heldOut.id]).length,
    tiedIncludingObserved:picks.filter(ids=>ids.length>1&&ids.includes(actual[heldOut.id])).length};
});
await fs.writeFile(path.join(output,'formalization-pilot.json'),JSON.stringify({status:'illustration with manually selected candidate sets and weights',
  weights,constraints,hardConstraints:['mandatory lyric display','merge requires available parts','beat-relative moves are outside the pilot'],
  contextualAssumption:'Separate presentation cues can justify staggering. Cues are supplied as experimental inputs; real-case labels were assigned retrospectively, not inferred from unseen audio or lyrics.',
  sensitivity:{method:'27 hand-defined weight triples; leave one excerpt out; retrospective staging inputs limit validity',results:sensitivity},
  models:{A:'reward for equal adoption or rejection',B:'unary utility plus bonuses for jointly selected actions',
    C:'nearest compatible observed case after leaving the sample out'},cases:scores},null,2));
console.log(scores.map(row=>[row.id,row.A[0].candidate,row.conditionalA[0].candidate,row.conditionalB[0].candidate,row.C.candidates.join(', ')]));
