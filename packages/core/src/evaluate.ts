// 任意時刻 t でのシーン状態を決定的に求める。描画・比較・計測の共通の入口。
import type { Ease, Scene, SceneElement, Track } from './schema.ts';

export type Mat = [number, number, number, number, number, number];

const PRESETS: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, 0, 0.66, -0.56],
};

/** CSS cubic-bezier と同じ定義。x(0..1) に対する y を返す。 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bez = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  let s = x;
  for (let i = 0; i < 40; i++) {
    const cx = bez(x1, x2, s);
    if (Math.abs(cx - x) < 1e-7) break;
    if (cx < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return bez(y1, y2, s);
}

export function applyEase(ease: Ease | undefined, p: number): number {
  if (!ease || ease === 'linear') return p;
  if (ease === 'hold') return 0;
  const c = typeof ease === 'string' ? PRESETS[ease] : ease.cubic;
  return cubicBezier(c[0], c[1], c[2], c[3], p);
}

/** トラックの値。最初のキーより前・最後のキーより後は端の値を保持する。 */
export function sampleTrack(track: Track | undefined, t: number, fallback: number): number {
  if (track === undefined) return fallback;
  if (typeof track === 'number') return track;
  const keys = track.keys;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t < b.t) {
      const span = b.t - a.t;
      const p = span <= 0 ? 1 : (t - a.t) / span;
      return a.v + (b.v - a.v) * applyEase(a.ease, p);
    }
  }
  return last.v;
}

export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function localMatrix(el: SceneElement, t: number): Mat {
  const tr = el.transform ?? {};
  const x = sampleTrack(tr.x, t, 0);
  const y = sampleTrack(tr.y, t, 0);
  const sx = sampleTrack(tr.scaleX, t, 1);
  const sy = sampleTrack(tr.scaleY, t, 1);
  const r = (sampleTrack(tr.rotation, t, 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos * sx, sin * sx, -sin * sy, cos * sy, x, y];
}

export interface EvaluatedElement {
  element: SceneElement;
  /** シーン座標への変換行列（親の変換を合成済み）。原点は要素の中心。 */
  matrix: Mat;
  opacity: number;
  width: number;
  height: number;
  /** シーン座標での中心位置。計測・比較用。 */
  cx: number;
  cy: number;
}

export function isActive(el: SceneElement, scene: Scene, t: number): boolean {
  return t >= (el.inPoint ?? 0) && t < (el.outPoint ?? scene.duration + 1e-9);
}

/** 要素の大きさ。text は文字数とフォントサイズからの概算（選択枠・当たり判定用）。 */
export function elementSize(el: SceneElement): { width: number; height: number } {
  if (el.type === 'text') {
    const size = el.fontSize ?? 48;
    return { width: el.width ?? Math.max(1, [...(el.text ?? '')].length) * size, height: el.height ?? size * 1.2 };
  }
  return { width: el.width ?? 100, height: el.height ?? 100 };
}

/** 要素（group を含む）のシーン座標への変換行列。存在しなければ単位行列。 */
export function worldMatrixOf(scene: Scene, id: string | undefined, t: number): Mat {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const chain: SceneElement[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur && chain.length < 64) {
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  for (const el of chain) m = multiply(m, localMatrix(el, t));
  return m;
}

/** シーン座標の点 (x,y) にある一番手前の要素。なければ null。 */
export function hitTest(scene: Scene, t: number, x: number, y: number): EvaluatedElement | null {
  const list = evaluateScene(scene, t);
  for (let i = list.length - 1; i >= 0; i--) {
    const [a, b, c, d, e, f] = list[i].matrix;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) continue;
    const lx = (d * (x - e) - c * (y - f)) / det;
    const ly = (-b * (x - e) + a * (y - f)) / det;
    if (Math.abs(lx) <= list[i].width / 2 && Math.abs(ly) <= list[i].height / 2) return list[i];
  }
  return null;
}

/** 時刻 t に表示される要素を、描画順（zIndex昇順、同値は配列順）で返す。 */
export function evaluateScene(scene: Scene, t: number): EvaluatedElement[] {
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const cache = new Map<string, Mat>();
  const world = (el: SceneElement, depth: number): Mat => {
    const hit = cache.get(el.id);
    if (hit) return hit;
    let m = localMatrix(el, t);
    const parent = el.parentId ? byId.get(el.parentId) : undefined;
    if (parent && depth < 64) m = multiply(world(parent, depth + 1), m);
    cache.set(el.id, m);
    return m;
  };
  return scene.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.type !== 'group' && isActive(element, scene, t))
    .sort((a, b) => (a.element.zIndex ?? 0) - (b.element.zIndex ?? 0) || a.index - b.index)
    .map(({ element }) => {
      const matrix = world(element, 0);
      return {
        element,
        matrix,
        opacity: Math.min(1, Math.max(0, sampleTrack(element.transform?.opacity, t, 1))),
        ...elementSize(element),
        cx: matrix[4],
        cy: matrix[5],
      };
    });
}
