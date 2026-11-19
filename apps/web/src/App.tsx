import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyOps as applySceneOps, blockingFrame } from '@mlm/core';
import type { Blocking, HistoryEntry, ProjectMeta, SceneElement, SceneOp } from '@mlm/core';
import { BlockingStage } from './BlockingStage.tsx';
import { BlockJobStatus, BlockingTools, busyJob } from './BlockingTools.tsx';
import { api, ApiError } from './api.ts';
import type { BlockJob, ExportResult, ProjectData } from './api.ts';
import { Inspector } from './Inspector.tsx';
import { Stage } from './Stage.tsx';
import type { ViewMode } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import type { LoopRange } from './Timeline.tsx';

export function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectId, setProjectId] = useState<string>(() => location.hash.slice(1));
  const [data, setData] = useState<ProjectData | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<ViewMode>('side');
  const [message, setMessage] = useState<string>('');
  const [dragOps, setDragOps] = useState<SceneOp[] | null>(null);
  const [range, setRange] = useState<LoopRange>({ in: null, out: null });
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [exportLayout, setExportLayout] = useState<'render' | 'compare'>('render');
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [blocking,setBlocking]=useState<{id:string;design:Blocking}|null>(null);
  const [showBlocking,setShowBlocking]=useState(false);
  const [blockJob,setBlockJob]=useState<BlockJob|null>(null);
  const [analysisProfile,setAnalysisProfile]=useState<'luma'|'flat-color'|'framed-type'|'type-only'>('luma');
  const videoRef = useRef<HTMLVideoElement>(null);

  const scene = data?.scene;
  // ドラッグ中だけ、保存前の変更を重ねたシーンを表示する。
  const shown = useMemo(() => (scene && dragOps ? applySceneOps(scene, dragOps) : scene), [scene, dragOps]);
  const source = data?.project.source;
  const id=data?.project.id, revision=data?.project.revision;
  const design=blocking?.id===projectId?blocking.design:null;
  const activeBlocking=showBlocking?design:null;
  const duration = scene?.duration ?? 0;
  const fps = scene?.fps ?? 30;
  const hasRange = range.in !== null && range.out !== null && range.out > range.in;
  // 再生する区間。ループ区間が有効ならその中、なければ全体。
  const playFrom = activeBlocking?.blocks.from ?? (loop && hasRange ? range.in! : 0);
  const playTo = activeBlocking?.blocks.to ?? (loop && hasRange ? range.out! : duration);

  const fail = useCallback((err: unknown) => {
    const e = err as ApiError;
    setMessage(`${e.message}${e.detail ? ` — ${JSON.stringify(e.detail)}` : ''}`);
  }, []);

  const reloadList = useCallback(() => api.listProjects().then((r) => setProjects(r.projects)).catch(fail), [fail]);

  useEffect(()=>{
    if(!id||id!==projectId) return;
    const controller=new AbortController();
    fetch(`/api/projects/${id}/blocking`,{signal:controller.signal}).then(async response=>{
      const value=await response.json();
      if(!response.ok) throw new Error(value.error??'工程比較を読み込めません');
      setBlocking(value.design?{id,design:value.design}:null);
      if(value.design&&new URLSearchParams(location.search).get('compare')==='1') {
        const {from,to}=value.design.blocks;
        setTime(current=>current<from||current>=to?from:current);
        setShowBlocking(true);
      }
    }).catch(error=>{if(!controller.signal.aborted) {setBlocking(null);fail(error);}});
    return ()=>controller.abort();
  },[id,revision,projectId,fail]);

  const reload = useCallback(
    (id: string) => {
      if (!id) return;
      api.getProject(id).then(setData).catch(fail);
      api.history(id).then((r) => setHistory(r.history)).catch(() => {});
    },
    [fail],
  );
  useEffect(()=>{
    if(!id||!blockJob||!busyJob(blockJob)) return;
    const timer=window.setTimeout(()=>{
      void api.blockingJob(id,blockJob.id).then(job=>{
        setBlockJob(job);
        if(job.state==='done') {
          if(job.operation==='export') setExported(job.output??null);
          else if(job.resultProjectId) reloadList();
          else {setShowBlocking(true);reload(id);}
        }
      }).catch(error=>{setBlockJob(null);fail(error);});
    },350);
    return ()=>window.clearTimeout(timer);
  },[id,blockJob,reload,reloadList,fail]);

  useEffect(() => void reloadList(), [reloadList]);

  useEffect(() => {
    const onHash = () => setProjectId(location.hash.slice(1));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    setData(null);
    setSelectedId(null);
    setTime(0);
    setPlaying(false);
    setExported(null);
    setShowBlocking(false);
    setBlocking(null);
    setBlockJob(null);
    setDragOps(null);
    setRange({ in: null, out: null });
    location.hash = projectId;
    if (projectId) reload(projectId);
  }, [projectId, reload]);
  useEffect(()=>{
    if(!projectId) return;
    let active=true;
    void api.latestBlockingJob(projectId).then(({job})=>{
      if(!active||!job) return;
      setBlockJob(previous=>previous??job);
    }).catch(()=>{});
    return ()=>{active=false;};
  },[projectId]);

  // 音声の波形（表示用）。元動画が変わったら取り直す。
  const audioKey = source?.hasAudio ? source.sha256 : null;
  useEffect(() => {
    setPeaks(null);
    if (!audioKey || !projectId) return;
    let alive = true;
    api
      .waveform(projectId)
      .then((w) => alive && setPeaks(w.peaks))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [audioKey, projectId]);

  // サーバーからの変更通知（AIや別タブの変更）を受けて読み直す。
  // サーバーが再起動すると、開発用プロキシは接続を開いたまま何も流さなくなるか、エラー応答で EventSource を
  // 閉じてしまい、その後のAIの変更が画面に出なくなった（実測）。サーバーは10秒ごとに ping を送るので、
  // 25秒なにも届かないか接続が閉じたら作り直す。2回目以降の接続では読み直して取りこぼしを埋める。
  useEffect(() => {
    let es: EventSource | null = null;
    let retry = 0;
    let watchdog = 0;
    let closed = false;
    let first = true;
    const reconnect = () => {
      if (closed) return;
      es?.close();
      window.clearTimeout(retry);
      retry = window.setTimeout(connect, 2000);
    };
    const alive = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(reconnect, 25000);
    };
    const connect = () => {
      es = new EventSource('/api/events');
      alive();
      es.addEventListener('ping', alive);
      es.addEventListener('hello', () => {
        alive();
        if (first) return void (first = false);
        reloadList();
        if (projectId) reload(projectId);
      });
      es.addEventListener('change', (ev) => {
        alive();
        const e = JSON.parse((ev as MessageEvent).data) as { projectId: string; actor: string; revision: number };
        reloadList();
        if (e.projectId !== projectId) return;
        if (e.revision < 0) {
          setProjectId('');
          setMessage('このプロジェクトはごみ箱へ移されました');
          return;
        }
        reload(projectId);
        if (e.actor !== 'human') setMessage(`${e.actor} がリビジョン ${e.revision} に更新しました`);
      });
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) reconnect();
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(watchdog);
      es?.close();
    };
  }, [projectId, reload, reloadList]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, data, activeBlocking]);

  // 再生。元動画があれば動画の時刻を基準にし、簡略版はそれに追従する。
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const v = videoRef.current;
      if (source && v) {
        if (v.ended || v.currentTime >= playTo) {
          if (loop) {
            v.currentTime = playFrom;
            void v.play();
          } else {
            v.pause();
            if (activeBlocking) {
              const lastFrame = Math.max(playFrom, playTo - .5 / fps);
              v.currentTime = lastFrame;
              setTime(lastFrame);
            }
            setPlaying(false);
            return;
          }
        }
        setTime(v.currentTime);
      } else {
        const dt = ((now - last) / 1000) * speed;
        setTime((t) => (t + dt >= playTo ? playFrom : t + dt));
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, source, speed, loop, playFrom, playTo, activeBlocking, fps]);

  const seek = useCallback(
    (t: number) => {
      const from=activeBlocking?.blocks.from??0;
      const until=activeBlocking?.blocks.to??duration;
      const requested=activeBlocking?(Math.floor(t*fps+1e-7)+.5)/fps:t;
      const clamped = Math.min(Math.max(from, requested), Math.max(from, until - 1e-3));
      setTime(clamped);
      if (videoRef.current) videoRef.current.currentTime = clamped;
    },
    [duration,activeBlocking,fps],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (playing) {
      v?.pause();
      setPlaying(false);
    } else {
      if (time >= playTo - 1 / fps || time < playFrom) seek(playFrom);
      void v?.play();
      setPlaying(true);
    }
  }, [playing, time, playFrom, playTo, fps, seek]);

  const step = useCallback(
    (frames: number) => {
      videoRef.current?.pause();
      setPlaying(false);
      // フレーム中央の時刻に合わせ、動画側の丸めで前後のフレームに落ちないようにする。
      seek((Math.floor(time * fps + 1e-6) + frames + 0.5) / fps);
    },
    [time, fps, seek],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.code === 'Space') {
        if ((e.target as HTMLElement).closest('button, a')) return;
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') step(1);
      else if (e.code === 'ArrowLeft') step(-1);
      else if (e.code === 'KeyI' && !activeBlocking) setRange((r) => ({ ...r, in: Math.round(time * 1000) / 1000 }));
      else if (e.code === 'KeyO' && !activeBlocking) setRange((r) => ({ ...r, out: Math.round(time * 1000) / 1000 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, step, time, activeBlocking]);

  const applyOps = useCallback(
    async (ops: SceneOp[], note: string) => {
      if (!data) return;
      try {
        setData(await api.updateScene(data.project.id, data.project.revision, ops, note));
        setDragOps(null); // 保存結果と同じ描画更新で仮の変更を外す（二重に動いて見えるのを防ぐ）
        setMessage('');
      } catch (err) {
        setDragOps(null);
        fail(err);
        if ((err as ApiError).status === 409) reload(data.project.id);
      }
    },
    [data, fail, reload],
  );

  const createProject = async (template: 'empty' | 'demo') => {
    const name = prompt('プロジェクト名', template === 'demo' ? 'デモ' : '新規プロジェクト');
    if (!name) return;
    try {
      const created = await api.createProject(name, template);
      await reloadList();
      setProjectId(created.project.id);
    } catch (err) {
      fail(err);
    }
  };

  const deleteProject = async () => {
    if (!data || !confirm(`「${data.project.name}」をごみ箱（data/trash）へ移しますか？`)) return;
    try {
      await api.deleteProject(data.project.id);
      setProjectId('');
      await reloadList();
    } catch (err) {
      fail(err);
    }
  };

  const addRect = () => {
    if (!scene) return;
    let n = scene.elements.length + 1;
    while (scene.elements.some((e) => e.id === `el${n}`)) n++;
    const element: SceneElement = {
      id: `el${n}`,
      type: 'rect',
      width: 200,
      height: 80,
      fill: '#f2f2f2',
      transform: { x: scene.width / 2, y: scene.height / 2 },
    };
    void applyOps([{ op: 'upsertElement', element }], `矩形 ${element.id} を追加`);
    setSelectedId(element.id);
  };

  const runExport = () => {
    if (!data) return;
    setExporting(true);
    api
      .exportVideo(data.project.id, { layout: exportLayout, ...(hasRange ? { from: range.in!, to: range.out! } : {}) })
      .then(setExported)
      .catch(fail)
      .finally(() => setExporting(false));
  };

  const compareStages = () => {
    videoRef.current?.pause();
    setPlaying(false);
    if (!showBlocking && design && (time < design.blocks.from || time >= design.blocks.to)) setTime(design.blocks.from);
    setExported(null);
    setShowBlocking(!showBlocking);
  };
  const exportStages = async () => {
    if(!data) return;
    try {setBlockJob(await api.exportBlocking(data.project.id,data.project.revision));}
    catch(error) {fail(error);}
  };

  return (
    <div className={activeBlocking?'app app-blocking':'app'}>
      <header>
        <strong>Motion Logic</strong>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">プロジェクトを選択…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（r{p.revision}）
            </option>
          ))}
        </select>
        <button onClick={() => createProject('empty')}>新規</button>
        <button onClick={() => createProject('demo')}>デモを作成</button>
        {data && <button onClick={deleteProject}>ごみ箱へ</button>}
        <span className="spacer" />
        {design && <button aria-pressed={showBlocking} onClick={compareStages}>{showBlocking?'シーン編集へ戻る':'工程比較'}</button>}
        {id&&revision!==undefined&&activeBlocking?.appearance.some(item=>item.contours?.length)&&<button disabled={!!busyJob(blockJob)} onClick={()=>{
          void api.analyzeBlocking(id,revision,{engine:'sequence-model'}).then(setBlockJob).catch(fail);
        }}>全編を固定形状とキーに変換</button>}
        {id&&revision&&source&&!design&&<><select aria-label="輪郭の解析方式" value={analysisProfile} onChange={event=>
          setAnalysisProfile(event.target.value as typeof analysisProfile)}>
          <option value="luma">明暗</option><option value="flat-color">単色背景と色文字</option>
          <option value="framed-type">枠と文字</option><option value="type-only">暗地の高コントラスト文字</option>
        </select><button disabled={!!busyJob(blockJob)} onClick={()=>{
          const cuts=scene?.markers?.filter(marker=>marker.kind==='cut').map(marker=>Math.round(marker.t*scene.fps));
          const frames=source.frameCount??Math.round(source.duration*source.fps);
          const step=Math.max(12,Math.ceil(frames/100));
          const ocrFrames=Array.from({length:Math.floor(frames/step)},(_,index)=>Math.round(step*(index+.5)));
          void api.analyzeBlocking(id,revision,{cuts,ocrFrames,to:frames,profile:analysisProfile==='luma'?undefined:analysisProfile}).then(setBlockJob).catch(fail);
        }}>輪郭と動きを解析</button></>}
        {id&&blockJob&&<BlockJobStatus job={blockJob}
          onCancel={()=>{void api.cancelBlocking(id,blockJob.id).then(setBlockJob).catch(fail);}}
          onRetry={()=>{void api.retryBlocking(id,blockJob.id).then(setBlockJob).catch(fail);}}/>}
        {!activeBlocking && (['side', 'overlay', 'render'] as ViewMode[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {m === 'side' ? '左右比較' : m === 'overlay' ? '重ね表示' : '簡略のみ'}
          </button>
        ))}
        {data && <span className="rev">リビジョン {data.project.revision}</span>}
      </header>

      {message && (
        <div className="message" onClick={() => setMessage('')}>
          {message}
        </div>
      )}

      {source?.variableFrameRate && (
        <div className="message">
          この動画は可変フレームレートの可能性があります（表記 {source.frameRate} / 平均 {source.avgFrameRate}）。フレーム番号と時刻の対応が一定でない場合があるので、時刻（秒）を基準に確認してください。
        </div>
      )}

      {!data || !scene || !shown ? (
        <main className="empty">プロジェクトを選ぶか、「デモを作成」で動作を確認してください。</main>
      ) : (
        <>
          <main>
            {activeBlocking && source ? <BlockingStage scene={shown} design={activeBlocking} time={time} videoRef={videoRef}
              videoUrl={`/api/projects/${data.project.id}/media/source?v=${source.sha256.slice(0, 8)}`} onSeek={seek}>
              <BlockingTools key={data.project.id} design={activeBlocking} scene={shown} time={time} id={data.project.id}
                revision={data.project.revision} job={blockJob} onJob={setBlockJob} onRefresh={()=>reload(data.project.id)} onError={fail}
                projects={projects} audio={data.project.audioAnalysis} hasAudio={source.hasAudio} onSeek={seek}/>
            </BlockingStage> : <Stage
              scene={design?blockingFrame(shown,design,Math.floor(time*fps+1e-7)/fps,'final'):shown}
              baseScene={scene}
              onSelect={setSelectedId}
              onDragPreview={setDragOps}
              onDragCommit={(ops, note) => void applyOps(ops, note)}
              time={time}
              mode={mode}
              videoRef={videoRef}
              videoUrl={source ? `/api/projects/${data.project.id}/media/source?v=${source.sha256.slice(0, 8)}` : null}
              selectedId={selectedId}
            />}
            {!activeBlocking && <Inspector
              data={data}
              history={history}
              selectedId={selectedId}
              onApply={applyOps}
              onAddRect={addRect}
              onSelect={setSelectedId}
              onImported={(d) => {
                setData(d);
                seek(0);
              }}
              onRevert={(rev) =>
                api
                  .revert(data.project.id, rev, data.project.revision)
                  .then(setData)
                  .catch(fail)
              }
              onDetectCuts={(threshold) =>
                api
                  .detectCuts(data.project.id, data.project.revision, threshold)
                  .then((r) => {
                    reload(data.project.id);
                    setMessage(`カット候補を ${r.cuts.length} 件置きました（推定。前後のフレームで確認してください）`);
                  })
                  .catch(fail)
              }
              onError={fail}
            />}
          </main>
          <footer>
            <div className="transport">
              <button onClick={() => step(-1)} title="1フレーム戻る（←）">◀</button>
              <button onClick={togglePlay} title="再生/停止（Space）">{playing ? '停止' : '再生'}</button>
              <button onClick={() => step(1)} title="1フレーム進む（→）">▶</button>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="再生速度">
                {[0.25, 0.5, 1, 2].map((s) => (
                  <option key={s} value={s}>
                    {s}倍
                  </option>
                ))}
              </select>
              <span className="time">
                {time.toFixed(3)} / {duration.toFixed(3)} 秒　フレーム {Math.floor(time * fps + 1e-6)}　{fps.toFixed(3)} fps
              </span>
              {!activeBlocking && <><span className="sep" />
              <button onClick={() => setRange((r) => ({ ...r, in: Math.round(time * 1000) / 1000 }))} title="区間の始点を現在位置に（I）">
                イン
              </button>
              <button onClick={() => setRange((r) => ({ ...r, out: Math.round(time * 1000) / 1000 }))} title="区間の終点を現在位置に（O）">
                アウト
              </button></>}
              <button className={loop ? 'on' : ''} onClick={() => setLoop((l) => !l)} title="区間（なければ全体）を繰り返し再生">
                ループ
              </button>
              {!activeBlocking && (range.in !== null || range.out !== null) && (
                <>
                  <span className="time">
                    区間 {range.in?.toFixed(3) ?? '—'} 〜 {range.out?.toFixed(3) ?? '—'}
                  </span>
                  <button onClick={() => setRange({ in: null, out: null })} title="区間を解除">
                    ×
                  </button>
                </>
              )}
              <span className="spacer" />
              {exported && (
                <a href={exported.url} target="_blank" rel="noreferrer" title={exported.path}>
                  r{exported.revision} の書き出しを開く（{exported.frameCount}フレーム{exported.hasAudio ? '・音声つき' : ''}）
                </a>
              )}
              {activeBlocking?<button disabled={!!busyJob(blockJob)} onClick={exportStages}>{blockJob?.operation==='export'&&busyJob(blockJob)?'書き出し中…':'4画面をMP4に書き出す'}</button>:<>
              <select value={exportLayout} onChange={(e) => setExportLayout(e.target.value as 'render' | 'compare')} title="書き出す内容">
                <option value="render">簡略版だけ</option>
                {source && <option value="compare">元動画と左右に並べる</option>}
              </select>
              <button disabled={exporting} title="MP4に書き出す（区間があればその範囲、元動画の音声つき、最大120秒）" onClick={runExport}>
                {exporting ? '書き出し中…' : 'MP4書き出し'}
              </button>
              </>}
            </div>
            {!activeBlocking && <Timeline
              scene={shown}
              baseScene={scene}
              time={time}
              selectedId={selectedId}
              range={range}
              peaks={peaks}
              onSeek={seek}
              onSelect={setSelectedId}
              onKeyPreview={setDragOps}
              onKeyCommit={(ops, note) => void applyOps(ops, note)}
            />}
          </footer>
        </>
      )}
    </div>
  );
}
