// Passage retargeting (docs/45-47): stage new lyrics by reusing block motion from the reconstructed
// reference works. Blocks (groups with transform keys) come from the source passage; the new text is
// attached later as appearance, so motion stays on the editable parents.
// Layers on top of the reused motion (user feedback 2026-11-20, docs/47):
//  - per-character entrances inside each block (split + stagger + unitTransform) with overshoot,
//  - squash/shrink that always recovers before the word leaves,
//  - a line camera with rotation and depth push/pull, strong eases instead of linear,
//  - seeded variety, song structure (show vs bridge passages), kanji part-merge staging.
import { createCanvas } from '@napi-rs/canvas';
import { canvasMeasurer, emptyScene, evaluateScene, fontSpec, type Scene, type SceneElement, type Track } from '@mlm/core';
import { getProject, HttpError } from './store.ts';
import { PASSAGES, type PassageSpec } from './passage-library.ts';
import { partsOf } from './kanji-parts.ts';
import type { AppearanceBinding } from './lyric-planner.ts';
import './fonts.ts';

export interface StageToken { text: string; at: number; emphasis: boolean; compound?: number }
export interface StageLine { from: number; to: number; tokens: StageToken[] }
export interface StageOptions { width: number; height: number; fps: number; duration: number; variation?: number;
  /** Loudness rank per line, 0 (quiet) .. 1 (loud). Missing: all lines are treated as middle. */
  intensity?: number[]; rng?: () => number }
type Options = StageOptions;
type Key = { t: number; v: number; ease?: Ease };
type Ease = NonNullable<Exclude<Track, number>['keys'][number]['ease']>;

const FAMILY = 'MLM BIZ UD Gothic';
const INK = '#1d2a2c', PAPER = '#eee8dc';
/** Shapes sit behind the text in a muted tone (references draw bars and rings in a second colour). */
const SHAPE_ON_PAPER = '#cfc5b3', SHAPE_ON_INK = '#3d5156';
/** Strong eases (feedback: no linear motion, eases close to the limit). */
const EXPO_IN_OUT: Ease = { cubic: [.9, 0, .1, 1] };
const EXPO_OUT: Ease = { cubic: [.05, .9, .1, 1] };
/** Accelerate in, pass the target slightly, come back (feedback: overshoot and correction). */
const BACK_OUT: Ease = { cubic: [.15, .9, .25, 1.35] };
/** Median on-screen height floor for a word (fraction of frame height). */
const READABLE = .08;

const ctx = createCanvas(1, 1).getContext('2d');
const measure = canvasMeasurer(ctx);

/** Seeded random numbers (mulberry32): the same input and variation give the same scene. */
export function seeded(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inkOf(text: string, fontSize: number) {
  ctx.font = fontSpec({ id: 'm', type: 'text', fontFamily: FAMILY, fontWeight: 700, fontSize });
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const m = ctx.measureText(text);
  return { w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight, h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
    dx: (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, dy: (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2 };
}

/** Source lifetimes are measured seconds; beat-relative values do not occur in reconstructions. */
const sec = (value: unknown, fallback: number) => typeof value === 'number' ? value : fallback;
const snapper = (fps: number) => (t: number) => Math.round(t * fps) / fps;
const median = (values: number[], fallback: number) => {
  if (!values.length) return fallback;
  const v = [...values].sort((a, b) => a - b); return v[Math.floor(v.length / 2)];
};

interface LoadedSlot { index: number; group: SceneElement; children: SceneElement[]; role: 'text' | 'shape';
  order: number; alias?: number; inSec: number; maxH: number; medianH: number; aspect: number;
  localW: number; localH: number; localX: number; localY: number }
export interface LoadedPassage { spec: PassageSpec; fps: number; width: number; height: number; fromSec: number; toSec: number;
  slots: LoadedSlot[]; textSlots: LoadedSlot[]; largestText: number }

const cache = new Map<string, LoadedPassage>();

/** Read a passage from its reconstructed project and measure its slots. */
export function loadPassage(spec: PassageSpec): LoadedPassage {
  const hit = cache.get(spec.id);
  if (hit) return hit;
  const { scene } = getProject(spec.projectId);
  const byId = new Map(scene.elements.map(element => [element.id, element]));
  const fps = scene.fps;
  const heights = new Map<string, number[]>(), aspects = new Map<string, number[]>();
  for (let frame = spec.from; frame <= spec.to; frame++) {
    for (const ev of evaluateScene(scene, (frame + .5) / fps, measure)) {
      const parent = ev.element.parentId;
      if (!parent || !spec.slots.some(slot => slot.group === parent)) continue;
      const [a, b, c, d] = ev.matrix;
      const h = (ev.element.type === 'text' ? inkOf(ev.element.text ?? '', ev.element.fontSize ?? 100).h : ev.element.height ?? 0) * Math.hypot(c, d);
      heights.set(parent, [...(heights.get(parent) ?? []), h / scene.height]);
      if (Math.hypot(c, d) > 1e-6) aspects.set(parent, [...(aspects.get(parent) ?? []), Math.hypot(a, b) / Math.hypot(c, d)]);
    }
  }
  const slots = spec.slots.map((slot, index): LoadedSlot => {
    const group = byId.get(slot.group);
    if (!group || group.type !== 'group') throw new HttpError(500, `パッセージ ${spec.id} のブロック ${slot.group} がありません`);
    const children = scene.elements.filter(element => element.parentId === group.id);
    const sized = children.map(child => {
      const t = child.transform ?? {};
      const sx = typeof t.scaleX === 'number' ? t.scaleX : 1, sy = typeof t.scaleY === 'number' ? t.scaleY : 1;
      const x = typeof t.x === 'number' ? t.x : 0, y = typeof t.y === 'number' ? t.y : 0;
      if (child.type === 'text') {
        const ink = inkOf(child.text ?? '', child.fontSize ?? 100);
        return { w: ink.w * sx, h: ink.h * sy, x: x + ink.dx * sx, y: y + ink.dy * sy };
      }
      return { w: (child.width ?? 0) * sx, h: (child.height ?? 0) * sy, x, y };
    }).filter(box => box.h > 0).sort((a, b) => b.h - a.h);
    const box = sized[0] ?? { w: 100, h: 100, x: 0, y: 0 };
    const hs = heights.get(group.id) ?? [];
    return { index, group, children, role: slot.role, order: slot.order ?? index, alias: slot.alias,
      inSec: sec(group.inPoint, spec.from / fps), maxH: hs.length ? Math.max(...hs) : 0, medianH: median(hs, 0),
      aspect: median(aspects.get(group.id) ?? [], 1), localW: box.w, localH: box.h, localX: box.x, localY: box.y };
  });
  const textSlots = slots.filter(slot => slot.role === 'text' && slot.alias === undefined).sort((a, b) => a.order - b.order);
  const largestText = textSlots.reduce((best, slot, i) => slot.maxH > textSlots[best].maxH ? i : best, 0);
  const loaded = { spec, fps, width: scene.width, height: scene.height, fromSec: spec.from / fps, toSec: (spec.to + 1) / fps,
    slots, textSlots, largestText };
  cache.set(spec.id, loaded);
  return loaded;
}

/** Monotone piecewise-linear time map from source seconds to target seconds. */
function timeMap(anchors: [number, number][]) {
  const points = anchors.filter((p, i) => i === 0 || (p[0] > anchors[i - 1][0] && p[1] > anchors[i - 1][1]));
  return (t: number) => {
    if (t <= points[0][0]) return points[0][1] + (t - points[0][0]);
    for (let i = 1; i < points.length; i++) {
      const [s0, t0] = points[i - 1], [s1, t1] = points[i];
      if (t <= s1) return t0 + (t - s0) * (t1 - t0) / (s1 - s0);
    }
    const [s, u] = points.at(-1)!;
    return u + (t - s);
  };
}

/** Fit of a word to a slot: shrink ratio, aspect correction and resulting median on-screen height. */
function fitWord(slot: LoadedSlot, text: string) {
  const squash = Math.min(1.1, Math.max(.9, slot.aspect)) / slot.aspect;
  const base = inkOf(text, 100);
  const heightFit = slot.localH / Math.max(1, base.h);
  const widthFit = slot.localW * 1.25 / Math.max(1, base.w * squash);
  const floor = slot.medianH > 0 ? READABLE / slot.medianH * heightFit : 0;
  const scale = Math.min(heightFit * 1.3, Math.max(Math.min(heightFit, widthFit), Math.min(floor, heightFit * 1.3)));
  const shown = slot.medianH * scale / heightFit;
  return { squash, font: 100 * scale, ratio: heightFit / Math.max(1e-6, Math.min(heightFit, widthFit)), shown };
}

const SHOW_TAGS = new Set(['big', 'big-result', 'invert', 'merge', 'collective-shrink', 'small-then-big', 'tilt']);
const BRIDGE_TAGS = new Set(['phrase', 'bar', 'arrow', 'spread', 'row', 'frame', 'append']);

export interface ChunkPlan { passage: string; work: string; tokens: string[]; start: number; end: number;
  stretch: number; score: number; reasons: string[]; alternatives: { passage: string; score: number }[] }

function scoreChunk(p: LoadedPassage, tokens: StageToken[], start: number, end: number, intensity: number) {
  const m = p.textSlots.length, k = tokens.length, reasons: string[] = [];
  let score = m === k ? 2 : m < k ? -1.5 * (k - m) : -1 * (m - k);
  const stretch = (end - start) / (p.toSec - p.fromSec);
  score -= 1.5 * Math.abs(Math.log(stretch));
  const emphasized = tokens.findIndex(token => token.emphasis);
  if (emphasized >= 0) score += Math.min(emphasized, m - 1) === p.largestText ? 1.5 : -.5;
  if (end - start < .25) score -= 2;
  for (const [i, slot] of p.textSlots.slice(0, Math.min(k, m)).entries()) {
    const text = i === Math.min(k, m) - 1 ? tokens.slice(i).map(t => t.text).join('') : tokens[i].text;
    const fit = fitWord(slot, text);
    if (fit.ratio > 1.25) score -= (m > 1 ? 1.2 : .6) * Math.log(fit.ratio / 1.25);
    if (fit.shown < .07) score -= 1.5;
    if (fit.shown < .04) score -= 2;
  }
  // Part-merge: a compound triple (part, part, kanji) belongs in a merge passage, whole.
  const compound = tokens[0].compound;
  if (compound !== undefined && k === 3 && tokens.every(t => t.compound === compound) && p.spec.tags.includes('merge')) {
    score += 8; reasons.push('字の見立て');
  }
  // Song structure: loud lines prefer show passages, quiet lines prefer bridge passages.
  const show = p.spec.tags.some(tag => SHOW_TAGS.has(tag)), bridge = p.spec.tags.some(tag => BRIDGE_TAGS.has(tag));
  if (intensity >= .66) { score += show ? 1.2 : -.4; if (show) reasons.push('見せ場'); }
  else if (intensity <= .33) { score += bridge ? .8 : -.2; if (bridge) reasons.push('つなぎ'); }
  return { score, stretch, reasons };
}

/** Choose passages for one line: split its tokens into consecutive chunks (DP over chunk sizes). */
function planLine(line: StageLine, passages: LoadedPassage[], previous: string | undefined, usage: Map<string, number>,
  intensity: number, rng: () => number) {
  const n = line.tokens.length;
  type State = { score: number; chunks: ChunkPlan[] };
  const best: (State | undefined)[] = [{ score: 0, chunks: [] }];
  for (let i = 1; i <= n; i++) {
    for (let k = 1; k <= Math.min(4, i); k++) {
      const before = best[i - k];
      if (!before) continue;
      const tokens = line.tokens.slice(i - k, i);
      // Never cut a compound triple across chunks.
      const head = line.tokens[i - k - 1], tail = line.tokens[i];
      if (tokens[0].compound !== undefined && head?.compound === tokens[0].compound) continue;
      if (tokens.at(-1)!.compound !== undefined && tail?.compound === tokens.at(-1)!.compound) continue;
      const start = i - k === 0 ? line.from : tokens[0].at;
      const end = i === n ? line.to : line.tokens[i].at;
      const last = before.chunks.at(-1)?.passage ?? previous;
      const scored = passages.map(p => {
        const s = scoreChunk(p, tokens, start, end, intensity);
        const used = (usage.get(p.spec.id) ?? 0) + before.chunks.filter(c => c.passage === p.spec.id).length;
        const repeat = (p.spec.id === last ? 3 : 0) + 2.2 * used;
        return { p, score: s.score - repeat, stretch: s.stretch, reasons: s.reasons };
      }).sort((a, b) => b.score - a.score);
      // Variety: pick at random among candidates within 0.8 of the best score.
      const near = scored.filter(c => c.score >= scored[0].score - .8);
      const pick = near[Math.floor(rng() * near.length)];
      const total = before.score + pick.score;
      if (!best[i] || total > best[i]!.score) {
        best[i] = { score: total, chunks: [...before.chunks, { passage: pick.p.spec.id, work: pick.p.spec.work,
          tokens: tokens.map(t => t.text), start, end, stretch: pick.stretch, score: pick.score, reasons: pick.reasons,
          alternatives: scored.filter(a => a !== pick).slice(0, 3).map(a => ({ passage: a.p.spec.id, score: a.score })) }] };
      }
    }
  }
  return best[n]!.chunks;
}

/** Value of a track at time t (hold and linear; cubic eases are approximated linearly for checks). */
function valueAt(track: Track | undefined, t: number, fallback: number) {
  if (track === undefined) return fallback;
  if (typeof track === 'number') return track;
  const keys = track.keys.filter(k => typeof k.t === 'number') as Key[];
  if (!keys.length) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      return a.ease === 'hold' ? a.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
    }
  }
  return keys.at(-1)!.v;
}

/** Text groups must not stay squashed or shrunk (feedback: a word must not leave incomplete). A squash
 * longer than 3 frames or within the last 4 frames becomes uniform; a sudden shrink (<65% in one frame)
 * returns to the previous size within 6 frames with a slight overshoot. Rewrites scaleX/scaleY per frame. */
function recoverScale(transform: Record<string, Track>, inPoint: number, outPoint: number, fps: number) {
  const frames: number[] = [];
  for (let f = Math.round(inPoint * fps); f <= Math.round(outPoint * fps); f++) frames.push(f / fps);
  if (frames.length < 2) return;
  const sx = frames.map(t => valueAt(transform.scaleX, t, 1)), sy = frames.map(t => valueAt(transform.scaleY, t, 1));
  const mag = (i: number) => Math.sqrt(Math.abs(sx[i] * sy[i]));
  const bad = frames.map((_, i) => Math.abs(Math.log(Math.max(1e-6, Math.abs(sx[i])) / Math.max(1e-6, Math.abs(sy[i])))) > .15);
  for (let i = 0; i < frames.length;) {
    if (!bad[i]) { i++; continue; }
    let j = i; while (j < frames.length && bad[j]) j++;
    if (j - i > 3 || j >= frames.length - 4) for (let k = i; k < j; k++) { const u = mag(k); sx[k] = Math.sign(sx[k] || 1) * u; sy[k] = Math.sign(sy[k] || 1) * u; }
    i = j;
  }
  const factor = frames.map(() => 1);
  for (let i = 1; i < frames.length; i++) {
    factor[i] = Math.max(factor[i], factor[i - 1]) === factor[i] && factor[i] !== 1 ? factor[i] : factor[i - 1];
    const before = mag(i - 1) * factor[i - 1], now = mag(i) * factor[i - 1];
    const r = now / Math.max(1e-6, before);
    if (r < .65 && r > 1e-3) {
      for (let k = i; k < frames.length; k++) {
        const u = Math.min(1, (k - i) / 6);
        const back = 1 + 2.7 * Math.pow(u - 1, 3) + 1.7 * Math.pow(u - 1, 2); // ease-out-back: 0 → 1 with overshoot
        factor[k] = factor[i - 1] * (1 + (1 / r - 1) * back);
      }
    }
  }
  transform.scaleX = { keys: frames.map((t, i) => ({ t, v: sx[i] * factor[i] })) };
  transform.scaleY = { keys: frames.map((t, i) => ({ t, v: sy[i] * factor[i] })) };
}

const ENTRANCES = ['pop', 'drop', 'spin', 'slide', 'flip', 'cut'] as const;
/** Per-character entrance inside the block (split + stagger + unitTransform). Every style ends at identity. */
function characterEntrance(text: string, font: number, inPoint: number, outPoint: number, fps: number, rng: () => number) {
  const style = ENTRANCES[Math.floor(rng() * ENTRANCES.length)];
  const count = Array.from(text).length;
  if (style === 'cut' || count === 0) return { style, fields: {} };
  const life = outPoint - inPoint;
  const interval = Math.max(0, Math.min(2 / fps, life * .35 / Math.max(1, count)));
  const dur = Math.min(6 / fps, Math.max(2 / fps, life * .4));
  const t0 = inPoint, t1 = inPoint + dur, h = font, sign = rng() < .5 ? -1 : 1;
  // Visible from its own start frame on (hidden only while waiting for its stagger turn).
  const unit: Record<string, Track> = { opacity: { keys: [{ t: t0 - .5 / fps, v: 0, ease: 'hold' }, { t: t0 - .25 / fps, v: 1 }] } };
  if (style === 'pop') { unit.scaleX = { keys: [{ t: t0, v: .15, ease: BACK_OUT }, { t: t1, v: 1 }] }; unit.scaleY = unit.scaleX; }
  if (style === 'drop') {
    unit.y = { keys: [{ t: t0, v: -.8 * h * sign, ease: BACK_OUT }, { t: t1, v: 0 }] };
    unit.rotation = { keys: [{ t: t0, v: 25 * sign, ease: EXPO_OUT }, { t: t1, v: 0 }] };
  }
  if (style === 'spin') {
    unit.rotation = { keys: [{ t: t0, v: 140 * sign, ease: BACK_OUT }, { t: t1, v: 0 }] };
    unit.scaleX = { keys: [{ t: t0, v: .3, ease: EXPO_OUT }, { t: t1, v: 1 }] }; unit.scaleY = unit.scaleX;
  }
  if (style === 'slide') unit.x = { keys: [{ t: t0, v: 1.2 * h * sign, ease: BACK_OUT }, { t: t1, v: 0 }] };
  if (style === 'flip') {
    unit.scaleX = { keys: [{ t: t0, v: .02, ease: BACK_OUT }, { t: t1, v: 1 }] };
    unit.shearX = { keys: [{ t: t0, v: .5 * sign, ease: EXPO_OUT }, { t: t1, v: 0 }] };
  }
  return { style, fields: { split: 'char' as const, stagger: { interval }, unitTransform: unit } };
}

/** Retarget one passage into [start, end] with the given tokens. Returns block elements and appearance bindings. */
export function retarget(p: LoadedPassage, tokens: StageToken[], start: number, end: number, prefix: string, o: Options) {
  const snap = snapper(o.fps);
  const rng = o.rng ?? seeded(1);
  const used = Math.min(tokens.length, p.textSlots.length);
  const assign = new Map<number, string>(), anchorAt = new Map<number, number>();
  p.textSlots.slice(0, used).forEach((slot, i) => {
    assign.set(slot.index, i === used - 1 ? tokens.slice(i).map(t => t.text).join('') : tokens[i].text);
    anchorAt.set(slot.index, tokens[i].at);
  });
  for (const slot of p.slots) if (slot.alias !== undefined) {
    const target = p.textSlots.find(s => s.order === slot.alias);
    if (target && assign.has(target.index)) { assign.set(slot.index, assign.get(target.index)!); anchorAt.set(slot.index, anchorAt.get(target.index)!); }
  }
  const anchors: [number, number][] = [[p.fromSec, start]];
  for (const slot of p.textSlots.slice(0, used)) anchors.push([slot.inSec, Math.max(start, anchorAt.get(slot.index)!)]);
  anchors.push([p.toSec, end]);
  anchors.sort((a, b) => a[0] - b[0]);
  const g = timeMap(anchors);
  const sx = o.width / p.width, sy = o.height / p.height;
  const dark = (sourceSec: number) => (p.spec.dark ?? []).some(([a, b]) => sourceSec * p.fps >= a && sourceSec * p.fps <= b + .5);
  const mapTrack = (track: Track | undefined, scale = 1): Track | undefined => {
    if (track === undefined) return undefined;
    if (typeof track === 'number') return track * scale;
    const keys: Key[] = [];
    for (const key of track.keys) {
      if (typeof key.t !== 'number') continue;
      const t = snap(Math.min(end, Math.max(start, g(key.t))));
      const value: Key = { t, v: key.v * scale, ...(key.ease ? { ease: key.ease } : {}) };
      if (keys.length && keys.at(-1)!.t === t) keys[keys.length - 1] = value; else keys.push(value);
    }
    // Sparse linear segments (gaps over 2 frames) get a strong ease; dense measured keys stay as they are.
    for (let i = 0; i < keys.length - 1; i++) {
      const e = keys[i].ease;
      if ((e === undefined || e === 'linear') && keys[i + 1].t - keys[i].t > 2.5 / o.fps) keys[i].ease = EXPO_IN_OUT;
    }
    return keys.length ? { keys } : undefined;
  };
  const transformOf = (t: SceneElement['transform'], withPosition: boolean, extra = false) => Object.fromEntries(Object.entries({
    x: mapTrack(t?.x, withPosition ? sx : 1), y: mapTrack(t?.y, withPosition ? sy : 1), scaleX: mapTrack(t?.scaleX),
    scaleY: mapTrack(t?.scaleY), rotation: mapTrack(t?.rotation), shearX: mapTrack(t?.shearX),
    ...(extra ? { opacity: mapTrack(t?.opacity) } : {}) }).filter(([, v]) => v !== undefined)) as Record<string, Track>;
  const elements: SceneElement[] = [], bindings: AppearanceBinding[] = [];
  const sourceWidth = new Map<string, number>();
  const entrances: { text: string; style: string }[] = [];
  for (const slot of p.slots) {
    const text = assign.get(slot.index);
    if (slot.role === 'text' && text === undefined) continue;
    const g0 = slot.group;
    let inPoint = snap(Math.max(start, g(sec(g0.inPoint, p.fromSec))));
    const outPoint = snap(Math.min(end, g(sec(g0.outPoint, p.toSec))));
    if (slot.role === 'text') inPoint = Math.max(inPoint, snap(anchorAt.get(slot.index)!));
    if (outPoint <= inPoint) continue;
    const fill = dark((sec(g0.inPoint, p.fromSec) + sec(g0.outPoint, p.toSec)) / 2) ? PAPER : INK;
    const groupId = `${prefix}:${slot.index}`;
    const transform = transformOf(g0.transform, true);
    if (slot.role === 'text') recoverScale(transform, inPoint, outPoint, o.fps);
    elements.push({ id: groupId, name: text ?? g0.name, type: 'group', inPoint, outPoint, transform });
    if (slot.role === 'shape') {
      for (const child of slot.children) {
        const cin = snap(Math.max(inPoint, g(sec(child.inPoint, p.fromSec)))), cout = snap(Math.min(outPoint, g(sec(child.outPoint, p.toSec))));
        if (cout <= cin) continue;
        const childTransform = transformOf(child.transform, false, true);
        const { zIndex: _z, transform: _t, ...rest } = structuredClone(child);
        elements.push({ ...rest, id: `${groupId}:${child.id}`, parentId: groupId, inPoint: cin, outPoint: cout, zIndex: -10,
          fill: fill === INK ? SHAPE_ON_PAPER : SHAPE_ON_INK, ...(Object.keys(childTransform).length ? { transform: childTransform } : {}) });
      }
      continue;
    }
    // Text: fit to the source glyph (height, within 1.25x width), correct inherited squash, keep a readable floor.
    const fit = fitWord(slot, text!);
    const ink = inkOf(text!, fit.font);
    const blockId = `${groupId}:block`;
    elements.push({ id: blockId, name: '動きのブロック', type: 'rect', parentId: groupId, inPoint, outPoint, fill,
      width: ink.w * fit.squash, height: ink.h, transform: { x: slot.localX, y: slot.localY } });
    sourceWidth.set(`${groupId}:text`, slot.localW);
    const entrance = characterEntrance(text!, fit.font, inPoint, outPoint, o.fps, rng);
    entrances.push({ text: text!, style: entrance.style });
    bindings.push({ blockId, groupId, text: { id: `${groupId}:text`, name: text, type: 'text', text, parentId: groupId,
      fontFamily: FAMILY, fontWeight: 700, fontSize: fit.font, fill, inPoint, outPoint, ...entrance.fields,
      transform: { x: slot.localX - ink.dx * fit.squash, y: slot.localY - ink.dy, ...(fit.squash !== 1 ? { scaleX: fit.squash } : {}) } } });
  }
  const darkRanges = (p.spec.dark ?? []).map(([a, b]) => [snap(Math.max(start, g(a / p.fps))), snap(Math.min(end, g((b + 1) / p.fps)))])
    .filter(([a, b]) => b > a);
  return { elements, bindings, darkRanges, sourceWidth, entrances };
}

const CAMERA_MOVES = ['push', 'pull', 'whip', 'roll', 'drift'] as const;
/** Line camera (feedback: the camera felt fixed). A pivot group at the frame centre carries rotation and
 * scale (depth push/pull); an offset child restores frame coordinates for the passages. Each chunk gets a
 * move at random, amplified on loud lines. */
function cameraRig(id: string, chunks: ChunkPlan[], from: number, to: number, intensity: number, o: Options, rng: () => number) {
  const snap = snapper(o.fps);
  const amp = .6 + .8 * intensity;
  const rot: Key[] = [], scale: Key[] = [];
  const moves: string[] = [];
  let angle = 0;
  for (const chunk of chunks) {
    const a = snap(chunk.start), b = Math.max(a + 1 / o.fps, snap(chunk.end));
    const quick = Math.min(b, a + 5 / o.fps);
    const move = CAMERA_MOVES[Math.floor(rng() * CAMERA_MOVES.length)];
    const sign = rng() < .5 ? -1 : 1;
    moves.push(move);
    if (move === 'push') { rot.push({ t: a, v: angle, ease: 'hold' }); scale.push({ t: a, v: 1, ease: EXPO_IN_OUT }, { t: b, v: 1 + .14 * amp }); }
    if (move === 'pull') { rot.push({ t: a, v: angle, ease: 'hold' }); scale.push({ t: a, v: 1 + .2 * amp, ease: EXPO_OUT }, { t: b, v: 1 }); }
    if (move === 'whip') {
      const next = sign * (5 + rng() * 7) * amp;
      rot.push({ t: a, v: next - sign * 20 * amp, ease: BACK_OUT }, { t: quick, v: next, ease: EXPO_IN_OUT }); angle = next;
      scale.push({ t: a, v: 1 + .12 * amp, ease: EXPO_OUT }, { t: quick, v: 1.02, ease: EXPO_IN_OUT });
    }
    if (move === 'roll') {
      const next = sign * (3 + rng() * 6) * amp;
      rot.push({ t: a, v: angle, ease: EXPO_IN_OUT }, { t: b, v: next }); angle = next;
      scale.push({ t: a, v: 1.03, ease: EXPO_IN_OUT }, { t: b, v: 1 + .08 * amp });
    }
    if (move === 'drift') {
      rot.push({ t: a, v: angle, ease: EXPO_IN_OUT }, { t: b, v: angle + sign * 2 * amp }); angle += sign * 2 * amp;
      scale.push({ t: a, v: 1.02, ease: EXPO_IN_OUT }, { t: b, v: 1 + .06 * amp });
    }
  }
  const tidy = (keys: Key[]): Track => {
    const out: Key[] = [];
    for (const k of [...keys].sort((p, q) => p.t - q.t)) { if (out.length && out.at(-1)!.t === k.t) out[out.length - 1] = k; else out.push(k); }
    return out.length ? { keys: out } : 1;
  };
  const elements: SceneElement[] = [
    { id: `${id}:cam`, name: 'カメラ', type: 'group', inPoint: from, outPoint: to,
      transform: { x: o.width / 2, y: o.height / 2, rotation: rot.length ? tidy(rot) : 0, scaleX: tidy(scale), scaleY: tidy(scale) } },
    { id: `${id}:camoff`, name: 'カメラの原点', type: 'group', parentId: `${id}:cam`, inPoint: from, outPoint: to,
      transform: { x: -o.width / 2, y: -o.height / 2 } },
  ];
  return { elements, moves };
}

/** Finer chopping (feedback): long words split into two timed parts; single kanji with known parts expand
 * into part, part, kanji for the merge passages. */
export function prepareLines(lines: StageLine[], fps: number) {
  let compound = 0;
  const minGap = 2 / fps;
  return lines.map(line => {
    const tokens: StageToken[] = [];
    line.tokens.forEach((token, k) => {
      const next = k + 1 < line.tokens.length ? line.tokens[k + 1].at : line.to;
      const span = next - token.at;
      const chars = Array.from(token.text);
      const parts = partsOf(token.text);
      if (parts && span >= .3) {
        const id = compound++;
        tokens.push({ text: parts[0], at: token.at, emphasis: false, compound: id },
          { text: parts[1], at: Math.round((token.at + span * .3) * fps) / fps, emphasis: false, compound: id },
          { text: token.text, at: Math.round((token.at + span * .6) * fps) / fps, emphasis: true, compound: id });
      } else if (chars.length >= 4 && span >= 4 * minGap) {
        const cut = Math.ceil(chars.length / 2);
        tokens.push({ text: chars.slice(0, cut).join(''), at: token.at, emphasis: token.emphasis },
          { text: chars.slice(cut).join(''), at: Math.round((token.at + span * .45) * fps) / fps, emphasis: false });
      } else tokens.push(token);
    });
    return { ...line, tokens };
  });
}

/** Stage all lines with passages. Returns the block scene, appearance bindings and the selection record. */
export function stageWithPassages(input: StageLine[], o: Options) {
  const passages = PASSAGES.map(loadPassage);
  const lines = prepareLines(input, o.fps);
  const snap = snapper(o.fps);
  const scene: Scene = { ...emptyScene(), width: o.width, height: o.height, fps: o.fps, duration: o.duration,
    background: PAPER, elements: [], markers: [] };
  const appearance: AppearanceBinding[] = [];
  const sourceWidth = new Map<string, number>();
  const usage = new Map<string, number>();
  const records: { line: number; intensity: number; tokens: string[]; chunks: ChunkPlan[]; camera: string[] }[] = [];
  const entranceLog: { line: number; text: string; style: string }[] = [];
  const rng = o.rng ?? seeded(1 + (o.variation ?? 0));
  let previous: string | undefined;
  for (const [i, line] of lines.entries()) {
    const intensity = o.intensity?.[i] ?? .5;
    const chunks = planLine(line, passages, previous, usage, intensity, rng);
    let cursor = 0;
    for (const [c, chunk] of chunks.entries()) {
      const p = passages.find(x => x.spec.id === chunk.passage)!;
      const tokens = line.tokens.slice(cursor, cursor + chunk.tokens.length);
      cursor += tokens.length;
      const built = retarget(p, tokens, chunk.start, chunk.end, `stage:${i}:${c}`, { ...o, rng });
      for (const element of built.elements) if (element.type === 'group' && !element.parentId) element.parentId = `stage:${i}:camoff`;
      scene.elements.push({ id: `stage:${i}:${c}:bg`, type: 'rect', zIndex: -1000, width: o.width, height: o.height, fill: PAPER,
        inPoint: snap(chunk.start), outPoint: snap(chunk.end), transform: { x: o.width / 2, y: o.height / 2 } });
      for (const [d, [a, b]] of built.darkRanges.entries()) scene.elements.push({ id: `stage:${i}:${c}:dark:${d}`, type: 'rect', zIndex: -999,
        width: o.width, height: o.height, fill: INK, inPoint: a, outPoint: b, transform: { x: o.width / 2, y: o.height / 2 } });
      scene.elements.push(...built.elements);
      appearance.push(...built.bindings);
      for (const [k, v] of built.sourceWidth) sourceWidth.set(k, v);
      entranceLog.push(...built.entrances.map(e => ({ line: i + 1, ...e })));
      usage.set(p.spec.id, (usage.get(p.spec.id) ?? 0) + 1);
      previous = p.spec.id;
    }
    const camera = cameraRig(`stage:${i}`, chunks, snap(line.from), snap(line.to), intensity, o, rng);
    scene.elements.push(...camera.elements);
    for (const token of input[i].tokens) scene.markers!.push({ t: token.at, kind: 'note', label: token.text, origin: 'estimated' });
    records.push({ line: i + 1, intensity, tokens: line.tokens.map(t => t.text), chunks, camera: camera.moves });
  }
  return { blockScene: scene, appearance, records, sourceWidth, entrances: entranceLog };
}

/** Shrink new text that is wider than its source glyph and leaves the frame. Source passages may enter
 * from outside the frame on purpose, so text at its source width is left as it is and only counted. */
export function fitInsideFrame(scene: Scene, appearance: AppearanceBinding[], o: Options,
  dress: (s: Scene, a: AppearanceBinding[]) => Scene, sourceWidth: Map<string, number>) {
  const adjusted = new Map<string, number>();
  let outsideFrames = 0;
  for (let round = 0; round < 8; round++) {
    const dressed = dress(scene, appearance);
    const outside = new Set<string>();
    outsideFrames = 0;
    for (let frame = 0; frame < Math.ceil(o.duration * o.fps); frame++) {
      let any = false;
      for (const ev of evaluateScene(dressed, frame / o.fps, measure)) {
        if (ev.element.type !== 'text') continue;
        const ink = inkOf(ev.element.text ?? '', ev.element.fontSize ?? 100);
        const [a, b, c, d, x, y] = ev.matrix;
        const xs: number[] = [], ys: number[] = [];
        for (const u of [-ink.w / 2 + ink.dx, ink.w / 2 + ink.dx]) for (const v of [-ink.h / 2 + ink.dy, ink.h / 2 + ink.dy]) {
          xs.push(a * u + c * v + x); ys.push(b * u + d * v + y);
        }
        if (Math.min(...xs) < 0 || Math.max(...xs) > o.width || Math.min(...ys) < 0 || Math.max(...ys) > o.height) {
          any = true;
          if (ev.unitIndex === undefined && ink.w > (sourceWidth.get(ev.element.id) ?? Infinity) * 1.15) outside.add(ev.element.id);
        }
      }
      if (any) outsideFrames++;
    }
    if (!outside.size) return { scene: dressed, adjusted: Object.fromEntries(adjusted), outsideFrames };
    for (const binding of appearance) {
      if (!outside.has(binding.text.id)) continue;
      const text = binding.text;
      const font = (text.fontSize ?? 100) * .85;
      const ink = inkOf(text.text ?? '', font);
      const block = scene.elements.find(e => e.id === binding.blockId)!;
      const cx = typeof block.transform?.x === 'number' ? block.transform.x : 0, cy = typeof block.transform?.y === 'number' ? block.transform.y : 0;
      const squash = typeof text.transform?.scaleX === 'number' ? text.transform.scaleX : 1;
      block.width = ink.w * squash; block.height = ink.h;
      text.fontSize = font; text.transform = { x: cx - ink.dx * squash, y: cy - ink.dy, ...(squash !== 1 ? { scaleX: squash } : {}) };
      adjusted.set(text.id, font);
    }
  }
  return { scene: dress(scene, appearance), adjusted: Object.fromEntries(adjusted), outsideFrames };
}
