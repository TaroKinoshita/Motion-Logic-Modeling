import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyScene,snapTime,snapElementTimesOps,applyOps} from '../src/index.ts';
test('24fps snap is explicit, exact and preserves beat relations',()=>{
  const scene=emptyScene();scene.fps=24;scene.tempo={bpm:120,offset:0};
  scene.markers=[{t:3.417,kind:'cut'}];
  scene.elements=[{id:'a',type:'rect',inPoint:3.42,transform:{x:{keys:[{t:{beat:1},v:0},{t:3.42,v:1}]}}}];
  assert.equal(snapTime(scene,3.42,'cut'),3.417);
  assert.equal(snapTime(scene,2,'cut'),2);
  assert.equal(snapTime(scene,2.05,'frame'),49/24);
  scene.markers.push({t:6.66667,kind:'cut'});
  assert.equal(snapTime(scene,6.6667,'cut'),160/24);
  const next=applyOps(scene,snapElementTimesOps(scene,'a','cut'));
  assert.equal(next.elements[0].inPoint,3.417);
  assert.equal(scene.elements[0].inPoint,3.42);
  assert.deepEqual((next.elements[0].transform!.x as {keys:unknown[]}).keys[0],{t:{beat:1},v:0});
});
