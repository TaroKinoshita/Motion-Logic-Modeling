// シーンの部分更新と、スキーマでは表せない整合性の検査。純粋関数。
import { SCHEMA_VERSION } from './schema.ts';
import { worldMatrixOf } from './evaluate.ts';
import type { Scene, SceneElement, SceneOp, Track } from './schema.ts';

export function emptyScene(): Scene {
  return {
    schemaVersion: SCHEMA_VERSION,
    width: 1280,
    height: 720,
    fps: 30,
    duration: 10,
    background: '#101014',
    elements: [],
    markers: [],
  };
}

/** 接続確認用の最小デモ。3つの矩形が時間差で入り、止まり、円が広がる。 */
export function demoScene(): Scene {
  const scene = emptyScene();
  scene.duration = 6;
  const colors = ['#f2f2f2', '#f2f2f2', '#ffcc33'];
  colors.forEach((fill, i) => {
    const start = Number((0.4 + i * 0.18).toFixed(3));
    const arrive = Number((start + 0.6).toFixed(3));
    const shown = Number((start + 0.15).toFixed(3));
    scene.elements.push({
      id: `bar${i + 1}`,
      name: `文字ブロック${i + 1}`,
      type: 'rect',
      width: 220,
      height: 64,
      fill,
      zIndex: 1,
      note: '単語1つを矩形1つに置換した例',
      transform: {
        x: { keys: [{ t: start, v: -200, ease: 'overshoot' }, { t: arrive, v: 380 + i * 260 }] },
        y: 360,
        opacity: { keys: [{ t: start, v: 0 }, { t: shown, v: 1 }, { t: 3.4, v: 1, ease: 'hold' }, { t: 3.5, v: 0 }] },
      },
    });
  });
  scene.elements.push({
    id: 'burst',
    name: '解放（円の拡大）',
    type: 'ellipse',
    width: 200,
    height: 200,
    fill: 'none',
    stroke: '#ffcc33',
    strokeWidth: 10,
    inPoint: 3.5,
    zIndex: 2,
    transform: {
      x: 640,
      y: 360,
      scaleX: { keys: [{ t: 3.5, v: 0.1, ease: 'easeOut' }, { t: 4.6, v: 6 }] },
      scaleY: { keys: [{ t: 3.5, v: 0.1, ease: 'easeOut' }, { t: 4.6, v: 6 }] },
      opacity: { keys: [{ t: 3.5, v: 1 }, { t: 4.6, v: 0 }] },
    },
  });
  scene.markers = [{ t: 3.5, kind: 'note', label: '停止→解放', origin: 'manual' }];
  return scene;
}

/** id重複、存在しない親、親子の循環、時刻の逆転などを文字列の一覧で返す。空なら問題なし。 */
export function validateScene(scene: Scene): string[] {
  const issues: string[] = [];
  const byId = new Map<string, SceneElement>();
  for (const el of scene.elements) {
    if (byId.has(el.id)) issues.push(`要素id "${el.id}" が重複しています`);
    byId.set(el.id, el);
  }
  for (const el of scene.elements) {
    if (el.parentId !== undefined && !byId.has(el.parentId)) {
      issues.push(`要素 "${el.id}" の親 "${el.parentId}" が存在しません`);
    }
    const seen = new Set<string>([el.id]);
    let cur = el.parentId ? byId.get(el.parentId) : undefined;
    while (cur) {
      if (seen.has(cur.id)) {
        issues.push(`要素 "${el.id}" の親子関係が循環しています`);
        break;
      }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    if (el.inPoint !== undefined && el.outPoint !== undefined && el.outPoint <= el.inPoint) {
      issues.push(`要素 "${el.id}" の outPoint が inPoint 以前です`);
    }
    for (const [name, track] of Object.entries(el.transform ?? {})) {
      if (typeof track !== 'object') continue;
      for (let i = 1; i < track.keys.length; i++) {
        if (track.keys[i].t < track.keys[i - 1].t) {
          issues.push(`要素 "${el.id}" の ${name} のキーが時刻順ではありません`);
          break;
        }
      }
    }
  }
  return issues;
}

function offsetTrack(track: Track | undefined, delta: number): Track {
  if (track === undefined) return delta;
  if (typeof track === 'number') return round3(track + delta);
  return { keys: track.keys.map((k) => ({ ...k, v: round3(k.v + delta) })) };
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * 要素をシーン座標で (dx,dy) だけ動かす op を作る。
 * x,y がキーフレームなら全キーを同じ量ずらす（軌道の形とタイミングは変えず、位置だけ移す）。
 * 親がある場合は、時刻 t での親の回転・拡縮を打ち消して親のローカル座標の移動量に直す。
 */
export function moveElementOps(scene: Scene, id: string, dx: number, dy: number, t: number): SceneOp[] {
  const el = scene.elements.find((e) => e.id === id);
  if (!el) return [];
  const [a, b, c, d] = worldMatrixOf(scene, el.parentId, t);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [];
  const lx = (d * dx - c * dy) / det;
  const ly = (-b * dx + a * dy) / det;
  return [
    {
      op: 'patchElement',
      id,
      patch: { transform: { x: offsetTrack(el.transform?.x, lx), y: offsetTrack(el.transform?.y, ly) } },
    },
  ];
}

function scaleTrack(track: Track | undefined, factor: number): Track {
  if (track === undefined) return round3(factor);
  if (typeof track === 'number') return round3(track * factor);
  return { keys: track.keys.map((k) => ({ ...k, v: round3(k.v * factor) })) };
}

/** 要素の拡縮を factor 倍する op。キーフレームなら全キーに掛ける（拡縮の変化の比率は保つ）。 */
export function scaleElementOps(scene: Scene, id: string, factor: number): SceneOp[] {
  const el = scene.elements.find((e) => e.id === id);
  if (!el || !Number.isFinite(factor) || factor <= 0) return [];
  return [
    {
      op: 'patchElement',
      id,
      patch: { transform: { scaleX: scaleTrack(el.transform?.scaleX, factor), scaleY: scaleTrack(el.transform?.scaleY, factor) } },
    },
  ];
}

/** 要素の回転に deltaDeg を足す op。キーフレームなら全キーに足す。 */
export function rotateElementOps(scene: Scene, id: string, deltaDeg: number): SceneOp[] {
  const el = scene.elements.find((e) => e.id === id);
  if (!el || !Number.isFinite(deltaDeg)) return [];
  return [{ op: 'patchElement', id, patch: { transform: { rotation: offsetTrack(el.transform?.rotation, deltaDeg) } } }];
}

/**
 * 要素の、時刻 fromT にあるキー（全トラック）を toT へ動かす op。
 * 同じトラックの隣のキーを追い越さないよう、隣のキーの手前で止める。
 */
export function shiftKeyTimeOps(scene: Scene, id: string, fromT: number, toT: number): SceneOp[] {
  const el = scene.elements.find((e) => e.id === id);
  if (!el?.transform) return [];
  const gap = 0.001;
  const transform: Record<string, Track> = {};
  for (const [name, track] of Object.entries(el.transform)) {
    if (typeof track !== 'object') continue;
    const i = track.keys.findIndex((k) => Math.abs(k.t - fromT) < 1e-6);
    if (i < 0) continue;
    const lo = i > 0 ? track.keys[i - 1].t + gap : 0;
    const hi = i < track.keys.length - 1 ? track.keys[i + 1].t - gap : scene.duration;
    const t = round3(Math.min(Math.max(toT, lo), hi));
    transform[name] = { keys: track.keys.map((k, j) => (j === i ? { ...k, t } : k)) };
  }
  return Object.keys(transform).length ? [{ op: 'patchElement', id, patch: { transform } }] : [];
}

/** 要素の中心が通る軌道を、フレームごとにサンプルして返す（表示・計測用）。 */
export function sampleTrajectory(scene: Scene, id: string, maxPoints = 600): Array<{ t: number; x: number; y: number }> {
  const el = scene.elements.find((e) => e.id === id);
  if (!el) return [];
  const from = el.inPoint ?? 0;
  const to = Math.min(el.outPoint ?? scene.duration, scene.duration);
  const step = Math.max(1 / scene.fps, (to - from) / maxPoints);
  const points = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const m = worldMatrixOf(scene, id, t);
    points.push({ t, x: m[4], y: m[5] });
  }
  return points;
}

/** ops を順に適用した新しいシーンを返す。元のシーンは変更しない。 */
export function applyOps(scene: Scene, ops: SceneOp[]): Scene {
  const next: Scene = structuredClone(scene);
  for (const op of ops) {
    switch (op.op) {
      case 'upsertElement': {
        const i = next.elements.findIndex((e) => e.id === op.element.id);
        if (i >= 0) next.elements[i] = op.element;
        else next.elements.push(op.element);
        break;
      }
      case 'patchElement': {
        const i = next.elements.findIndex((e) => e.id === op.id);
        if (i < 0) throw new Error(`patchElement: 要素 "${op.id}" がありません`);
        const cur = next.elements[i];
        const transform =
          op.patch.transform === undefined ? cur.transform : { ...cur.transform, ...op.patch.transform };
        next.elements[i] = { ...cur, ...op.patch, id: cur.id, ...(transform ? { transform } : {}) };
        break;
      }
      case 'removeElement': {
        if (!next.elements.some((e) => e.id === op.id)) throw new Error(`removeElement: 要素 "${op.id}" がありません`);
        next.elements = next.elements.filter((e) => e.id !== op.id);
        break;
      }
      case 'setSceneProps':
        Object.assign(next, op.props);
        break;
      case 'setMarkers':
        next.markers = op.markers;
        break;
    }
  }
  return next;
}
