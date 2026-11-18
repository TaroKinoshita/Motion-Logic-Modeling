import type { Scene, Time, Transform } from './schema.ts';
import { resolveTime } from './time.ts';

export interface GlyphSequence {
  from: number;
  to: number;
  combineAt: number;
  partIds: string[];
  resultId: string;
  partCompanions?: Record<string, string[]>;
  resultCompanions?: string[];
}

/** Schedule a reveal and swap from explicitly identified elements and a witnessed event. */
export function varyGlyphSequence(source: Scene, sequence: GlyphSequence, gap: number, offset = 0, reverse = false): Scene {
  const scene = structuredClone(source);
  const ids = reverse ? [...sequence.partIds].reverse() : sequence.partIds;
  const start = sequence.from;
  const swap = sequence.combineAt + offset;
  if (ids.length < 2 || !Number.isFinite(gap) || gap < 0 || !Number.isFinite(swap) || swap >= sequence.to || start + (ids.length - 1) * gap >= swap) {
    throw new Error('すべての部品が合体より先に現れ、合体が観察区間内にあるようにしてください');
  }
  const used = new Set<string>();
  const get = (id: string) => {
    const element = scene.elements.find(e => e.id === id);
    if (!element || used.has(id) || element.type === 'group') throw new Error(`合字規則の要素が無効または重複しています: ${id}`);
    used.add(id);
    return element;
  };
  const shift = (value: Time, delta: number): Time => typeof value === 'number' ? value + delta : { ...value, offsetSeconds: (value.offsetSeconds ?? 0) + delta };
  const shiftKeys = (transform: Transform | undefined, delta: number) => {
    for (const track of Object.values(transform ?? {}) as NonNullable<Transform['x']>[]) {
      if (typeof track === 'number') continue;
      for (const key of track.keys) key.t = shift(key.t, delta);
      if (track.repeat?.until !== undefined) track.repeat.until = shift(track.repeat.until, delta);
    }
  };
  for (const [i, id] of ids.entries()) {
    const enter = start + i * gap;
    for (const targetId of [id, ...(sequence.partCompanions?.[id] ?? [])]) {
      const element = get(targetId);
      const delta = enter - resolveTime(element.inPoint ?? 0, source.tempo);
      element.inPoint = enter;
      element.outPoint = swap;
      shiftKeys(element.transform, delta);
      shiftKeys(element.unitTransform, delta);
    }
  }
  const result = get(sequence.resultId);
  const delta = swap - resolveTime(result.inPoint ?? 0, source.tempo);
  const companions = (sequence.resultCompanions ?? []).map(get);
  for (const element of [result, ...companions]) {
    const from = element === result ? swap : resolveTime(element.inPoint ?? 0, source.tempo) + delta;
    // Keep the individual phase lengths so that the contact frame and the post-swap hold move together.
    const to = resolveTime(element.outPoint ?? source.duration, source.tempo) + delta;
    if (from < swap - 1e-8 || from >= to || to > sequence.to + 1e-8) throw new Error(`合体後の要素 ${element.id} が観察区間をはみ出します`);
    element.inPoint = from;
    element.outPoint = Math.min(to, sequence.to);
    shiftKeys(element.transform, delta);
    shiftKeys(element.unitTransform, delta);
  }
  return scene;
}
