import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {emptyScene,evaluateScene,fontSpec,isActive,resolveTime,sampleTrack,worldMatrixOf} from '@mlm/core';
import {getBlocking} from '../apps/server/src/blocking.ts';
import {probe,sourcePath} from '../apps/server/src/media.ts';
import {checkScene,getDocuments,REPO_ROOT} from '../apps/server/src/store.ts';
import {publishPassage} from './passage-review.mjs';

const [modelId,measurementId,output]=process.argv.slice(2);
if(!modelId||!measurementId||!output) throw new Error('Supply the edited and measured Lyricsample1 projects and output folder');
const {project,scene,design}=getBlocking(modelId);
const measured=getBlocking(measurementId);
const {observations}=getDocuments(measurementId);
assert.equal(project.source.sha256,measured.project.source.sha256);
const {fps,width,height}=project.source,dir=path.resolve(output),actor='passage-verification';
const track=n=>`track:lyrics:${n}`;
const frameOf=(value,fallback)=>Math.round(resolveTime(value??fallback,scene.tempo)*fps);
const byId=new Map(scene.elements.map(e=>[e.id,e]));
const selectedShapes=(blockId,text,fill)=>{
  const binding=design.appearance.find(b=>b.blockId===blockId);
  assert.ok(binding&&!binding.contours?.length);
  return binding.childIds.map(id=>({id,text,fill}));
};
const frameSlice=(element,first,end)=>{
  const from=Math.max(first,frameOf(element.inPoint,0)),to=Math.min(end,frameOf(element.outPoint,scene.duration));
  if(from>=to) return undefined;
  const t=frame=>(frame-first)/fps;
  const transform=Object.fromEntries(Object.entries(element.transform??{}).map(([key,value])=>{
    if(typeof value==='number') return [key,value];
    assert.ok(!value.repeat&&value.keys.every(item=>typeof item.t==='number'));
    const lower=t(from)+first/fps,upper=t(to-1)+first/fps;
    const keys=value.keys.filter(item=>item.t>=lower-1e-8&&item.t<=upper+1e-8).map(item=>({...item,t:item.t-first/fps}));
    for(const frame of [from,to-1]) if(!keys.some(item=>Math.abs(item.t-t(frame))<1e-8)) {
      keys.push({t:t(frame),v:sampleTrack(value,frame/fps,0,scene.tempo)});
    }
    const clipped={keys:keys.sort((a,b)=>a.t-b.t)};
    for(let frame=from;frame<to;frame++) {
      if(Math.abs(sampleTrack(clipped,t(frame),0)-sampleTrack(value,frame/fps,0,scene.tempo))>1e-8) {
        return [key,{keys:Array.from({length:to-from},(_,i)=>({t:t(from+i),v:sampleTrack(value,(from+i)/fps,0,scene.tempo)}))}];
      }
    }
    return [key,clipped];
  }));
  return {...element,inPoint:t(from),outPoint:t(to),transform};
};
const ctx=createCanvas(1,1).getContext('2d');
const letter=(shape,text)=>{
  const {width,height,outline,vector,transform,...rest}=shape;
  const el={...rest,type:'text',text,fontSize:100,fontFamily:'MLM Yu Gothic',fontWeight:700};
  ctx.font=fontSpec(el);ctx.textAlign='center';ctx.textBaseline='middle';
  const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=ctx.measureText(text);
  assert.ok(l+r>0&&a+b>0);
  // Appearance fitting is one local transform. The animated source transform lives on its parent.
  const sx=width/(l+r),sy=height/(a+b);
  return {...el,transform:{x:(l-r)*sx/2,y:(a-b)*sy/2,scaleX:sx,scaleY:sy}};
};
const fromSelected=(selection,first,end)=>{
  const groups=new Map(),leaves=[];
  for(const {id,text,fill} of selection) {
    const source=byId.get(id);
    assert.ok(source&&source.type==='rect'&&source.parentId);
    const visible=frameSlice(source,first,end);
    if(!visible) continue;
    for(let node=byId.get(source.parentId);node;node=byId.get(node.parentId)) {
      assert.equal(node.type,'group');
      if(!groups.has(node.id)) groups.set(node.id,frameSlice(node,first,end));
    }
    const {outline,vector,transform,...appearance}=visible;
    const anchor=`${id}:appearance`;
    groups.set(anchor,{id:anchor,name:text??source.name,type:'group',parentId:visible.parentId,
      inPoint:visible.inPoint,outPoint:visible.outPoint,transform});
    const shape={...appearance,parentId:anchor,fill:fill??appearance.fill};
    leaves.push({shape,text,sourceId:id});
  }
  return {groups:[...groups.values()],leaves};
};
const worker=path.join(REPO_ROOT,'workers','track');
const python=process.env.MLM_TRACK_PYTHON??path.join(worker,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const run=(name,...args)=>JSON.parse(execFileSync(python,[path.join(worker,'track',name),...args],{encoding:'utf8',windowsHide:true}));
const strokeFirst=27,strokeEnd=42;
const strokeBoxes=observations['contour:lyrics:21'].samples.filter(s=>s.frame>=strokeFirst&&s.frame<strokeEnd).map(({frame,box})=>[frame,box]);
assert.equal(strokeBoxes.length,strokeEnd-strokeFirst);
const strokes=run('horizontal_stroke.py',sourcePath(project),JSON.stringify(strokeBoxes));
const strokeScene=fromSelected(selectedShapes(track(20),'日'),strokeFirst,strokeEnd);
const trackRows=(samples,fields)=>{
  const tolerances=Object.fromEntries(fields.map(key=>[key,1]));
  const {eased}=run('motion_vocabulary_fit.py',JSON.stringify([samples,tolerances,Object.fromEntries(fields.map(key=>[key,[]]))]));
  return Object.fromEntries(fields.map(key=>[key,{keys:eased.tracks[key].map(k=>({t:k.t,v:k.value,ease:k.easing}))}]));
};
const origin=strokes.map(({frame,bar,stem})=>({t:(frame-strokeFirst)/fps,x:stem[0]+stem[2]/2,y:bar[1]+bar[3]/2}));
const life={inPoint:0,outPoint:(strokeEnd-strokeFirst)/fps};
strokeScene.groups.push({id:'stroke-anchor',name:'横線と縦の支点',type:'group',...life,transform:trackRows(origin,['x','y'])});
for(const segment of ['bar','stem']) {
  const rows=strokes.map((row,i)=>{
    const [x,y,w,h]=row[segment];
    return {t:origin[i].t,x:x+w/2-origin[i].x,y:y+h/2-origin[i].y,scaleX:w/100,scaleY:h/100};
  });
  // Fit local dimensions in pixels before converting to scale factors.
  const fit=trackRows(rows.map(({t,x,y,scaleX,scaleY})=>({t,x,y,w:scaleX*100,h:scaleY*100})),['x','y','w','h']);
  const scale=field=>({keys:fit[field].keys.map(k=>({...k,v:k.v/100}))});
  strokeScene.groups.push({id:`stroke:${segment}`,type:'group',parentId:'stroke-anchor',...life,
    transform:{x:fit.x,y:fit.y,scaleX:scale('w'),scaleY:scale('h')}});
  strokeScene.leaves.push({shape:{id:`stroke:${segment}:shape`,type:'rect',parentId:`stroke:${segment}`,width:100,height:100,fill:'#222222',...life}});
}
const strokeWidths=strokes.map(({frame,bar})=>({frame,width:bar[2]}));
assert.ok(Math.max(...strokeWidths.map(row=>row.width))>2*strokeWidths[0].width);
const rotation=design.blocks.items.find(b=>b.id.startsWith('rotation:'));
assert.ok(rotation);
const rotationShapes=selectedShapes(rotation.id).map((shape,i)=>({...shape,text:['ど','こ','へ'][i]}));
const sharedFirst=97,sharedEnd=104;
const commonScene=fromSelected([...selectedShapes(track(99),'木'),...selectedShapes(track(100),'陰')],sharedFirst,sharedEnd);
const displacement=[{t:0,x:0,y:0}];
for(let frame=sharedFirst+1;frame<sharedEnd;frame++) {
  const observation=observations[`camera:lyrics:${frame}`];
  assert.ok(observation.support>=3);
  const previous=displacement.at(-1);
  displacement.push({t:(frame-sharedFirst)/fps,x:previous.x+observation.movement[0],y:previous.y+observation.movement[1]});
}
const coordinates=axis=>({keys:displacement.map(row=>({t:row.t,v:row[axis]}))});
for(const element of commonScene.groups.filter(group=>!group.parentId)) {
  const local=axis=>({keys:displacement.map(row=>({t:row.t,v:sampleTrack(element.transform?.[axis],row.t,0)-row[axis]}))});
  Object.assign(element,{parentId:'shared-translation',transform:{...element.transform,x:local('x'),y:local('y')}});
}
commonScene.groups.unshift({id:'shared-translation',name:'共通移動',type:'group',inPoint:0,outPoint:(sharedEnd-sharedFirst)/fps,
  transform:{x:coordinates('x'),y:coordinates('y')}});
const cases=[
  {slug:'01-contact',first:10,end:27,title:'接触と分離',replacementLabel:'日・右・る',
    geometry:fromSelected([...selectedShapes(track(1),'右','#222222'),...selectedShapes(track(10),'日','#414141'),
      ...selectedShapes(track(5),'る'),...selectedShapes(track(11),'る')],10,27),
    cues:[{frame:15,label:'接触'},{frame:16,label:'分離'}],notes:'15Fの田は既存の3点による推定を利用。2部品は別IDのまま。元のルビは省略。'},
  {slug:'02-rotation',first:150,end:160,title:'3文字の共通回転',replacementLabel:'何にも → どこへ',
    geometry:fromSelected(rotationShapes,150,160),cues:[{frame:150,label:'反転と共通回転の開始'}],
    notes:'3文字の子を共通の回転親に固定。画面上部の細線は省略。'},
  {slug:'03-stroke',first:strokeFirst,end:strokeEnd,title:'横線の伸びと引き戻し',replacementLabel:'田 → 日・横線は独立',
    geometry:strokeScene,cues:[{frame:27,label:'切り替え'}],notes:'元動画の横線を長い連続画素として直接計測。縦線の鉤・粒子・ルビは簡略化。',strokeWidths},
  {slug:'04-sequence',first:49,end:60,title:'順次出現と落ち着き',replacementLabel:'田んぼの田 → 春風そよぐ',
    geometry:fromSelected([20,21,58,57,61].flatMap((id,i)=>selectedShapes(track(id),['春','風','そ','よ','ぐ'][i])),49,60),
    cues:[{frame:55,label:'2字が加わる'},{frame:56,label:'最後の字が加わる'}],
    notes:'元の先行2字の表示と、55Fに2字、56Fに最後の字が増える順番を維持。文字ごとの登場を等間隔にしていない。'},
  {slug:'05-common',first:sharedFirst,end:sharedEnd,title:'共通移動と各部の揺れ',replacementLabel:'食・反 → 木・陰',
    geometry:commonScene,cues:[{frame:sharedFirst,label:'共通移動の区間'}],
    notes:'観察した共通の移動を親に置き、各部の残差を子に保存。実際のカメラかどうかは判定しない。背景・ルビは簡略化。',
    commonDisplacement:displacement.at(-1)},
];
const casesOut=[];
for(const variant of cases) {
  const {slug,first,end,title,replacementLabel,geometry,cues,notes}=variant;
  const number=frame=>(frame-first)/fps;
  const luma=Math.round(sampleTrack(design.blocks.backgroundLuma,first/fps,232));
  const background=`#${luma.toString(16).padStart(2,'0').repeat(3)}`;
  const shared={...emptyScene(),width,height,fps,duration:number(end),background,
    markers:cues.map(cue=>({t:number(cue.frame),kind:'note',origin:'measured',label:`${cue.frame}F ${cue.label}`}))};
  const blocks=checkScene({...shared,elements:[...geometry.groups,...geometry.leaves.map(({shape})=>shape)]});
  const replacement=checkScene({...shared,elements:[...geometry.groups,...geometry.leaves.map(({shape,text})=>text?letter(shape,text):shape)]});
  let transformError=0;
  for(let frame=first;frame<end;frame++) {
    const t=number(frame);
    const visible=view=>evaluateScene(view,t).map(entry=>entry.element.id);
    assert.deepEqual(visible(blocks),visible(replacement));
    for(const {shape,sourceId} of geometry.leaves) {
      if(!isActive(shape,blocks,t)) continue;
      const matrix=worldMatrixOf(blocks,shape.id,t);
      assert.deepEqual(worldMatrixOf(blocks,shape.parentId,t),worldMatrixOf(replacement,shape.parentId,t));
      if(!sourceId) continue;
      const source=worldMatrixOf(scene,sourceId,frame/fps);
      transformError=Math.max(transformError,...source.map((v,i)=>Math.abs(matrix[i]-v)));
    }
  }
  assert.ok(transformError<1e-6);
  const folder=path.join(dir,slug);
  const provenance={sourceProjectId:modelId,sourceRevision:project.revision,sourceSha256:project.source.sha256,frameRange:[first,end],cues,notes};
  const published=await publishPassage({dir:folder,project,first,end,actor,title:`Lyricsample1 · ${title}`,blocks,replacement,replacementLabel,
    documents:{observations:{passage:{...provenance,kind:'motion-passage',origin:'measured'}},adaptation:{kind:'motion-passage',...provenance}}});
  const detail={slug,title,frameRange:[first,end],notes,cues,sourceModelMaxMatrixError:transformError,...published};
  if(variant.strokeWidths) {
    detail.strokeWidths=variant.strokeWidths;
    detail.strokeMaxWidthErrorPx=Math.max(...strokes.map(({frame,bar})=>Math.abs(worldMatrixOf(blocks,'stroke:bar',number(frame))[0]*100-bar[2])));
    assert.ok(detail.strokeMaxWidthErrorPx<=1.01);
  }
  if(slug==='02-rotation') detail.clockwiseDegrees=sampleTrack(scene.elements.find(el=>el.id===rotation.id).transform.rotation,(end-1)/fps,0);
  if(variant.commonDisplacement) detail.commonDisplacement=variant.commonDisplacement;
  await writeFile(path.join(folder,'report.json'),JSON.stringify(detail,null,2));
  casesOut.push(detail);
}
const reel='comparison-reel-half-speed.mp4';
const media=casesOut.flatMap(({slug})=>['-i',path.join(dir,slug,'comparison-half-speed.mp4')]);
const scaledAudio=casesOut.map(({frames},i)=>`[${i}:a]apad,atrim=duration=${2*frames/fps}[a${i}]`).join(';');
const pairs=casesOut.map((_,i)=>`[${i}:v][a${i}]`).join('');
execFileSync(process.env.MLM_FFMPEG??'ffmpeg',['-v','error','-y',...media,'-filter_complex_threads','1','-filter_complex',
  `${scaledAudio};${pairs}concat=n=${casesOut.length}:v=1:a=1[v][a]`,'-map','[v]','-map','[a]',
  '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path.join(dir,reel)]);
const reelMedia=await probe(path.join(dir,reel),reel);
assert.equal(reelMedia.frameCount,2*casesOut.reduce((sum,entry)=>sum+entry.frames,0));
const summary={modelId,sourceRevision:project.revision,measurementId,measurementRevision:measured.project.revision,sourceSha256:project.source.sha256,
  reel,reelFrames:reelMedia.frameCount,cases:casesOut};
await writeFile(path.join(dir,'report.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
