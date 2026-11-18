import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { commit, getProject, HttpError, projectDir } from './store.ts';
import { probe } from './media.ts';
const run=promisify(execFile);
export const MusicRequest=z.strictObject({baseRevision:z.number().int().positive(),actor:z.string().default('human'),path:z.string().min(1)});

/** Wrap audio in black video so existing source playback/export stays a single pipeline. */
export async function importMusic(id:string,input:z.infer<typeof MusicRequest>) {
  const {project,scene}=getProject(id);
  if(project.revision!==input.baseRevision) throw new HttpError(409,'最新のrevisionを読み直してください');
  const source=path.resolve(input.path);
  if(!fs.existsSync(source)||!fs.statSync(source).isFile()) throw new HttpError(400,'音声ファイルがありません');
  const name=`music-${randomUUID()}.mp4`,file=path.join(projectDir(id),'media',name);
  try {
    const info=await run(process.env.MLM_FFPROBE??'ffprobe',['-v','error','-show_format','-show_streams','-of','json',source],{windowsHide:true,timeout:15000});
    const metadata=JSON.parse(info.stdout);
    const seconds=Number(metadata.format?.duration);
    if(!metadata.streams?.some((s:{codec_type:string})=>s.codec_type==='audio')||!Number.isFinite(seconds)||seconds<=0||seconds>120) throw new HttpError(422,'初版は120秒以内の音声に対応します');
    const width=Math.round(scene.width/2)*2,height=Math.round(scene.height/2)*2;
    await run(process.env.MLM_FFMPEG??'ffmpeg',['-v','error','-f','lavfi','-i',`color=c=black:s=${width}x${height}:r=${scene.fps}`,'-i',source,'-map','0:v','-map','1:a:0','-t',String(seconds),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',file],{windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});
    const manifest=await probe(file,name);
    return commit(id,{baseRevision:input.baseRevision,actor:input.actor,note:`新曲を取り込み（黒背景の比較用動画）: ${path.basename(source)}`,meta:p=>{p.source=manifest;delete p.audioAnalysis;},
      scene:s=>({...s,duration:manifest.duration,markers:(s.markers??[]).filter(m=>m.kind!=='beat'&&m.kind!=='downbeat'&&m.kind!=='section')}),
      documents:({blocks:_blocks,events:_events,appearance:_appearance,...documents})=>documents});
  } catch(err) {
    fs.rmSync(file,{force:true});
    if(err instanceof HttpError) throw err;
    throw new HttpError(422,'音声の取り込みに失敗しました',String(err));
  }
}
