import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SceneElement, Track } from '@mlm/core';
import { saveGeneratedProject } from './modeling.ts';
import { checkScene, getDocuments, getProject, HttpError, trashProject } from './store.ts';

const revision=z.number().int().positive();
const word=z.string().trim().min(1).max(100);
const effect=z.enum(['entrance','hold','stagger','invert','combine']);
const lyric=z.strictObject({text:word,ruby:word.optional(),parts:z.array(word).min(2).max(6).optional(),
  from:z.number().nonnegative(),to:z.number().positive(),tags:z.array(word).max(10).default([])});
export const LyricGenerationRequest=z.strictObject({baseRevision:revision,targetProjectId:z.string().min(1),targetRevision:revision,
  actor:z.string().trim().min(1).max(40).default('human'),name:word,lyrics:z.array(lyric).min(1).max(100),
  effects:z.array(z.strictObject({claimId:word,kind:effect,tag:word.optional(),metric:word.optional()})).min(1).max(5)});
const generation=z.object({unit:z.enum(['seconds','beats','degrees','ratio']),min:z.number(),max:z.number()});
const distribution=z.object({median:z.number()});
const evidenceClaim=z.object({id:word,condition:z.string(),axis:z.string(),generation:generation.optional(),
  summary:z.object({author:z.object({distributions:z.record(z.string(),distribution)})})});
type Input=z.infer<typeof LyricGenerationRequest>;
type Rule=Input['effects'][number]&{condition:string;value:number;selection:string;unit:'seconds'|'beats'};

export function generateLyricStudy(id:string,input:Input) {
  const {project:source}=getProject(id),target=getProject(input.targetProjectId);
  if(source.revision!==input.baseRevision||target.project.revision!==input.targetRevision) throw new HttpError(409,'入力と観察のリビジョンを読み直してください');
  if(!target.project.source?.hasAudio) throw new HttpError(422,'音源を取り込んだ生成先を指定してください');
  const {source:media}=target.project;
  const {width,height}=target.scene;
  const duration=Math.min(target.scene.duration,media.duration);
  const lyrics=[...input.lyrics].sort((a,b)=>a.from-b.from);
  if(lyrics.some((line,i)=>line.from>=line.to||line.to>duration||(i>0&&lyrics[i-1].to>line.from))) throw new HttpError(422,'歌詞の区間を入力音源内で重複せずに指定してください');
  if(new Set(input.effects.map(rule=>rule.kind)).size!==input.effects.length||new Set(input.effects.map(rule=>rule.claimId)).size!==input.effects.length) {
    throw new HttpError(422,'同じ効果や観察の重複を除いてください');
  }
  const parsed=z.object({claims:z.array(evidenceClaim)}).safeParse(getDocuments(id).style_study);
  if(!parsed.success) throw new HttpError(422,'作品をまたぐ観察の比較を保存してください');
  const expectedAxis={entrance:'motion',hold:'motion',stagger:'motion',invert:'screen',combine:'meaning'};
  const rules:Rule[]=input.effects.map(request=>{
    const claim=parsed.data.claims.find(item=>item.id===request.claimId);
    const range=claim?.generation;
    if(!claim||claim.axis!==expectedAxis[request.kind]||!range||range.min<0||range.max<range.min||!['seconds','beats'].includes(range.unit)) {
      throw new HttpError(422,`効果に合う観察軸と秒または拍の生成範囲が必要です: ${request.claimId}`);
    }
    if(range.unit!=='seconds'&&range.unit!=='beats') throw new HttpError(422,'秒または拍の範囲を指定してください');
    const observed=request.metric?claim.summary.author.distributions[request.metric]?.median:undefined;
    const sameUnit=range.unit==='seconds'?/(?:\.seconds(?:\.|$)|Seconds$)/:/\.beats(?:\.|$)/;
    if(request.metric&&(!sameUnit.test(request.metric)||observed===undefined)) {
      throw new HttpError(422,`生成範囲と同じ単位の観測分布を指定してください: ${request.metric}`);
    }
    return {...request,condition:claim.condition,unit:range.unit,value:Math.max(range.min,Math.min(range.max,observed??(range.min+range.max)/2)),
      selection:observed===undefined?'range-midpoint':'observed-median-clamped'};
  });
  const beats=[...new Set((target.scene.markers??[]).filter(marker=>marker.kind==='beat').map(marker=>marker.t))].sort((a,b)=>a-b);
  const gaps=beats.slice(1).map((t,i)=>t-beats[i]).sort((a,b)=>a-b);
  const fallbackBeat=gaps[Math.floor(gaps.length/2)]??(target.scene.tempo?60/target.scene.tempo.bpm:undefined);
  if(rules.some(rule=>rule.unit==='beats')&&!fallbackBeat) throw new HttpError(422,'拍単位の規則には拍マーカーかテンポが必要です');
  const beatAt=(t:number)=>{
    const next=beats.findIndex(beat=>beat>t);
    return next>0?beats[next]-beats[next-1]:fallbackBeat??0;
  };
  const fits=(rule:Rule,line:z.infer<typeof lyric>)=>(!rule.tag||line.tags.includes(rule.tag))&&(rule.kind!=='combine'||!!line.parts);
  if(rules.some(rule=>!lyrics.some(line=>fits(rule,line)))) throw new HttpError(422,'各規則に対応する歌詞のタグまたは合字部品を指定してください');
  const colors={dark:'#222222',light:'#eeeeee'};
  const authorStyles=(tag:string)=>createHash('sha256').update(JSON.stringify([source.id,input.baseRevision,target.project.id,input.targetRevision,input.effects,input.lyrics,tag])).digest('hex');
  const variants=[{tag:'baseline',enabled:[] as Rule[]},{tag:'full',enabled:rules},...rules.map(rule=>({tag:`without:${rule.claimId}`,enabled:rules.filter(item=>item!==rule)}))]
    .sort((a,b)=>authorStyles(a.tag).localeCompare(authorStyles(b.tag)));
  const entries=variants.map(({tag,enabled},i)=>{
    const label=String.fromCharCode(65+i);
    const applied:{line:number;claimId:string;kind:string;seconds:number}[]=[];
    const elements:SceneElement[]=lyrics.flatMap((line,index)=>{
      const {text,ruby,parts,from,to}=line;
      const span=to-from,prefix=`line:${index+1}`;
      const active=new Map(enabled.filter(rule=>fits(rule,line)).map(rule=>[rule.kind,rule]));
      const use=(kind:z.infer<typeof effect>,limit:number)=>{
        const rule=active.get(kind);
        if(!rule) return 0;
        const seconds=Math.min(limit,rule.value*(rule.unit==='beats'?beatAt(from):1));
        applied.push({line:index+1,claimId:rule.claimId,kind,seconds});
        return seconds;
      };
      const fontSize=Math.min(height*.17,width*.82/Math.max(1,[...text].length));
      const center=height*.5;
      const entrance=use('entrance',span*.3),hold=use('hold',span*.3),stagger=use('stagger',span*.35/Math.max(1,[...text].length-1));
      const invert=use('invert',span*.4),combine=use('combine',span*.45);
      const movement=entrance||(hold>0?Math.min(.15,span*.2):0), startY=center+height*.12;
      const y=movement>0?{keys:[{t:from,v:startY,ease:hold>0?'hold' as const:'easeOut' as const},
        ...(hold>0?[{t:from+hold,v:startY,ease:'easeOut' as const}]:[]),{t:from+hold+movement,v:center}]}:center;
      const lines:SceneElement[]=[{id:`${prefix}:group`,type:'group',transform:{x:width/2,y},inPoint:from,outPoint:to}];
      const foreground=(piece:string,pieceId:string,begin:number,end:number,x:Track,size:number,offsetY:number,split=false)=>{
        for(const [cursor,limit,fill,side] of [[begin,Math.min(end,from+invert),colors.light,'light'],[Math.max(begin,from+invert),end,colors.dark,'dark']] as const) {
          if(limit<=cursor) continue;
          lines.push({id:`${prefix}:${pieceId}:${side}`,parentId:`${prefix}:group`,type:'text',text:piece,fontSize:size,fill,
            inPoint:cursor,outPoint:limit,transform:{x,y:offsetY},split:split?'char':undefined,
            stagger:split?{interval:stagger}:undefined,
            unitTransform:split?{opacity:{keys:[{t:from,v:0,ease:'hold'},{t:from+Math.min(1/media.fps,span/2),v:1}]}}:undefined});
        }
      };
      if(invert>0) lines.unshift({id:`${prefix}:invert`,type:'rect',width,height,fill:colors.dark,inPoint:from,outPoint:from+invert,transform:{x:width/2,y:height/2}});
      if(parts&&combine>0) parts.forEach((piece,i)=>{
        const size=Math.min(fontSize*.72,width*.8/(parts.length*Math.max(...parts.map(part=>[...part].length))));
        const offset=(i-(parts.length-1)/2)*size;
        const x={keys:[{t:from,v:offset*1.45,ease:'easeInOut' as const},{t:from+combine,v:offset*.55}]};
        foreground(piece,`part:${i}`,from,from+combine,x,size,0);
      });
      foreground(text,'text',from+combine,to,0,fontSize,0,stagger>0);
      if(ruby) foreground(ruby,'ruby',from+combine,to,0,Math.min(fontSize*.35,width*.8/[...ruby].length),-fontSize*.73);
      return lines;
    });
    const scene=checkScene({...target.scene,duration,fps:media.fps,background:colors.light,elements});
    return {label,tag,scene,applied};
  });
  const provenance={sourceProjectId:id,sourceRevision:input.baseRevision,targetProjectId:target.project.id,targetRevision:input.targetRevision,
    targetSha256:media.sha256,lyrics,rules};
  const variantsOut:{label:string;project:ReturnType<typeof getProject>['project']}[]=[];
  try {
    for(const entry of entries) {
      const {project}=saveGeneratedProject(`${input.name.slice(0,98)} ${entry.label}`,entry.scene,target.project.id,input.actor,{adaptation:{
        ...provenance,kind:'lyric-study',condition:entry.tag,applied:entry.applied,
      }});
      variantsOut.push({label:entry.label,project});
    }
  } catch(error) {
    for(const item of variantsOut) trashProject(item.project.id,input.actor);
    throw error;
  }
  return {variants:variantsOut,reveal:Object.fromEntries(entries.map(entry=>[entry.label,entry.tag])),...provenance};
}
