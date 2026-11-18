import { useEffect, useState } from 'react';
import { sampleTrack } from '@mlm/core';
import type { Blocking, ProjectMeta, Scene } from '@mlm/core';
import { api } from './api.ts';
import type { BlockJob } from './api.ts';
import { activeBlocks } from './BlockingStage.tsx';

type Props={
  design:Blocking;scene:Scene;id:string;revision:number;time:number;
  job:BlockJob|null;onJob:(job:BlockJob)=>void;onRefresh:()=>void;onError:(error:unknown)=>void;
  projects:ProjectMeta[];audio?:Record<string,unknown>;hasAudio:boolean;onSeek:(time:number)=>void;
};
const stateNames={queued:'待機',measuring:'計測中',saving:'保存中',exporting:'書き出し中',done:'完了',failed:'失敗',cancelled:'中断'};
export const busyJob=(job:BlockJob|null)=>job&&['queued','measuring','saving','exporting'].includes(job.state);

export function BlockJobStatus({job,onCancel,onRetry}:{job:BlockJob|null;onCancel:()=>void;onRetry:()=>void}) {
  if(!job) return null;
  return <span className="block-job" role="status">
    {stateNames[job.state]}{busyJob(job)&&job.progress!==undefined&&` ${Math.round(job.progress*100)}%`}
    {job.error&&<span className="error" title={job.error}> {job.error.split(/\r?\n/).at(0)}</span>}
    {busyJob(job)&&<button type="button" onClick={onCancel}>中断</button>}
    {job.resultProjectId&&<a href={`?compare=1#${job.resultProjectId}`}>生成した代表形モデルを開く</a>}
    {['failed','cancelled'].includes(job.state)&&<button type="button" onClick={onRetry}>再試行</button>}
  </span>;
}

export function BlockingTools({design,scene,id,revision,time,job,onJob,onRefresh,onError,projects,audio,hasAudio,onSeek}:Props) {
  const [blockId,setBlockId]=useState('');
  const [eventId,setEventId]=useState('');
  const [section,setSection]=useState<'block'|'event'|'model'|null>(null);
  const [documents,setDocuments]=useState<Awaited<ReturnType<typeof api.documents>>|null>(null);
  const [pending,setPending]=useState(false);
  const [crop,setCrop]=useState<string|null>(null);
  const [pair,setPair]=useState<Awaited<ReturnType<typeof api.generateRulePair>>|null>(null);
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
        else if(kind==='text') void apply({kind,blockId:block.id,frame,text:fields.get('text')});
        else if(kind==='analyze'||kind==='crop'||kind==='sprite') {
          const {left,top,roiWidth,roiHeight,from,to}=fieldsOf(['left','top','roiWidth','roiHeight','from','to']);
          if(kind==='crop') {
            const params=new URLSearchParams({kind:'source',times:String((frame+.5)/scene.fps),cellWidth:'640',
              region:JSON.stringify({x:left,y:top,w:roiWidth,h:roiHeight}),gridStep:String(Math.max(8,Math.round(roiWidth/8)))});
            setCrop(`/api/projects/${id}/frames?${params}`);
            return;
          }
          if(kind==='sprite') {
            void api.analyzeBlocking(id,revision,{engine:'sprite',from,to,region:[left,top,roiWidth,roiHeight]}).then(onJob).catch(onError);
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
          <button type="submit" data-kind="sprite" disabled={!!busyJob(job)}>Fast Spriteで代表形を生成</button>
        </div>
        {crop&&<figure className="blocking-crop"><img src={crop} alt="元動画から切り出した座標目盛りつきの画像"/>
          <button type="button" onClick={()=>setCrop(null)}>閉じる</button></figure>}
      </form>:<p>箱が表示されるコマへ移動してください。</p>}
      {block&&design.appearance.some(binding=>binding.blockId===block.id&&binding.contours?.length)&&<details>
        <summary>同じ文字の断片から代表形を作る</summary>
        <form className="blocking-fields" key={`${block.id}:${frame}`} onSubmit={async e=>{
          e.preventDefault();
          const data=new FormData(e.currentTarget);
          setPending(true);
          try {
            const result=await api.representative(id,revision,{label:String(data.get('label')),
              fragmentIds:[block.id,...data.getAll('fragments').map(String)],from:Number(data.get('from')),to:Number(data.get('to')),
              shapeFrame:Number(data.get('shapeFrame')),geometry:data.has('affine')?'affine':undefined});
            location.assign(`?compare=1#${result.project.id}`);
          } catch(error) {onError(error);}
          finally {setPending(false);}
        }}>
          <label>文字の名前 <input name="label" defaultValue={block.label} required maxLength={75}/></label>
          {numberField('from','開始F',frame,0,1)}
          {numberField('to','終了F（手前まで）',Math.min(Math.round(design.blocks.to*scene.fps),frame+2),1,1)}
          {numberField('shapeFrame','代表にするF',frame,0,1)}
          <label><input type="checkbox" name="affine"/>回転・せん断も輪郭に合わせる</label>
          <label>接触前後の追加断片 <select name="fragments" multiple size={4}>
            {design.appearance.filter(binding=>binding.blockId!==block.id&&binding.contours?.length).map(binding=>{
              const name=design.blocks.items.find(item=>item.id===binding.blockId)?.label;
              return <option key={binding.blockId} value={binding.blockId}>{name} · {binding.blockId} · {Math.round(binding.contours![0].t*scene.fps)}〜{Math.round(binding.contours!.at(-1)!.t*scene.fps)}F</option>;
            })}
          </select></label>
          <button disabled={pending}>代表形を別プロジェクトに保存</button>
        </form>
      </details>}
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
      {hasAudio&&<LyricTiming {...{id,revision,design,time,documents,onSeek,onRefresh,onError}}/>}
      <Orientation {...{id,revision,design,frame,scene,documents,onSeek,onRefresh,onError}}/>
      {block&&<MotionEvidence {...{id,revision,frame,scene,design,documents,onRefresh,onError}} blockId={block.id}/>}
      {block&&<Checkpoint {...{id,revision,frame,documents,onRefresh,onError}} blockId={block.id}/>}
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
          const body={baseRevision:revision,ruleId:fields.get('rule'),name:fields.get('name'),
            seconds:Number(fields.get('seconds')),mergeOffsetSeconds:offset?Number(offset):undefined};
          const wantsPair=(e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-kind')==='pair';
          setPending(true);
          void (wantsPair?api.generateRulePair(id,body).then(setPair):api.runModel(id,'variant',body).then(generated=>{location.hash=generated.project.id;}))
            .catch(onError).finally(()=>setPending(false));
        }}>
          <label>規則ID <input name="rule" required/></label>
          <label>比較版の名前 <input name="name" required/></label>
          {numberField('seconds','秒',0,0)}
          <label>時刻差（秒） <input name="offset" type="number" step="any"/></label>
          <button disabled={pending}>比較版を生成</button>
          <button disabled={pending} data-kind="pair">同じ素材でA/Bを生成</button>
        </form>
        {pair&&<div className="blocking-fields">
          {pair.variants.map(variant=><a key={variant.label} href={`?compare=1#${variant.project.id}`}>比較版 {variant.label}</a>)}
          <details><summary>条件の答え合わせ</summary>規則を変更 {pair.reveal.withRule}、元の設定 {pair.reveal.withoutRule}</details>
        </div>}
      </details>
      <StyleStudy {...{id,revision,documents,projects,onRefresh,onError}}/>
      <GlyphEvidenceForm {...{id,revision,time,onRefresh,onError}}/>
      {!!documents?.style_study?.claims.length&&<LyricStudy {...{id,revision,documents,projects,onError}}/>}
      <AdaptOptions id={id} revision={revision} scene={scene} projects={projects} onError={onError}/>
      {documents?.adaptation!=null&&<details><summary>生成条件</summary><pre>{JSON.stringify(documents.adaptation,null,2)}</pre></details>}
    </div>}
  </div>;
}

type ModelDocuments=Awaited<ReturnType<typeof api.documents>>;
function GlyphEvidenceForm({id,revision,time,onRefresh,onError}:Pick<Props,'id'|'revision'|'time'|'onRefresh'|'onError'>) {
  const [kind,setKind]=useState<'combine'|'ruby'>('combine');
  const [saving,setSaving]=useState(false);
  return <details><summary>見立て・合字・ルビを観察として記録</summary>
    <form className="blocking-fields" key={`${kind}:${revision}`} onSubmit={async event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      const text=String(data.get('text')).trim(), detail=String(data.get('detail')).trim();
      const interval={from:Number(data.get('from')),to:Number(data.get('to')),note:String(data.get('note'))};
      const entry=kind==='combine'?{...interval,relation:kind,result:{text},parts:detail.split('|').map(part=>({text:part.trim()})),
        combineAt:Number(data.get('combine'))}:{...interval,relation:kind,base:{text},ruby:{text:detail}};
      setSaving(true);
      try {await api.runModel(id,'observe-glyphs',{baseRevision:revision,entries:[entry]});onRefresh();}
      catch(error) {onError(error);}
      finally {setSaving(false);}
    }}>
      <label>種類 <select value={kind} onChange={event=>setKind(event.target.value==='ruby'?'ruby':'combine')}><option value="combine">合字</option><option value="ruby">ルビ</option></select></label>
      <label>{kind==='combine'?'合体後の字':'対象の文字'} <input name="text" required maxLength={100}/></label>
      <label>{kind==='combine'?'部品（例 田|丁）':'ルビ'} <input name="detail" required maxLength={250}/></label>
      {numberField('from','開始（秒）',time,0)}
      {numberField('to','終了（秒）',time+.2,0)}
      {kind==='combine'&&numberField('combine','合体（秒）',time+.1,0)}
      <label>根拠・見立て <input name="note" maxLength={500}/></label>
      <button disabled={saving}>文字構成を保存</button>
    </form>
  </details>;
}
function LyricStudy({id,revision,documents,projects,onError}:Pick<Props,'id'|'revision'|'projects'|'onError'>&{documents:ModelDocuments|null}) {
  const targets=projects.filter(project=>project.source?.hasAudio);
  const [result,setResult]=useState<Awaited<ReturnType<typeof api.generateLyricStudy>>|null>(null);
  const [pending,setPending]=useState(false);
  return <details><summary>新しい歌詞から規則比較を生成</summary>
    <p>歌詞の区間を秒で指定します。効果は entrance、hold、stagger、invert、combine。ルビは ruby、合字部品は parts に記録できます。</p>
    <p>観察のID {documents?.style_study?.claims.map(claim=>String(claim.id)).join('、')}</p>
    <form onSubmit={async event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      const target=targets.find(project=>project.id===data.get('target'));
      if(!target) return;
      setPending(true);
      try {setResult(await api.generateLyricStudy(id,{...JSON.parse(String(data.get('input'))),baseRevision:revision,
        targetProjectId:target.id,targetRevision:target.revision,name:String(data.get('name'))}));}
      catch(error) {onError(error);}
      finally {setPending(false);}
    }}>
      <div className="blocking-fields">
        <label>音源 <select name="target" required><option value="">選択</option>{targets.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>比較名 <input name="name" required maxLength={100}/></label>
      </div>
      <textarea name="input" rows={9} aria-label="歌詞区間と使う規則 JSON" defaultValue={JSON.stringify({
        lyrics:[{text:'新しい歌詞',from:0,to:1.5}],effects:[{claimId:documents?.style_study?.claims[0]?.id,kind:'entrance'}],
      },null,2)}/>
      <button disabled={pending}>全規則・規則なし・1つ省いた版を生成</button>
    </form>
    {result&&<><ul>{result.variants.map(row=><li key={row.label}><a href={`#${row.project.id}`}>比較版 {row.label}</a></li>)}</ul>
      <details><summary>条件の答え合わせ</summary><pre>{JSON.stringify(result.reveal,null,2)}</pre></details></>}
  </details>;
}
function StyleStudy({id,revision,documents,projects,onRefresh,onError}:Pick<Props,'id'|'revision'|'projects'|'onRefresh'|'onError'>&{documents:ModelDocuments|null}) {
  const [saving,setSaving]=useState(false);
  if(!documents) return null;
  const study=documents.style_study;
  const template={works:study?.works.map(({title:_title,sourceSha256:_sha,...entry})=>entry)??[],
    claims:study?.claims.map(({summary:_summary,...entry})=>entry)??[]};
  return <details><summary>作品をまたぐ観察の比較</summary>
    <p>各作品の projectId、revision、group（author または control）、credit、creditBasis を works に入力します。</p>
    <p>claims の axis に motion、timing、screen、meaning のいずれかを指定し、id、label、condition、evidence、exceptions を記録します。根拠と例外は projectId、revision、observationId で指定します。</p>
    <details><summary>プロジェクトIDとリビジョン</summary><ul>{projects.filter(project=>project.source).map(project=><li key={project.id}>{project.name} · {project.id} · r{project.revision}</li>)}</ul></details>
    <form key={revision} onSubmit={async event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      setSaving(true);
      try {await api.saveStyleStudy(id,{...JSON.parse(String(data.get('study'))),baseRevision:revision});onRefresh();}
      catch(error) {onError(error);}
      finally {setSaving(false);}
    }}>
      <textarea name="study" rows={8} defaultValue={JSON.stringify(template,null,2)} aria-label="作品と観察の比較 JSON"/>
      <button disabled={saving}>作品と観察の比較を保存</button>
    </form>
    {study&&<details><summary>作家側と対照側の分布</summary><pre>{JSON.stringify(study.claims.map(({id,label,summary})=>({id,label,summary})),null,2)}</pre></details>}
  </details>;
}
type LyricSpan={kind:'lyric-span';id:string;text:string;reading?:string;from:number;to:number;uncertaintySeconds:number;replaces?:string};
type TimingMatch={label:string;offsetSeconds:number;origin:string;withinWindow:boolean};
type TimingRow={kind:'event-audio-timing';id:string;sourceRevision:number;event:{id:string;label:string;t:number};
  matches:Record<'lyric'|'beat'|'downbeat'|'onset',TimingMatch[]>;assessment:keyof typeof assessments};
const assessments={insufficient:'候補不足',indistinguishable:'発音と拍を区別できない','lyric-nearby':'発音が近い',
  'beat-nearby':'拍が近い','neither-nearby':'両方とも範囲外'};

function Orientation({id,revision,design,scene,frame,documents,onSeek,onRefresh,onError}:Pick<Props,'id'|'revision'|'design'|'scene'|'onSeek'|'onRefresh'|'onError'>&{documents:ModelDocuments|null;frame:number}) {
  const [pending,setPending]=useState(false);
  const observations=Object.values(documents?.observations??{}).filter(entry=>(entry as {kind?:string})?.kind==='group-orientation') as
    {id:string;label:string;missingFrames:number[];samples:{frame:number;t:number;deltaDegrees:number;distancePx:number;cx?:number}[]}[];
  const options=design.appearance.filter(binding=>binding.contours?.length).map(binding=>{
    const label=design.blocks.items.find(item=>item.id===binding.blockId)?.label;
    return <option key={binding.blockId} value={binding.blockId}>{label} · {binding.blockId} · {Math.round(binding.contours![0].t*scene.fps)}〜{Math.round(binding.contours!.at(-1)!.t*scene.fps)}F</option>;
  });
  if(options.length<2&&!observations.length) return null;
  return <details><summary>2つの対象から画面内の角度を測る</summary>
    {options.length>=2&&<form className="blocking-fields" key={revision} onSubmit={async event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      setPending(true);
      try {await api.editTiming(id,revision,{operation:'orientation',label:String(data.get('label')),
        from:Number(data.get('from')),to:Number(data.get('to')),anchors:[data.getAll('first').map(String),data.getAll('second').map(String)]});onRefresh();}
      catch(error) {onError(error);}
      finally {setPending(false);}
    }}>
      <label>対象名 <input name="label" required maxLength={120}/></label>
      {numberField('from','開始F',frame,0,1)}
      {numberField('to','終了F（手前まで）',Math.min(Math.round(design.blocks.to*scene.fps),frame+2),1,1)}
      <label>対象1の輪郭断片 <select name="first" multiple size={4} required>{options}</select></label>
      <label>対象2の輪郭断片 <select name="second" multiple size={4} required>{options}</select></label>
      <button disabled={pending}>移動と角度の観察を保存</button>
    </form>}
    {observations.map(row=><details key={row.id}><summary>{row.label} · {row.samples.length}コマ計測 · 欠測{row.missingFrames.length}</summary>
      <p>最初に計測できたコマからの時計回り角度と2対象間距離</p>
      {row.samples.map(sample=><button type="button" key={sample.frame} onClick={()=>onSeek(sample.t)}>
        {sample.frame}F {sample.deltaDegrees.toFixed(1)}° · {sample.distancePx.toFixed(0)} px
      </button>)}
      {options.length>0&&row.samples[0]?.cx!==undefined&&<form className="blocking-fields" onSubmit={async event=>{
        event.preventDefault();
        const data=new FormData(event.currentTarget);
        setPending(true);
        try {
          const next=await api.editTiming(id,revision,{operation:'apply-orientation',observationId:row.id,
            shapeFrame:Number(data.get('shape')),partIds:data.getAll('parts').map(String)});
          location.assign(`?compare=1#${next.project.id}`);
        } catch(error) {onError(error);}
        finally {setPending(false);}
      }}>
        <label>代表コマ <select name="shape">{row.samples.map(sample=><option key={sample.frame} value={sample.frame}>{sample.frame}F</option>)}</select></label>
        <label>表示する輪郭 <select name="parts" multiple size={4} required>{options}</select></label>
        <button disabled={pending}>別プロジェクトへ回転キーを適用</button>
      </form>}
    </details>)}
  </details>;
}

function MotionEvidence({id,revision,frame,scene,design,blockId,documents,onRefresh,onError}:Pick<Props,'id'|'revision'|'scene'|'design'|'onRefresh'|'onError'>&
    {blockId:string;frame:number;documents:ModelDocuments|null}) {
  const [saving,setSaving]=useState(false);
  const rows=Object.values(documents?.observations??{}).filter(entry=>{
    const row=entry as {kind?:string;blockId?:string};
    return row?.kind==='block-motion-metrics'&&row.blockId===blockId;
  }) as {id:string;origin:string;stops:{from:number;to:number}[];missingFrames:number[];
    samples:{speedPxPerS?:number;accelerationPxPerS2?:number;occupancyRatio?:number;visibleCount:number}[];
    rmsComparison?:{quietFrames:number;speed:{frames:number;n:number;pearson?:number}[]}}[];
  const last=rows.at(-1);
  return <details><summary>選択中ブロックの停止・速度・占有率</summary>
    <form className="blocking-fields" key={`${blockId}:${frame}`} onSubmit={async event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      setSaving(true);
      try {await api.editTiming(id,revision,{operation:'motion',blockId,from:Number(data.get('from')),to:Number(data.get('to')),
        stationaryPx:Number(data.get('stationary'))});onRefresh();}
      catch(error) {onError(error);}
      finally {setSaving(false);}
    }}>
      {numberField('from','開始F',frame,0,1)}
      {numberField('to','終了F（手前まで）',Math.min(Math.round(design.blocks.to*scene.fps),frame+3),1,1)}
      {numberField('stationary','停止とみなす移動量（px/F）',2,.01)}
      <button disabled={saving}>計測を保存</button>
    </form>
    {last&&<>
      <p>{last.origin==='measured'?'元映像の輪郭':'編集モデル'} · 停止 {last.stops.length} 件 · 欠測 {last.missingFrames.length}F · 最大速度 {Math.max(0,...last.samples.map(row=>row.speedPxPerS??0)).toFixed(0)} px/s</p>
      <p>加速度の絶対値の最大 {Math.max(0,...last.samples.map(row=>Math.abs(row.accelerationPxPerS2??0))).toFixed(0)} px/s² · 箱の最大占有率 {(100*Math.max(0,...last.samples.map(row=>row.occupancyRatio??0))).toFixed(1)}% · 最大表示ブロック数 {Math.max(0,...last.samples.map(row=>row.visibleCount))}</p>
      {last.rmsComparison&&<p>音量と速度の相関 {last.rmsComparison.speed.map(row=>`${row.frames}F ${row.pearson?.toFixed(2)??'—'}（${row.n}点）`).join('、')}</p>}
    </>}
  </details>;
}

function Checkpoint({id,revision,frame,blockId,documents,onRefresh,onError}:Pick<Props,'id'|'revision'|'onRefresh'|'onError'>&{frame:number;blockId:string;documents:ModelDocuments|null}) {
  const [missing,setMissing]=useState(false);
  const [pending,setPending]=useState(false);
  const observations=Object.values(documents?.observations??{}).filter(entry=>{
    const row=entry as {kind?:string;blockId?:string};
    return row?.kind==='block-checkpoint'&&row.blockId===blockId;
  }) as {id:string;frame:number;visibilityMatches:boolean;score?:{centerErrorPx:number;widthRelativeError:number;heightRelativeError:number}}[];
  return <details><summary>元映像の箱を別に採点する</summary>
    <p>元動画の座標で入力します。入力した箱は変形キーの近似に使いません。</p>
    <form className="blocking-fields" key={`${blockId}:${frame}:${revision}`} onSubmit={async event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      const box=missing?null:['x','y','w','h'].map(key=>Number(data.get(key))) as [number,number,number,number];
      setPending(true);
      try {await api.editTiming(id,revision,{operation:'checkpoint',blockId,frame:Number(data.get('frame')),box,note:String(data.get('note'))});onRefresh();}
      catch(error) {onError(error);}
      finally {setPending(false);}
    }}>
      {numberField('frame','F',frame,0,1)}
      <label><input type="checkbox" checked={missing} onChange={event=>setMissing(event.target.checked)}/>元映像では非表示</label>
      {!missing&&<>{numberField('x','左',0,0)}{numberField('y','上',0,0)}{numberField('w','幅',1,1)}{numberField('h','高さ',1,1)}</>}
      <label>注記 <input name="note" maxLength={500}/></label>
      <button disabled={pending}>採点を記録</button>
    </form>
    {observations.length>0&&<ul>{observations.map(row=><li key={row.id}>{row.frame}F {row.score?`中心誤差 ${row.score.centerErrorPx.toFixed(1)} px`:row.visibilityMatches?'非表示が一致':'表示が不一致'}</li>)}</ul>}
  </details>;
}

function LyricTiming({id,revision,design,time,documents,onSeek,onRefresh,onError}:Pick<Props,'id'|'revision'|'design'|'time'|'onSeek'|'onRefresh'|'onError'>&{documents:ModelDocuments|null}) {
  const [selection,setSelection]=useState('');
  const [saving,setSaving]=useState(false);
  const observations=Object.values(documents?.observations??{});
  const lyrics=observations.filter((entry):entry is LyricSpan=>(entry as LyricSpan)?.kind==='lyric-span');
  const superseded=new Set(lyrics.map(entry=>entry.replaces));
  const active=lyrics.filter(entry=>!superseded.has(entry.id)).sort((a,b)=>a.from-b.from);
  const selected=active.find(entry=>entry.id===selection);
  const confirmed=new Set(design.events.filter(event=>event.status==='confirmed').map(event=>event.id));
  const measurements=observations.filter((entry):entry is TimingRow=>(entry as TimingRow)?.kind==='event-audio-timing');
  const last=Math.max(0,...measurements.map(entry=>entry.sourceRevision));
  const results=measurements.filter(entry=>entry.sourceRevision===last);
  const control=observations.map(entry=>entry as {kind?:string;sourceRevision:number;eventCount:number;
    groups:Record<string,{observedHits:number;shiftedHits:number[]}>}).find(entry=>entry?.kind==='event-audio-shift-control'&&entry.sourceRevision===last);
  const inRange=(t:number)=>t>=design.blocks.from&&t<design.blocks.to;
  const fmt=(match:TimingMatch|undefined)=>match?`${match.offsetSeconds>=0?'+':''}${Math.round(match.offsetSeconds*1000)} ms${match.origin==='estimated'?'（推定）':''}`:'—';
  const save=async(body:Parameters<typeof api.editTiming>[2])=>{
    setSaving(true);
    try {await api.editTiming(id,revision,body);if(body.operation==='lyric') setSelection('');onRefresh();}
    catch(error) {onError(error);}
    finally {setSaving(false);}
  };
  return <details><summary>歌詞の発音と出来事の照合</summary>
    <label>発音注釈 <select value={selected?.id??''} onChange={event=>setSelection(event.target.value)}>
      <option value="">新規</option>
      {active.map(span=><option key={span.id} value={span.id}>{span.from.toFixed(3)}秒 {span.text}</option>)}
    </select></label>
    {selected&&inRange(selected.from)&&<button type="button" onClick={()=>onSeek(selected.from)}>発音の位置へ移動</button>}
    <form className="blocking-fields" key={`${selection}:${revision}`} onSubmit={event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      void save({operation:'lyric',text:String(data.get('text')),reading:String(data.get('reading')),
        from:Number(data.get('from')),to:Number(data.get('to')),uncertaintySeconds:Number(data.get('uncertainty')),replaces:selected?.id});
    }}>
      <label>歌詞 <input name="text" required maxLength={250} defaultValue={selected?.text}/></label>
      <label>読み <input name="reading" maxLength={250} defaultValue={selected?.reading}/></label>
      {numberField('from','発音開始（秒）',selected?.from??time,0)}
      {numberField('to','発音終了（秒）',selected?.to??(time+.1),0)}
      {numberField('uncertainty','不確かさ（秒）',selected?.uncertaintySeconds??.04,0)}
      <button disabled={saving}>発音時刻を保存</button>
    </form>
    <button disabled={saving||!confirmed.size} type="button" onClick={()=>{void save({operation:'measure'});}}>発音・拍・小節頭・立ち上がりを照合</button>
    {results.length>0&&<>
      <p>計測元リビジョン {last}。負の値は映像が先行。</p>
      <table><thead><tr><th>出来事</th><th>発音</th><th>拍</th><th>小節頭</th><th>立ち上がり</th><th>判定</th></tr></thead>
        <tbody>{results.map(row=><tr key={row.id}>
          <th>{inRange(row.event.t)?<button type="button" onClick={()=>onSeek(row.event.t)}>{row.event.label}</button>:row.event.label}</th>
          {(['lyric','beat','downbeat','onset'] as const).map(key=><td key={key} title={row.matches[key].map(match=>`${match.label} ${fmt(match)}`).join('、')}>{fmt(row.matches[key][0])}</td>)}
          <td>{assessments[row.assessment]}</td>
        </tr>)}</tbody>
      </table>
      {control&&<details><summary>音の時刻をずらした対照</summary>
        <ul>{Object.entries(control.groups).map(([kind,row])=><li key={kind}>
          {({lyric:'発音',beat:'拍',downbeat:'小節頭',onset:'立ち上がり'} as Record<string,string>)[kind]??kind} · 元の時刻 {row.observedHits}/{control.eventCount}件 · ずらした時刻 {row.shiftedHits.join('、')}件
        </li>)}</ul>
      </details>}
    </>}
  </details>;
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
