import type { Scene, SceneOp, Time, Transform } from './schema.ts';
export function snapTime(scene:Scene,time:number,mode:'frame'|'cut'|'cut-frame'):number {
  if(mode==='frame') return Math.round(time*scene.fps)/scene.fps;
  const cuts=(scene.markers??[]).filter(m=>m.kind==='cut');
  const nearest=cuts.reduce<number|undefined>((best,m)=>best===undefined||Math.abs(m.t-time)<Math.abs(best-time)?m.t:best,undefined);
  if(nearest===undefined||Math.abs(nearest-time)>1/scene.fps+1e-9) return mode==='cut-frame'?Math.round(time*scene.fps)/scene.fps:time;
  // FFmpeg's printed timestamps can be a few microseconds past their CFR frame.
  const frame=Math.round(nearest*scene.fps)/scene.fps;
  return Math.abs(nearest-frame)<=5e-6?frame:nearest;
}
export function snapElementTimesOps(scene:Scene,id:string,mode:'frame'|'cut'):SceneOp[] {
  const element=structuredClone(scene.elements.find(e=>e.id===id));
  if(!element) throw new Error('要素がありません');
  const time=(t:Time):Time=>typeof t==='number'?snapTime(scene,t,mode):t;
  if(element.inPoint!==undefined) element.inPoint=time(element.inPoint);
  if(element.outPoint!==undefined) element.outPoint=time(element.outPoint);
  for(const transform of [element.transform,element.unitTransform] as (Transform|undefined)[]) {
    if(!transform) continue;
    for(const track of Object.values(transform)) if(typeof track==='object') {
      track.keys=track.keys.map(k=>({...k,t:time(k.t)}));
      if(track.repeat?.until!==undefined) track.repeat.until=time(track.repeat.until);
    }
  }
  return [{op:'upsertElement',element}];
}
