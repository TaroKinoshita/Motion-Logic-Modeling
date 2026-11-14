import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyOps as applySceneOps } from '@mlm/core';
import type { HistoryEntry, ProjectMeta, SceneElement, SceneOp } from '@mlm/core';
import { api, ApiError } from './api.ts';
import type { ExportResult, ProjectData } from './api.ts';
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
  const videoRef = useRef<HTMLVideoElement>(null);

  const scene = data?.scene;
  // ドラッグ中だけ、保存前の変更を重ねたシーンを表示する。
  const shown = useMemo(() => (scene && dragOps ? applySceneOps(scene, dragOps) : scene), [scene, dragOps]);
  const source = data?.project.source;
  const duration = scene?.duration ?? 0;
  const fps = scene?.fps ?? 30;
  const hasRange = range.in !== null && range.out !== null && range.out > range.in;
  // 再生する区間。ループ区間が有効ならその中、なければ全体。
  const playFrom = loop && hasRange ? range.in! : 0;
  const playTo = loop && hasRange ? range.out! : duration;

  const fail = useCallback((err: unknown) => {
    const e = err as ApiError;
    setMessage(`${e.message}${e.detail ? ` — ${JSON.stringify(e.detail)}` : ''}`);
  }, []);

  const reloadList = useCallback(() => api.listProjects().then((r) => setProjects(r.projects)).catch(fail), [fail]);

  const reload = useCallback(
    (id: string) => {
      if (!id) return;
      api.getProject(id).then(setData).catch(fail);
      api.history(id).then((r) => setHistory(r.history)).catch(() => {});
    },
    [fail],
  );

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
    setDragOps(null);
    setRange({ in: null, out: null });
    location.hash = projectId;
    if (projectId) reload(projectId);
  }, [projectId, reload]);

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
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('change', (ev) => {
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
    return () => es.close();
  }, [projectId, reload, reloadList]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, data]);

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
  }, [playing, source, speed, loop, playFrom, playTo]);

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(0, t), Math.max(0, duration - 1e-3));
      setTime(clamped);
      if (videoRef.current) videoRef.current.currentTime = clamped;
    },
    [duration],
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
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') step(1);
      else if (e.code === 'ArrowLeft') step(-1);
      else if (e.code === 'KeyI') setRange((r) => ({ ...r, in: Math.round(time * 1000) / 1000 }));
      else if (e.code === 'KeyO') setRange((r) => ({ ...r, out: Math.round(time * 1000) / 1000 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, step, time]);

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

  return (
    <div className="app">
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
        {(['side', 'overlay', 'render'] as ViewMode[]).map((m) => (
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
            <Stage
              scene={shown}
              baseScene={scene}
              onSelect={setSelectedId}
              onDragPreview={setDragOps}
              onDragCommit={(ops, note) => void applyOps(ops, note)}
              time={time}
              mode={mode}
              videoRef={videoRef}
              videoUrl={source ? `/api/projects/${data.project.id}/media/source?v=${source.sha256.slice(0, 8)}` : null}
              selectedId={selectedId}
            />
            <Inspector
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
            />
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
              <span className="sep" />
              <button onClick={() => setRange((r) => ({ ...r, in: Math.round(time * 1000) / 1000 }))} title="区間の始点を現在位置に（I）">
                イン
              </button>
              <button onClick={() => setRange((r) => ({ ...r, out: Math.round(time * 1000) / 1000 }))} title="区間の終点を現在位置に（O）">
                アウト
              </button>
              <button className={loop ? 'on' : ''} onClick={() => setLoop((l) => !l)} title="区間（なければ全体）を繰り返し再生">
                ループ
              </button>
              {(range.in !== null || range.out !== null) && (
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
              <select value={exportLayout} onChange={(e) => setExportLayout(e.target.value as 'render' | 'compare')} title="書き出す内容">
                <option value="render">簡略版だけ</option>
                {source && <option value="compare">元動画と左右に並べる</option>}
              </select>
              <button disabled={exporting} title="MP4に書き出す（区間があればその範囲、元動画の音声つき、最大120秒）" onClick={runExport}>
                {exporting ? '書き出し中…' : 'MP4書き出し'}
              </button>
            </div>
            <Timeline
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
            />
          </footer>
        </>
      )}
    </div>
  );
}
