import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { z } from 'zod';
import { blockingFrame, isActive, sampleTrack, worldMatrixOf } from '@mlm/core';
import type { Blocking, Scene, SceneElement, Track } from '@mlm/core';
import { getBlocking } from './blocking.ts';
import { contourObservation } from './representative.ts';
import { commit, createProject, getDocuments, HttpError, trashProject } from './store.ts';
import { sourcePath } from './media.ts';

const seconds = z.number().nonnegative();
const head = { baseRevision: z.number().int().positive(), actor: z.string().trim().min(1).max(40).default('human') };
const lyricFields = {
  text: z.string().trim().min(1).max(250), reading: z.string().trim().max(250).optional(),
  from: seconds, to: seconds, uncertaintySeconds: seconds.max(1),
};
const anchorIds=z.array(z.string().min(1)).min(1).max(8);
export const TimingRequest = z.discriminatedUnion('operation', [
  z.strictObject({ ...head, ...lyricFields, operation: z.literal('lyric'), replaces: z.string().uuid().optional() }),
  z.strictObject({ ...head, operation: z.literal('measure'), windowSeconds: z.number().positive().max(1).default(.1) }),
  z.strictObject({ ...head, operation: z.literal('orientation'), label:z.string().trim().min(1).max(120),
    from:z.number().int().nonnegative(), to:z.number().int().positive(), anchors:z.tuple([anchorIds,anchorIds]) }),
  z.strictObject({ ...head, operation:z.literal('motion'), blockId:z.string().min(1), from:z.number().int().nonnegative(),to:z.number().int().positive(),
    stationaryPx:z.number().positive().max(50).default(2) }),
  z.strictObject({ ...head, operation:z.literal('apply-orientation'), observationId:z.string().min(1),shapeFrame:z.number().int().nonnegative(),partIds:anchorIds }),
  z.strictObject({ ...head, operation:z.literal('checkpoint'), blockId:z.string().min(1),frame:z.number().int().nonnegative(),
    box:z.tuple([seconds,seconds,z.number().positive(),z.number().positive()]).nullable(),note:z.string().trim().max(500).optional() }),
]);
const lyricSchema = z.object({ ...lyricFields, kind: z.literal('lyric-span'), id: z.string().uuid(),
  sourceSha256: z.string(), replaces: z.string().uuid().optional(), origin: z.literal('manual') });

type Candidate = { t: number; label: string; origin: string; observationId?: string; uncertaintySeconds?: number };

export function editTiming(id: string, input: Exclude<z.infer<typeof TimingRequest>,{operation:'apply-orientation'}>) {
  const { project, scene, design } = getBlocking(id);
  if (project.revision !== input.baseRevision) throw new HttpError(409, '最新のリビジョンを読み直してください');
  if (!project.source || !design) throw new HttpError(422, '元動画がある工程比較を開いてください');
  const sourceSha256 = project.source.sha256;
  const observations = getDocuments(id).observations as Record<string, unknown> ?? {};
  const provenance = { sourceProjectId: id, sourceSha256, sourceRevision: project.revision };
  if(input.operation==='checkpoint') {
    const {blockId,frame,box,note}=input;
    const t=frame/scene.fps;
    const block=design.blocks.items.find(item=>item.id===blockId);
    if(!block||t<design.blocks.from||t>=design.blocks.to||box&&(box[0]+box[2]>scene.width||box[1]+box[3]>scene.height)) {
      throw new HttpError(422,'比較範囲内のブロック・コマと、元動画内の箱を指定してください');
    }
    const row={id:randomUUID(),kind:'block-checkpoint',origin:'manual',...provenance,reviewer:input.actor,blockId,frame,t,box,note,
      model:checkpointBox(scene,design,blockId,t)};
    const score=box&&row.model?{centerErrorPx:Math.hypot(box[0]+box[2]/2-row.model[0]-row.model[2]/2,box[1]+box[3]/2-row.model[1]-row.model[3]/2),
      widthRelativeError:Math.abs(row.model[2]-box[2])/box[2],heightRelativeError:Math.abs(row.model[3]-box[3])/box[3]}:undefined;
    const observation={...row,score,visibilityMatches:!!box===!!row.model};
    return {...save(id,input,[observation],'元映像の確認コマを記録'),observation};
  }
  if(input.operation==='motion') {
    const measured=measureMotion(design,scene,observations,input);
    const row={id:randomUUID(),...measured,...provenance,
      rmsComparison:compareRms(measured.samples,scene.fps,project.audioAnalysis,sourceSha256)};
    return {...save(id,input,[row],'停止・速度・画面占有率を計測'),observation:row};
  }
  if (input.operation==='orientation') {
    const measured=measureOrientation(design,scene.fps,observations,input);
    const row={id:randomUUID(),kind:'group-orientation',origin:'measured',...provenance,...measured};
    return {...save(id,input,[row],'2つの対象から画面内の角度を計測'),observation:row};
  }
  if (!project.source.hasAudio) throw new HttpError(422, '音声がある工程比較を開いてください');
  const lyrics = Object.values(observations).flatMap(value => {
    const parsed = lyricSchema.safeParse(value);
    return parsed.success && parsed.data.sourceSha256 === sourceSha256 ? [parsed.data] : [];
  });
  const superseded = new Set(lyrics.map(span => span.replaces));
  const activeLyrics = lyrics.filter(span => !superseded.has(span.id));
  if (input.operation === 'lyric') {
    const { text, reading, from, to, uncertaintySeconds, replaces } = input;
    if (from >= to || to > Math.min(scene.duration, project.source.duration)) throw new HttpError(422, '歌詞の開始・終了を元動画の範囲内で指定してください');
    if (replaces && !activeLyrics.some(span => span.id === replaces)) throw new HttpError(422, '修正前の歌詞注釈がありません');
    const row = { id: randomUUID(), kind: 'lyric-span', origin: 'manual', ...provenance, reviewer: input.actor,
      text, reading, from, to, uncertaintySeconds, replaces, clock: 'source-video' };
    return { ...save(id, input, [row], '発音時刻を記録'), observation: row };
  }

  const matchEvents = design.events.filter(event => event.status === 'confirmed');
  if (!matchEvents.length) throw new HttpError(422, '比較する出来事を1つ以上確定してください');
  const markerCandidates = (kind: 'beat' | 'downbeat'): Candidate[] => (scene.markers ?? []).filter(marker => marker.kind === kind)
    .map(marker => ({ t: marker.t, label: marker.label ?? kind, origin: marker.origin ?? 'unspecified' }));
  const parsedAudio = z.object({ sourceSha256: z.string(), onsets: z.array(seconds), sourceOffsetSeconds: z.number().optional() }).safeParse(project.audioAnalysis);
  const audio = parsedAudio.success && parsedAudio.data.sourceSha256 === sourceSha256 ? parsedAudio.data : undefined;
  const candidates = {
    lyric: activeLyrics.map(span => ({ t: span.from, label: span.text, origin: span.origin, observationId: span.id, uncertaintySeconds: span.uncertaintySeconds })),
    beat: markerCandidates('beat'), downbeat: markerCandidates('downbeat'),
    onset: (audio?.onsets ?? []).map(t => ({ t: t + (audio?.sourceOffsetSeconds ?? 0), label: '音の立ち上がり', origin: 'estimated' })),
  };
  const rows = matchEvents.map(event => {
    const compare = (candidate: Candidate) => {
      const offsetSeconds = event.t - candidate.t;
      const uncertaintySeconds = .5 / scene.fps + (candidate.uncertaintySeconds ?? 0);
      return { ...candidate, offsetSeconds, eventFrameToleranceSeconds: .5 / scene.fps,
        withinWindow: Math.abs(offsetSeconds) <= input.windowSeconds + uncertaintySeconds };
    };
    const nearest = (items: Candidate[]) => items.map(compare).sort((a, b) => Math.abs(a.offsetSeconds) - Math.abs(b.offsetSeconds) || a.t - b.t).slice(0, 2);
    const matches = { lyric: nearest(candidates.lyric), beat: nearest(candidates.beat), downbeat: nearest(candidates.downbeat), onset: nearest(candidates.onset) };
    const nearLyric = matches.lyric.some(match => match.withinWindow);
    const nearBeat = matches.beat.some(match => match.withinWindow) || matches.downbeat.some(match => match.withinWindow);
    const assessment = !matches.lyric.length || (!matches.beat.length && !matches.downbeat.length) ? 'insufficient' :
      nearLyric && nearBeat ? 'indistinguishable' : nearLyric ? 'lyric-nearby' : nearBeat ? 'beat-nearby' : 'neither-nearby';
    return { id: randomUUID(), kind: 'event-audio-timing', origin: 'measured', ...provenance,
      event: { id: event.id, label: event.label, t: event.t, observationIds: event.observationIds }, matches, assessment,
      windowSeconds: input.windowSeconds, onsetSourceOffsetSeconds: audio?.sourceOffsetSeconds,
      method: 'nearest two per modality; offset = visual event minus audio cue; estimated cue error may be unknown' };
  });
  const shift={id:randomUUID(),kind:'event-audio-shift-control',origin:'measured',...provenance,
    ...shiftControl(design.blocks,matchEvents,candidates,input.windowSeconds,.5/scene.fps),observationIds:rows.map(row=>row.id)};
  return { ...save(id, input, [...rows,shift], '出来事と音の時差・時刻ずらしを計測'), measurements: rows, shiftControl:shift };
}

function compareRms(samples:{t:number;speedPxPerS?:number;visibleCount:number}[],fps:number,analysis:unknown,sourceSha256:string) {
  const decoded=z.object({sourceSha256:z.string(),sourceOffsetSeconds:z.number().optional(),
    energy:z.object({stepSeconds:z.number().positive(),rms:z.array(z.number().nonnegative()).min(1)})}).safeParse(analysis);
  if(!decoded.success||decoded.data.sourceSha256!==sourceSha256) return;
  const {energy,sourceOffsetSeconds=0}=decoded.data;
  const rms=energy.rms;
  const at=(t:number)=>rms[Math.round((t-sourceOffsetSeconds)/energy.stepSeconds)];
  const sampleCount=samples.filter(row=>at(row.t)!==undefined).length;
  const sorted=[...rms].sort((a,b)=>a-b);
  const floor=sorted[Math.floor((sorted.length-1)*.95)]*.05;
  const lagFrames=[-2,-1,0,1,2];
  const model=(field:'speedPxPerS'|'visibleCount')=>lagFrames.map(frames=>{
    const pairs=samples.flatMap(row=>{
      const energy=at(row.t-frames/fps),value=row[field];
      return energy!==undefined&&value!==undefined?[[energy,value]]:[];
    });
    const n=pairs.length;
    if(n<8) return {frames,n};
    const ax=pairs.reduce((sum,[x])=>sum+x,0)/n,ay=pairs.reduce((sum,[,y])=>sum+y,0)/n;
    const covariance=pairs.reduce((sum,[x,y])=>sum+(x-ax)*(y-ay),0);
    const varianceX=pairs.reduce((sum,[x])=>sum+(x-ax)**2,0),varianceY=pairs.reduce((sum,[,y])=>sum+(y-ay)**2,0);
    return {frames,n,pearson:varianceX>1e-12&&varianceY>1e-12?covariance/Math.sqrt(varianceX*varianceY):undefined};
  });
  return {sampleCount,quietThresholdRms:floor,quietFrames:samples.filter(row=>at(row.t)!==undefined&&at(row.t)<=floor).length,
    speed:model('speedPxPerS'),visibleCount:model('visibleCount'),method:'raw RMS nearest to frame time; positive lag means picture follows audio; quiet uses 5% of source RMS p95'};
}

function checkpointBox(scene:Scene,design:Blocking,blockId:string,t:number) {
  const block=design.blocks.items.find(item=>item.id===blockId)!;
  const group=scene.elements.find(el=>el.id===blockId)!;
  if(!isActive(group,scene,t)||block.hiddenDuring?.some(gap=>t>=gap.from&&t<gap.to)) return null;
  const extent=block.extent;
  const fixed=blockingFrame(scene,design,t,'final');
  const ids=design.appearance.find(item=>item.blockId===blockId)?.childIds??[];
  const visible=ids.flatMap(id=>fixed.elements.filter(el=>el.id===id&&isActive(el,fixed,t)));
  if(visible.length&&visible.every(el=>el.outline?.length&&el.width!==undefined&&el.height!==undefined)) {
    let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
    for(const el of visible) {
      const [a,b,c,d,x,y]=worldMatrixOf(fixed,el.id,t);
      for(const polygon of el.outline!) for(let i=0;i<polygon.length;i+=2) {
        const u=(polygon[i]/4096-.5)*el.width!,v=(polygon[i+1]/4096-.5)*el.height!;
        const px=x+a*u+c*v,py=y+b*u+d*v;
        left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);
      }
    }
    return [left,top,right-left,bottom-top] as const;
  }
  const [a,b,c,d,x,y]=worldMatrixOf(scene,blockId,t);
  const [cx,cy,w,h]=[extent.cx,extent.cy,extent.width,extent.height].map(track=>sampleTrack(track,t,0,scene.tempo));
  const screenWidth=Math.abs(a)*w+Math.abs(c)*h,screenHeight=Math.abs(b)*w+Math.abs(d)*h;
  return [x+a*cx+c*cy-screenWidth/2,y+b*cx+d*cy-screenHeight/2,screenWidth,screenHeight] as const;
}

export async function applyOrientation(id:string,input:Extract<z.infer<typeof TimingRequest>,{operation:'apply-orientation'}>) {
  const {project,scene,design}=getBlocking(id);
  if(project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  if(!design||!project.source) throw new HttpError(422,'元動画がある工程比較を開いてください');
  const observations=getDocuments(id).observations as Record<string,unknown>??{};
  const angle=z.object({kind:z.literal('group-orientation'),label:z.string().max(120),sourceSha256:z.string(),from:z.number().int(),to:z.number().int(),
    samples:z.array(z.object({frame:z.number(),t:z.number(),deltaDegrees:z.number(),distancePx:z.number().positive(),cx:z.number(),cy:z.number()})).min(2)}).safeParse(observations[input.observationId]);
  if(!angle.success||angle.data.sourceSha256!==project.source.sha256) throw new HttpError(422,'同じ元動画の角度観察を作成してください');
  const {samples,from,to,label}=angle.data;
  const reference=samples.find(row=>row.frame===input.shapeFrame);
  if(!reference||samples[0].frame!==from||samples.at(-1)!.frame!==to-1||new Set(input.partIds).size!==input.partIds.length) {
    throw new HttpError(422,'角度観察の両端と代表コマに観測が必要です。部品は重複なく指定してください');
  }
  const life={inPoint:from/scene.fps,outPoint:to/scene.fps};
  const at=input.shapeFrame/scene.fps;
  const blockId=`rotation:${randomUUID()}`;
  const parts:SceneElement[]=input.partIds.map((fragment,i)=>{
    const shape=design.appearance.find(item=>item.blockId===fragment)?.contours?.find(row=>Math.abs(row.t-at)<1e-8);
    const block=design.blocks.items.find(item=>item.id===fragment);
    const row=block?.observationIds.flatMap(key=>{
      const parsed=contourObservation.safeParse(observations[key]);
      return parsed.success?parsed.data.samples:[];
    }).findLast(row=>row.frame===input.shapeFrame);
    if(!shape||!row) throw new HttpError(422,`代表コマの部品輪郭がありません: ${fragment}`);
    const [left,top,width,height]=row.box;
    const shade=shape.luma.toString(16).padStart(2,'0');
    return {id:`${blockId}:${i}`,parentId:blockId,type:'rect',name:block?.label,width:Math.max(.01,width-1),height:Math.max(.01,height-1),
      fill:`#${shade.repeat(3)}`,outline:shape.paths,transform:{x:left+(width-1)/2-reference.cx,y:top+(height-1)/2-reference.cy}};
  });
  const track=(read:(row:(typeof samples)[number])=>number,error:number)=>boundedKeys(samples.map(row=>({t:row.t,v:read(row)})),error);
  const scale=track(row=>row.distancePx/reference.distancePx,.005);
  const next:Scene={...scene,elements:[{id:blockId,name:label,type:'group',...life,transform:{x:track(row=>row.cx,2),y:track(row=>row.cy,2),
    rotation:track(row=>row.deltaDegrees-reference.deltaDegrees,.35),scaleX:scale,scaleY:scale}},...parts]};
  const reach=(axis:'x'|'y',side:'width'|'height')=>2*Math.max(...parts.map(part=>Math.abs(part.transform?.[axis] as number)+part[side]!/2));
  const maxTurn=samples.reduce((largest,row)=>Math.abs(row.deltaDegrees-reference.deltaDegrees)>Math.abs(largest.deltaDegrees-reference.deltaDegrees)?row:largest,reference);
  const model:Blocking={blocks:{...design.blocks,from:life.inPoint,to:life.outPoint,derived:true,measuredTo:undefined,
    items:[{id:blockId,label,color:'#64c7e7',extent:{cx:0,cy:0,width:reach('x','width'),height:reach('y','height')},observationIds:[input.observationId]}]},
    appearance:[{blockId,childIds:parts.map(part=>part.id)}],events:[{id:`${blockId}:turn`,kind:'rotate',t:maxTurn.t,
      label:`${label} ${ (maxTurn.deltaDegrees-reference.deltaDegrees).toFixed(1)}°`,inputs:[blockId],outputs:[blockId],
      observationIds:[input.observationId],status:'proposed'}]};
  const created=createProject(`${label.slice(0,75)} · 回転モデル`,next,input.actor);
  try {
    await copyFile(sourcePath(project),sourcePath({...created.project,source:project.source}));
    return {...commit(created.project.id,{baseRevision:created.project.revision,actor:input.actor,note:'画面内の共通回転をキーに適用',
      meta:meta=>{meta.source=project.source;meta.audioAnalysis=project.audioAnalysis;},
      documents:()=>({...model,observations:{[input.observationId]:observations[input.observationId]},
        simplification:{orientation:{sourceProjectId:id,sourceRevision:project.revision,observationId:input.observationId,shapeFrame:input.shapeFrame,partIds:input.partIds}}})}),design:model};
  } catch(error) {trashProject(created.project.id,input.actor);throw error;}
}

function boundedKeys(keys:{t:number;v:number}[],tolerance:number):Track {
  if(keys.every(row=>row.v===keys[0].v)) return keys[0].v;
  const keep=new Set([0,keys.length-1]);
  const segments=[[0,keys.length-1]];
  while(segments.length) {
    const [a,b]=segments.pop()!;
    let error=tolerance,split=-1;
    for(let i=a+1;i<b;i++) {
      const ratio=(keys[i].t-keys[a].t)/(keys[b].t-keys[a].t);
      const residual=Math.abs(keys[i].v-(keys[a].v+(keys[b].v-keys[a].v)*ratio));
      if(residual>error) {error=residual;split=i;}
    }
    if(split>=0) {keep.add(split);segments.push([a,split],[split,b]);}
  }
  return {keys:keys.filter((_,i)=>keep.has(i))};
}

function shiftControl({from,to}:{from:number;to:number},events:{t:number}[],candidates:Record<string,Candidate[]>,window:number,frameTolerance:number) {
  const duration=to-from;
  const shifts=[0,.17,.31,.47,.63,.79].map(fraction=>fraction*duration);
  const groups=Object.fromEntries(Object.entries(candidates).flatMap(([kind,points])=>{
    const local=points.filter(point=>point.t>=from&&point.t<to);
    if(!local.length) return [];
    const counts=shifts.map(shift=>events.filter(event=>local.some(point=>{
      const t=from+(point.t-from+shift)%duration;
      const distance=Math.abs(event.t-t);
      return Math.min(distance,duration-distance)<=Math.min(duration/2,window+frameTolerance+(point.uncertaintySeconds??0));
    })).length);
    return [[kind,{candidateCount:local.length,observedHits:counts[0],shiftedHits:counts.slice(1)}]];
  }));
  return {from,to,shifts:shifts.slice(1),eventCount:events.length,groups,method:'circular shifts preserve event and candidate counts and spacing on this interval; descriptive control'};
}

function measureMotion(design:NonNullable<ReturnType<typeof getBlocking>['design']>,scene:Scene,observations:Record<string,unknown>,
    input:Extract<z.infer<typeof TimingRequest>,{operation:'motion'}>) {
  const {blockId,from,to,stationaryPx}=input;
  const block=design.blocks.items.find(item=>item.id===blockId), group=scene.elements.find(el=>el.id===blockId);
  if(!block||!group||to-from<3||to-from>480||from/scene.fps<design.blocks.from||to/scene.fps>design.blocks.to) {
    throw new HttpError(422,'工程比較のブロックと、3〜480コマの計測範囲を指定してください');
  }
  const measured=new Map<number,[number,number,number,number]>();
  const evidence=block.observationIds.filter(id=>{
    const row=contourObservation.safeParse(observations[id]);
    if(row.success) for(const sample of row.data.samples) measured.set(sample.frame,sample.box);
    return row.success;
  });
  const sceneElements=new Map(scene.elements.map(element=>[element.id,element]));
  const rows=Array.from({length:to-from},(_,i)=>{
    const frame=from+i,t=frame/scene.fps;
    const visible=isActive(group,scene,t)&&!block.hiddenDuring?.some(gap=>t>=gap.from&&t<gap.to);
    const visibleCount=design.blocks.items.filter(item=>{
      if(item.members||item.hiddenDuring?.some(gap=>t>=gap.from&&t<gap.to)) return false;
      const layer=sceneElements.get(item.id);
      return layer&&isActive(layer,scene,t);
    }).length;
    if(!visible||evidence.length&&!measured.has(frame)) return {frame,t,visibleCount};
    const box=measured.get(frame);
    const [a,b,c,d,x,y]=worldMatrixOf(scene,blockId,t);
    const w=sampleTrack(block.extent.width,t,0,scene.tempo),h=sampleTrack(block.extent.height,t,0,scene.tempo);
    const [cx,cy,width,height]=box?[box[0]+box[2]/2,box[1]+box[3]/2,box[2],box[3]]:
      [x,y,Math.abs(a)*w+Math.abs(c)*h,Math.abs(b)*w+Math.abs(d)*h];
    const occupiedWidth=Math.max(0,Math.min(scene.width,cx+width/2)-Math.max(0,cx-width/2));
    const occupiedHeight=Math.max(0,Math.min(scene.height,cy+height/2)-Math.max(0,cy-height/2));
    return {frame,t,visibleCount,cx,cy,occupancyRatio:occupiedWidth*occupiedHeight/(scene.width*scene.height)};
  });
  let previousSpeed:number|undefined;
  const samples=rows.map((row,i)=>{
    const previous=rows[i-1];
    const step=row.cx!==undefined&&row.cy!==undefined&&previous?.cx!==undefined&&previous.cy!==undefined?Math.hypot(row.cx-previous.cx,row.cy-previous.cy):undefined;
    const accelerationPxPerS2=step!==undefined&&previousSpeed!==undefined?(step-previousSpeed)*scene.fps**2:undefined;
    previousSpeed=step;
    return {...row,speedPxPerS:step===undefined?undefined:step*scene.fps,accelerationPxPerS2};
  });
  const stops:{from:number;to:number}[]=[];
  let start:number|undefined;
  for(const row of [...samples,{t:to/scene.fps,speedPxPerS:undefined}]) {
    if(row.speedPxPerS!==undefined&&row.speedPxPerS<=stationaryPx*scene.fps) {start??=row.t-1/scene.fps;continue;}
    if(start!==undefined&&row.t-start>=3/scene.fps-1e-9) stops.push({from:Math.max(from/scene.fps,start),to:row.t-1/scene.fps});
    start=undefined;
  }
  if(!samples.some(row=>row.speedPxPerS!==undefined)) throw new HttpError(422,'連続した位置の観測がありません');
  return { kind:'block-motion-metrics',origin:evidence.length?'measured':'estimated',blockId,from,to,stationaryPx,stops,samples,observationIds:evidence,
    missingFrames:samples.filter(row=>row.cx===undefined).map(row=>row.frame),method:'consecutive center differences; stationary runs use two or more consecutive steps; occupancy is clipped bounding box' };
}

function measureOrientation(design: NonNullable<ReturnType<typeof getBlocking>['design']>, fps:number, observations:Record<string,unknown>,
    input:Extract<z.infer<typeof TimingRequest>,{operation:'orientation'}>) {
  const {anchors,from,to,label}=input;
  if (to-from<2||to-from>48||from/fps<design.blocks.from||to/fps>design.blocks.to||new Set(anchors.flat()).size!==anchors.flat().length) {
    throw new HttpError(422,'比較区間内の2〜48コマと、重複しない2系統の断片を指定してください');
  }
  const evidence=new Set<string>();
  const layers=anchors.map(fragmentIds=>{
    const points=new Map<number,{x:number;y:number}>();
    for (const fragmentId of fragmentIds) {
      const block=design.blocks.items.find(item=>item.id===fragmentId);
      const binding=design.appearance.find(item=>item.blockId===fragmentId);
      if (!binding?.contours?.length||!block) throw new HttpError(422,`輪郭断片がありません: ${fragmentId}`);
      const visible=new Set(binding.contours.map(shape=>Math.round(shape.t*fps)));
      const fragment=new Map<number,{x:number;y:number}>();
      for (const key of block.observationIds) {
        const observation=contourObservation.safeParse(observations[key]);
        if (!observation.success) continue;
        for (const {frame,box:[left,top,width,height]} of observation.data.samples) {
          if (frame<from||frame>=to||!visible.has(frame)) continue;
          fragment.set(frame,{x:left+(width-1)/2,y:top+(height-1)/2});
        }
        evidence.add(key);
      }
      for (const [frame,center] of fragment) {
        if (points.has(frame)) throw new HttpError(422,`一つの対象に複数の断片があります: ${frame}F`);
        points.set(frame,center);
      }
    }
    return points;
  });
  const missingFrames:number[]=[];
  const samples:{frame:number;t:number;angleDegrees:number;deltaDegrees:number;distancePx:number;cx:number;cy:number}[]=[];
  for (let frame=from;frame<to;frame++) {
    const a=layers[0].get(frame),b=layers[1].get(frame);
    const distancePx=a&&b?Math.hypot(b.x-a.x,b.y-a.y):0;
    if (!a||!b||distancePx<10) { missingFrames.push(frame);continue; }
    const angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
    const previous=samples.at(-1)?.angleDegrees??angle;
    const angleDegrees=angle+360*Math.round((previous-angle)/360);
    samples.push({frame,t:frame/fps,angleDegrees,deltaDegrees:angleDegrees-(samples[0]?.angleDegrees??angleDegrees),distancePx,cx:(a.x+b.x)/2,cy:(a.y+b.y)/2});
  }
  if (samples.length<2) throw new HttpError(422,'2対象の距離が10px以上ある共通コマが2つ以上必要です');
  return {label,anchors,from,to,samples,missingFrames,observationIds:[...evidence],
    method:'axis between the centers of two selected contours; clockwise positive; group estimate if spacing and identities are stable'};
}

function save(id: string, input: z.infer<typeof TimingRequest>, rows: { id: string }[], note: string) {
  const { baseRevision, actor } = input;
  return commit(id, { baseRevision, actor, note, documents: docs => ({ ...docs,
    observations: { ...docs.observations as object, ...Object.fromEntries(rows.map(row => [row.id, row])) },
  }) });
}
