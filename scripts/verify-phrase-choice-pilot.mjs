import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene, fontSpec, sampleTrack} from '@mlm/core';
import {exportVideo} from '../apps/server/src/export.ts';
import {fonts} from '../apps/server/src/fonts.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {getProject, listProjects} from '../apps/server/src/store.ts';

const [targetId, output, boundaryPath] = process.argv.slice(2);
assert.ok(targetId && output && boundaryPath, 'Supply the synthetic audio project ID, output folder and boundary comparison');
const boundary = JSON.parse(await readFile(boundaryPath,'utf8')).summary;
const dir = path.resolve(output);
await mkdir(dir,{recursive:true});
const {project:target} = getProject(targetId);
const fps = target.source?.fps;
assert.ok(target.source?.hasAudio && fps===24 && target.source.duration>=5);
const font = fonts.find(entry => entry.family==='MLM BIZ UD Gothic' && entry.weight===700);
assert.ok(font, 'The pilot uses the installed BIZ UD Gothic (700)');
const frameCount=120;
const lines=[
  {text:'風がほどける',from:0,to:30,width:.26,planning:[{frame:4,role:'introduce'},{frame:22,role:'yield'}]},
  {text:'夜を越えて',from:30,to:59,width:.69,planning:[{frame:46,role:'neutral'}]},
  {text:'遠くへ',from:59,to:89,width:.37,planning:[{frame:63,role:'introduce'},{frame:81,role:'neutral'}]},
  {text:'朝を迎える',from:89,to:120,width:.74,planning:[{frame:107,role:'yield'}]},
];
const variants=[
  {label:'A',mode:'width'},
  {label:'B',mode:'planned-step'},
  {label:'C',mode:'maintain'},
  {label:'D',mode:'planned-eased'},
];
const sceneBase={...emptyScene(),width:960,height:540,duration:frameCount/fps,fps,background:'#ede9df'};
const camera=createCanvas(1,1).getContext('2d');
const choose=(mode, role, width, nextWithinWindow)=>{
  if(mode==='width') return width>=.50?'shrink':width<=.25?'grow':'maintain';
  if(mode==='maintain') return 'maintain';
  if(role==='introduce') return 'grow';
  return role==='yield'&&nextWithinWindow?'shrink':'maintain';
};
const registry=listProjects();
const exportRows=[];
for(const {label,mode} of variants) {
  const decisions=[];
  const elements=lines.flatMap((line,index)=>{
    const next=lines[index+1];
    const id=`line:${index+1}`;
    const inPoint=line.from/fps;
    const outPoint=line.to/fps;
    const child={id:`${id}:text`,name:line.text,type:'text',parentId:id,inPoint,outPoint,
      fontFamily:font.family,fontWeight:font.weight,fontSize:100,fill:'#242723',text:line.text,transform:{x:0,y:0}};
    camera.font=fontSpec(child);
    const designWidth=camera.measureText(child.text).width/sceneBase.width;
    const sizeToScale=width=>width/designWidth;
    let width=line.width;
    const keys=[{t:inPoint,v:sizeToScale(width),ease:'hold'}];
    for(const spec of line.planning) {
      const framesToNext=next?next.from-spec.frame:null;
      const nextWithinWindow=framesToNext!==null && framesToNext<=Math.round(.33*fps);
      const choice=choose(mode,spec.role,width,nextWithinWindow);
      const newWidth=choice==='shrink'?width*.42:choice==='grow'?Math.min(.84,width*1.65):width;
      const entry={line:index+1,frame:spec.frame,role:spec.role,framesToNext,choice,widthBefore:width,widthAfter:newWidth};
      decisions.push(entry);
      if(newWidth===width) continue;
      const rapid=mode!=='planned-eased';
      const end=spec.frame+(rapid?1:6);
      assert.ok(end<line.to);
      assert.ok(keys.at(-1).t<spec.frame/fps);
      keys.push({t:spec.frame/fps,v:sizeToScale(width),ease:rapid?'hold':'easeInOut'},
        {t:end/fps,v:sizeToScale(newWidth),ease:'hold'});
      entry.settledFrame=end;
      width=newWidth;
    }
    const scale=keys.length===1?keys[0].v:{keys};
    for(const decision of decisions.filter(item=>item.line===index+1)) {
      assert.ok(Math.abs(sampleTrack(scale,decision.frame/fps,1)*designWidth-decision.widthBefore)<1e-10);
      if(decision.settledFrame!==undefined) {
        assert.ok(Math.abs(sampleTrack(scale,decision.settledFrame/fps,1)*designWidth-decision.widthAfter)<1e-10);
        if(mode==='planned-eased') {
          const first=sampleTrack(scale,(decision.frame+1)/fps,1)*designWidth;
          assert.ok(Math.min(decision.widthBefore,decision.widthAfter)<first && first<Math.max(decision.widthBefore,decision.widthAfter));
        }
      }
    }
    return [{id,type:'group',name:line.text,inPoint,outPoint,
      transform:{x:sceneBase.width/2,y:sceneBase.height*.55,scaleX:scale,scaleY:scale}},child];
  });
  const scene={...sceneBase,elements};
  const name=`語の大きさを選ぶ試作 ${label}`;
  const existing=registry.find(project=>project.name===name&&project.source?.sha256===target.source.sha256);
  const saved=existing&&isDeepStrictEqual(getProject(existing.id).scene,scene)?getProject(existing.id):
    saveGeneratedProject(name,scene,targetId,'phrase-choice-pilot',{adaptation:{kind:'phrase-choice-pilot',mode,
      decisions,input:{targetId,targetRevision:target.revision,sourceSha256:target.source.sha256},planning:lines}});
  const movie=await exportVideo(saved.project,saved.scene,{from:0,to:5,width:640,layout:'render',withAudio:true,outputTag:'phrase-choice'});
  assert.equal(movie.frameCount,frameCount);
  const file=`version-${label}.mp4`;
  await copyFile(movie.path,path.join(dir,file));
  exportRows.push({label,mode,file,decisions,projectId:saved.project.id,revision:saved.project.revision});
}
const byMode=Object.fromEntries(exportRows.map(row=>[row.mode,row]));
const picks=mode=>byMode[mode].decisions.map(({choice})=>choice);
assert.deepEqual(picks('planned-step'),['grow','shrink','maintain','grow','maintain','maintain']);
assert.deepEqual(picks('planned-step'),picks('planned-eased'));
assert.deepEqual(picks('maintain'),Array(6).fill('maintain'));
const comparison=path.join(dir,'comparison.mp4');
execFileSync('ffmpeg',['-v','error','-y',...exportRows.flatMap(item=>['-i',path.join(dir,item.file)]),
  '-filter_complex_threads','1','-filter_complex','[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]',
  '-map','[v]','-map','0:a:0','-frames:v',String(frameCount),'-c:a','copy','-c:v','libx264','-pix_fmt','yuv420p',comparison]);
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',comparison],{encoding:'utf8'}));
const video=probe.streams.find(stream=>stream.codec_type==='video');
assert.deepEqual([video.width,video.height,Number(video.nb_read_frames)],[1280,720,frameCount]);
assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
await writeFile(path.join(dir,'report.json'),JSON.stringify({targetId,targetRevision:target.revision,sourceSha256:target.source.sha256,
  planning:lines,verified:{frameCount,fps,width:video.width,height:video.height},boundary,variants:exportRows},null,2));
console.log(comparison,exportRows.map(({label,projectId})=>({label,projectId})));
