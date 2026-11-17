import type { Scene, SceneElement, Track, Transform } from './schema.ts';
import { resolveTime, resolveDuration } from './time.ts';

export interface SectionMap { sourceFrom: number; sourceTo: number; targetFrom: number; targetTo: number; elementIds: string[]; reason: string }

/** Exact affine retiming within an explicitly assigned section. Geometry and easing stay intact. */
export function retimeSections(source: Scene, target: Scene, sections: SectionMap[]): Scene {
  if (!sections.length) throw new Error('区間対応が必要です');
  const assignments = new Map<string, SectionMap>();
  for(const s of sections) {
    if (![s.sourceFrom,s.sourceTo,s.targetFrom,s.targetTo].every(Number.isFinite) || s.sourceFrom<0 || s.sourceTo<=s.sourceFrom || s.sourceTo>source.duration || s.targetFrom<0 || s.targetTo<=s.targetFrom || s.targetTo>target.duration || !s.reason.trim()) throw new Error('区間・変更理由が不正です');
    for(const id of s.elementIds) {
      if(assignments.has(id) || !source.elements.some(e=>e.id===id)) throw new Error('要素の重複または存在しない要素です');
      assignments.set(id,s);
    }
  }
  const elements = source.elements.map(original=>{
    const s = assignments.get(original.id);
    if(!s) throw new Error(`要素 ${original.id} の区間対応がありません`);
    if(original.parentId && assignments.get(original.parentId)!==s) throw new Error('親子は同じ区間に割り当ててください');
    const ratio=(s.targetTo-s.targetFrom)/(s.sourceTo-s.sourceFrom);
    const time=(t: Parameters<typeof resolveTime>[0])=>s.targetFrom+(resolveTime(t,source.tempo)-s.sourceFrom)*ratio;
    const track=(t:Track):Track=>typeof t==='number'?t:{keys:t.keys.map(k=>({...k,t:time(k.t)})),...(t.repeat?{repeat:{every:resolveDuration(t.repeat.every,source.tempo)*ratio,...(t.repeat.count!==undefined?{count:t.repeat.count}:{}),...(t.repeat.until!==undefined?{until:time(t.repeat.until)}:{})}}:{})};
    const transform=(t?:Transform):Transform|undefined=>t?Object.fromEntries(Object.entries(t).map(([k,v])=>[k,track(v)])):undefined;
    const start=Math.max(s.targetFrom,time(original.inPoint??s.sourceFrom));
    const end=Math.min(s.targetTo,time(original.outPoint??s.sourceTo));
    if(end<=start) throw new Error(`要素 ${original.id} は指定区間に表示されません`);
    const e:SceneElement={...structuredClone(original),inPoint:start,outPoint:end};
    if(original.transform) e.transform=transform(original.transform);
    if(original.unitTransform) e.unitTransform=transform(original.unitTransform);
    if(original.stagger) e.stagger={...original.stagger,interval:resolveDuration(original.stagger.interval,source.tempo)*ratio};
    return e;
  });
  // Keep reference geometry; target contributes duration and music markers only.
  return {...structuredClone(source),duration:target.duration,tempo:undefined,markers:structuredClone(target.markers??[]),elements};
}

/** Explicit hold on one track; other element tracks are intentionally not inferred. */
export function varyHold(source: Scene, elementId: string, property: keyof Transform, index: number, seconds: number): Scene {
  if(!Number.isFinite(seconds)||seconds<0) throw new Error('停止長は0秒以上です');
  const scene=structuredClone(source), element=scene.elements.find(e=>e.id===elementId);
  const t=element?.transform?.[property];
  if(!element||!t||typeof t==='number'||t.repeat) throw new Error('繰り返しのないキートラックを指定してください');
  const keys=t.keys.map(k=>({...k,t:resolveTime(k.t,scene.tempo)}));
  const a=keys[index],b=keys[index+1];
  if(!a||!b||a.v!==b.v) throw new Error('同じ値の連続する2キーが必要です');
  const delta=seconds-(b.t-a.t);
  for(let i=index+1;i<keys.length;i++) keys[i].t+=delta;
  if(seconds===0) keys.splice(index,1);
  const out=resolveTime(element.outPoint??scene.duration,scene.tempo);
  if(keys.some(k=>k.t<0||k.t>out)) throw new Error('変更後のキーが要素の表示区間を超えます');
  element.transform![property]={keys};
  return scene;
}
