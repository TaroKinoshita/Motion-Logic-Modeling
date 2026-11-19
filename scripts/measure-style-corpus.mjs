import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getBlocking } from '../apps/server/src/blocking.ts';
import { getDocuments } from '../apps/server/src/store.ts';

const [root='data/Lyricsample_Corpus_Editable',inventoryFile='data/Lyricsample_Corpus_Intake/inventory.json',
  output='data/Lyricsample_Theory_Study']=process.argv.slice(2);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const inventory=await read(inventoryFile);
const prior=await read(path.join(root,'report.json'));
const motion=await read(path.join(root,'..','Lyricsample_Corpus_Motion','report.json'));
const median=values=>quantile(values,.5);
function quantile(values,q) {
  if(!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b), index=(sorted.length-1)*q;
  return sorted[Math.floor(index)]+(sorted[Math.ceil(index)]-sorted[Math.floor(index)])*(index%1);
}
const distribution=values=>({n:values.length,median:median(values),p90:quantile(values,.9)});
const norm=vector=>Math.hypot(...vector);
const delta=(a,b,rate)=>a.map((v,i)=>(v-b[i])*rate);
const differences=(points,rate)=>points.slice(1).map((point,i)=>delta(point,points[i],rate));
function smooth(points,window) {
  const pad=(window-1)/2;
  return points.slice(pad,points.length-pad).map((_,i)=>[0,1].map(k=>
    points.slice(i,i+window).reduce((sum,p)=>sum+p[k],0)/window));
}
function splitTrack(samples,cuts) {
  const runs=[];
  for(const row of samples) {
    const previous=runs.at(-1)?.at(-1);
    if(!previous||row.frame!==previous.frame+1||cuts.has(row.frame)) runs.push([]);
    runs.at(-1).push(row);
  }
  return runs;
}
function unionArea(boxes) {
  const xs=[...new Set(boxes.flatMap(([x,,w])=>[x,x+w]))].sort((a,b)=>a-b);
  return xs.slice(1).reduce((area,right,i)=>{
    const left=xs[i], ys=boxes.filter(([x,,w])=>x<right&&x+w>left).map(([,y,,h])=>[y,y+h]).sort((a,b)=>a[0]-b[0]);
    let covered=0,end=-Infinity;
    for(const [top,bottom] of ys) {
      covered+=Math.max(0,bottom-Math.max(top,end));
      end=Math.max(end,bottom);
    }
    return area+(right-left)*covered;
  },0);
}
function runMetrics(run,window,fps,diagonal) {
  const centers=smooth(run.map(({box:[x,y,w,h]})=>[(x+w/2)/diagonal,(y+h/2)/diagonal]),window);
  const velocity=differences(centers,fps), acceleration=differences(velocity,fps), jerk=differences(acceleration,fps);
  const speed=velocity.map(norm);
  const stops=[];
  let still=0;
  for(const s of [...speed,Infinity]) {
    if(s<=.015) still++;
    else {
      if(still>=3) stops.push(still/fps);
      still=0;
    }
  }
  // An endpoint projection is a geometric proxy. These tracks have no labeled target.
  const chord=centers.length?delta(centers.at(-1),centers[0],1):[0,0], distance=norm(chord);
  const beyond=distance>=.025&&centers.length>=6?Math.max(0,...centers.map(p=>
    delta(p,centers[0],1).reduce((d,v,i)=>d+v*chord[i],0)/(distance*distance)-1)):null;
  return {speed, acceleration:acceleration.map(norm),jerk:jerk.map(norm),stops,beyond};
}
function summarizeRuns(runs,window,fps,diagonal) {
  const measures=runs.map(run=>runMetrics(run,window,fps,diagonal));
  const metric=key=>distribution(measures.flatMap(row=>row[key]));
  return {eligibleRunsForJerk:runs.filter(run=>run.length>=window+3).length,speed:metric('speed'),
    acceleration:metric('acceleration'),jerk:metric('jerk'),stopSeconds:metric('stops'),
    overshootProxy:distribution(measures.flatMap(row=>row.beyond===null?[]:[row.beyond])),
    positiveOvershootProxyRuns:measures.filter(row=>row.beyond!==null&&row.beyond>.05).length};
}

// Fit the same centered time support on the observed samples of every source.
// Scale time to [-1, 1] before solving the four normal equations.
function localDerivatives(points,at,half,fps) {
  const reach=Math.floor(half*fps+1e-9);
  if(reach<2||at<reach||at+reach>=points.length) return null;
  const matrix=Array.from({length:4},()=>Array(6).fill(0));
  for(let step=-reach;step<=reach;step++) {
    const u=step/(fps*half), basis=[1,u,u*u,u*u*u];
    const weight=Math.exp(-2*u*u), sample=points[at+step];
    for(let row=0;row<4;row++) {
      for(let column=0;column<4;column++) matrix[row][column]+=weight*basis[row]*basis[column];
      for(let axis=0;axis<2;axis++) matrix[row][4+axis]+=weight*basis[row]*sample[axis];
    }
  }
  for(let k=0;k<4;k++) {
    let pivot=k;
    for(let i=k+1;i<4;i++) if(Math.abs(matrix[i][k])>Math.abs(matrix[pivot][k])) pivot=i;
    [matrix[k],matrix[pivot]]=[matrix[pivot],matrix[k]];
    const divisor=matrix[k][k];
    if(Math.abs(divisor)<1e-10) return null;
    matrix[k]=matrix[k].map(value=>value/divisor);
    for(let i=0;i<4;i++) {
      if(i===k) continue;
      const factor=matrix[i][k];
      matrix[i]=matrix[i].map((value,j)=>value-matrix[k][j]*factor);
    }
  }
  return [1,2,6].map((factor,i)=>norm(matrix[i+1].slice(4))*factor/half**(i+1));
}

function fixedTimeMetrics(runs,fps,diagonal) {
  const support=[.24,.36],grid=runs.map(run=>run.map(({box:[x,y,w,h]})=>[(x+w/2)/diagonal,(y+h/2)/diagonal]));
  const common=[], stops=[];
  const summaries=support.map(span=>{
    const eligible=grid.map(points=>points.map((_,i)=>localDerivatives(points,i,span/2,fps)));
    if(!common.length) common.push(...eligible);
    const values=eligible.flatMap(run=>run.filter(Boolean));
    const paired=eligible.flatMap((run,j)=>run.flatMap((row,i)=>row&&common[j][i]?[row]:[]));
    let eligibleRuns=0;
    for(const run of eligible) {
      if(run.some(Boolean)) eligibleRuns++;
      let still=0;
      for(const row of [...run,null]) {
        if(row&&row[0]<=.015) still++;
        else {
          if(still/fps>=.1-1e-9) stops.push({span,seconds:still/fps});
          still=0;
        }
      }
    }
    return {spanSeconds:span,sampleReachFrames:Math.floor(span*fps/2+1e-9),eligibleRuns,
      speed:distribution(values.map(row=>row[0])),acceleration:distribution(values.map(row=>row[1])),
      jerk:distribution(values.map(row=>row[2])),sharedWithNarrow:distribution(paired.map(row=>row[2])),stopSeconds:distribution(stops.filter(s=>s.span===span).map(s=>s.seconds))};
  });
  const wide=support[1]/2;
  const sameFrames=grid.flatMap((points,j)=>common[j].flatMap((row,i)=>
    row&&i>=Math.floor(wide*fps+1e-9)&&i+Math.floor(wide*fps+1e-9)<points.length?[row[2]]:[]));
  summaries[0].sharedWithNarrow=distribution(sameFrames);
  assert.equal(summaries[0].sharedWithNarrow.n,summaries[1].sharedWithNarrow.n);
  return summaries;
}
const polynomial=Array.from({length:21},(_,i)=>{
  const t=(i-10)/30;
  return [t+2*t*t+3*t*t*t,0];
});
assert.ok(localDerivatives(polynomial,10,.12,30).every((v,i)=>Math.abs(v-[1,4,18][i])<1e-8));
assert.equal(localDerivatives(polynomial,0,.12,30),null);

const reports=[];
for(const material of inventory) {
  const {sample,frames,width,height,sourceSha256=material.sha256}=material;
  const row=sample===1?{rawProjectId:'p_mwm2ho9imuws',projectId:prior.hostProjectId,shotAudit:[]}
    :await read(path.join(root,'Corrections',`Lyricsample${sample}`,'report.json'));
  const raw=getBlocking(row.rawProjectId), reviewed=getBlocking(row.projectId);
  assert.equal(raw.project.source.sha256,sourceSha256);
  assert.equal(reviewed.project.source.sha256,sourceSha256);
  const {fps}=raw.scene, diagonal=Math.hypot(width,height);
  const observations=Object.values(getDocuments(row.rawProjectId).observations??{});
  const contours=observations.filter(item=>item.kind==='block-contour'&&item.sourceSha256===sourceSha256);
  const visualEvents=reviewed.design.events.filter(event=>event.status==='confirmed');
  const cuts=new Set([...contours.flatMap(item=>item.inputs?.cuts??[]),
    ...reviewed.design.events.filter(event=>event.kind==='cut'||event.kind==='invert').map(event=>Math.round(event.t*fps)),
    ...visualEvents.filter(event=>['merge','split','replace','shape'].includes(event.kind)).map(event=>Math.round(event.t*fps)),
    ...(row.shotAudit??[]).flatMap(shot=>shot.boundaries)]);
  const byFrame=Array.from({length:frames},()=>[]);
  const runs=[];
  let removed=0;
  for(const contour of contours) {
    const rows=contour.samples.filter(({frame,box:[,,w,h]})=>{
      const keep=Number.isInteger(frame)&&frame>=0&&frame<frames&&w*h>=width*height*.0001;
      if(!keep) removed++;
      return keep;
    }).sort((a,b)=>a.frame-b.frame);
    for(const r of rows) byFrame[r.frame].push(r.box);
    runs.push(...splitTrack(rows,cuts));
  }
  const composition=byFrame.flatMap((boxes,frame)=>{
    if(!boxes.length) return [];
    const sorted=boxes.map(box=>box[3]).sort((a,b)=>b-a);
    const clipped=boxes.map(([x,y,w,h])=>[Math.max(0,x),Math.max(0,y),Math.min(width,x+w),Math.min(height,y+h)])
      .filter(([x,y,r,b])=>r>x&&b>y).map(([x,y,r,b])=>[x,y,r-x,b-y]);
    return [{frame,boxCount:boxes.length,boxOccupancy:unionArea(clipped)/(width*height),
      tallestRatio:sorted.length>1?sorted[0]/sorted[1]:null}];
  });
  const effects=getDocuments(row.projectId).simplification?.fits??[];
  const time=[...new Set(visualEvents.map(event=>event.t))].sort((a,b)=>a-b);
  const beats=(reviewed.scene.markers??[]).filter(m=>m.kind==='beat');
  const timing=visualEvents.map(({t,kind,label})=>({
    frame:Math.round(t*fps),t,kind,label,beatOffsetSeconds:beats.length?
      beats.map(m=>t-m.t).reduce((a,b)=>Math.abs(a)<=Math.abs(b)?a:b):null,
    lyricOffsetSeconds:null,
  }));
  reports.push({sample,sourceSha256,originalWorkId:null,fps,frames,rawProjectId:row.rawProjectId,rawRevision:raw.project.revision,
    reviewedProjectId:row.projectId,reviewedRevision:reviewed.project.revision,
    scope:sample===7?'type and layout only; source effects excluded from reconstruction':'source contour boxes',
    coverage:{framesWithBoxes:composition.length,filteredSmallOrInvalidSamples:removed,observedTracks:contours.length,
      contiguousRuns:runs.length,singleFrameRuns:runs.filter(run=>run.length===1).length},
    composition:{boxOccupancy:distribution(composition.map(r=>r.boxOccupancy)),
      vacantBoxArea:distribution(composition.map(r=>1-r.boxOccupancy)),
      boxCount:distribution(composition.map(r=>r.boxCount)),largestToSecondHeight:distribution(composition.flatMap(r=>r.tallestRatio===null?[]:[r.tallestRatio])),
      frames:composition},
    motion:{windows:Object.fromEntries([3,5].map(window=>[window,{spanSeconds:(window-1)/fps,...summarizeRuns(runs,window,fps,diagonal)}])),
      fixedTimeWindows:fixedTimeMetrics(runs,fps,diagonal),
      cutAndEventFrames:[...cuts].sort((a,b)=>a-b),continuity:'adjacent source observations with cut and event exclusions; identity may still drift'},
    glyph:{reviewedTransformCases:(row.shotAudit??[]).map(shot=>({label:shot.label,frames:shot.checks})),
      fittedAffineGroups:effects.filter(fit=>fit.geometry==='affine').length,
      reviewedRelations:visualEvents.filter(e=>['merge','split','replace'].includes(e.kind)).map(e=>({frame:Math.round(e.t*fps),kind:e.kind,label:e.label})),
      residualLocalDeformation:null},
    timing:{events:timing,eventIntervalsSeconds:distribution(time.slice(1).map((t,i)=>t-time[i])),beatCount:beats.length,lyricAlignment:null}});
}
assert.equal(reports.reduce((sum,row)=>sum+row.frames,0),1581);
await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify({schemaVersion:1,parameters:{
  minBoxAreaRatio:.0001,windowsFrames:[3,5],stopThresholdDiagonalsPerSecond:.015,minStopSteps:3,
  motionUnits:['diagonals/s','diagonals/s²','diagonals/s³'],closedSetAttribution:null},
  anchors:{merge:{sample:1,frame:81,input:['食','反'],output:'飯',source:'docs/13_Lyricsample1_Meshi_Rule.md'},
    settle:motion.measures.find(row=>row.sample===2),shrink:motion.validation},works:reports},null,2));
const lines=reports.map(({sample,frames,coverage,composition,motion})=>
  `| ${sample} | ${coverage.framesWithBoxes}/${frames} | ${composition.boxOccupancy.median?.toFixed(3)??'—'} | ${motion.windows[3].eligibleRunsForJerk} | ${motion.windows[5].eligibleRunsForJerk} |`);
const timeLines=reports.map(({sample,motion})=>{
  const [short,long]=motion.fixedTimeWindows;
  const show=row=>row.sharedWithNarrow.median?.toPrecision(3)??'—';
  return `| ${sample} | ${short.eligibleRuns} | ${long.eligibleRuns} | ${long.sharedWithNarrow.n} | ${show(short)} | ${show(long)} |`;
});
await fs.writeFile(path.join(output,'SUMMARY.md'),['# 7抜粋の初回測定','',
  '| 素材 | 箱が得られたコマ | 箱占有率の中央値 | 3コマ平滑化でジャークを算出できた系列 | 5コマ平滑化で算出できた系列 |',
  '| --- | --- | --- | --- | --- |',...lines,'',
  '## 秒幅をそろえた感度比較','',
  '| 素材 | 0.24秒で算出できた系列 | 0.36秒で算出できた系列 | 両方で算出できた観測点数 | 0.24秒のジャーク中央値 | 0.36秒のジャーク中央値 |',
  '| --- | --- | --- | --- | --- | --- |',...timeLines,'',
  'ジャークの単位は画面対角／秒³。中央値は両方で算出できた同じ観測点を使用。微分の結果には追跡の誤差やカメラの動きも含まれる。','',
  '[各コマの値と算出条件](measurements.json)',
  '', '連続性と箱の観測を確認する初回集計。意味上の主役、字形の局所変形、発音との関係は別途評価する。',''].join('\n'));
console.log(lines.join('\n'));
