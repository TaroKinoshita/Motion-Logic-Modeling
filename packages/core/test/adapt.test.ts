import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyScene, retimeSections, varyHold, sampleTrack } from '../src/index.ts';
import type { Scene, Track } from '../src/schema.ts';

test('section retiming preserves easing, beat repeats and stagger under affine time change',()=>{
  const source:Scene={...emptyScene(),duration:4,tempo:{bpm:120,offset:0},elements:[{id:'text',type:'text',text:'AB',split:'char',stagger:{interval:{beats:.2}},inPoint:{beat:0},outPoint:{beat:8},transform:{x:{keys:[{t:{beat:0},v:0,ease:'easeIn'},{t:{beat:2},v:100}],repeat:{every:{beats:4},count:2}}}}]};
  const result=retimeSections(source,{...emptyScene(),duration:8},[{sourceFrom:0,sourceTo:4,targetFrom:0,targetTo:8,elementIds:['text'],reason:'double length'}]);
  const a=source.elements[0].transform!.x!,b=result.elements[0].transform!.x!;
  for(const t of [0,.2,.7,1.2,2.1,3.8]) assert.ok(Math.abs(sampleTrack(a,t,0,source.tempo)-sampleTrack(b,2*t,0,result.tempo))<1e-8);
  assert.equal(result.elements[0].stagger!.interval,.2);
  assert.deepEqual(source.tempo,{bpm:120,offset:0});
});

test('section assignment rejects ambiguous parents, missing and duplicate elements',()=>{
  const s={...emptyScene(),elements:[{id:'p',type:'group' as const},{id:'c',type:'rect' as const,parentId:'p'}]};
  const section={sourceFrom:0,sourceTo:10,targetFrom:0,targetTo:10,elementIds:['p'],reason:'test'};
  assert.throws(()=>retimeSections(s,s,[section]),/区間対応|親子/);
  assert.throws(()=>retimeSections(s,s,[section,{...section,elementIds:['c']}]),/親子/);
  assert.throws(()=>retimeSections(s,s,[{...section,elementIds:['p','c','p']}]),/重複/);
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
