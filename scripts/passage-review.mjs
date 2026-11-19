import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,rm,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {exportVideo} from '../apps/server/src/export.ts';
import {mediaTarget,probe,sourcePath} from '../apps/server/src/media.ts';
import {commit,createProject,trashProject} from '../apps/server/src/store.ts';

export async function publishPassage({dir,project,first,end,actor,title,blocks,replacement,replacementLabel,documents}) {
  const {fps}=project.source;
  const duration=(end-first)/fps;
  await mkdir(dir,{recursive:true});
  const ff=(...args)=>execFileSync(process.env.MLM_FFMPEG??'ffmpeg',['-v','error','-y',...args]);
  const original=path.join(dir,'source.mp4');
  const scratch=await mkdtemp(path.join(dir,'.passage-'));
  const silent=path.join(scratch,'video.mp4'),muxed=path.join(scratch,'muxed.mp4'),overlay=path.join(scratch,'labels.png');
  const comparison=path.join(dir,'comparison.mp4');
  const outputs=[];
  let checked;
  try {
    ff('-i',sourcePath(project),'-vf',`trim=start_frame=${first}:end_frame=${end},setpts=PTS-STARTPTS`,'-an','-frames:v',String(end-first),
      '-c:v','libx264','-crf','14','-pix_fmt','yuv420p',silent);
    ff('-i',silent,'-i',sourcePath(project),'-af',`atrim=start=${first/fps}:end=${end/fps},asetpts=PTS-STARTPTS`,
      '-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k',muxed);
    await copyFile(muxed,original);
    for(const [label,scene,file] of [['ブロックで再現',blocks,'blocks.mp4'],[replacementLabel,replacement,'replacement.mp4']]) {
      const created=createProject(`${title} · ${label}`,scene,actor);
      try {
        const media=mediaTarget(created.project.id,original);
        await copyFile(original,media.file);
        const manifest=await probe(media.file,media.fileName);
        assert.equal(manifest.frameCount,end-first);
        const saved=commit(created.project.id,{baseRevision:created.project.revision,actor,note:'比較用シーンと出典を保存',
          meta:p=>{p.source=manifest;},documents:()=>({...documents,adaptation:{...documents.adaptation,replacement:file==='replacement.mp4'}})});
        const video=await exportVideo(saved.project,saved.scene,{from:0,to:duration,width:640,layout:'render',withAudio:false});
        assert.equal(video.frameCount,end-first);
        ff('-i',video.path,'-i',original,'-map','0:v','-map','1:a','-c','copy',muxed);
        assert.equal((await probe(muxed,file)).frameCount,end-first);
        await copyFile(muxed,path.join(dir,file));
        outputs.push({file,id:saved.project.id,revision:saved.project.revision});
      } catch(error) {trashProject(created.project.id,actor);throw error;}
    }
    const labels=createCanvas(1920,406),ctx=labels.getContext('2d');
    ctx.font='700 23px "MLM Yu Gothic"';ctx.textBaseline='middle';
    for(const [i,label] of ['元映像','ブロックで再現',replacementLabel].entries()) {
      ctx.fillStyle='#252832';ctx.fillRect(i*640,0,640,46);
      ctx.fillStyle='#f6f6f6';ctx.fillText(label,i*640+18,23);
    }
    await writeFile(overlay,await labels.encode('png'));
    ff('-i',original,'-i',path.join(dir,'blocks.mp4'),'-i',path.join(dir,'replacement.mp4'),'-i',overlay,
      '-filter_complex_threads','1','-filter_complex','[0:v]scale=640:360,setsar=1[src];[src][1:v][2:v]hstack=inputs=3:shortest=1[h];[h]pad=1920:406:0:46[p];[p][3:v]overlay[v]',
      '-map','[v]','-an','-c:v','libx264','-pix_fmt','yuv420p','-frames:v',String(end-first),silent);
    ff('-i',silent,'-i',original,'-map','0:v','-map','1:a','-c','copy',muxed);
    checked=await probe(muxed,'comparison.mp4');
    assert.equal(checked.frameCount,end-first);
    assert.ok(checked.hasAudio);
    await copyFile(muxed,comparison);
    ff('-i',comparison,'-vf',`setpts=2*PTS,fps=${fps},tpad=stop_mode=clone:stop_duration=1`,'-an','-frames:v',String(2*(end-first)),
      '-c:v','libx264','-pix_fmt','yuv420p',silent);
    ff('-i',silent,'-i',original,'-map','0:v','-map','1:a','-af','atempo=0.5','-c:v','copy','-c:a','aac',muxed);
    assert.equal((await probe(muxed,'comparison-half-speed.mp4')).frameCount,2*(end-first));
    await copyFile(muxed,path.join(dir,'comparison-half-speed.mp4'));
  } finally {
    await Promise.all([silent,muxed,overlay].map(file=>rm(file,{force:true})));
    await rmdir(scratch);
  }
  return {frames:checked.frameCount,outputs};
}
