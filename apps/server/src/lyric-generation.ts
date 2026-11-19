import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { canvasMeasurer, layoutText, sampleTrack, textUnits, type SceneElement, type Track, type Transform } from '@mlm/core';
import { saveGeneratedProject } from './modeling.ts';
import { readMotionVocabulary } from './motion-vocabulary.ts';
import { checkScene, getDocuments, getProject, HttpError, trashProject } from './store.ts';

const revision=z.number().int().positive();
const word=z.string().trim().min(1).max(100);
const effect=z.enum(['entrance','hold','stagger','invert','combine']);
const placement=z.strictObject({id:word,duration:z.number().positive().optional(),unit:z.enum(['seconds','beats']).default('seconds'),
  offset:z.number().nonnegative().default(0),strength:z.number().positive().max(2).default(1),at:z.enum(['start','end']).optional()});
const frameLayout=z.strictObject({x:z.number().min(.05).max(.95),y:z.number().min(.1).max(.9),size:z.number().min(.05).max(.85)});
const layout=frameLayout.extend({readingRatio:z.number().min(.12).max(.6).default(.35),letterSpacing:z.number().min(0).max(.5).default(0)});
const lyric=z.strictObject({text:word,ruby:word.optional(),parts:z.array(word).min(2).max(6).optional(),
  from:z.number().nonnegative(),to:z.number().positive(),tags:z.array(word).max(10).default([]),
  motion:z.array(placement).max(3).optional(),layout:layout.optional(),focus:z.number().int().nonnegative().optional(),
  partLayouts:z.array(frameLayout).min(2).max(6).optional(),
  compoundShot:z.strictObject({delayFrames:z.number().int().min(0).max(24).default(1),layout:frameLayout.optional()}).optional(),
  glyphMotion:z.array(z.strictObject({index:z.number().int().nonnegative(),motion:z.array(placement).min(1).max(3)})).min(1).max(100).optional()});
export const LyricGenerationRequest=z.strictObject({baseRevision:revision,targetProjectId:z.string().min(1),targetRevision:revision,
  actor:z.string().trim().min(1).max(40).default('human'),name:word,lyrics:z.array(lyric).min(1).max(100),
  comparison:z.enum(['rules','motion-layout','composition-compound']).default('rules'),
  staging:z.array(z.strictObject({tag:word.optional(),target:z.enum(['line','first','last','focus']),motion:z.array(placement).min(1).max(3)})).min(1).max(12).optional(),
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
  const sortedLyrics=[...input.lyrics].sort((a,b)=>a.from-b.from);
  const glyphs=sortedLyrics.map(line=>textUnits({id:'line',type:'text',text:line.text}));
  const selections:{line:number;rule:number;index?:number;reason:string;ids:string[]}[]=[];
  const lyrics=sortedLyrics.map((line,i)=>{
    if(!input.staging) return line;
    const visible=glyphs[i].flatMap((glyph,index)=>/^\s+$/u.test(glyph)?[]:[index]);
    if(line.focus!==undefined&&!visible.includes(line.focus)) throw new HttpError(422,'強調には表示される文字の番号を指定してください');
    const focus=line.focus??visible.find(index=>/\p{Script=Han}/u.test(glyphs[i][index]))??visible[0];
    const byGlyph=new Map((line.glyphMotion??[]).map(item=>[item.index,item]));
    if(byGlyph.size!==line.glyphMotion?.length&&line.glyphMotion) throw new HttpError(422,'文字の動きの指定が重複しています');
    let whole=line.motion;
    for(const [ruleIndex,rule] of input.staging.entries()) {
      if(rule.tag&&!line.tags.includes(rule.tag)) continue;
      if(rule.target==='line') {
        if(whole?.length) continue;
        whole=rule.motion;
        selections.push({line:i+1,rule:ruleIndex+1,reason:'line',ids:rule.motion.map(item=>item.id)});
        continue;
      }
      const index=rule.target==='last'?visible.at(-1):rule.target==='first'?visible[0]:focus;
      if(index===undefined||byGlyph.has(index)) continue;
      byGlyph.set(index,{index,motion:rule.motion});
      const reason=rule.target!=='focus'?rule.target:line.focus!==undefined?'authored-focus':/\p{Script=Han}/u.test(glyphs[i][index])?'first-han':'first-glyph';
      selections.push({line:i+1,rule:ruleIndex+1,index,reason,ids:rule.motion.map(item=>item.id)});
    }
    return {...line,motion:whole,glyphMotion:byGlyph.size?[...byGlyph.values()]:undefined};
  });
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
  const motionStudy=input.comparison==='motion-layout';
  const compoundStudy=input.comparison==='composition-compound';
  const hasMotion=(line:Input['lyrics'][number])=>!!(line.motion?.length||line.glyphMotion);
  if(motionStudy&&(!lyrics.some(hasMotion)||!lyrics.some(line=>line.layout))) throw new HttpError(422,'動きと配置を両方指定してください');
  if(!motionStudy&&!compoundStudy&&(input.staging||lyrics.some(line=>hasMotion(line)||line.layout))) throw new HttpError(422,'動きと配置を使える比較方法を選んでください');
  if(!compoundStudy&&lyrics.some(line=>line.partLayouts||line.compoundShot)) throw new HttpError(422,'合字に合わせた構図には comparison: "composition-compound" を指定してください');
  if(compoundStudy&&(!lyrics.some(line=>line.compoundShot)||!lyrics.some(line=>line.layout||line.partLayouts||line.compoundShot?.layout))) {
    throw new HttpError(422,'合字の画面切り替えと構図を指定してください');
  }
  const vocabulary=motionStudy||compoundStudy?readMotionVocabulary(id):{};
  for(const rule of input.staging??[]) for(const spec of rule.motion) if(!Object.hasOwn(vocabulary,spec.id)) {
    throw new HttpError(422,`割り当ての型が見つかりません: ${spec.id}`);
  }
  const beatIndex=(t:number)=>{
    if(!beats.length) return t/fallbackBeat!;
    const next=beats.findIndex(beat=>beat>t);
    if(next===0) return (t-beats[0])/fallbackBeat!;
    const index=next<0?beats.length-1:next-1;
    return index+(t-beats[index])/beatAt(t);
  };
  const beatTime=(position:number)=>{
    if(!beats.length) return position*fallbackBeat!;
    const index=Math.floor(position);
    if(index<0) return beats[0]+position*fallbackBeat!;
    if(index>=beats.length-1) return beats.at(-1)!+(position-beats.length+1)*fallbackBeat!;
    return beats[index]+(position-index)*(beats[index+1]-beats[index]);
  };
  const resolveMotions=(specs:z.infer<typeof placement>[],start:number,end:number)=>{
    const used=new Set<string>();
    return specs.map(spec=>{
      const motion=Object.hasOwn(vocabulary,spec.id)?vocabulary[spec.id]:undefined;
      const channels=Object.keys(motion?.tracks??{});
      if(!motion||channels.some(channel=>used.has(channel))) throw new HttpError(422,`動かす項目が重ならない型を指定してください: ${spec.id}`);
      channels.forEach(channel=>used.add(channel));
      if(spec.unit==='beats'&&(!spec.duration||!fallbackBeat)) throw new HttpError(422,'拍単位の型には拍数と拍マーカーまたはテンポが必要です');
      const duration=spec.duration??motion.sourceSeconds;
      const shift=(t:number,delta:number)=>spec.unit==='beats'?beatTime(beatIndex(t)+delta):t+delta;
      const atEnd=(spec.at??(motion.kind==='exit'?'end':'start'))==='end';
      const from=atEnd?shift(end-spec.offset,-duration):start+spec.offset;
      const to=atEnd?end-spec.offset:shift(from,duration);
      if(to<=from||from<start-1e-8||to>end+1e-8) throw new HttpError(422,`型の再生範囲を表示期間内に収めてください: ${spec.id}`);
      return {spec,motion,from:Math.max(from,start),to:Math.min(to,end)};
    });
  };
  const timing=(line:Input['lyrics'][number],rule:Rule,limit:number)=>Math.min(limit,rule.value*(rule.unit==='beats'?beatAt(line.from):1));
  const combineRule=rules.find(rule=>rule.kind==='combine'),staggerRule=rules.find(rule=>rule.kind==='stagger');
  const staggerLimit=(line:Input['lyrics'][number])=>(line.to-line.from)*.35/Math.max(1,[...line.text].length-1);
  const fadeFrame=(line:Input['lyrics'][number])=>Math.min(1/media.fps,(line.to-line.from)/2);
  const compoundEvents=lyrics.map((line,i)=>{
    if(!line.compoundShot&&!line.partLayouts) return undefined;
    const combine=combineRule&&fits(combineRule,line)?timing(line,combineRule,(line.to-line.from)*.45):0;
    if(!combine||!line.parts||(line.partLayouts&&line.partLayouts.length!==line.parts.length)) {
      throw new HttpError(422,'構図を指定した合字には、部品の数と同じ配置および有効な合字の規則が必要です');
    }
    const resultAt=line.from+combine;
    const stagger=staggerRule&&fits(staggerRule,line)?timing(line,staggerRule,staggerLimit(line)):0;
    const visibleAt=Math.max(resultAt,line.from+(stagger>0?fadeFrame(line):0));
    const resultFrame=Math.ceil(visibleAt*media.fps-1e-8);
    const shotFrame=line.compoundShot?resultFrame+line.compoundShot.delayFrames:undefined;
    if(shotFrame!==undefined&&shotFrame/media.fps>=line.to) throw new HttpError(422,'合字後の画面切り替えが歌詞の終了を越えています');
    return {line:i+1,resultAt,resultFrame,shotFrame,shotAt:shotFrame===undefined?undefined:shotFrame/media.fps};
  });
  const motions=lyrics.map(line=>resolveMotions(line.motion??[],line.from,line.to));
  const glyphMotions=lyrics.map((line,i)=>{
    const used=new Set<number>();
    const combine=combineRule&&fits(combineRule,line)?timing(line,combineRule,(line.to-line.from)*.45):0;
    const stagger=staggerRule&&fits(staggerRule,line)?timing(line,staggerRule,staggerLimit(line)):0;
    return (line.glyphMotion??[]).map(({index,motion})=>{
      const glyph=glyphs[i][index];
      if(!glyph||/^\s+$/u.test(glyph)||used.has(index)) throw new HttpError(422,`表示される書記素の番号を一度ずつ指定してください: ${index}`);
      used.add(index);
      const start=line.from+Math.max(combine,stagger>0?index*stagger+fadeFrame(line):0);
      return {index,glyph,motions:resolveMotions(motion,start,line.to)};
    });
  });
  const toTransform=(items:ReturnType<typeof resolveMotions>)=>{
    const transform:Transform={};
    for(const item of items) {
      for(const [field,rows] of Object.entries(item.motion.tracks) as [keyof Transform,NonNullable<(typeof item.motion.tracks)['x']>][]) {
        const factor=field==='x'?width:field==='y'?height:1;
        transform[field]={keys:rows.map(key=>({t:item.from+key.t*(item.to-item.from),
          v:field==='scaleX'||field==='scaleY'?Math.max(.025,1+(key.value-1)*item.spec.strength):key.value*factor*item.spec.strength,ease:key.easing}))};
      }
    }
    return transform;
  };
  const measure=canvasMeasurer(createCanvas(1,1).getContext('2d'));
  const colors={dark:'#222222',light:'#eeeeee'};
  const authorStyles=(tag:string)=>createHash('sha256').update(JSON.stringify([source.id,input.baseRevision,target.project.id,input.targetRevision,input.effects,input.lyrics,tag])).digest('hex');
  const variants=(motionStudy?['timing','motion','layout','motion-layout'].map(tag=>({tag,enabled:rules})):
    compoundStudy?['motion-common','composition','compound-cut','composition-compound'].map(tag=>({tag,enabled:rules})):
    [{tag:'baseline',enabled:[] as Rule[]},{tag:'full',enabled:rules},...rules.map(rule=>({tag:`without:${rule.claimId}`,enabled:rules.filter(item=>item!==rule)}))])
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
        const seconds=timing(line,rule,limit);
        applied.push({line:index+1,claimId:rule.claimId,kind,seconds});
        return seconds;
      };
      const useComposition=['layout','motion-layout','composition','composition-compound'].includes(tag);
      const composition=useComposition?line.layout:undefined;
      const cue=compoundEvents[index];
      const shot=useComposition?line.compoundShot?.layout:undefined;
      const characterCount=glyphs[index].length;
      const center=height*(composition?.y??.5),xCenter=width*(composition?.x??.5);
      const space=composition?Math.min(xCenter,width-xCenter)*2:width;
      const fontSize=Math.min(height*(composition?.size??.17),space*.82/Math.max(1,characterCount*(1+(composition?.letterSpacing??0))));
      const entrance=use('entrance',span*.3),hold=use('hold',span*.3),stagger=use('stagger',staggerLimit(line));
      const invert=use('invert',span*.4),combine=use('combine',span*.45);
      const movement=entrance||(hold>0?Math.min(.15,span*.2):0), startY=center+height*.12;
      const y=movement>0?{keys:[{t:from,v:startY,ease:hold>0?'hold' as const:'easeOut' as const},
        ...(hold>0?[{t:from+hold,v:startY,ease:'easeOut' as const}]:[]),{t:from+hold+movement,v:center}]}:center;
      const lines:SceneElement[]=[];
      let shotParent:string|undefined;
      if(shot&&cue?.shotAt!==undefined) {
        const shotX=width*shot.x;
        const shotSpace=Math.min(shotX,width-shotX)*2;
        const finalSize=Math.min(height*shot.size,shotSpace*.82/(characterCount*(1+(composition?.letterSpacing??0))));
        const ratio=finalSize/fontSize;
        const cut=(v:number,after:number):Track=>({keys:[{t:from,v,ease:'hold'},{t:cue.shotAt!,v:after}]});
        shotParent=`${prefix}:camera`;
        lines.push({id:shotParent,type:'group',inPoint:from,outPoint:to,anchorX:xCenter,anchorY:center,
          transform:{x:cut(xCenter,shotX),y:cut(center,shot.y*height),scaleX:cut(1,ratio),scaleY:cut(1,ratio)}});
      }
      lines.push({id:`${prefix}:group`,parentId:shotParent,type:'group',transform:{x:xCenter,y},inPoint:from,outPoint:to});
      const applyMotion=compoundStudy||tag==='motion'||tag==='motion-layout';
      const transform=toTransform(applyMotion?motions[index]:[]);
      const parentId=Object.keys(transform).length?`${prefix}:motion`:`${prefix}:group`;
      if(parentId!==`${prefix}:group`) lines.push({id:parentId,parentId:`${prefix}:group`,type:'group',transform,inPoint:from,outPoint:to});
      const darkAfter=tag==='compound-cut'||tag==='composition-compound'?cue?.shotAt:undefined;
      const boundaries=[...new Set([from,to,...(invert>0?[from+invert]:[]),...(darkAfter===undefined?[]:[darkAfter])])].sort((a,b)=>a-b);
      const palette=boundaries.slice(0,-1).map((start,i)=>({start,end:boundaries[i+1],dark:(invert>0&&start<from+invert)||(darkAfter!==undefined&&start>=darkAfter)}));
      const foreground=(piece:string,pieceId:string,begin:number,end:number,x:Track,size:number,offsetY:Track,split=false,owner=parentId)=>{
        for(const [i,row] of palette.entries()) {
          const cursor=Math.max(begin,row.start),limit=Math.min(end,row.end),fill=row.dark?colors.light:colors.dark;
          const side=compoundStudy?`palette:${i}`:row.dark?'light':'dark';
          if(limit<=cursor) continue;
          const spacing=pieceId==='text'?(composition?.letterSpacing??0)*size:0;
          const separated=split||spacing>0||(compoundStudy&&pieceId==='text'&&!!line.layout?.letterSpacing);
          lines.push({id:`${prefix}:${pieceId}:${side}`,parentId:owner,type:'text',text:piece,fontSize:size,fill,
            inPoint:cursor,outPoint:limit,transform:{x,y:offsetY},letterSpacing:spacing||undefined,split:separated?'char':undefined,
            stagger:split?{interval:stagger}:undefined,
            unitTransform:split?{opacity:{keys:[{t:from,v:0,ease:'hold'},{t:from+fadeFrame(line),v:1}]}}:undefined});
        }
      };
      for(const [i,row] of palette.entries()) if(row.dark) lines.unshift({id:`${prefix}:invert${compoundStudy?`:${i}`:''}`,type:'rect',width,height,fill:colors.dark,
        inPoint:row.start,outPoint:row.end,transform:{x:width/2,y:height/2}});
      if(parts&&combine>0) parts.forEach((piece,i)=>{
        const baseSize=Math.min(fontSize*.72,width*.8/(parts.length*Math.max(...parts.map(part=>[...part].length))));
        const configured=useComposition?line.partLayouts?.[i]:undefined;
        const offset=(i-(parts.length-1)/2)*baseSize;
        const approach=(start:number,end:number):Track=>({keys:[{t:from,v:start,ease:'easeInOut'},{t:from+combine,v:end}]});
        const partMovement=configured?approach(configured.x*width-xCenter,offset*.55):approach(offset*1.45,offset*.55);
        const partY=configured?approach(configured.y*height-sampleTrack(y,from,center),0):0;
        const size=configured?Math.min(configured.size*height,Math.min(configured.x,1-configured.x)*width*1.64/[...piece].length):baseSize;
        foreground(piece,`part:${i}`,from,from+combine,partMovement,size,partY);
      });
      if(line.glyphMotion) {
        const units=layoutText({id:prefix,type:'text',text,fontSize,split:'char',letterSpacing:(composition?.letterSpacing??0)*fontSize},measure);
        const individual=new Map(glyphMotions[index].map(glyph=>[glyph.index,glyph.motions]));
        for(const unit of units.units) {
          if(/^\s+$/u.test(unit.text)) continue;
          const begin=from+Math.max(combine,stagger>0?unit.rank*stagger+fadeFrame(line):0);
          const owner=`${prefix}:glyph:${unit.index}`;
          lines.push({id:owner,parentId,type:'group',transform:{x:unit.x},inPoint:begin,outPoint:to});
          const keys=applyMotion?individual.get(unit.index):undefined;
          const motionOwner=keys?`${owner}:motion`:owner;
          if(keys) lines.push({id:motionOwner,parentId:owner,type:'group',transform:toTransform(keys),inPoint:begin,outPoint:to});
          foreground(unit.text,`glyph:${unit.index}`,begin,to,0,fontSize,0,false,motionOwner);
        }
      } else foreground(text,'text',from+combine,to,0,fontSize,0,stagger>0);
      if(ruby) foreground(ruby,'ruby',from+combine,to,0,Math.min(fontSize*(composition?.readingRatio??.35),space*.8/[...ruby].length),-fontSize*.73);
      return lines;
    });
    const scene=checkScene({...target.scene,duration,fps:media.fps,background:colors.light,elements});
    return {label,tag,scene,applied};
  });
  const provenance={sourceProjectId:id,sourceRevision:input.baseRevision,targetProjectId:target.project.id,targetRevision:input.targetRevision,
    targetSha256:media.sha256,lyrics,rules,motions,glyphMotions,staging:input.staging,selections,compoundEvents};
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
