import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, retimeSections, varyHold, varyHoldGroup, sampleTrack, resolveTime, evaluateScene } from '../src/index.ts';
import type { Scene, Track } from '../src/schema.ts';

test('section retiming preserves easing, beat repeats and stagger under affine time change',()=>{
  const source:Scene={...emptyScene(),duration:4,tempo:{bpm:120,offset:0},elements:[{id:'text',type:'text',text:'AB',split:'char',stagger:{interval:{beats:.2}},inPoint:{beat:0},outPoint:{beat:8},transform:{x:{keys:[{t:{beat:0},v:0,ease:'easeIn'},{t:{beat:2},v:100}],repeat:{every:{beats:4},count:2}}}}]};
  const result=retimeSections(source,{...emptyScene(),duration:8},[{sourceFrom:0,sourceTo:4,targetFrom:0,targetTo:8,elementIds:['text'],reason:'double length'}],false);
  const a=source.elements[0].transform!.x!,b=result.elements[0].transform!.x!;
  for(const t of [0,.2,.7,1.2,2.1,3.8]) assert.ok(Math.abs(sampleTrack(a,t,0,source.tempo)-sampleTrack(b,2*t,0,result.tempo))<1e-8);
  assert.equal(result.elements[0].stagger!.interval,.2);
  assert.deepEqual(source.tempo,{bpm:120,offset:0});
});

test('section assignment permits independent parents but rejects missing and duplicate elements',()=>{
  const s={...emptyScene(),elements:[{id:'p',type:'group' as const},{id:'c',type:'rect' as const,parentId:'p'}]};
  const section={sourceFrom:0,sourceTo:10,targetFrom:0,targetTo:10,elementIds:['p'],reason:'test'};
  assert.throws(()=>retimeSections(s,s,[section]),/区間対応|親子/);
  assert.equal(retimeSections(s,s,[section,{...section,elementIds:['c']}]).elements.length,2);
  assert.throws(()=>retimeSections(s,s,[{...section,elementIds:['p','c','p']}]),/重複/);
});

test('beat keys align to irregular target markers and remain tempo editable',()=>{
  const source:Scene={...emptyScene(),duration:4,tempo:{bpm:120,offset:0},elements:[{id:'a',type:'rect',transform:{x:{keys:[{t:{beat:0},v:0},{t:{beat:2,offsetSeconds:.02},v:100}]},y:{keys:[{t:0,v:0},{t:1,v:100}]}}}]};
  const target:Scene={...emptyScene(),duration:4,tempo:{bpm:120,offset:0},markers:[0,.4,1.3,1.8].map(t=>({t,kind:'beat',origin:'manual'}))};
  const sections=[{sourceFrom:0,sourceTo:4,targetFrom:0,targetTo:4,elementIds:['a'],reason:'beat relation'}];
  const result=retimeSections(source,target,sections);
  const key=(result.elements[0].transform!.x as Exclude<Track,number>).keys[1];
  assert.throws(()=>retimeSections(source,{...emptyScene(),duration:4},sections),/拍関係/);
  assert.equal(typeof key.t,'object');
  assert.ok(Math.abs(resolveTime(key.t,result.tempo)-1.32)<1e-10);
  assert.ok(Math.abs(resolveTime(key.t,{bpm:60,offset:0})-2.32)<1e-10);
  const baseline=retimeSections(source,target,sections,false);
  assert.equal((baseline.elements[0].transform!.x as Exclude<Track,number>).keys[1].t,1.02);
  assert.equal((result.elements[0].transform!.y as Exclude<Track,number>).keys[1].t,1);
});

test('a persistent parent spans contiguous sections without clipping its child',()=>{
  const source:Scene={...emptyScene(),duration:4,elements:[{id:'background',type:'rect'},{id:'parent',type:'group',transform:{x:20}},{id:'title',type:'text',parentId:'parent',text:'TITLE'}]};
  const target={...emptyScene(),duration:6};
  const sections=[{sourceFrom:0,sourceTo:2,targetFrom:0,targetTo:3,elementIds:['background','parent','title'],reason:'first'},{sourceFrom:2,sourceTo:4,targetFrom:3,targetTo:6,elementIds:['background','parent','title'],reason:'second'}];
  const result=retimeSections(source,target,sections);
  assert.equal(result.elements.length,3);
  assert.equal(result.elements.find(e=>e.id==='title')!.outPoint,6);
  assert.equal(evaluateScene(result,4).some(e=>e.element.id==='title'),true);
  assert.throws(()=>retimeSections(source,target,[sections[0],{...sections[1],targetFrom:3.5}]),/連続/);
});

test('group hold changes parent and child tracks together and rejects mismatched windows',()=>{
  const source:Scene={...emptyScene(),elements:[{id:'parent',type:'group',transform:{scaleX:{keys:[{t:0,v:1},{t:1,v:.95},{t:2,v:.95},{t:3,v:1}]}}},{id:'child',type:'rect',parentId:'parent',transform:{x:{keys:[{t:0,v:0},{t:1,v:10},{t:2,v:10},{t:3,v:20}]}}}]};
  const targets=[{elementId:'parent',property:'scaleX' as const,keyIndex:1},{elementId:'child',property:'x' as const,keyIndex:1}];
  const changed=varyHoldGroup(source,targets,.5);
  for(const t of targets) assert.deepEqual((changed.elements.find(e=>e.id===t.elementId)!.transform![t.property] as Exclude<Track,number>).keys.map(k=>k.t),[0,1,1.5,2.5]);
  assert.equal((source.elements[0].transform!.scaleX as Exclude<Track,number>).keys[2].t,2);
  (source.elements[1].transform!.x as Exclude<Track,number>).keys[2].t=2.1;
  assert.throws(()=>varyHoldGroup(source,targets,.5),/揃えて/);
});

test('beat endpoint baseline keeps elements before and after the beat range',()=>{
  const source:Scene={...emptyScene(),duration:4,elements:[{id:'intro',type:'rect',outPoint:.5},{id:'outro',type:'rect',inPoint:3.5}]};
  const result=retimeSections(source,source,[{sourceFrom:1,sourceTo:3,targetFrom:1,targetTo:3,elementIds:['intro','outro'],reason:'endpoints'}],false);
  assert.equal(evaluateScene(result,.25).some(e=>e.element.id==='intro'),true);
  assert.equal(evaluateScene(result,3.75).some(e=>e.element.id==='outro'),true);
});

test('hold variants preserve source and reject repeat or overflow',()=>{
  const s:Scene={...emptyScene(),elements:[{id:'a',type:'rect',transform:{x:{keys:[{t:0,v:0},{t:1,v:10},{t:2,v:10},{t:3,v:20}]}}}]};
  const noHold=varyHold(s,'a','x',1,0);
  const track=noHold.elements[0].transform!.x as Exclude<Track,number>;
  assert.deepEqual(track.keys.map(k=>k.t),[0,1,2]);
  assert.equal(sampleTrack(track,1.5,0),15);
  assert.equal((s.elements[0].transform!.x as Exclude<Track,number>).keys.length,4);
  assert.throws(()=>varyHold(s,'a','x',1,20),/表示区間/);
  assert.throws(()=>varyHold(s,'a','x',0,1),/同じ値/);
});
