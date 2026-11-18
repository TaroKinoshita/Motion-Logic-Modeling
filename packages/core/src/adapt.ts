import type { Scene, SceneElement, Track, Transform, Time, Tempo, Duration } from './schema.ts';
import { resolveTime, resolveDuration } from './time.ts';

export interface SectionMap { sourceFrom: number; sourceTo: number; targetFrom: number; targetTo: number; elementIds: string[]; reason: string }

/** Preserve beat keys; map second-based keys through the element's contiguous sections. */
export function retimeSections(source: Scene, target: Scene, sections: SectionMap[], preserveBeats = true): Scene {
  return planSectionRetiming(source,target,sections,preserveBeats).scene;
}

export function planSectionRetiming(source:Scene,target:Scene,sections:SectionMap[],preserveBeats=true) {
  if (!sections.length) throw new Error('区間対応が必要です');
  const assignments = new Map<string, SectionMap[]>();
  const beatTimes=[...new Set((target.markers??[]).filter(m=>m.kind==='beat').map(m=>m.t))].sort((a,b)=>a-b);
  let tempo:Tempo|undefined=preserveBeats?structuredClone(target.tempo):undefined;
  if(preserveBeats && !tempo && beatTimes.length>=2) {
    const gaps=beatTimes.slice(1).map((t,i)=>t-beatTimes[i]).sort((a,b)=>a-b);
    tempo={bpm:60/gaps[Math.floor(gaps.length/2)],offset:beatTimes[0]};
  }
  const usesBeats=(v:unknown):boolean=>!!v && typeof v==='object' && (Object.hasOwn(v,'beat')||Object.hasOwn(v,'beats')||Object.values(v).some(usesBeats));
  if(preserveBeats && !tempo && usesBeats(source.elements)) throw new Error('拍関係の再構成には新曲のtempoまたは2拍以上のマーカーが必要です');
  const beatTime=(beat:number)=>{
    if(beatTimes.length<2) return tempo!.offset+beat*60/tempo!.bpm;
    const i=Math.max(0,Math.min(beatTimes.length-2,Math.floor(beat)));
    return beatTimes[i]+(beat-i)*(beatTimes[i+1]-beatTimes[i]);
  };
  for(const s of sections) {
    if (![s.sourceFrom,s.sourceTo,s.targetFrom,s.targetTo].every(Number.isFinite) || s.sourceFrom<0 || s.sourceTo<=s.sourceFrom || s.sourceTo>source.duration || s.targetFrom<0 || s.targetTo<=s.targetFrom || s.targetTo>target.duration || !s.reason.trim()) throw new Error('区間・変更理由が不正です');
    if(new Set(s.elementIds).size!==s.elementIds.length) throw new Error('区間内の要素が重複しています');
    for(const id of s.elementIds) {
      if(!source.elements.some(e=>e.id===id)) throw new Error('存在しない要素です');
      assignments.set(id,[...(assignments.get(id)??[]),s]);
    }
  }
  const maps=new Map<string,ReturnType<typeof mapper>>();
  function mapper(spans:SectionMap[]) {
    const section=(t:number)=>spans.find(s=>t<s.sourceTo)??spans.at(-1)!;
    const ratioOf=(s:SectionMap)=>(s.targetTo-s.targetFrom)/(s.sourceTo-s.sourceFrom);
    const time=(t:Time):Time=>{
      const s=section(resolveTime(t,source.tempo)),ratio=ratioOf(s);
      if(typeof t==='number'||!tempo||!source.tempo) return s.targetFrom+(resolveTime(t,source.tempo)-s.sourceFrom)*ratio;
      const sourceBeat=(s.sourceFrom-source.tempo.offset)*source.tempo.bpm/60;
      const nearest=beatTimes.length?beatTimes.reduce((best,v,i)=>Math.abs(v-s.targetFrom)<Math.abs(beatTimes[best]-s.targetFrom)?i:best,0):(s.targetFrom-tempo.offset)*tempo.bpm/60;
      const beat=nearest+t.beat-sourceBeat;
      return {beat,offsetSeconds:beatTime(beat)-(tempo.offset+beat*60/tempo.bpm)+(t.offsetSeconds??0)*ratio};
    };
    const duration=(d:Duration):Duration=>typeof d!=='number'&&tempo?structuredClone(d):resolveDuration(d,source.tempo)*ratioOf(spans[0]);
    const track=(t:Track):Track=>typeof t==='number'?t:{keys:t.keys.map(k=>({...k,t:time(k.t)})),...(t.repeat?{repeat:{every:duration(t.repeat.every),...(t.repeat.count!==undefined?{count:t.repeat.count}:{}),...(t.repeat.until!==undefined?{until:time(t.repeat.until)}:{})}}:{})};
    const transform=(t?:Transform):Transform|undefined=>t?Object.fromEntries(Object.entries(t).map(([k,v])=>[k,track(v)])):undefined;
    return {time,track,transform,duration};
  }
  const elements = source.elements.map(original=>{
    const spans = assignments.get(original.id)?.sort((a,b)=>a.sourceFrom-b.sourceFrom);
    if(!spans) throw new Error(`要素 ${original.id} の区間対応がありません`);
    for(let i=1;i<spans.length;i++) if(Math.abs(spans[i-1].sourceTo-spans[i].sourceFrom)>1e-8 || Math.abs(spans[i-1].targetTo-spans[i].targetFrom)>1e-8) throw new Error('同じ要素の複数区間は元・先とも連続して指定してください');
    const map=mapper(spans);
    maps.set(original.id,map);
    const {time,transform,duration}=map;
    const start=time(original.inPoint??(preserveBeats?spans[0].sourceFrom:0));
    const end=time(original.outPoint??(preserveBeats?spans.at(-1)!.sourceTo:source.duration));
    if(resolveTime(end,tempo)<=resolveTime(start,tempo)) throw new Error(`要素 ${original.id} の表示区間が不正です`);
    const e:SceneElement={...structuredClone(original),inPoint:start,outPoint:end};
    if(original.transform) e.transform=transform(original.transform);
    if(original.unitTransform) e.unitTransform=transform(original.unitTransform);
    if(original.stagger) e.stagger={...original.stagger,interval:duration(original.stagger.interval)};
    return e;
  });
  // Keep reference geometry; target contributes duration and music markers only.
  const scene:Scene={...structuredClone(source),duration:target.duration,tempo,markers:structuredClone(target.markers??[]),elements};
  const overall=mapper([...sections].sort((a,b)=>a.sourceFrom-b.sourceFrom));
  return {scene,forElement:(id?:string)=>id?maps.get(id)??overall:overall};
}

/** Explicit hold on one track; other element tracks are intentionally not inferred. */
export function varyHold(source: Scene, elementId: string, property: keyof Transform, index: number, seconds: number): Scene {
  if(!Number.isFinite(seconds)||seconds<0) throw new Error('停止長は0秒以上です');
  const scene=structuredClone(source), element=scene.elements.find(e=>e.id===elementId);
  const t=element?.transform?.[property];
  if(!element||!t||typeof t==='number'||t.repeat) throw new Error('繰り返しのないキートラックを指定してください');
  const keys=t.keys.map(k=>({...k}));
  const a=keys[index],b=keys[index+1];
  if(!a||!b||a.v!==b.v) throw new Error('同じ値の連続する2キーが必要です');
  const delta=seconds-(resolveTime(b.t,scene.tempo)-resolveTime(a.t,scene.tempo));
  for(let i=index+1;i<keys.length;i++) {
    const time=keys[i].t;
    keys[i].t=typeof time==='number'?time+delta:{...time,offsetSeconds:(time.offsetSeconds??0)+delta};
  }
  if(seconds===0) keys.splice(index,1);
  const out=resolveTime(element.outPoint??scene.duration,scene.tempo);
  if(keys.some(k=>resolveTime(k.t,scene.tempo)<0||resolveTime(k.t,scene.tempo)>out)) throw new Error('変更後のキーが要素の表示区間を超えます');
  element.transform![property]={keys};
  return scene;
}

export interface HoldTarget { elementId:string; property:keyof Transform; keyIndex:number }
/** All members must describe the same stop window; validate before producing any output. */
export function varyHoldGroup(source:Scene, targets:HoldTarget[], seconds:number):Scene {
  if(!targets.length) throw new Error('停止規則の対象が必要です');
  const seen=new Set<string>();
  let window:[number,number]|undefined;
  for(const target of targets) {
    const identity=`${target.elementId}:${target.property}`;
    if(seen.has(identity)) throw new Error('停止対象のトラックが重複しています');
    seen.add(identity);
    const track=source.elements.find(e=>e.id===target.elementId)?.transform?.[target.property];
    if(typeof track!=='object'||track.repeat) throw new Error('繰返しのないキートラックが必要です');
    const a=track.keys[target.keyIndex],b=track.keys[target.keyIndex+1];
    if(!a||!b||a.v!==b.v) throw new Error('同じ値の連続キーが必要です');
    const bounds:[number,number]=[resolveTime(a.t,source.tempo),resolveTime(b.t,source.tempo)];
    if(window && bounds.some((t,i)=>Math.abs(t-window![i])>1e-8)) throw new Error('連動する停止区間の開始と終了を揃えてください');
    window=bounds;
  }
  return targets.reduce((scene,t)=>varyHold(scene,t.elementId,t.property,t.keyIndex,seconds),structuredClone(source));
}
