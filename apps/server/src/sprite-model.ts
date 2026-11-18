import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {ElementSchema, validateBlocking} from '@mlm/core';
import type {Blocking, ProjectMeta, Scene, SceneElement, Track, Transform} from '@mlm/core';
import {z} from 'zod';
import {sourcePath} from './media.ts';
import {HttpError, projectDir, REPO_ROOT} from './store.ts';

const run=promisify(execFile);
const fields=['x','y','scaleX','scaleY','shearX','rotation','opacity'] as const;
type Property=typeof fields[number];
const shape=ElementSchema.pick({vector:true,fill:true,width:true,height:true}).required();
const keys=z.object({t:z.number(),value:z.number(),easing:z.union([z.literal('linear'),z.object({cubic:z.tuple([z.number(),z.number(),z.number(),z.number()])})])});
const layer=shape.extend({cx:z.number(),cy:z.number(),fit:z.object({tracks:z.record(z.enum(fields),z.array(keys).min(1)),maxSampleError:z.record(z.enum(fields),z.number())}),
  samples:z.array(z.record(z.string(),z.number()))});
const resultSchema=z.object({layers:z.array(layer).min(1),background:z.string(),seconds:z.number(),peakCudaBytes:z.number()});

export async function spriteModel(project:ProjectMeta, scene:Scene, options:{from:number;to:number;region:[number,number,number,number]}, signal:AbortSignal) {
  const video=project.source;
  if(!video||video.variableFrameRate) throw new HttpError(422,'Fast Spriteの計測には固定フレームレートの元動画が必要です');
  const {from,to,region}=options;
  if(to-from<2||to-from>48||to>Math.round(video.duration*video.fps)) throw new HttpError(422,'Fast Spriteの区間を2〜48フレームで指定してください');
  const [x,y,w,h]=region;
  if(x+w>video.width||y+h>video.height) throw new HttpError(422,'開始フレームの範囲が映像の外です');
  const external=path.join(REPO_ROOT,'external');
  const executable=process.platform==='win32'?'Scripts/python.exe':'bin/python';
  const fsd=process.env.MLM_FSD_PYTHON??path.join(external,'sprite-decompose','.venv',executable);
  const vtracer=process.env.MLM_VTRACER_PYTHON??path.join(external,'vtracer','.venv',executable);
  try {await Promise.all([fs.access(fsd),fs.access(vtracer)]);} catch {throw new HttpError(422,'Fast SpriteとVTracerの専用環境を確認してください');}
  const dir=await fs.mkdtemp(path.join(projectDir(project.id),'cache','sprite-'));
  try {
    const input=path.join(dir,'parameters.json'),output=path.join(dir,'model.json');
    await fs.writeFile(input,JSON.stringify({...options,fps:video.fps}));
    const worker=path.join(REPO_ROOT,'workers','track','track','sprite_sequence.py');
    const env={...process.env,OMP_NUM_THREADS:'2',TORCH_HOME:path.join(external,'sprite-decompose','torch-cache')};
    try {await run(fsd,[worker,sourcePath(project),input,output,vtracer],{env,windowsHide:true,signal,timeout:300_000});}
    catch(error) {throw new HttpError(422,'Fast Spriteのモデル生成に失敗しました',String(error).slice(-5000));}
    const result=resultSchema.parse(JSON.parse(await fs.readFile(output,'utf8')));
    const bounds={from:from/video.fps,to:to/video.fps};
    const life={inPoint:bounds.from,outPoint:bounds.to};
    const elements:SceneElement[]=[];
    const items:Blocking['blocks']['items']=[],appearance:Blocking['appearance']=[];
    const observations:Record<string,unknown>={};
    for(const [i,sprite] of result.layers.entries()) {
      const id=`sprite:${i+1}`,childId=`${id}:shape`,label=`代表形 ${i+1}`;
      const getTrack=(field:Property):Track=>{
        const points=sprite.fit.tracks[field];
        return points.every(k=>k.value===points[0].value)?points[0].value:
          {keys:points.map(k=>({t:k.t,v:k.value,ease:k.easing}))};
      };
      const geometry=Object.fromEntries(fields.filter(key=>key!=='opacity').map(key=>[key,getTrack(key)])) as Transform;
      const observationId=`${id}:fit`;
      observations[observationId]={id:observationId,kind:'sprite-fit',sourceSha256:video.sha256,sourceRevision:project.revision,method:'Fast Sprite + VTracer',
        options,peakCudaBytes:result.peakCudaBytes,seconds:result.seconds,samples:sprite.samples,maxSampleError:sprite.fit.maxSampleError};
      elements.push({id,type:'group',name:label,...life,transform:geometry},
        {id:childId,parentId:id,type:'rect',name:label,...life,width:sprite.width,height:sprite.height,fill:sprite.fill,vector:sprite.vector,
          transform:{x:sprite.cx,y:sprite.cy,opacity:getTrack('opacity')}});
      items.push({id,label,color:'#64c7e7',extent:{cx:sprite.cx,cy:sprite.cy,width:sprite.width,height:sprite.height},observationIds:[observationId]});
      appearance.push({blockId:id,childIds:[childId]});
    }
    const next:Scene={...scene,width:video.width,height:video.height,fps:video.fps,duration:video.duration,background:result.background,elements};
    const design:Blocking={blocks:{...bounds,sourceSha256:video.sha256,derived:true,items},appearance,
      events:[{id:'sprite:entry',kind:'appear',t:bounds.from,label:'代表形の表示開始',status:'proposed',inputs:[],
        outputs:items.map(item=>item.id),observationIds:Object.keys(observations)}]};
    validateBlocking(next,design);
    return {scene:next,design,observations};
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
