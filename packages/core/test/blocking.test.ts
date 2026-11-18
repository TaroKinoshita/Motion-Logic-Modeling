import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockingFrame, emptyScene, evaluateScene, validateBlocking } from '../src/index.ts';
import type { Blocking, Scene } from '../src/index.ts';

const scene: Scene = {...emptyScene(),duration:2,elements:[
  {id:'parent',type:'group',inPoint:0,outPoint:2,transform:{x:{keys:[{t:0,v:100},{t:1,v:200}]},y:90}},
  {id:'glyph',type:'text',parentId:'parent',text:'田',fontSize:20,transform:{scaleX:2}},
]};
const design: Blocking = {
  blocks:{from:0,to:2,sourceSha256:'source',items:[{
    id:'parent',label:'A',color:'#ffffff',observationIds:[],
    extent:{cx:0,cy:0,width:{keys:[{t:0,v:80},{t:1,v:160}]},height:50},
    hiddenDuring:[{from:1.25,to:1.5}],
  }]},
  events:[],
  appearance:[{blockId:'parent',childIds:['glyph']}],
};

test('the placeholder and glyph share translation while extent edits leave the glyph scale unchanged',()=>{
  validateBlocking(scene,design);
  for(const [time,width,cx] of [[0,80,100],[1,160,200]]) {
    const [box] = evaluateScene(blockingFrame(scene,design,time,'motion'),time);
    const [glyph] = evaluateScene(blockingFrame(scene,design,time,'final'),time);
    assert.equal(box.width,width);
    assert.equal(box.cx,cx);
    assert.equal(glyph.cx,cx);
    assert.equal(glyph.matrix[0],2);
  }
  for(const view of ['motion','final'] as const) {
    assert.equal(evaluateScene(blockingFrame(scene,design,1.25,view),1.25).length,0);
    assert.equal(evaluateScene(blockingFrame(scene,design,1.5,view),1.5).length,1);
  }
});

test('a confirmed replacement requires an end and a new start at the same time',()=>{
  const next:Scene={...scene,elements:[...scene.elements,{id:'result',type:'group',inPoint:1.5}]};
  const replacement:Blocking={
    blocks:{...design.blocks,items:[...design.blocks.items,{...design.blocks.items[0],id:'result'}]},
    appearance:design.appearance,
    events:[{id:'swap',kind:'replace',status:'confirmed',t:1.5,label:'交代',inputs:['parent'],outputs:['result'],observationIds:[]}],
  };
  assert.throws(()=>validateBlocking(next,replacement),/寿命が一致しません/);
  next.elements[0]={...next.elements[0],outPoint:1.5};
  assert.doesNotThrow(()=>validateBlocking(next,replacement));
});
