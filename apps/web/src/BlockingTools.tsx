import { useEffect, useState } from 'react';
import { sampleTrack } from '@mlm/core';
import type { Blocking, ProjectMeta, Scene } from '@mlm/core';
import { api } from './api.ts';
import type { BlockJob } from './api.ts';
import { activeBlocks } from './BlockingStage.tsx';

type Props={
  design:Blocking;scene:Scene;id:string;revision:number;time:number;
  job:BlockJob|null;onJob:(job:BlockJob)=>void;onRefresh:()=>void;onError:(error:unknown)=>void;
  projects:ProjectMeta[];audio?:Record<string,unknown>;
};
const stateNames={queued:'待機',measuring:'計測中',saving:'保存中',exporting:'書き出し中',done:'完了',failed:'失敗',cancelled:'中断'};
export const busyJob=(job:BlockJob|null)=>job&&['queued','measuring','saving','exporting'].includes(job.state);

export function BlockJobStatus({job,onCancel,onRetry}:{job:BlockJob|null;onCancel:()=>void;onRetry:()=>void}) {
  if(!job) return null;
  return <span className="block-job" role="status">
    {stateNames[job.state]}{busyJob(job)&&job.progress!==undefined&&` ${Math.round(job.progress*100)}%`}
    {job.error&&<span className="error" title={job.error}> {job.error.split(/\r?\n/).at(0)}</span>}
    {busyJob(job)&&<button type="button" onClick={onCancel}>中断</button>}
    {['failed','cancelled'].includes(job.state)&&<button type="button" onClick={onRetry}>再試行</button>}
  </span>;
}

export function BlockingTools({design,scene,id,revision,time,job,onJob,onRefresh,onError,projects,audio}:Props) {
  const [blockId,setBlockId]=useState('');
  const [eventId,setEventId]=useState('');
  const [section,setSection]=useState<'block'|'event'|'model'|null>(null);
  const [documents,setDocuments]=useState<Awaited<ReturnType<typeof api.documents>>|null>(null);
  const [pending,setPending]=useState(false);
  const [crop,setCrop]=useState<string|null>(null);
  const frame=Math.floor(time*scene.fps+1e-7);
  const blocks=activeBlocks(scene,design,time);
  const block=blocks.find(item=>item.id===blockId)??blocks[0];
  const event=design.events.find(item=>item.id===eventId);
  useEffect(()=>{
    if(section!=='model') return;
    let cancelled=false;
    api.documents(id).then(value=>{if(!cancelled)setDocuments(value);}).catch(onError);
    return ()=>{cancelled=true;};
  },[id,revision,section,onError]);
  const apply=async(edit:Record<string,unknown>)=>{
    setPending(true);
    try {await api.editBlocking(id,revision,edit);onRefresh();}
    catch(error) {onError(error);}
    finally {setPending(false);}
  };
  const group=block&&scene.elements.find(el=>el.id===block.id);
  const value=(track:Parameters<typeof sampleTrack>[0],fallback=0)=>sampleTrack(track,time,fallback,scene.tempo);
  const toggle=(name:typeof section)=>setSection(section===name?null:name);
  return <div className="blocking-tools">
    <div className="blocking-tool-actions">
      <button type="button" aria-pressed={section==='block'} onClick={()=>toggle('block')}>ブロックの修正</button>
      <button type="button" aria-pressed={section==='event'} onClick={()=>toggle('event')}>出来事の修正</button>
      <button type="button" aria-pressed={section==='model'} onClick={()=>toggle('model')}>観察・仮説・規則</button>
    </div>
    {section==='block'&&<div className="blocking-tool">
      <label>表示中のブロック <select value={block?.id??''} onChange={e=>setBlockId(e.target.value)}>
        {blocks.map(item=><option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
      </select></label>
      {block&&group?<form key={`${block.id}:${frame}:${revision}`} onSubmit={e=>{
        e.preventDefault();
        const fields=new FormData(e.currentTarget);
        const fieldsOf=(keys:string[])=>Object.fromEntries(keys.map(key=>[key,Number(fields.get(key))]));
        const kind=(e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-kind');
        if(kind==='ungroup') void apply({kind,blockId:block.id});
        else if(kind==='split') void apply({kind,blockId:block.id,frame});
        else if(kind==='text') void apply({kind,blockId:block.id,text:fields.get('text')});
        else if(kind==='analyze'||kind==='crop') {
          const {left,top,roiWidth,roiHeight,from,to}=fieldsOf(['left','top','roiWidth','roiHeight','from','to']);
          if(kind==='crop') {
            const params=new URLSearchParams({kind:'source',times:String((frame+.5)/scene.fps),cellWidth:'640',
              region:JSON.stringify({x:left,y:top,w:roiWidth,h:roiHeight}),gridStep:String(Math.max(8,Math.round(roiWidth/8)))});
            setCrop(`/api/projects/${id}/frames?${params}`);
            return;
          }
          void api.analyzeBlocking(id,revision,{blockId:block.id,region:[left,top,roiWidth,roiHeight],from,to,ocrFrames:[from]}).then(onJob).catch(onError);
        } else void apply({kind:'box',blockId:block.id,frame,...fieldsOf(['cx','cy','width','height','rotation'])});
      }}>
        <div className="blocking-fields">
          {numberField('cx','中心X',value(group.transform?.x))}
          {numberField('cy','中心Y',value(group.transform?.y))}
          {numberField('width','幅',value(block.extent.width),1)}
          {numberField('height','高さ',value(block.extent.height),1)}
          {numberField('rotation','角度',value(group.transform?.rotation))}
          <button disabled={pending}>このコマの箱を保存</button>
          {block.members?<button disabled={pending} data-kind="ungroup">まとめを解除</button>:
            <button disabled={pending} data-kind="split">このコマで軌道を分割</button>}
        </div>
        <div className="blocking-fields">
          <label>文字 <input name="text" placeholder="例：飯" maxLength={120}/></label>
          <button disabled={pending} data-kind="text">外観を文字へ置換</button>
        </div>
        <div className="blocking-fields">
          {numberField('left','再計測 左',Math.round(Math.max(0,value(group.transform?.x)-value(block.extent.width)/2-16)),0,1)}
          {numberField('top','上',Math.round(Math.max(0,value(group.transform?.y)-value(block.extent.height)/2-16)),0,1)}
          {numberField('roiWidth','範囲幅',Math.round(value(block.extent.width)+32),1,1)}
          {numberField('roiHeight','範囲高',Math.round(value(block.extent.height)+32),1,1)}
          {numberField('from','開始F',frame,0,1)}
          {numberField('to','終了F（手前まで）',frame+1,1,1)}
          <button type="submit" data-kind="crop">元動画の範囲を拡大</button>
          <button type="submit" data-kind="analyze" disabled={!!busyJob(job)}>指定範囲を再計測</button>
        </div>
        {crop&&<figure className="blocking-crop"><img src={crop} alt="元動画から切り出した座標目盛りつきの画像"/>
          <button type="button" onClick={()=>setCrop(null)}>閉じる</button></figure>}
      </form>:<p>箱が表示されるコマへ移動してください。</p>}
      {blocks.length>1&&<details><summary>複数のブロックをまとめる</summary>
        <form className="blocking-fields" onSubmit={e=>{
          e.preventDefault();
          const fields=new FormData(e.currentTarget);
          void apply({kind:'group',blockIds:fields.getAll('members'),label:fields.get('label')});
        }}>
          {blocks.filter(item=>!item.members).map(item=><label key={item.id}><input type="checkbox" name="members" value={item.id}/>{item.label}</label>)}
          <label>まとめる名前 <input name="label" required maxLength={120}/></label>
          <button disabled={pending}>同じ動きのまとまりにする</button>
        </form>
      </details>}
    </div>}
    {section==='event'&&<div className="blocking-tool">
      <label>出来事 <select value={eventId} onChange={e=>setEventId(e.target.value)}>
        <option value="">現在のコマから追加</option>
        {design.events.map(item=><option key={item.id} value={item.id}>{Math.round(item.t*scene.fps)}F {item.label}</option>)}
      </select></label>
      <form className="blocking-fields" key={`${eventId}:${revision}`} onSubmit={e=>{
        e.preventDefault();
        const fields=new FormData(e.currentTarget);
        const next={frame:Number(fields.get('frame')),label:fields.get('label')};
        if(event) void apply({kind:'event',id:event.id,...next,status:fields.get('status'),beatRelative:fields.has('beatRelative')});
        else void apply({kind:'add-event',blockId:block?.id,...next});
      }}>
        {numberField('frame','F',event?Math.round(event.t*scene.fps):frame,0,1)}
        <label>ラベル <input name="label" defaultValue={event?.label} required maxLength={120}/></label>
        {event&&<><label>判定 <select name="status" defaultValue={event.status}>
          <option value="proposed">候補</option><option value="confirmed">確定</option><option value="rejected">却下</option>
        </select></label><label><input type="checkbox" name="beatRelative" defaultChecked={event.beatRelative}/>新曲の拍に結ぶ</label></>}
        <button disabled={pending}>保存</button>
      </form>
      {event&&<p>根拠 {event.observationIds.join('、')||'手動記録'}　対象 {[...event.inputs,...event.outputs].join('、')||'画面全体'}</p>}
    </div>}
    {section==='model'&&<div className="blocking-tool">
      <AudioEvidence id={id} revision={revision} scene={scene} time={time} audio={audio} onRefresh={onRefresh} onError={onError}/>
      <Evidence documents={documents} observationIds={block?.observationIds??[]}/>
      <CameraOptions documents={documents} onApply={(from,to)=>{void apply({kind:'camera',from,to});}}/>
      <div className="blocking-fields">
        <button type="button" onClick={()=>{void api.runModel(id,'measure-events',{baseRevision:revision,
          events:design.events.filter(item=>item.status==='confirmed').map(item=>({label:item.label,t:item.t,origin:'manual'})),
        }).then(onRefresh).catch(onError);}}>確定した出来事と拍を照合</button>
      </div>
      <details><summary>仮説と規則の編集</summary>
        <form key={`${revision}:${!!documents}`} onSubmit={e=>{
          e.preventDefault();
          const fields=new FormData(e.currentTarget);
          try {
            const model=JSON.parse(String(fields.get('model')));
            void api.runModel(id,'model',{...model,baseRevision:revision}).then(onRefresh).catch(onError);
          } catch(error) {onError(error);}
        }}>
          <textarea aria-label="仮説と規則 JSON" name="model" defaultValue={JSON.stringify({
            hypotheses:documents?.hypotheses??[],rules:(documents?.motion_rules as {rules?:unknown[]}|undefined)?.rules??[],
          },null,2)} rows={8}/>
          <button>仮説と規則を保存</button>
        </form>
        <form className="blocking-fields" onSubmit={e=>{
          e.preventDefault();
          const fields=new FormData(e.currentTarget);
          const offset=String(fields.get('offset')??'');
          void api.runModel(id,'variant',{baseRevision:revision,ruleId:fields.get('rule'),name:fields.get('name'),
            seconds:Number(fields.get('seconds')),mergeOffsetSeconds:offset?Number(offset):undefined}).then(generated=>{location.hash=generated.project.id;}).catch(onError);
        }}>
          <label>規則ID <input name="rule" required/></label>
          <label>比較版の名前 <input name="name" required/></label>
          {numberField('seconds','秒',0,0)}
          <label>時刻差（秒） <input name="offset" type="number" step="any"/></label>
          <button>比較版を生成</button>
        </form>
      </details>
      <AdaptOptions id={id} revision={revision} scene={scene} projects={projects} onError={onError}/>
      {documents?.adaptation!=null&&<details><summary>生成条件</summary><pre>{JSON.stringify(documents.adaptation,null,2)}</pre></details>}
    </div>}
  </div>;
}

function CameraOptions({documents,onApply}:{documents:Awaited<ReturnType<typeof api.documents>>|null;onApply:(from:number,to:number)=>void}) {
  const frames=Object.values(documents?.observations??{}).flatMap(value=>{
    const observation=value as {kind?:string;frame?:number};
    return observation.kind==='camera-candidate'&&observation.frame!==undefined?[observation.frame]:[];
  }).sort((a,b)=>a-b);
  const runs:number[][]=[];
  for(const frame of new Set(frames)) {
    const previous=runs.at(-1);
    if(previous?.at(-1)===frame-1) previous.push(frame);
    else runs.push([frame]);
  }
  return <details><summary>共通のカメラ移動の候補</summary>
    <div className="blocking-fields">
      {runs.filter(run=>run.length>=3).map(run=>{
        const from=run[0]-1,to=run.at(-1)!+1;
        return <button key={from} type="button" onClick={()=>onApply(from,to)}>{from}〜{to-1}F をカメラの親に分ける</button>;
      })}
    </div>
  </details>;
}

function AudioEvidence({id,revision,scene,time,audio,onRefresh,onError}:Pick<Props,'id'|'revision'|'scene'|'time'|'audio'|'onRefresh'|'onError'>) {
  const onsets=Array.isArray(audio?.onsets)?audio.onsets as number[]:[];
  const energy=audio?.energy as {stepSeconds:number;rms:number[]}|undefined;
  const rms=energy?.rms[Math.round(time/energy.stepSeconds)];
  const onset=onsets.reduce<number|undefined>((best,next)=>best===undefined||Math.abs(time-next)<Math.abs(time-best)?next:best,undefined);
  const markers=(scene.markers??[]).filter(marker=>['beat','downbeat','section'].includes(marker.kind));
  return <details><summary>拍・小節頭・区間</summary>
    <p>最寄りの立ち上がり {onset?.toFixed(3)??'—'} 秒　強弱 RMS {rms?.toFixed(4)??'—'}</p>
    <form className="blocking-fields" key={revision} onSubmit={e=>{
      e.preventDefault();
      const form=new FormData(e.currentTarget);
      const selected=String(form.get('marker'));
      const t=Number(form.get('frame'))/scene.fps;
      if(t<0||t>=scene.duration) {onError(new Error('比較範囲内のフレームを指定してください'));return;}
      const kind=form.get('kind') as 'beat'|'downbeat'|'section';
      const next=(scene.markers??[]).filter(marker=>selected===''||marker!==markers[Number(selected)]);
      next.push({t,kind,origin:'manual',label:String(form.get('label')||kind)});
      next.sort((a,b)=>a.t-b.t);
      void api.updateScene(id,revision,[{op:'setMarkers',markers:next}],'音声マーカーを確認・修正').then(onRefresh).catch(onError);
    }}>
      <label>対象 <select name="marker"><option value="">新規</option>{markers.map((marker,i)=><option key={i} value={i}>{Math.round(marker.t*scene.fps)}F {marker.label??marker.kind}（{marker.origin==='estimated'?'推定':'確認済み'}）</option>)}</select></label>
      {numberField('frame','F',Math.floor(time*scene.fps+1e-7),0,1)}
      <label>種類 <select name="kind"><option value="beat">拍</option><option value="downbeat">小節頭</option><option value="section">区間</option></select></label>
      <label>名前 <input name="label"/></label>
      <button>マーカーを保存</button>
    </form>
  </details>;
}

function AdaptOptions({id,revision,scene,projects,onError}:Pick<Props,'id'|'revision'|'scene'|'projects'|'onError'>) {
  const [targetId,setTargetId]=useState('');
  const [generated,setGenerated]=useState<ProjectMeta[]>([]);
  const target=projects.find(project=>project.id===targetId);
  const sections=target?.source?[{sourceFrom:0,sourceTo:scene.duration,targetFrom:0,targetTo:target.source.duration,elementIds:scene.elements.map(el=>el.id),reason:'曲の区間の長さに合わせる'}]:[];
  return <details><summary>別の曲への区間割り当てと比較基準</summary>
    <form key={targetId} onSubmit={e=>{
      e.preventDefault();
      if(!target) return;
      const fields=new FormData(e.currentTarget);
      const common={baseRevision:revision,targetProjectId:target.id,targetRevision:target.revision,name:fields.get('name')};
      if((e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-kind')==='baselines') {
        void api.generateBaselines(id,{...common,includeLocalBeat:true}).then(result=>setGenerated(result.projects.map(entry=>entry.project))).catch(onError);
        return;
      }
      try {
        void api.runModel(id,'adapt',{...common,sections:JSON.parse(String(fields.get('sections')))}).then(result=>setGenerated([result.project])).catch(onError);
      } catch(error) {onError(error);}
    }}>
      <label>転用先 <select value={targetId} onChange={e=>{setGenerated([]);setTargetId(e.target.value);}}>
        <option value="">音源を取り込んだプロジェクトを選択</option>
        {projects.filter(project=>project.id!==id&&project.source?.hasAudio).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      {target&&<>
        <label>生成名 <input name="name" required defaultValue={`${target.name} の構成`}/></label>
        <textarea name="sections" aria-label="区間と要素の割り当て JSON" defaultValue={JSON.stringify(sections,null,2)} rows={8}/>
        <button>区間を割り当てて生成</button> <button data-kind="baselines">比較基準を生成</button>
      </>}
    </form>
    {generated.map(project=><p key={project.id}><a href={`#${project.id}`}>{project.name}</a></p>)}
  </details>;
}

function Evidence({documents,observationIds}:{documents:Awaited<ReturnType<typeof api.documents>>|null;observationIds:string[]}) {
  const items=documents?.observations??{};
  const related=[...Object.entries(items).filter(([id,value])=>observationIds.includes(id)||(value as {kind?:string}).kind==='event-beat')];
  return <details><summary>観察・拍との時間差（{related.length}件）</summary>
    <pre>{JSON.stringify(Object.fromEntries(related),null,2)}</pre>
  </details>;
}

function numberField(name:string,label:string,value:number,min?:number,step:number|'any'='any') {
  return <label>{label} <input type="number" name={name} min={min} step={step} defaultValue={Number(value.toFixed(3))} required/></label>;
}
