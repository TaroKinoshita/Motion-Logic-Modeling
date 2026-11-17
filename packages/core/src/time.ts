import type { Duration, Tempo, Time, Track } from './schema.ts';

function requireTempo(tempo?: Tempo): Tempo {
  if (!tempo || !Number.isFinite(tempo.bpm) || tempo.bpm <= 0) throw new Error('拍指定には正のBPMを持つtempoが必要です');
  return tempo;
}
export function resolveTime(time: Time, tempo?: Tempo): number {
  if (typeof time === 'number') return time;
  const t = requireTempo(tempo);
  return t.offset + time.beat * 60 / t.bpm + (time.offsetSeconds ?? 0);
}
export function resolveDuration(duration: Duration, tempo?: Tempo): number {
  return typeof duration === 'number' ? duration : duration.beats * 60 / requireTempo(tempo).bpm;
}
export function resolvedKeys(track: Exclude<Track, number>, tempo?: Tempo) {
  return track.keys.map(k => ({ ...k, t: resolveTime(k.t, tempo) }));
}
/** End is exclusive. A completed repeat holds its left-hand limit, not the next cycle's first value. */
export function repeatTime(track: Exclude<Track, number>, t: number, tempo?: Tempo): number {
  if (!track.repeat) return t;
  const start = resolveTime(track.keys[0].t, tempo);
  if (t < start) return t;
  const period = resolveDuration(track.repeat.every, tempo);
  if (!(period > 0)) throw new Error('repeat.everyは正の長さが必要です');
  const end = track.repeat.count !== undefined ? start + track.repeat.count * period
    : track.repeat.until !== undefined ? resolveTime(track.repeat.until, tempo) : Infinity;
  const elapsed = Math.min(t, end) - start;
  let phase = elapsed % period;
  const boundary = Math.abs(phase) < 1e-10 || Math.abs(phase - period) < 1e-10;
  if (boundary) phase = t >= end ? period : 0;
  // A truncated hold key must retain its left-hand value at the exclusive end.
  if (t >= end) phase = Math.max(0, phase - Math.max(1, Math.abs(end)) * Number.EPSILON * 4);
  return start + phase;
}
