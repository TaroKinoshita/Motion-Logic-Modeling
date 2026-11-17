import { useEffect, useRef } from 'react';
import type { PointerEvent, RefObject } from 'react';
import {
  drawFrame,
  canvasMeasurer,
  selectionFrame,
  evaluateScene,
  hitTest,
  moveElementOps,
  rotateElementOps,
  sampleTrajectory,
  scaleElementOps,
} from '@mlm/core';
import type { EvaluatedElement, Scene, SceneOp } from '@mlm/core';

export type ViewMode = 'side' | 'overlay' | 'render';

interface Props {
  /** 表示するシーン（ドラッグ中は仮の変更を含む）。 */
  scene: Scene;
  /** 保存済みのシーン。 */
  baseScene: Scene;
  time: number;
  mode: ViewMode;
  videoUrl: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** ドラッグ中の仮の変更（保存しない）。null で取り消し。 */
  onDragPreview: (ops: SceneOp[] | null) => void;
  /** ドラッグ終了。ここで1リビジョンとして保存する。 */
  onDragCommit: (ops: SceneOp[], note: string) => void;
}

interface Drag {
  kind: 'move' | 'scale' | 'rotate';
  id: string;
  startX: number;
  startY: number;
  /** 拡縮・回転の基準になる要素の中心（シーン座標）。 */
  cx: number;
  cy: number;
  ops: SceneOp[];
}

interface Handles {
  corners: Array<[number, number]>;
  rotate: [number, number];
}

/**
 * 選択枠の四隅（拡縮用）と、上辺の外側の点（回転用）をシーン座標で返す。
 * 回転用の点が画面の外に出る場合（画面の上端近くの要素など）は、つかめるように下辺の外側に出す。
 */
function handlesOf(sel: EvaluatedElement, pxScale: number, sceneW: number, sceneH: number): Handles {
  const [a, b, c, d, e, f] = sel.matrix;
  const at = (lx: number, ly: number): [number, number] => [a * lx + c * ly + e, b * lx + d * ly + f];
  const w = sel.width / 2;
  const h = sel.height / 2;
  const off = 28 * pxScale;
  const outside = (edgeY: number): [number, number] => {
    const p = at(0, edgeY);
    const len = Math.hypot(p[0] - e, p[1] - f) || 1;
    return [p[0] + ((p[0] - e) / len) * off, p[1] + ((p[1] - f) / len) * off];
  };
  const inView = ([x, y]: [number, number]) => x >= 0 && x <= sceneW && y >= 0 && y <= sceneH;
  const top = outside(-h);
  return {
    corners: [at(-w, -h), at(w, -h), at(w, h), at(-w, h)],
    rotate: inView(top) ? top : outside(h),
  };
}

const NOTES = { move: 'ドラッグで移動', scale: 'ドラッグで拡縮', rotate: 'ドラッグで回転' };

/** 元動画と簡略版の表示。簡略版は core の drawFrame をそのまま呼ぶ（サーバーの書き出しと同じ描画）。 */
export function Stage({ scene, baseScene, time, mode, videoUrl, videoRef, selectedId, onSelect, onDragPreview, onDragCommit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const trajectoryCache = useRef<{ scene: Scene; id: string; paths: Map<number, Array<{x: number; y: number}>> } | null>(null);
  const overlay = mode === 'overlay' && !!videoUrl;

  /** シーン1pxあたりの画面px の逆数（画面上の1pxがシーンで何pxか）。 */
  const pxScaleOf = (canvas: HTMLCanvasElement) => scene.width / Math.max(1, canvas.getBoundingClientRect().width);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFrame(ctx, scene, time, { transparent: overlay });
    if (!selectedId) return;
    const px = pxScaleOf(canvas);

    // 選択中の要素の軌道。点はフレームごとなので、点の間隔が速さを表す。
    const selected = scene.elements.find(el => el.id === selectedId);
    const cached = trajectoryCache.current;
    const paths = cached?.scene === scene && cached.id === selectedId ? cached.paths : new Map<number, Array<{x: number; y: number}>>();
    if (paths !== cached?.paths) {
    if (selected?.split) {
      for (let t = 0; t < scene.duration; t += Math.max(1 / scene.fps, scene.duration / 300)) {
        for (const unit of evaluateScene(scene, t, canvasMeasurer(ctx)).filter(e => e.element.id === selectedId && e.opacity > 0)) {
          const key = unit.unitIndex ?? 0;
          if (!paths.has(key)) paths.set(key, []);
          paths.get(key)!.push({ x: unit.cx, y: unit.cy });
        }
      }
    } else paths.set(0, sampleTrajectory(scene, selectedId));
    trajectoryCache.current = { scene, id: selectedId, paths };
    }
    for (const path of paths.values()) {
      if (path.length < 2) continue;
      ctx.strokeStyle = 'rgba(51,208,255,0.45)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }

    const sel = selectionFrame(scene, selectedId, time, canvasMeasurer(ctx));
    if (!sel) return;
    const h = handlesOf(sel, px, scene.width, scene.height);
    ctx.strokeStyle = '#33d0ff';
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 5 * px]);
    ctx.beginPath();
    h.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    for (const [x, y] of h.corners) {
      ctx.fillRect(x - 5 * px, y - 5 * px, 10 * px, 10 * px);
      ctx.strokeRect(x - 5 * px, y - 5 * px, 10 * px, 10 * px);
    }
    ctx.beginPath();
    ctx.arc(h.rotate[0], h.rotate[1], 6 * px, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }, [scene, time, overlay, selectedId]);

  const toScene = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * scene.width, y: ((e.clientY - r.top) / r.height) * scene.height };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = toScene(e);
    const px = pxScaleOf(e.currentTarget);
    const near = ([x, y]: [number, number]) => Math.hypot(p.x - x, p.y - y) <= 10 * px;
    const start = (kind: Drag['kind'], id: string, cx: number, cy: number) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind, id, startX: p.x, startY: p.y, cx, cy, ops: [] };
    };
    // 先に、選択中の要素のハンドル（回転・拡縮）を調べる。
    const sel = selectedId ? selectionFrame(scene, selectedId, time, canvasMeasurer(e.currentTarget.getContext('2d')!)) : undefined;
    if (sel) {
      const h = handlesOf(sel, px, scene.width, scene.height);
      if (near(h.rotate)) return start('rotate', sel.element.id, sel.cx, sel.cy);
      if (h.corners.some(near)) return start('scale', sel.element.id, sel.cx, sel.cy);
    }
    const hit = hitTest(scene, time, p.x, p.y, canvasMeasurer(e.currentTarget.getContext('2d')!));
    onSelect(hit?.element.id ?? null);
    if (hit) start('move', hit.element.id, hit.cx, hit.cy);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toScene(e);
    // 変化量は常にドラッグ開始時の保存済みシーンを基準に計算する（仮の変更を積み重ねない）。
    if (d.kind === 'move') {
      d.ops = moveElementOps(baseScene, d.id, p.x - d.startX, p.y - d.startY, time);
    } else if (d.kind === 'scale') {
      const from = Math.hypot(d.startX - d.cx, d.startY - d.cy);
      d.ops = from > 1e-6 ? scaleElementOps(baseScene, d.id, Math.max(0.01, Math.hypot(p.x - d.cx, p.y - d.cy) / from)) : [];
    } else {
      const delta = Math.atan2(p.y - d.cy, p.x - d.cx) - Math.atan2(d.startY - d.cy, d.startX - d.cx);
      d.ops = rotateElementOps(baseScene, d.id, Math.round(((delta * 180) / Math.PI) * 10) / 10);
    }
    onDragPreview(d.ops);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.ops.length) onDragCommit(d.ops, `要素 ${d.id} を${NOTES[d.kind]}`);
    else onDragPreview(null);
  };

  const aspect = `${scene.width} / ${scene.height}`;
  return (
    <div className={`stage ${mode}`}>
      {videoUrl && (
        <div className="pane" style={{ aspectRatio: aspect, display: mode === 'render' ? 'none' : undefined }}>
          <span className="label">元動画</span>
          <video ref={videoRef} src={videoUrl} preload="auto" playsInline />
        </div>
      )}
      {!videoUrl && mode !== 'render' && (
        <div className="pane placeholder" style={{ aspectRatio: aspect }}>
          元動画は未取り込み（右のパネルから取り込めます）
        </div>
      )}
      <div className={`pane ${overlay ? 'over' : ''}`} style={{ aspectRatio: aspect }}>
        <span className="label">簡略版</span>
        <canvas
          ref={canvasRef}
          width={scene.width}
          height={scene.height}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </div>
  );
}
