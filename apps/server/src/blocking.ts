import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { BlockingSchema, blockingFrame, validateBlocking } from '@mlm/core';
import { getDocuments, getProject, HttpError, projectDir } from './store.ts';
import { sourcePath } from './media.ts';
import { exportVideo, runFfmpeg } from './export.ts';

export function getBlocking(id:string) {
  const snapshot=getProject(id);
  const documents=getDocuments(id);
  if(!documents.blocks) return { ...snapshot,design:null };
  const design=BlockingSchema.parse(documents);
  if(design.blocks.sourceSha256!==snapshot.project.source?.sha256) throw new HttpError(409,'ブロックの元動画が現在の素材と一致しません');
  try {validateBlocking(snapshot.scene,design);} catch(error) {throw new HttpError(422,String(error));}
  return {...snapshot,design};
}

export async function exportBlocking(id:string, cellWidth=960,signal?:AbortSignal,onProgress?:(value:number)=>void) {
  const {project,scene,design}=getBlocking(id);
  if(!project.source||!design) throw new HttpError(400,'ブロック比較のあるプロジェクトを指定してください');
  const {fps,frameRate}=project.source;
  const startFrame=Math.round(design.blocks.from*fps),endFrame=Math.round(design.blocks.to*fps);
  const from=startFrame/fps,to=endFrame/fps;
  // ffprobe reports durations rounded to microseconds, including exact frame endpoints.
  if(endFrame<=startFrame||Math.abs(from-design.blocks.from)>1e-6||Math.abs(to-design.blocks.to)>1e-6) throw new HttpError(422,'比較範囲は元動画のフレーム境界で指定してください');
  const width=Math.round(cellWidth/2)*2;
  const height=Math.round(width*scene.height/scene.width/2)*2;
  const band=40;
  const frameCount=endFrame-startFrame;
  const dir=path.join(projectDir(id),'exports');
  fs.mkdirSync(dir,{recursive:true});
  const token=randomUUID(),fileName=`blocking_r${project.revision}_${token}.mp4`;
  const output=path.join(dir,fileName);
  const temp=(suffix:string)=>path.join(dir,`.tmp_blocking_${token}_${suffix}`);
  const header=temp('header.png'),source=temp('source.mp4'),grid=temp('grid.mp4'),mux=temp('mux.mp4');
  const cleanup=[header,source,grid,mux];
  const src=sourcePath(project);
  const encode=['-frames:v',String(frameCount),'-c:v','libx264','-pix_fmt','yuv420p','-r',frameRate];
  try {
    const clips=[source];
    await runFfmpeg(['-v','error','-i',src,'-map','0:v:0','-vf',`fps=${frameRate},trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1`,'-an',...encode,'-crf','15',source],undefined,signal);
    onProgress?.(1/6);
    for(const view of ['motion','events','final'] as const) {
      const clip=await exportVideo(project,scene,{from,to,width,layout:'render',withAudio:false,outputTag:`${token}-${view}`,signal,sceneAt:t=>blockingFrame(scene,design,t,view)});
      clips.push(clip.path);
      cleanup.push(clip.path);
      onProgress?.(clips.length/6);
    }
    const canvas=createCanvas(width*2,(height+band)*2);
    const ctx=canvas.getContext('2d');
    ['入力 / 元動画','中間① / 動き','中間② / 関係と時刻','最終調整 / 文字を載せた版'].forEach((label,i)=>{
      const x=(i%2)*width,y=Math.floor(i/2)*(height+band);
      ctx.fillStyle='#172338';ctx.fillRect(x,y,width,band);
      ctx.fillStyle='#f8fafc';ctx.textBaseline='middle';ctx.font='20px "MLM Yu Gothic", sans-serif';ctx.fillText(label,x+17,y+band/2);
    });
    fs.writeFileSync(header,await canvas.encode('png'));
    const filters=clips.map((_,i)=>`[${i}:v]setsar=1,pad=${width}:${height+band}:0:${band}[p${i}]`).join(';');
    await runFfmpeg(['-v','error',...clips.flatMap(clip=>['-i',clip]),'-i',header,'-filter_complex_threads','1',
      '-filter_complex',`${filters};[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|${width}_0|0_${height+band}|${width}_${height+band}:shortest=1[g];[g][4:v]overlay[v]`,
      '-map','[v]','-an',...encode,'-crf','17',grid],undefined,signal);
    onProgress?.(5/6);
    if(project.source.hasAudio) {
      await runFfmpeg(['-v','error','-i',grid,'-i',src,'-filter_complex',`[1:a:0]atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS[a]`,
        '-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-movflags','+faststart',mux],undefined,signal);
      fs.renameSync(mux,output);
    } else fs.renameSync(grid,output);
    onProgress?.(1);
    return {path:output,fileName,url:`/api/projects/${id}/exports/${fileName}`,width:width*2,height:(height+band)*2,frameCount,frameRate,from,to,hasAudio:project.source.hasAudio,revision:project.revision};
  } finally {
    for(const file of cleanup) fs.rmSync(file,{force:true});
  }
}
