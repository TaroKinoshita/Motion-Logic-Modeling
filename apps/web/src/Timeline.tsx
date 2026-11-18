import { useState, type MouseEvent, type PointerEvent } from 'react';
import { timelineKeys, resolveTime, shiftKeyTimeOps, snapTime } from '@mlm/core';
import type { Scene, SceneElement, SceneOp } from '@mlm/core';

export interface LoopRange {
  in: number | null;
  out: number | null;
}

interface Props {
  /** 表示するシーン（ドラッグ中は仮の変更を含む）。 */
  scene: Scene;
  /** 保存済みのシーン。 */
  baseScene: Scene;
  time: number;
  selectedId: string | null;
  range: LoopRange;
  /** 音声の波形（0..1）。なければ行を出さない。 */
  peaks: number[] | null;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
  onKeyPreview: (ops: SceneOp[] | null) => void;
  onKeyCommit: (ops: SceneOp[], note: string) => void;
}

function wavePath(peaks: number[]): string {
  const n = peaks.length;
  const top = peaks.map((p, i) => `${(i / n) * 100},${50 - p * 48}`);
  const bottom = peaks.map((p, i) => `${(i / n) * 100},${50 + p * 48}`).reverse();
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

/** 共通タイムライン。要素ごとの表示区間・キー時刻・マーカー・波形・再生位置を同じ時間軸に並べる。 */
export function Timeline({ scene, baseScene, time, selectedId, range, peaks, onSeek, onSelect, onKeyPreview, onKeyCommit }: Props) {
  const [snap,setSnap]=useState(false);
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), scene.duration) / scene.duration) * 100}%`;
  const seekFrom = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - r.left) / r.width) * scene.duration);
  };
  const ticks = Array.from({ length: Math.floor(scene.duration) + 1 }, (_, i) => i);

  // キーを左右にドラッグして時刻を動かす。ドラッグ中は要素が描き直されるので、移動はウィンドウで受ける。
  const startKeyDrag = (e: PointerEvent<HTMLSpanElement>, id: string, fromT: number) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(id);
    const lane = e.currentTarget.parentElement!.getBoundingClientRect();
    let ops: SceneOp[] = [];
    let toT = fromT;
    const move = (ev: globalThis.PointerEvent) => {
      toT = Math.round(((ev.clientX - lane.left) / lane.width) * scene.duration * 1000) / 1000;
      if(snap) toT=snapTime(baseScene,toT,'cut-frame');
      ops = shiftKeyTimeOps(baseScene, id, fromT, toT);
      onKeyPreview(ops);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (ops.length && Math.abs(toT - fromT) > 1e-6) onKeyCommit(ops, `要素 ${id} のキーを ${fromT}秒 から ${toT}秒 付近へ移動`);
      else onKeyPreview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const band = range.in !== null && range.out !== null && range.out > range.in && (
    <span className="range" style={{ left: pct(range.in), width: `calc(${pct(range.out)} - ${pct(range.in)})` }} />
  );

  return (
    <div className="timeline">
      <label><input type="checkbox" checked={snap} onChange={e=>setSnap(e.target.checked)}/>キーのドラッグをカット・フレームへ吸着</label>
      <div className="row ruler">
        <div className="name" />
        <div className="lane" onMouseDown={seekFrom} onMouseMove={(e) => e.buttons === 1 && seekFrom(e)}>
          {band}
          {ticks.map((s) => (
            <span key={s} className="tick" style={{ left: pct(s) }}>
              {s}
            </span>
          ))}
          {(scene.markers ?? []).map((m, i) => (
            <span
              key={i}
              className={`marker ${m.kind} ${m.origin === 'estimated' ? 'estimated' : ''}`}
              style={{ left: pct(m.t) }}
              title={`${m.kind} ${m.t}秒 ${m.label ?? ''}${m.origin ? `（${m.origin}）` : ''}`}
            >
              {m.label ?? m.kind}
            </span>
          ))}
          <span className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
      <div className="rows">
        {peaks && (
          <div className="row wave">
            <div className="name">音声（波形）</div>
            <div className="lane" onMouseDown={seekFrom}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <path d={wavePath(peaks)} />
              </svg>
              {band}
              <span className="playhead" style={{ left: pct(time) }} />
            </div>
          </div>
        )}
        {scene.elements.map((el) => { const timeline = timelineKeys(el, scene); return (
          <div key={el.id} className={`row ${el.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(el.id)}>
            <div className="name" title={el.note}>
              {el.name ?? el.id}{timeline.truncated ? '（キー表示省略あり）' : ''}
            </div>
            <div className="lane" onMouseDown={seekFrom}>
              <span
                className="bar"
                style={{
                  left: pct(resolveTime(el.inPoint ?? 0, scene.tempo)),
                  width: `calc(${pct(resolveTime(el.outPoint ?? scene.duration, scene.tempo))} - ${pct(resolveTime(el.inPoint ?? 0, scene.tempo))})`,
                  background: el.type === 'group' ? '#555' : el.fill && el.fill !== 'none' ? el.fill : el.stroke,
                }}
              />
              {timeline.times.map((t, i) => (
                <span
                  key={i}
                  className="key"
                  style={{ left: pct(t) }}
                  title={`${t}秒${timeline.readOnly ? '（関係から展開・JSONで編集）' : '（ドラッグで移動）'}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => { if (!timeline.readOnly) startKeyDrag(e, el.id, t); }}
                />
              ))}
              <span className="playhead" style={{ left: pct(time) }} />
            </div>
          </div>
        ); })}
      </div>
    </div>
  );
}
