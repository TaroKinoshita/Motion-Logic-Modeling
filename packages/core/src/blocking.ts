import { z } from 'zod';
import { sampleTrack, isActive, worldMatrixOf } from './evaluate.ts';
import { resolveTime } from './time.ts';
import { ElementSchema, TrackSchema } from './schema.ts';
import type { Scene, SceneElement, Time, Track } from './schema.ts';
import type { planSectionRetiming } from './adapt.ts';

const id = z.string().min(1);
const box = z.strictObject({cx:TrackSchema,cy:TrackSchema,width:TrackSchema,height:TrackSchema});
const interval = z.strictObject({from:z.number().nonnegative(),to:z.number().positive()});
export const BlocksSchema = z.strictObject({
  from:z.number().nonnegative(),to:z.number().positive(),sourceSha256:z.string(),
  measuredTo:z.number().positive().optional(),
  derived:z.boolean().optional(),
  backgroundLuma:TrackSchema.optional(),
  items:z.array(z.strictObject({
    id,label:z.string(),color:z.string(),extent:box,observationIds:z.array(id),
    hiddenDuring:z.array(interval).optional(),
    members:z.array(id).min(2).optional(),
  })).min(1),
});
export const EventsSchema = z.array(z.strictObject({
  id,kind:z.enum(['appear','contact','merge','split','replace','hold','invert','cut','rotate','shape']),
  t:z.number().nonnegative(),until:z.number().nonnegative().optional(),label:z.string(),
  beatRelative:z.boolean().optional(),
  inputs:z.array(id),outputs:z.array(id),observationIds:z.array(id),status:z.enum(['proposed','confirmed','rejected']),
}));
export const AppearanceSchema = z.array(z.strictObject({
  blockId:id,childIds:z.array(id).min(1),
  contours:z.array(z.strictObject({t:z.number().nonnegative(),luma:z.number().int().min(0).max(255),
    color:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),paths:ElementSchema.shape.outline.unwrap()})).optional(),
}));
export const BlockingSchema = z.object({blocks:BlocksSchema,events:EventsSchema,appearance:AppearanceSchema});
export type Blocking = z.infer<typeof BlockingSchema>;
export type BlockingView = 'motion'|'events'|'final';

export function withBlockingBeatLinks(scene:Scene,design:Blocking) {
  const pins=design.events.filter(event=>event.status==='confirmed'&&event.beatRelative);
  if(!pins.length) return scene;
  const beats=[...new Set((scene.markers??[]).filter(marker=>marker.kind==='beat').map(marker=>marker.t))].sort((a,b)=>a-b);
  const gaps=beats.slice(1).map((t,i)=>t-beats[i]).sort((a,b)=>a-b);
  const tempo=scene.tempo??(gaps.length?{offset:beats[0],bpm:60/gaps[Math.floor(gaps.length/2)]}:undefined);
  if(!tempo) throw new Error('拍に結んだ出来事には参照側の拍が必要です');
  const asBeat=(time:number):Time=>({beat:(time-tempo.offset)*tempo.bpm/60});
  const elements=scene.elements.map(element=>{
    const block=element.parentId??element.id;
    const entry=pins.find(event=>event.outputs.includes(block)&&Math.abs(resolveTime(element.inPoint??-1,tempo)-event.t)<1e-8);
    const exit=pins.find(event=>event.inputs.includes(block)&&Math.abs(resolveTime(element.outPoint??-1,tempo)-event.t)<1e-8);
    const times=pins.filter(event=>event.inputs.includes(block)||event.outputs.includes(block)).map(event=>event.t);
    const transform=element.transform&&times.length?Object.fromEntries(Object.entries(element.transform).map(([property,track])=>{
      if(typeof track==='number') return [property,track];
      return [property,{...track,keys:track.keys.map(key=>{
        const pin=typeof key.t==='number'?times.find(t=>Math.abs(Number(key.t)-t)<1e-8):undefined;
        return pin===undefined?key:{...key,t:asBeat(pin)};
      })}];
    })):element.transform;
    return entry||exit||transform!==element.transform?{...element,transform,inPoint:entry?asBeat(entry.t):element.inPoint,outPoint:exit?asBeat(exit.t):element.outPoint}:element;
  });
  return {...scene,tempo,elements};
}

export function retimeBlocking(design:Blocking, source:Scene, mapping:ReturnType<typeof planSectionRetiming>, sourceSha256:string):Blocking {
  const {scene,forElement}=mapping;
  const limit=(t:number)=>Math.max(0,Math.min(scene.duration,t));
  const seconds=(t:number,id?:string,beatRelative=false)=>{
    const pin=beatRelative&&source.tempo?{beat:(t-source.tempo.offset)*source.tempo.bpm/60}:t;
    return resolveTime(forElement(id).time(pin),scene.tempo);
  };
  const pinned=(id:string,t:number)=>design.events.some(event=>event.status==='confirmed'&&event.beatRelative&&
    (event.inputs.includes(id)||event.outputs.includes(id))&&Math.abs(event.t-t)<1e-8);
  const trackFor=(id:string,track:Track):Track=>{
    if(typeof track==='number'||!source.tempo) return forElement(id).track(track);
    const tempo=source.tempo;
    return forElement(id).track({...track,keys:track.keys.map(key=>typeof key.t==='number'&&pinned(id,key.t)?
      {...key,t:{beat:(key.t-tempo.offset)*tempo.bpm/60}}:key)});
  };
  const next:Blocking={
    blocks:{...design.blocks,from:0,to:scene.duration,sourceSha256,measuredTo:undefined,derived:true,
      backgroundLuma:design.blocks.backgroundLuma===undefined?undefined:forElement().track(design.blocks.backgroundLuma),
      items:design.blocks.items.map(block=>{
        const {cx,cy,width,height}=block.extent;
        const at=(t:number)=>limit(seconds(t,block.id,pinned(block.id,t)));
        const hiddenDuring=block.hiddenDuring?.map(gap=>({from:at(gap.from),to:at(gap.to)})).filter(gap=>gap.to>gap.from);
        return {...block,hiddenDuring,extent:{cx:trackFor(block.id,cx),cy:trackFor(block.id,cy),width:trackFor(block.id,width),height:trackFor(block.id,height)}};
      })},
    events:design.events.flatMap(event=>{
      const anchor=event.outputs[0]??event.inputs[0];
      let t=seconds(event.t,anchor,event.beatRelative);
      if(anchor&&event.status==='confirmed'&&['merge','split','replace'].includes(event.kind)) {
        const output=scene.elements.find(el=>el.id===anchor);
        t=output?.inPoint===undefined?t:resolveTime(output.inPoint,scene.tempo);
      }
      if(t<0||t>=scene.duration) return [];
      const until=event.until===undefined?undefined:limit(t+seconds(event.until,anchor,event.beatRelative)-seconds(event.t,anchor,event.beatRelative));
      return [{...event,t,until:until!==undefined&&until>t?until:undefined}];
    }).sort((a,b)=>a.t-b.t),
    appearance:design.appearance.map(binding=>{
      const owner=scene.elements.find(el=>el.id===binding.blockId);
      const start=resolveTime(owner?.inPoint??0,scene.tempo),end=resolveTime(owner?.outPoint??scene.duration,scene.tempo);
      const clips=new Map(binding.contours?.map(sample=>[Math.max(0,start,seconds(sample.t,binding.blockId,pinned(binding.blockId,sample.t))),sample]));
      return {...binding,contours:binding.contours?[...clips].filter(([t])=>t<Math.min(end,scene.duration)).sort(([a],[b])=>a-b).map(([t,sample])=>({...sample,t})):undefined};
    }),
  };
  validateBlocking(scene,next);
  return next;
}

export function validateBlocking(scene:Scene, design:Blocking):void {
  const {blocks,events,appearance}=design;
  if(blocks.from>=blocks.to||blocks.to>scene.duration) throw new Error('ブロックの比較範囲が不正です');
  if(blocks.measuredTo!==undefined&&(blocks.measuredTo<=blocks.from||blocks.measuredTo>blocks.to)) throw new Error('ブロックの実測範囲が不正です');
  const groups=new Map(scene.elements.filter(e=>e.type==='group').map(e=>[e.id,e]));
  const known=new Set(blocks.items.map(b=>b.id));
  if(known.size!==blocks.items.length||blocks.items.some(b=>!groups.has(b.id))) throw new Error('ブロックに対応するグループが見つからないか、IDが重複しています');
  if(blocks.items.some(block=>block.members&&(new Set(block.members).size!==block.members.length||
    block.members.some(member=>!known.has(member)||member===block.id||groups.get(member)?.parentId!==block.id)))) throw new Error('ブロックのまとめ方と親子が一致しません');
  if(blocks.items.some(block=>block.hiddenDuring?.some(gap=>gap.from>=gap.to||gap.from<blocks.from||gap.to>blocks.to))) throw new Error('ブロックを隠す区間が不正です');
  if(new Set(events.map(event=>event.id)).size!==events.length) throw new Error('イベントIDが重複しています');
  for(const event of events) {
    const ids=[...event.inputs,...event.outputs];
    if(event.t<blocks.from||event.t>=blocks.to||(event.until!==undefined&&(event.until<=event.t||event.until>blocks.to))||ids.some(ref=>!known.has(ref))) throw new Error(`イベント ${event.id} の時刻または対象が不正です`);
    if(event.status==='confirmed'&&['merge','split','replace'].includes(event.kind)) {
      const counts=[event.inputs.length,event.outputs.length];
      const valid=event.kind==='merge'?counts[0]>=2&&counts[1]===1:event.kind==='split'?counts[0]===1&&counts[1]>=2:counts[0]===1&&counts[1]===1;
      const edgeMatches=(ref:string,which:'inPoint'|'outPoint')=>Math.abs(resolveTime(groups.get(ref)![which]??-1,scene.tempo)-event.t)<1e-8;
      if(!valid||new Set(ids).size!==ids.length||!event.inputs.every(ref=>edgeMatches(ref,'outPoint'))||!event.outputs.every(ref=>edgeMatches(ref,'inPoint'))) throw new Error(`イベント ${event.id} とブロックの寿命が一致しません`);
    }
  }
  if(new Set(appearance.map(binding=>binding.blockId)).size!==appearance.length) throw new Error('外観のブロックIDが重複しています');
  for(const binding of appearance) {
    if(!known.has(binding.blockId)||binding.childIds.some(ref=>!scene.elements.some(e=>e.id===ref&&e.parentId===binding.blockId))) throw new Error('外観の子要素と親ブロックが一致しません');
    if(binding.contours?.some((sample,i,all)=>sample.t<blocks.from||sample.t>=blocks.to||(i>0&&sample.t<=all[i-1].t))) throw new Error('外観の観測時刻または並びが不正です');
  }
}

function gray(value:number):string {
  const channel=Math.round(Math.min(255,Math.max(0,value))).toString(16).padStart(2,'0');
  return `#${channel.repeat(3)}`;
}

export function blockingFrame(scene:Scene, design:Blocking, time:number, view:BlockingView):Scene {
  const byId=new Map(scene.elements.map(element=>[element.id,element]));
  const value=(track:z.infer<typeof TrackSchema>)=>sampleTrack(track,time,0,scene.tempo);
  const visible=new Set(design.blocks.items.filter(block=>{
    const group=byId.get(block.id);
    return group&&isActive(group,scene,time)&&!block.hiddenDuring?.some(gap=>time>=gap.from&&time<gap.to);
  }).map(block=>block.id));
  if(view==='final') {
    const owners=new Map(design.appearance.flatMap(a=>a.childIds.map(id=>[id,a.blockId] as const)));
    const shapes=new Map(design.appearance.filter(binding=>binding.contours?.length).map(binding=>[binding.childIds[0],binding.contours!]));
    const extents=new Map(design.blocks.items.map(block=>[block.id,block.extent]));
    const elements=scene.elements.flatMap(el=>{
      const owner=owners.get(el.id);
      if(!owner) return [el];
      if(!visible.has(owner)) return [];
      const shape=shapes.get(el.id)?.findLast(sample=>sample.t<=time+1e-8);
      if(!shape) return shapes.has(el.id)?[]:[el];
      const extent=extents.get(owner)!;
      return [{...el,outline:shape.paths,width:Math.max(.01,value(extent.width)-1),height:Math.max(.01,value(extent.height)-1),fill:shape.color??gray(shape.luma),
        transform:{...el.transform,x:value(extent.cx)-.5+sampleTrack(el.transform?.x,time,0,scene.tempo),
          y:value(extent.cy)-.5+sampleTrack(el.transform?.y,time,0,scene.tempo)}}];
    });
    return {...scene,elements,background:design.blocks.backgroundLuma===undefined?scene.background:gray(value(design.blocks.backgroundLuma))};
  }
  const elements=scene.elements.filter(el=>el.type==='group');
  const members=new Set(design.blocks.items.filter(item=>visible.has(item.id)).flatMap(item=>item.members??[]));
  for(const block of design.blocks.items) {
    const parent=byId.get(block.id);
    if(!parent||!visible.has(block.id)) continue;
    if(view==='motion'&&members.has(block.id)) continue;
    if(view==='events'&&block.members) continue;
    const {extent}=block;
    const width=value(extent.width),height=value(extent.height);
    if(!(width>0&&height>0)) continue;
    elements.push({id:`box:${block.id}`,type:'rect',parentId:block.id,width,height,fill:view==='events'?'none':block.color,
      stroke:block.color,strokeWidth:view==='events'?3:1,zIndex:parent.zIndex,transform:{x:value(extent.cx),y:value(extent.cy)}});
  }
  if(design.blocks.measuredTo!==undefined||design.blocks.derived) {
    const measured=time<(design.blocks.measuredTo??0);
    const x=scene.width*.87,y=scene.height*.062;
    elements.push({id:'block:provenance',type:'rect',width:scene.width*.22,height:scene.height*.055,fill:'#172338',zIndex:9999,transform:{x,y}},
      text('block:provenance-label',design.blocks.derived?'参照から再構成':measured?'元映像から計測':'既存シーンから補完',x,y+1,scene.height*.031,'#a2b7cc'));
  }
  if(view==='events') {
    const events=design.events.filter(event=>event.status!=='rejected').sort((a,b)=>a.t-b.t);
    const current=events.filter(event=>event.t<=time+1e-9).at(-1);
    const frame=Math.floor(time*scene.fps+1e-7);
    const bandY=scene.height*.91;
    const title=current?`${current.label}   ${Math.round(current.t*scene.fps)}F${current.status==='proposed'?'  [候補]':''}`:'出来事を待機';
    elements.push({id:'event:band',type:'rect',width:scene.width,height:scene.height*.18,zIndex:10000,fill:'#172338',transform:{x:scene.width/2,y:bandY}},
      text('event:title',title,scene.width/2,bandY-scene.height*.027,scene.height*.038,'#f1f5f9'),
      text('event:time',`${frame}F   ${time.toFixed(3)} s`,scene.width/2,bandY+scene.height*.031,scene.height*.027,'#a2b7cc'));
    const at=(t:number)=>scene.width*.06+(scene.width*.88)*(t-design.blocks.from)/(design.blocks.to-design.blocks.from);
    const y=scene.height*.981;
    const beat=(scene.markers??[]).filter(marker=>marker.kind==='beat'&&marker.t>=design.blocks.from&&marker.t<design.blocks.to);
    const nearest=beat.reduce<(typeof beat)[number]|undefined>((best,marker)=>!best||Math.abs(marker.t-time)<Math.abs(best.t-time)?marker:best,undefined);
    if(nearest) {
      const delta=Math.round((time-nearest.t)*1000);
      elements.push(text('event:beat',`拍${nearest.origin==='estimated'?'（推定）':''} ${delta>=0?'+':''}${delta} ms`,scene.width*.83,bandY+scene.height*.031,scene.height*.025,'#8ed3bc'));
    }
    for(const [i,marker] of beat.entries()) elements.push({id:`event:beat:${i}`,type:'rect',width:2,height:10,fill:'#539885',zIndex:10002,transform:{x:at(marker.t),y:y-16}});
    if(current&&time<Math.max(current.until??0,current.t+.19)) {
      for(const [role,ids] of [['入力',current.inputs],['結果',current.outputs]] as const) for(const id of ids) {
        if(!visible.has(id)) continue;
        const block=design.blocks.items.find(item=>item.id===id)!;
        const [a,b,c,d,x,y]=worldMatrixOf(scene,id,time);
        const cx=value(block.extent.cx),cy=value(block.extent.cy)-value(block.extent.height)/2-16;
        elements.push(text(`event:role:${role}:${id}`,role,x+a*cx+c*cy,y+b*cx+d*cy,scene.height*.025,'#f5e1a3'));
      }
    }
    elements.push({id:'event:rail',type:'rect',width:scene.width*.88,height:4,fill:'#667993',zIndex:10001,transform:{x:scene.width/2,y}});
    for(const event of events) elements.push({id:`event:tick:${event.id}`,type:'rect',width:4,height:14,fill:event.status==='confirmed'?'#64e1bb':'#e6ae5b',zIndex:10002,transform:{x:at(event.t),y}});
    elements.push({id:'event:playhead',type:'ellipse',width:15,height:15,fill:'#ffffff',zIndex:10003,transform:{x:at(time),y}});
  }
  return {...scene,background:'#101a2b',elements};
}

function text(id:string,body:string,x:number,y:number,fontSize:number,fill:string):SceneElement {
  return {id,type:'text',text:body,fill,fontSize,zIndex:10001,transform:{x,y}};
}
