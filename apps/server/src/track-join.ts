import { resolveTime, sampleTrack, type Blocking, type Scene, type Track } from '@mlm/core';
import { HttpError } from './store.ts';

/** Join manually reviewed fixed-shape fragments at an adjacent source-frame boundary. */
export function joinTracks(scene:Scene,design:Blocking,firstId:string,secondId:string) {
  const ids=[firstId,secondId];
  const sources=ids.map(id=>{
    const element=scene.elements.find(item=>item.id===id&&item.type==='group');
    const block=design.blocks.items.find(item=>item.id===id);
    const appearance=design.appearance.find(item=>item.blockId===id);
    if(!element||!block||block.members||!appearance||appearance.contours?.length||design.blocks.items.some(item=>item.members?.includes(id))) {
      throw new HttpError(422,'接続には固定した外観を持つ独立したブロックを指定してください');
    }
    const start=resolveTime(element.inPoint??0,scene.tempo),end=resolveTime(element.outPoint??scene.duration,scene.tempo);
    if(end<=start||[start,end].some(t=>Math.abs(t*scene.fps-Math.round(t*scene.fps))>1e-7)||
      scene.elements.some(item=>item.parentId===id&&!appearance.childIds.includes(item.id))) {
      throw new HttpError(422,'フレーム境界の表示範囲と登録済みの外観だけを持つブロックを指定してください');
    }
    return {element,block,appearance,start,end};
  });
  const [a,b]=sources;
  if(firstId===secondId||a.element.parentId!==b.element.parentId||a.element.zIndex!==b.element.zIndex||
    a.element.anchorX!==b.element.anchorX||a.element.anchorY!==b.element.anchorY||Math.abs(a.end-b.start)>1e-8) {
    throw new HttpError(422,'同じ親とアンカーを持ち、前後が隣り合う軌道を時刻順に指定してください');
  }
  if(scene.markers?.some(marker=>marker.kind==='cut'&&Math.abs(marker.t-a.end)<.5/scene.fps)||
    design.events.some(event=>event.status==='confirmed'&&(
    [...event.inputs,...event.outputs].some(id=>ids.includes(id))||
    ['cut','invert'].includes(event.kind)&&Math.abs(event.t-a.end)<1e-8))) {
    throw new HttpError(422,'確定した出来事の対象やカット・反転の境界は接続できません');
  }
  const tracks=(left:Track|undefined,right:Track|undefined,fallback:number):Track=>{
    const keys=sources.flatMap(({start,end},index)=>{
      const from=Math.round(start*scene.fps),to=Math.round(end*scene.fps);
      return Array.from({length:to-from},(_,i)=>{
        const t=(from+i)/scene.fps;
        const boundary=index===0&&from+i===to-1;
        return {t,v:sampleTrack(index===0?left:right,t,fallback,scene.tempo),ease:boundary?'hold' as const:undefined};
      });
    });
    if(keys.every(key=>key.v===keys[0].v)) return keys[0].v;
    return {keys:keys.filter((key,i)=>{
      const prev=keys[i-1],next=keys[i+1];
      return !prev||!next||!!key.ease||!!prev.ease||Math.abs(key.v-(prev.v+next.v)/2)>1e-9;
    })};
  };
  const fields=['x','y','scaleX','scaleY','rotation','shearX','opacity'] as const;
  a.element.transform=Object.fromEntries(fields.filter(field=>a.element.transform?.[field]!==undefined||b.element.transform?.[field]!==undefined)
    .map(field=>[field,tracks(a.element.transform?.[field],b.element.transform?.[field],['scaleX','scaleY','opacity'].includes(field)?1:0)]));
  a.element.outPoint=b.element.outPoint;
  for(const {appearance,start,end} of sources) for(const id of appearance.childIds) {
    const child=scene.elements.find(item=>item.id===id)!;
    child.parentId=firstId;
    child.inPoint=Math.max(start,resolveTime(child.inPoint??start,scene.tempo));
    child.outPoint=Math.min(end,resolveTime(child.outPoint??end,scene.tempo));
    if(child.outPoint<=child.inPoint) throw new HttpError(422,`外観 ${id} の表示範囲が崩れています`);
  }
  a.appearance.childIds=[...a.appearance.childIds,...b.appearance.childIds];
  a.block.extent=Object.fromEntries((['cx','cy','width','height'] as const).map(field=>[field,tracks(a.block.extent[field],b.block.extent[field],0)])) as typeof a.block.extent;
  a.block.hiddenDuring=[...a.block.hiddenDuring??[],...b.block.hiddenDuring??[]];
  a.block.observationIds=[...new Set([...a.block.observationIds,...b.block.observationIds])];
  for(const event of design.events) {
    const replace=(refs:string[])=>[...new Set(refs.map(id=>id===secondId?firstId:id))];
    event.inputs=replace(event.inputs);
    event.outputs=replace(event.outputs);
  }
  scene.elements=scene.elements.filter(item=>item.id!==secondId);
  design.blocks.items=design.blocks.items.filter(item=>item.id!==secondId);
  design.appearance=design.appearance.filter(item=>item.blockId!==secondId);
  return {survivingId:firstId,joinedIds:ids,frame:Math.round(b.start*scene.fps)};
}
