import { z } from 'zod';
import { commit, getEvidenceSnapshot, getProject, HttpError } from './store.ts';

const revision=z.number().int().positive();
const axis=z.enum(['motion','timing','screen','meaning']);
const work=z.strictObject({projectId:z.string().min(1),revision,group:z.enum(['author','control']),credit:z.string().trim().min(1).max(240),
  creditBasis:z.string().trim().min(1).max(500)});
const reference=z.strictObject({projectId:z.string().min(1),revision,observationId:z.string().min(1).max(160)});
const claim=z.strictObject({id:z.string().min(1).max(80),axis,label:z.string().trim().min(1).max(120),condition:z.string().trim().min(1).max(500),
  evidence:z.array(reference).min(1).max(200),exceptions:z.array(reference).max(200).default([]),
  generation:z.object({unit:z.enum(['seconds','beats','degrees','ratio']),min:z.number(),max:z.number()}).optional()});
export const StyleStudyRequest=z.strictObject({baseRevision:revision,actor:z.string().min(1).max(40).default('human'),
  works:z.array(work).min(1).max(40),claims:z.array(claim).max(50)});

const delta=z.object({offsetSeconds:z.number(),origin:z.string()});
const timing=z.object({kind:z.literal('event-audio-timing'),matches:z.record(z.string(),z.array(delta))});
const orientation=z.object({kind:z.literal('group-orientation'),samples:z.array(z.object({deltaDegrees:z.number()})).min(2)});
const motion=z.object({kind:z.literal('block-motion-metrics'),origin:z.string(),samples:z.array(z.object({visibleCount:z.number(),occupancyRatio:z.number().optional(),
  speedPxPerS:z.number().optional(),accelerationPxPerS2:z.number().optional()})).min(1),stops:z.array(z.object({from:z.number(),to:z.number()}))});
const glyph=z.object({kind:z.literal('glyph-structure'),relation:z.enum(['combine','ruby']),from:z.number(),to:z.number(),parts:z.array(z.unknown()).optional()});
const evidenceShape=z.object({kind:z.string().min(1),sourceSha256:z.string(),sourceRevision:revision.optional()});
const passage=z.object({kind:z.literal('motion-passage-review'),status:z.enum(['confirmed','rejected']),pattern:z.string(),metrics:z.record(z.string(),z.number())});
const corpusMotion=z.object({kind:z.literal('corpus-motion-measurement'),key:z.string(),values:z.record(z.string(),z.number())});

export function saveStyleStudy(id:string,input:z.infer<typeof StyleStudyRequest>) {
  if(getProject(id).project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  const works=new Map(input.works.map(entry=>[entry.projectId,{...entry,snapshot:getEvidenceSnapshot(entry.projectId,entry.revision)}]));
  if(works.size!==input.works.length||new Set(input.claims.map(entry=>entry.id)).size!==input.claims.length) throw new HttpError(422,'作品または比較項目のIDが重複しています');
  const sourceHashes=input.works.map(entry=>works.get(entry.projectId)!.snapshot.sourceSha256);
  if(sourceHashes.some(hash=>!hash)||new Set(sourceHashes).size!==sourceHashes.length) throw new HttpError(422,'元素材が入った別々の作品を指定してください。同じ素材の比較版は1作品として数えます');

  const claims=input.claims.map(entry=>{
    if(entry.generation&&entry.generation.min>entry.generation.max) throw new HttpError(422,`生成範囲が不正です: ${entry.id}`);
    const refs=[...entry.evidence,...entry.exceptions];
    if(new Set(refs.map(ref=>JSON.stringify([ref.projectId,ref.revision,ref.observationId]))).size!==refs.length) throw new HttpError(422,`根拠または例外が重複しています: ${entry.id}`);
    const checked=refs.map(ref=>{
      const item=works.get(ref.projectId);
      const raw=item?.snapshot.observations[ref.observationId];
      const observation=evidenceShape.safeParse(raw);
      if(!item||item.revision!==ref.revision||!observation.success||observation.data.sourceSha256!==item.snapshot.sourceSha256) {
        throw new HttpError(422,`作品・リビジョン・元素材に対応する観察がありません: ${ref.projectId} / ${ref.observationId}`);
      }
      const reviewed=passage.safeParse(raw);
      if(reviewed.success&&reviewed.data.status==='rejected'&&entry.evidence.includes(ref)) {
        throw new HttpError(422,'却下した演出候補は根拠に使えません。例外として記録してください');
      }
      return {...ref,group:item.group,kind:observation.data.kind,values:metrics(entry.axis,raw)};
    });
    const byGroup=(group:'author'|'control')=>{
      const support=checked.slice(0,entry.evidence.length).filter(ref=>ref.group===group);
      const exceptions=checked.slice(entry.evidence.length).filter(ref=>ref.group===group);
      const byMetric=new Map<string,number[]>();
      for(const item of support) for(const {name,value} of item.values) {
        const values=byMetric.get(name)??[];
        values.push(value);
        byMetric.set(name,values);
      }
      return {works:new Set([...support,...exceptions].map(ref=>ref.projectId)).size,caseCount:support.length,exceptionCount:exceptions.length,
        distributions:Object.fromEntries([...byMetric].map(([name,values])=>{
          values.sort((a,b)=>a-b);
          const middle=Math.floor(values.length/2);
          return [name,{n:values.length,min:values[0],median:(values[middle]+values[Math.floor((values.length-1)/2)])/2,max:values.at(-1)}];
        }))};
    };
    return {...entry,summary:{author:byGroup('author'),control:byGroup('control')}};
  });
  const study={works:[...works.values()].map(({snapshot,...entry})=>({...entry,title:snapshot.title,sourceSha256:snapshot.sourceSha256})),claims,
    method:'manually selected evidence and exceptions; summary counts do not estimate effect prevalence'};
  return {...commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:'作品をまたぐ観察の整理を保存',documents:current=>({...current,style_study:study})}),study};
}

function metrics(layer:z.infer<typeof axis>,raw:unknown):{name:string;value:number}[] {
  const example=corpusMotion.safeParse(raw);
  if(example.success) {
    const allowed:Record<z.infer<typeof axis>,string[]>={motion:['arrivalDxPx','settledMaxDxPx','settledSpanSeconds','narrowestWidthRatio'],
      timing:['entryLagSeconds','secondEntrySeconds'],screen:['leadHeightDrop','heightRatio','secondToCompanionHeightRatio'],meaning:[]};
    return Object.entries(example.data.values).filter(([name])=>allowed[layer].includes(name))
      .map(([name,value])=>({name:`${example.data.key}.${name}`,value}));
  }
  const reviewed=passage.safeParse(raw);
  if(reviewed.success&&(layer==='motion'||layer==='timing')) return Object.entries(reviewed.data.metrics)
    .filter(([name])=>layer==='motion'?['roleCount','displacementRatio'].includes(name):name==='entrySpanSeconds')
    .map(([name,value])=>({name:`${reviewed.data.pattern}.${name}`,value}));
  const moving=layer==='motion'||layer==='screen'?motion.safeParse(raw):undefined;
  if(moving?.success) {
    const {samples,stops,origin}=moving.data;
    const mean=(name:string,values:(number|undefined)[])=>{
      const present=values.filter((value):value is number=>value!==undefined);
      return present.length?[{name:`${name}.${origin}`,value:present.reduce((sum,value)=>sum+value,0)/present.length}]:[];
    };
    if(layer==='screen') return [...mean('box.occupancyRatio',samples.map(row=>row.occupancyRatio)),...mean('visibleBlockCount',samples.map(row=>row.visibleCount))];
    return [...mean('speedPxPerS',samples.map(row=>row.speedPxPerS)),...mean('absoluteAccelerationPxPerS2',samples.map(row=>row.accelerationPxPerS2===undefined?undefined:Math.abs(row.accelerationPxPerS2))),
      ...mean('stop.seconds',stops.map(row=>row.to-row.from))];
  }
  if(layer==='timing') {
    const parsed=timing.safeParse(raw);
    if(parsed.success) return Object.entries(parsed.data.matches).flatMap(([key,[match]])=>match?.origin?
      [{name:`${key}.${match.origin}.offsetSeconds`,value:match.offsetSeconds}]:[]);
  }
  if(layer==='motion') {
    const parsed=orientation.safeParse(raw);
    if(parsed.success) return [{name:'angle.changeDegrees',value:parsed.data.samples.at(-1)!.deltaDegrees}];
  }
  if(layer==='meaning') {
    const parsed=glyph.safeParse(raw);
    if(parsed.success) {
      const {relation,from,to,parts}=parsed.data;
      return [{name:`${relation}.annotatedDurationSeconds`,value:to-from},...(parts?[{name:'combine.partCount',value:parts.length}]:[])];
    }
  }
  return [];
}
