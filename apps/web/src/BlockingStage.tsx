import { useEffect, useRef, useState, type RefObject } from 'react';
import { blockingFrame, drawFrame, isActive } from '@mlm/core';
import type { Blocking, BlockingView, Scene } from '@mlm/core';

const titles={source:'入力 · 元動画',motion:'中間① · 動き',events:'中間② · 関係と時刻',final:'最終調整'};
type View = keyof typeof titles | 'all';

interface Props {
  scene:Scene;
  design:Blocking;
  time:number;
  videoRef:RefObject<HTMLVideoElement|null>;
  videoUrl:string;
  onSeek:(t:number)=>void;
  children?:React.ReactNode;
}

export function BlockingStage({scene,design,time,videoRef,videoUrl,onSeek,children}:Props) {
  const [view,setView]=useState<View>('all');
  const isVisible=(pane: keyof typeof titles)=>view==='all'||view===pane;
  const firstFrame=Math.round(design.blocks.from*scene.fps);
  const lastFrame=Math.max(firstFrame,Math.round(design.blocks.to*scene.fps)-1);
  const frame=Math.min(lastFrame,Math.max(firstFrame,Math.floor(time*scene.fps+1e-7)));
  return <section className="blocking-stage" aria-label="工程比較">
    <nav className="blocking-tabs" aria-label="比較する工程">
      <button type="button" aria-pressed={view==='all'} onClick={()=>setView('all')}>4画面</button>
      {(Object.keys(titles) as (keyof typeof titles)[]).map(pane=><button type="button" key={pane} aria-pressed={view===pane} onClick={()=>setView(pane)}>{titles[pane]}</button>)}
    </nav>
    <div className={`blocking-grid ${view==='all'?'':'single'}`}>
      <figure hidden={!isVisible('source')}>
        <figcaption>{titles.source}</figcaption>
        <video ref={videoRef} src={videoUrl} playsInline preload="auto" aria-label="元動画" onLoadedMetadata={event=>{
          event.currentTarget.currentTime=(Math.floor(time*scene.fps+1e-7)+.5)/scene.fps;
        }} />
      </figure>
      {(['motion','events','final'] as const).filter(isVisible).map(pane=><figure key={pane}>
        <figcaption>{titles[pane]}</figcaption>
        <BlockingCanvas scene={scene} design={design} time={time} view={pane}/>
      </figure>)}
    </div>
    <label className="blocking-scrub">比較区間
      <input type="range" aria-label="比較区間の再生位置" aria-valuetext={`${frame}F`} min={firstFrame} max={lastFrame} step={1}
        value={frame} onChange={event=>onSeek(Number(event.currentTarget.value)/scene.fps)}/>
    </label>
    {design.blocks.measuredTo!==undefined&&design.blocks.measuredTo<design.blocks.to&&
      <p className="blocking-provenance">{Math.round(design.blocks.from*scene.fps)}〜{Math.round(design.blocks.measuredTo*scene.fps)-1}F は元映像から計測。以降の動きは既存シーンから補完。</p>}
    {design.events.some(event=>event.status!=='rejected')&&<div className="blocking-event-list" aria-label="確認する出来事">
      {design.events.filter(event=>event.status!=='rejected').map(event=><button type="button" key={event.id}
        onClick={()=>onSeek(event.t)}>{Math.round(event.t*scene.fps)}F {event.label}{event.status==='proposed'?'（候補）':''}</button>)}
    </div>}
    {children}
  </section>;
}

export function activeBlocks(scene:Scene,design:Blocking,t:number) {
  const groups=new Set(scene.elements.filter(el=>el.type==='group'&&isActive(el,scene,t)).map(el=>el.id));
  return design.blocks.items.filter(block=>groups.has(block.id)&&!block.hiddenDuring?.some(gap=>t>=gap.from&&t<gap.to));
}

function BlockingCanvas({scene,design,time,view}:{scene:Scene;design:Blocking;time:number;view:BlockingView}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const width=960, height=Math.round(width*scene.height/scene.width);
  const frameTime=Math.floor(time*scene.fps+1e-7)/scene.fps;
  useEffect(()=>{
    const ctx=canvas.current?.getContext('2d');
    if(!ctx) return;
    ctx.setTransform(width/scene.width,0,0,height/scene.height,0,0);
    drawFrame(ctx,blockingFrame(scene,design,frameTime,view),frameTime);
  },[scene,design,frameTime,view,height]);
  return <canvas ref={canvas} width={width} height={height} aria-label={titles[view]}/>;
}
