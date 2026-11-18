import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Blocking, ProjectMeta, Scene, SceneElement, Track } from '@mlm/core';
import { BlockingSchema, validateBlocking } from '@mlm/core';
import { sourcePath } from './media.ts';
import { DATA_DIR, HttpError, projectDir, REPO_ROOT } from './store.ts';

const run = promisify(execFile);
const colors = ['#64c7e7','#ffba6c','#bf9eef','#83dbb3','#e68daf','#e9d874'];
type Box = [number,number,number,number];
type Candidate = {text:string;confidence:number|null;inferenceMs:number};
type Sample = {frame:number;box:Box;paths:number[][];ink:number;ocr?:Candidate};
type Sequence = {
  fps:number;frames:number;backgrounds:number[];tracks:{id:number;samples:Sample[]}[];
  cameraCandidates:{frame:number;support:number;spread:number;movement:[number,number];medianResidual:number}[];
  runtimeSeconds:number;opencv:string;
};
export interface SequenceOptions { from?:number;to?:number;region?:Box;cuts?:number[];ocrFrames?:number[] }

export async function analyzeSequence(project:ProjectMeta, options:SequenceOptions, signal?:AbortSignal, onProgress?:(value:number)=>void):Promise<Sequence> {
  const video=project.source;
  if(!video||video.variableFrameRate) throw new HttpError(422,'固定フレームレートの元動画が必要です');
  const from=options.from??0,to=options.to??video.frameCount??Math.floor(video.duration*video.fps);
  if(from<0||from>=to||to>Math.ceil(video.duration*video.fps)||to-from>Math.ceil(120*video.fps)) throw new HttpError(422,'解析範囲のフレーム番号が不正です');
  const region=options.region;
  if(region&&(region[0]<0||region[1]<0||region[2]<=0||region[3]<=0||region[0]+region[2]>video.width||region[1]+region[3]>video.height)) throw new HttpError(422,'選択範囲が元動画の外です');
  const dir=await fs.mkdtemp(path.join(projectDir(project.id),'cache','block-'));
  const config=path.join(dir,'input.json'),output=path.join(dir,'output.json');
  try {
    await fs.writeFile(config,JSON.stringify({...options,from,to}));
    const model=path.join(DATA_DIR,'models','pp-ocrv5-mobile-rec');
    const args=[path.join(REPO_ROOT,'workers','track','track','blocking_sequence.py'),sourcePath(project),output,'--config',config];
    if(options.ocrFrames?.length) {
      try {await fs.access(path.join(model,'inference.onnx'));args.push('--ocr-model',model);} catch {/* contours work without OCR */}
    }
    const local=path.join(REPO_ROOT,'workers','track','.venv-blocking',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const python=process.env.MLM_BLOCKING_PYTHON??await fs.access(local).then(()=>local,()=> 'python');
    const worker=run(python,args,{windowsHide:true,timeout:180_000,signal});
    let tail='';
    worker.child.stdout?.on('data',(chunk:string)=>{
      const lines=(tail+chunk).split(/\r?\n/);
      tail=lines.pop()??'';
      for(const line of lines) {
        const match=/^PROGRESS (\d+)\/(\d+)$/.exec(line);
        if(match) onProgress?.(Number(match[1])/Number(match[2]));
      }
    });
    await worker;
    const sequence=JSON.parse(await fs.readFile(output,'utf8')) as Sequence;
    if(sequence.frames<to||Math.abs(sequence.fps-video.fps)>1e-6) throw new Error('計測したフレーム数またはフレームレートが元動画と一致しません');
    return sequence;
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
}

/** Keep subpixel error bounded at the observed frames while removing redundant coordinates. */
function fit(samples:Sample[],fps:number,read:(box:Box)=>number):Track {
  const keys=samples.map(sample=>({t:sample.frame/fps,v:read(sample.box)}));
  if(keys.every(key=>key.v===keys[0].v)) return keys[0].v;
  const kept=new Set([0,keys.length-1]);
  const spans=[[0,keys.length-1]];
  while(spans.length) {
    const [left,right]=spans.pop()!;
    let split=-1,maximum=.3;
    for(let i=left+1;i<right;i++) {
      const ratio=(keys[i].t-keys[left].t)/(keys[right].t-keys[left].t);
      const error=Math.abs(keys[i].v-(keys[left].v+ratio*(keys[right].v-keys[left].v)));
      if(error>maximum) { split=i; maximum=error; }
    }
    if(split>=0) { kept.add(split); spans.push([left,split],[split,right]); }
  }
  return {keys:keys.filter((_,index)=>kept.has(index))};
}

export function sequenceDesign(project:ProjectMeta, base:Scene, measured:Sequence,
  options:SequenceOptions={}, namespace=randomUUID().slice(0,8)) {
  const source=project.source!;
  const fps=source.fps;
  const from=(options.from??0)/fps,to=Math.min(source.duration,(options.to??measured.frames)/fps);
  const elements:SceneElement[]=[];
  const items:Blocking['blocks']['items']=[],appearance:Blocking['appearance']=[];
  const observations:Record<string,unknown>={};
  const time=(sample:Sample)=>sample.frame/fps;
  for(const {id,samples} of measured.tracks) {
    if(!samples.length) continue;
    const blockId=`track:${namespace}:${id}`, childId=`${blockId}:outline`;
    const life={inPoint:time(samples[0]),outPoint:Math.min(to,(samples.at(-1)!.frame+1)/fps)};
    const candidate=samples.filter(sample=>sample.ocr?.text).sort((a,b)=>(b.ocr!.confidence??0)-(a.ocr!.confidence??0))[0]?.ocr;
    const label=candidate&&candidate.confidence!==null&&candidate.confidence>=.9 ? `${candidate.text}（OCR候補）` : `ブロック ${id}`;
    const color=colors[(id-1)%colors.length];
    const form:Blocking['appearance'][number]={blockId,childIds:[childId],contours:samples.map(sample=>({t:time(sample),luma:sample.ink,paths:sample.paths}))};
    const observationId=`contour:${namespace}:${id}`;
    observations[observationId]={id:observationId,kind:'block-contour',origin:'measured',sourceSha256:source.sha256,sourceRevision:project.revision,
      method:'OpenCV / connected outlines and adjacent-frame assignment',version:measured.opencv,inputs:options,
      samples:samples.map(({frame,box,ocr})=>({frame,t:frame/fps,box,ocr}))};
    elements.push(
      {id:blockId,name:label,type:'group',...life,transform:{x:fit(samples,fps,([x,,w])=>x+w/2),y:fit(samples,fps,([,y,,h])=>y+h/2)}},
      {id:childId,name:`${label} の輪郭`,parentId:blockId,type:'rect',fill:'none',...life},
    );
    const hiddenDuring=samples.flatMap((sample,i)=>i&&sample.frame-samples[i-1].frame>1?[{from:(samples[i-1].frame+1)/fps,to:time(sample)}]:[]);
    items.push({id:blockId,label,color,extent:{cx:0,cy:0,width:fit(samples,fps,box=>box[2]),height:fit(samples,fps,box=>box[3])},observationIds:[observationId],hiddenDuring});
    appearance.push(form);
  }
  if(!items.length) throw new HttpError(422,'指定範囲に追跡できる輪郭がありません');
  const start=options.from??0,end=options.to??measured.frames;
  const luminance=measured.backgrounds.slice(start,end);
  const backgroundLoss=luminance.map((v,i)=>({t:(start+i)/fps,v,ease:'hold' as const})).filter((sample,i,all)=>i===0||sample.v!==all[i-1].v);
  const identity=(frame:number)=>`polarity:${namespace}:${frame}`;
  const events:Blocking['events']=luminance.flatMap((value,i)=>{
    if(!i||(value>=128)===(luminance[i-1]>=128)) return [];
    const frame=start+i,id=identity(frame);
    observations[id]={id,kind:'background-polarity',frame,t:frame/fps,luma:value,sourceSha256:source.sha256};
    return [{id,kind:'invert',t:frame/fps,label:value>=128?'黒から白へ反転':'白から黒へ反転',inputs:[],outputs:[],observationIds:[id],status:'proposed'}];
  });
  for(const camera of measured.cameraCandidates) {
    const id=`camera:${namespace}:${camera.frame}`;
    observations[id]={id,kind:'camera-candidate',sourceSha256:source.sha256,t:camera.frame/fps,...camera};
  }
  const scene:Scene={...base,width:source.width,height:source.height,fps,duration:source.duration,elements};
  const design=BlockingSchema.parse({blocks:{from,to,sourceSha256:source.sha256,measuredTo:to,backgroundLuma:{keys:backgroundLoss},items},events,appearance});
  validateBlocking(scene,design);
  return {scene,design,observations};
}
