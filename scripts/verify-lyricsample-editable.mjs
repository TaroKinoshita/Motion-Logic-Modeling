import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {blockingFrame,canvasMeasurer,evaluateScene,fontSpec,resolveTime,sampleTrack,validateBlocking,worldMatrixOf} from '@mlm/core';
import {exportBlocking,getBlocking} from '../apps/server/src/blocking.ts';
import {exportVideo} from '../apps/server/src/export.ts';
import {sourcePath} from '../apps/server/src/media.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {getDocuments,getProject,REPO_ROOT} from '../apps/server/src/store.ts';
import {editTiming,TimingRequest} from '../apps/server/src/timing.ts';

const [output,...selection]=process.argv.slice(2);
if(!output) throw new Error('Supply the full-corpus output folder and optional sample numbers');
const dir=path.resolve(output);
const actor='corpus-editable-review';
const context=createCanvas(1,1).getContext('2d');
const python=process.env.MLM_TRACK_PYTHON??path.join(REPO_ROOT,'workers','track','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const fitter=path.join(REPO_ROOT,'workers','track','track','motion_vocabulary_fit.py');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

// Source coordinates and IDs were checked against the displayed source frames.
const captionCases={
  2:[
    {span:[68,76],tracks:[121],text:'青',alternate:'風',fill:'#4e7478'},
    {span:[76,91],tracks:[121,136],text:'空',alternate:'音',fill:'#4e7478'},
    {span:[77,91],tracks:[137,138],text:'青',alternate:'風',fill:'#4e7478'},
  ],
  4:[
    {span:[104,139],tracks:[59,83],text:'ど',alternate:'こ',fill:'#cfaa62'},
    {span:[104,139],tracks:[80],text:'分',alternate:'伝',fill:'#5891a6'},
  ],
  5:[
    {span:[58,63],tracks:[115],text:'顔',alternate:'影',fill:'#ffffff'},
    {span:[58,63],tracks:[116],text:'が',alternate:'を',fill:'#ffffff'},
    {span:[139,148],tracks:[307],text:'嘲',alternate:'眺',fill:'#ffffff'},
    {span:[139,148],tracks:[309],text:'ら',alternate:'め',fill:'#ffffff'},
    {span:[139,148],tracks:[308],text:'れ',alternate:'た',fill:'#ffffff'},
  ],
  7:[
    {span:[26,35],tracks:[26],text:'先',alternate:'明',fill:'#f6f6f6',ruby:['Sen','Mei',30]},
    {span:[26,35],tracks:[27],text:'天',alternate:'日',fill:'#f6f6f6',ruby:['Ten','Nichi',31]},
    {span:[77,91],tracks:[82],text:'生',alternate:'星',fill:'#f6f6f6'},
    {span:[77,91],tracks:[78],text:'命',alternate:'光',fill:'#f6f6f6'},
    {span:[84,91],tracks:[81],text:'線',alternate:'路',fill:'#f6f6f6'},
    {span:[205,213],tracks:[184],text:'革',alternate:'新',fill:'#f6f6f6',ruby:['Kaku','Shin',185]},
    {span:[235,243],tracks:[212],text:'革',alternate:'新',fill:'#f6f6f6'},
    {span:[235,243],tracks:[204],text:'命',alternate:'章',fill:'#f6f6f6'},
    {span:[235,243],tracks:[206],text:'前',alternate:'開',fill:'#f6f6f6'},
    {span:[235,243],tracks:[211],text:'夜',alternate:'幕',fill:'#f6f6f6'},
  ],
};
const reviewedEvents={
  2:[[76,'appear','「空」が先に大きく現れる'],[77,'appear','大きい「青」が続く']],
  3:[[101,'cut','縦枠から横枠の「兵器」へ'],[110,'cut','縦枠の「に成る」へ']],
  4:[[104,'appear','先行する「ど」を残して「分」が入る'],[148,'cut','矢印で方向を示す次の構図へ']],
  5:[[58,'invert','白い文字の「顔が」に切り替わる'],[139,'appear','「嘲られ」の文字列が現れる']],
  6:[[129,'shape','「やめろよ」の全体が1コマで縮む'],[274,'shape','「回った」の全体が1コマで縮む']],
  7:[[30,'appear','横並びの大字とルビを確認'],[210,'appear','大字「革」とルビを確認'],[240,'appear','独立した4字の横組みを確認']],
};
const keyCount=scene=>scene.elements.reduce((total,el)=>total+
  Object.values(el.transform??{}).reduce((n,track)=>n+(typeof track==='number'?0:track.keys.length),0),0);
const probe=file=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type,nb_frames,avg_frame_rate',
  '-of','json',file],{encoding:'utf8',windowsHide:true})).streams;

function textLayer(text,width,height,fill,fit='stretch',weight=700,spacing=0) {
  const element={type:'text',text,fill,fontFamily:'MLM Yu Gothic',fontSize:100,fontWeight:weight,
    ...(spacing?{split:'char',letterSpacing:spacing}:{})};
  context.font=fontSpec(element);
  context.textAlign='center';context.textBaseline='middle';
  const {actualBoundingBoxLeft:l,actualBoundingBoxRight:r,actualBoundingBoxAscent:a,actualBoundingBoxDescent:b}=context.measureText(text);
  assert.ok(l+r>0&&a+b>0,text);
  const x=width/(l+r+spacing*([...(text.trim())].length-1)),y=height/(a+b);
  const scaleX=fit==='contain'?Math.min(x,y):x,scaleY=fit==='contain'?Math.min(x,y):y;
  return {...element,transform:{x:(l-r)*scaleX/2,y:(a-b)*scaleY/2,scaleX,scaleY}};
}

function fitBoxes(samples,fps,breaks,extent) {
  const fields={x:1.5,y:1.5,w:2,h:2},pinned={x:[],y:[],w:[],h:[]};
  const groups=[];
  for(const row of samples) {
    if(!groups.length||breaks.includes(row.frame)||row.frame>groups.at(-1).at(-1).frame+1) groups.push([]);
    groups.at(-1).push(row);
  }
  const fits=groups.map(group=>JSON.parse(execFileSync(python,[fitter,
    JSON.stringify([group.map(({frame,box:[x,y,w,h]})=>({t:frame/fps,x:x+w/2,y:y+h/2,w,h})),fields,pinned])],
    {windowsHide:true,encoding:'utf8'})).eased);
  const tracks={};
  for(const [field,property,unit] of [['x','x',1],['y','y',1],['w','scaleX',extent[0]],['h','scaleY',extent[1]]]) {
    const keys=fits.flatMap(({tracks},i)=>tracks[field].map(({t,value,easing},j,rows)=>({
      t,v:value/unit,ease:i<fits.length-1&&j===rows.length-1?'hold':easing,
    })));
    tracks[property]=keys.every(key=>key.v===keys[0].v)?keys[0].v:{keys};
  }
  return {tracks,groups,error:Object.fromEntries(Object.keys(fields).map(key=>[key,Math.max(...fits.map(f=>f.maxSampleError[key]))]))};
}

function hideExisting(scene,design,pick,from,to,originals) {
  const byId=new Map(scene.elements.map(element=>[element.id,element]));
  for(const block of originals.filter(pick)) {
    const group=byId.get(block.id);
    const start=Math.max(resolveTime(group.inPoint??0,scene.tempo),from);
    const end=Math.min(resolveTime(group.outPoint??scene.duration,scene.tempo),to);
    if(end<=start) continue;
    const intervals=[...(block.hiddenDuring??[]),{from:start,to:end}].sort((a,b)=>a.from-b.from);
    block.hiddenDuring=[];
    for(const next of intervals) {
      const last=block.hiddenDuring.at(-1);
      if(last&&next.from<=last.to+1e-9) last.to=Math.max(last.to,next.to);
      else block.hiddenDuring.push({...next});
    }
  }
}

function keepSceneVisibility(scene,design) {
  const byId=new Map(scene.elements.map(element=>[element.id,element]));
  const byBlock=new Map(design.blocks.items.map(block=>[block.id,block]));
  for(const binding of design.appearance) {
    const block=byBlock.get(binding.blockId);
    if(!block.hiddenDuring?.length) continue;
    const group=byId.get(block.id);
    const start=resolveTime(group.inPoint??0,scene.tempo),end=resolveTime(group.outPoint??scene.duration,scene.tempo);
    const keys=new Map([[start,1]]);
    for(const gap of block.hiddenDuring) {
      const from=Math.max(start,gap.from),to=Math.min(end,gap.to);
      if(from>=to) continue;
      keys.set(from,0);
      if(to<end) keys.set(to,1);
    }
    const opacity=keys.size===1?keys.get(start):
      {keys:[...keys].sort((a,b)=>a[0]-b[0]).map(([t,v])=>({t,v,ease:'hold'}))};
    for(const id of binding.childIds) {
      const child=byId.get(id);
      assert.equal(child.transform?.opacity,undefined);
      child.transform={...child.transform,opacity};
    }
  }
}

function union(rows) {
  const x=Math.min(...rows.map(row=>row[0])),y=Math.min(...rows.map(row=>row[1]));
  return [x,y,Math.max(...rows.map(row=>row[0]+row[2]))-x,Math.max(...rows.map(row=>row[1]+row[3]))-y];
}

function palette(project) {
  const w=48,h=28,bytes=w*h*3;
  const image=execFileSync('ffmpeg',['-v','error','-i',sourcePath(project),'-map','0:v:0',
    '-vf',`scale=${w}:${h}:flags=area`,'-pix_fmt','rgb24','-f','rawvideo','-'],{maxBuffer:10*1024*1024,windowsHide:true});
  const changes=[];
  for(let i=0;i<image.length/bytes;i++) {
    const start=i*bytes;
    const rgb=[0,1,2].map(channel=>{
      const values=[];
      for(let x=0;x<w;x++) for(const y of [0,1,h-2,h-1]) values.push(image[start+3*(y*w+x)+channel]);
      for(let y=2;y<h-2;y++) for(const x of [0,w-1]) values.push(image[start+3*(y*w+x)+channel]);
      values.sort((a,b)=>a-b);
      return values[Math.floor(values.length/2)];
    });
    if(!changes.length||rgb.some((v,c)=>Math.abs(v-changes.at(-1).rgb[c])>=7)) changes.push({i,rgb});
  }
  return changes.map(({i,rgb},n)=>({id:`corpus-background:${i}`,name:'背景色',type:'rect',width:project.source.width,height:project.source.height,
    zIndex:-10000,transform:{x:project.source.width/2,y:project.source.height/2},fill:'#'+rgb.map(value=>value.toString(16).padStart(2,'0')).join(''),
    inPoint:i/project.source.fps,outPoint:(changes[n+1]?.i??project.source.frameCount)/project.source.fps}));
}

async function applyReview(sample,analysis,model) {
  const {project,scene,design}=model;
  const {fps}=scene,originals=[...design.blocks.items],docs=getDocuments(project.id),marked={},substitutions=[];
  const head={sourceSha256:analysis.sourceSha256,sourceRevision:analysis.sourceRevision,sourceProjectId:analysis.sourceProjectId};
  if(sample===7) scene.background='#101010';
  else scene.elements.push(...palette(project));
  const newBinding=(group,child,width,height,evidence,hiddenDuring)=>{
    scene.elements.push(group,child);
    design.blocks.items.push({id:group.id,label:group.name,color:'#67c8de',extent:{cx:0,cy:0,width,height},
      observationIds:[evidence],hiddenDuring});
    design.appearance.push({blockId:group.id,childIds:[child.id]});
  };
  const raw=sample===3?null:getDocuments(analysis.rawProjectId).observations;
  if(sample===3) {
    const discarded=new Set(originals.filter(item=>{
      const samples=item.observationIds.flatMap(id=>docs.observations[id]?.samples??[]);
      return samples.length>0&&samples.every(({box:[,y,w,h]})=>w*h<30||y>scene.height*.86);
    }).map(item=>item.id));
    const children=new Set(design.appearance.filter(item=>discarded.has(item.blockId)).flatMap(item=>item.childIds));
    scene.elements=scene.elements.filter(item=>!discarded.has(item.id)&&!children.has(item.id));
    design.blocks.items=design.blocks.items.filter(item=>!discarded.has(item.id));
    design.appearance=design.appearance.filter(item=>!discarded.has(item.blockId));
    design.events=design.events.filter(item=>![...item.inputs,...item.outputs].some(id=>discarded.has(id)));
    for(let i=originals.length-1;i>=0;i--) if(discarded.has(originals[i].id)) originals.splice(i,1);
    const id='review:3:minor-mark-policy';
    marked[id]={...head,id,kind:'corpus-filter-decision',origin:'manual',count:discarded.size,
      method:'Dropped tiny marks or the lower footnote marks from the editable model; raw observations are preserved'};
  }
  if(sample===7) {
    hideExisting(scene,design,item=>{
      const samples=item.observationIds.flatMap(id=>raw[id]?.samples??[]);
      return samples.length>0&&samples.every(({box:[x,y,w,h]})=>
        w*h<1600&&(y+h<scene.height*.22||x>scene.width*.91));
    },0,scene.duration,originals);
  }
  function addText(row,rows,index,contextDetail) {
    assert.ok(rows.length,`missing measured bounds for ${sample} ${row.text}`);
    const id=`review:${sample}:${index}`,evidence=id+':bounds';
    const [,,width,height]=[...rows].sort((a,b)=>b.box[2]*b.box[3]-a.box[2]*a.box[3])[0].box;
    const fit=fitBoxes(rows,fps,row.breaks??[],[width,height]);
    const group={id,name:row.text,type:'group',inPoint:rows[0].frame/fps,outPoint:(rows.at(-1).frame+1)/fps,transform:fit.tracks};
    const child={...textLayer(row.text,width,height,row.fill,row.fit,row.weight,row.spacing),id:id+':text',parentId:id,inPoint:group.inPoint,outPoint:group.outPoint};
    const hiddenDuring=fit.groups.slice(1).flatMap((part,i)=>((fit.groups[i].at(-1).frame+1)<part[0].frame)?
      [{from:(fit.groups[i].at(-1).frame+1)/fps,to:part[0].frame/fps}]:[]);
    newBinding(group,child,width,height,evidence,hiddenDuring);
    substitutions.push({id:child.id,parentId:id,original:row.text,text:row.alternate,width,height,fill:row.fill,weight:row.weight,
      spacing:row.spacing,frames:rows.map(row=>row.frame)});
    marked[evidence]={...head,id:evidence,kind:'reviewed-text-unit',origin:'manual',text:row.text,expectedSpan:row.span,
      checkedVisualIdentity:contextDetail,measurement:'OpenCV extent, manual role assignment, eased fit',maxSampleError:fit.error,
      boundsSpace:row.boundsSpace??'source-frame',samples:rows};
    return {group,child,evidence};
  }
  for(const [index,row] of (captionCases[sample]??[]).entries()) {
    const byFrame=new Map();
    for(const track of row.tracks) for(const entry of raw[`contour:corpus${sample}:${track}`]?.samples??[]) {
      if(entry.frame<row.span[0]||entry.frame>=row.span[1]) continue;
      const values=byFrame.get(entry.frame)??[];
      values.push(entry.box);
      byFrame.set(entry.frame,values);
    }
    const rows=[...byFrame].sort((a,b)=>a[0]-b[0]).map(([frame,boxes])=>({frame,box:union(boxes)}));
    if(!rows.length) continue;
    const sameTrack=item=>item.observationIds.some(id=>row.tracks.some(track=>id===`contour:corpus${sample}:${track}`));
    hideExisting(scene,design,sameTrack,row.span[0]/fps,row.span[1]/fps,originals);
    const primary=addText(row,rows,index,'元コマと照合した範囲のみ');
    if(row.ruby) {
      const [text,alternate,track]=row.ruby;
      const readings=raw[`contour:corpus${sample}:${track}`]?.samples.filter(item=>item.frame>=row.span[0]&&item.frame<row.span[1])??[];
      if(readings.length) {
        hideExisting(scene,design,item=>item.observationIds.includes(`contour:corpus${sample}:${track}`),row.span[0]/fps,row.span[1]/fps,originals);
        const relative=readings.map(({frame,box:[x,y,w,h]})=>{
          const [sx,,,,px,py]=worldMatrixOf(scene,primary.group.id,frame/fps);
          const sy=sampleTrack(primary.group.transform.scaleY,frame/fps,1,scene.tempo);
          return {frame,box:[(x-px)/sx,(y-py)/sy,w/sx,h/sy]};
        });
        const ruby=addText({...row,text,alternate,fit:'contain',boundsSpace:'parent-local'},relative,`${index}:ruby`,'主字の座標へ変換した読み');
        ruby.group.parentId=primary.group.id;
        ruby.child.name=`${row.text} のルビ`;
        const entry=substitutions.find(value=>value.id===ruby.child.id);
        entry.rubyOf=primary.child.id;
        marked[ruby.evidence].rubyOf=primary.child.id;
      }
    }
  }
  if(sample===4) {
    const rows=JSON.parse(execFileSync(python,[path.join(REPO_ROOT,'scripts','measure-lyricsample4-layers.py'),sourcePath(project)],
      {encoding:'utf8',windowsHide:true}));
    const hide=(track,from,to)=>hideExisting(scene,design,item=>item.observationIds.includes(`contour:corpus4:${track}`),from/fps,to/fps,originals);
    const originalColor='#fae6ce';
    hide(1,1,33);
    hide(42,33,55);
    for(const [i,role,text,alternate,span] of [
      [0,'title','行き詰まって','目を閉じて',[1,19]],
      [1,'title','行き詰まって 時が','目を閉じて 風が',[19,33]],
      [2,'elapsed','経った','吹いた',[34,55]],
      [3,'night','ありふれた夜の','静かな街の',[149,192]],
    ]) {
      const samples=rows[role].filter(row=>row.frame>=span[0]&&row.frame<span[1]);
      addText({span,text,alternate,fill:originalColor,weight:role==='elapsed'?700:400,spacing:role==='night'?45:13},
        samples,`color:${i}`,'色で図形から分離し、原文を目視照合');
    }
    const ring=(radius)=>Array.from({length:40},(_,i)=>{
      const rad=2*Math.PI*i/40;
      return [2048+Math.round(radius*Math.cos(rad)),2048+Math.round(radius*Math.sin(rad))];
    }).flat();
    for(const [name,fill,type,outline,zIndex] of [
      ['bar','#284b58','rect',undefined,-100],
      ['dark-circle','#284b58','ellipse',undefined,-100],
      ['ring','#c49960','rect',[ring(2048),ring(1110)],-99],
    ]) {
      const samples=rows[name];
      assert.ok(samples?.length,name);
      const id=`review:4:shape:${name}`,evidence=id+':bounds';
      const [,,width,height]=samples.find(row=>row.box[2]>=16&&row.box[3]>=16)?.box??samples[0].box;
      const {tracks}=fitBoxes(samples,fps,[],[width,height]);
      const inPoint=samples[0].frame/fps,outPoint=(samples.at(-1).frame+1)/fps;
      const group={id,name,type:'group',transform:tracks,inPoint,outPoint};
      const child={id:id+':appearance',parentId:id,type,fill,width,height,outline,zIndex,inPoint,outPoint};
      newBinding(group,child,width,height,evidence);
      marked[evidence]={...head,id:evidence,kind:'reviewed-graphic-unit',origin:'manual',sourceColor:fill,samples,
        method:'color mask and independent transform fit; simple geometry approximation'};
    }
  }
  if(sample===3) {
    const report=await read(path.join(dir,'..','Lyricsample3_Editable_Frame','report.json'));
    assert.equal(report.sourceSha256,analysis.sourceSha256);
    const patch=getProject(report.outputs[1].id).scene;
    const [start,end]=report.frameRange;
    hideExisting(scene,design,item=>{
      const observations=docs.observations;
      return item.observationIds.flatMap(id=>observations[id]?.samples??[]).some(({frame,box:[x,y,w,h]})=>
        start<=frame&&frame<end&&x+w/2>scene.width*.22&&x+w/2<scene.width*.78&&y+h/2<scene.height*.87);
    },start/fps,end/fps,originals);
    const offset=start/fps;
    const offsetTrack=track=>typeof track==='number'?track:{...track,keys:track.keys.map(key=>({...key,t:key.t+offset}))};
    const shift=el=>({...el,inPoint:el.inPoint+offset,outPoint:el.outPoint+offset,
      transform:el.transform&&Object.fromEntries(Object.entries(el.transform).map(([key,track])=>[key,offsetTrack(track)]))});
    const replacements={'に':'へ','な':'か','る':'く','兵':'言','器':'葉','成':'描'};
    for(const owner of patch.elements.filter(el=>el.type==='group')) {
      const [leaf]=patch.elements.filter(el=>el.parentId===owner.id);
      const evidence=`review:3:${owner.id}`;
      newBinding(shift(owner),shift(leaf),100,100,evidence);
      marked[evidence]={...head,id:evidence,kind:leaf.type==='text'?'reviewed-text-unit':'reviewed-graphic-unit',origin:'manual',
        reviewProjectId:report.outputs[1].id,reviewRevision:report.outputs[1].revision,sourceFrameRange:report.frameRange,text:leaf.text};
      if(leaf.type==='text') substitutions.push({id:leaf.id,parentId:owner.id,original:leaf.text,text:replacements[leaf.text],width:100,height:100,fill:leaf.fill,weight:400,
        frames:Array.from({length:Math.round((owner.outPoint-owner.inPoint)*fps)},(_,i)=>Math.round(owner.inPoint*fps)+start+i)});
    }
  }
  if(sample===6) {
    const folder=path.join(dir,'..','Lyricsample_Corpus_Motion','06-collective');
    for(const [index,name,text,alternate] of [[0,'interval-result.json','やめろよ','待ってて'],[1,'second-interval-result.json','回った','響いた']]) {
      const item=await read(path.join(folder,name));
      assert.equal(item.sourceSha256,analysis.sourceSha256);
      const [start,end]=item.frameRange;
      const [left,top,width,height]=item.roi;
      hideExisting(scene,design,item=>item.observationIds.flatMap(id=>docs.observations[id]?.samples??[]).some(({frame,box:[x,y,w,h]})=>
        start<=frame&&frame<end&&x+w/2>=left&&x+w/2<left+width&&y+h/2>=top&&y+h/2<top+height),start/fps,end/fps,originals);
      addText({span:item.frameRange,text,alternate,breaks:item.found.map(row=>row.frame),fill:'#454545',fit:'contain'},item.samples,index,'語全体の同一性を前後で確認');
    }
  }
  assert.ok(substitutions.length,`no editable text in sample ${sample}`);
  const addedEvents=[];
  for(const [frame,kind,label] of reviewedEvents[sample]) {
    const id=`review-event:${sample}:${frame}`,observationId=id+':evidence';
    marked[observationId]={...head,id:observationId,kind:'corpus-reviewed-event',origin:'manual',frame,t:frame/fps,label};
    const event={id,kind,t:frame/fps,label,status:'confirmed',inputs:[],outputs:[],observationIds:[observationId]};
    // Frames 30/210/240 in sample 7 are inspected states, so keep their
    // locations as observations without treating them as onset times.
    if(sample!==7) addedEvents.push(event);
  }
  if(addedEvents.length) {
    design.events=design.events.filter(event=>event.status!=='proposed'||!addedEvents.some(reviewed=>Math.abs(event.t-reviewed.t)<1/fps));
    design.events.push(...addedEvents);
    design.events.sort((a,b)=>a.t-b.t);
  }
  keepSceneVisibility(scene,design);
  validateBlocking(scene,design);
  return {substitutions,documents:{...docs,...design,observations:{...docs.observations,...marked}}};
}

async function publish(sample) {
  const analysis=await read(path.join(dir,`sample-${sample}-analysis.json`));
  const model=getBlocking(analysis.model.projectId),raw=getBlocking(analysis.rawProjectId);
  const files=path.join(dir,`Lyricsample${sample}`);
  await fs.mkdir(files,{recursive:true});
  const {substitutions,documents}=await applyReview(sample,analysis,model);
  const {scene,design}=model;
  const measure=canvasMeasurer(context);
  const visible=(scene,t)=>evaluateScene(scene,t,measure).filter(row=>row.opacity>0).map(row=>row.element.id);
  for(let frame=0;frame<analysis.frames;frame++) {
    const t=frame/scene.fps;
    assert.deepEqual(visible(scene,t),visible(blockingFrame(scene,design,t,'final'),t),`${sample}: ${frame}F plain vs final view`);
  }
  const original=saveGeneratedProject(`Lyricsample${sample} · 全編編集モデル`,scene,model.project.id,actor,documents);
  let timing=null;
  if(design.events.some(event=>event.status==='confirmed')) {
    const measured=editTiming(original.project.id,TimingRequest.parse({operation:'measure',baseRevision:original.project.revision,actor}));
    timing={revision:measured.project.revision,events:measured.measurements,shiftControl:measured.shiftControl};
  }
  const alternate=structuredClone(scene);
  for(const item of substitutions) {
    const {id,parentId,text,width,height,fill,weight,spacing}=item;
    const index=alternate.elements.findIndex(el=>el.id===id);
    const original=alternate.elements[index],replacement=textLayer(text,width,height,fill,'contain',weight,spacing);
    alternate.elements[index]={...original,...replacement,transform:{...replacement.transform,opacity:original.transform?.opacity}};
    for(const frame of item.frames) assert.deepEqual(worldMatrixOf(alternate,parentId,frame/scene.fps),worldMatrixOf(scene,parentId,frame/scene.fps));
  }
  const variant=saveGeneratedProject(`Lyricsample${sample} · 文字差し替え試験`,alternate,original.project.id,actor,
    {...documents,adaptation:{kind:'reviewed-text-replacements',sourceProjectId:original.project.id,
      sourceRevision:timing?.revision??original.project.revision,substitutions}});
  const focus=await exportBlocking(original.project.id,640);
  await fs.copyFile(focus.path,path.join(files,'01-comparison.mp4'));
  const exportWork=async(project,stage,file,view)=>{
    const output=await exportVideo(project,stage,{from:design.blocks.from,to:design.blocks.to,width:640,
      layout:'render',withAudio:view==='final',outputTag:file,sceneAt:t=>blockingFrame(stage,design,t,view)});
    await fs.copyFile(output.path,path.join(files,`${file}.mp4`));
  };
  await exportWork(original.project,scene,'02-motion','motion');
  await exportWork(original.project,scene,'03-events','events');
  await exportWork(original.project,scene,'04-editable','final');
  await exportWork(variant.project,alternate,'05-replacement','final');
  const names=['01-comparison','02-motion','03-events','04-editable','05-replacement'];
  for(const name of names) {
    const streams=probe(path.join(files,`${name}.mp4`));
    assert.equal(Number(streams.find(s=>s.codec_type==='video')?.nb_frames),analysis.frames,name);
    if(['01-comparison','04-editable','05-replacement'].includes(name)) assert.ok(streams.some(s=>s.codec_type==='audio'),name);
  }
  const report={...analysis,projectId:original.project.id,revision:timing?.revision??original.project.revision,variantId:variant.project.id,
    files:names.map(name=>`${name}.mp4`),sourceDuration:scene.duration,fps:scene.fps,rawKeys:keyCount(raw.scene),transformKeys:keyCount(scene),
    rawContourFrames:raw.design.appearance.reduce((n,row)=>n+(row.contours?.length??0),0),
    attachedFixedShapes:scene.elements.filter(el=>el.outline).length,remainingFrameContours:design.appearance.filter(row=>row.contours?.length).length,
    blockCount:design.blocks.items.length,shortBlocks:design.blocks.items.filter(block=>{
      const el=scene.elements.find(item=>item.id===block.id);
      return (resolveTime(el.outPoint??scene.duration,scene.tempo)-resolveTime(el.inPoint??0,scene.tempo))*scene.fps<=2.000001;
    }).length,substitutions,timing,estimatedBeatCount:model.project.audioAnalysis?.beats?.length??0};
  await fs.writeFile(path.join(files,'report.json'),JSON.stringify(report,null,2));
  console.log(sample,report.projectId,variant.project.id,report.frames,report.substitutions.length);
}

for(const sample of (selection.length?selection.map(Number):[2,3,4,5,6,7])) {
  try {await publish(sample);}
  catch(error) {console.error(sample,error);process.exitCode=1;}
}
