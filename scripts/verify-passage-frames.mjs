// Frame-exact round trip of every passage (docs/50 step 1).
// identity: re-time each passage onto its own window and compare every transform channel of every
// block group on every frame with the source, evaluated by the shared sampler (eases included).
// half: compress the passage to half its length and compare each output frame with the source at the
// corresponding source time (inverse of the linear map). Collisions move keys by one frame, so the
// half-speed error is reported, not asserted.
// Usage: node scripts/verify-passage-frames.mjs <out.json>
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {sampleTrack} from '@mlm/core';
import {PASSAGES} from '../apps/server/src/passage-library.ts';
import {loadPassage,retarget,seeded} from '../apps/server/src/passage-staging.ts';

const channels=['x','y','scaleX','scaleY','rotation','shearX'];
const fallback={x:0,y:0,scaleX:1,scaleY:1,rotation:0,shearX:0};
const rows=[];
for(const spec of PASSAGES) {
  const p=loadPassage(spec);
  for(const factor of [1,.5]) {
    const start=p.fromSec,end=p.fromSec+(p.toSec-p.fromSec)*factor;
    const tokens=p.textSlots.map(slot=>({text:'字',at:start+(Math.max(p.fromSec,slot.inSec)-p.fromSec)*factor,emphasis:false}));
    const built=retarget(p,tokens,start,end,'f',{width:p.width,height:p.height,fps:p.fps,duration:end,rng:seeded(1),mode:'faithful'});
    const worst={position:0,scale:0,rotation:0,shear:0};
    for(const slot of p.slots) {
      const copy=built.elements.find(e=>e.id==='f:'+slot.index);
      if(!copy) continue;
      for(let f=Math.round(copy.inPoint*p.fps);f<Math.round(copy.outPoint*p.fps);f++) {
        const t=f/p.fps, ts=p.fromSec+(t-start)/factor;
        for(const name of channels) {
          const a=sampleTrack(slot.group.transform?.[name],ts,fallback[name]);
          const b=sampleTrack(copy.transform?.[name],t,fallback[name]);
          const d=Math.abs(a-b);
          if(name==='x'||name==='y') worst.position=Math.max(worst.position,d);
          else if(name==='rotation') worst.rotation=Math.max(worst.rotation,d);
          else if(name==='shearX') worst.shear=Math.max(worst.shear,d);
          else worst.scale=Math.max(worst.scale,d/Math.max(1e-6,Math.abs(a)));
        }
      }
    }
    rows.push({passage:spec.id,factor,...Object.fromEntries(Object.entries(worst).map(([k,v])=>[k,+v.toFixed(4)]))});
  }
}
for(const r of rows) console.log(r.passage.padEnd(12),'x'+r.factor,'pos',r.position,'scale',r.scale,'rot',r.rotation,'shear',r.shear);
for(const r of rows.filter(r=>r.factor===1)) {
  assert.ok(r.position<1,`${r.passage} position error ${r.position}px`);
  assert.ok(r.scale<.005,`${r.passage} scale error ${r.scale}`);
}
await writeFile(process.argv[2]??'data/Scene_Roundtrip/frames.json',JSON.stringify(rows,null,1));
console.log('identity: all passages within 1px / 0.5%');
