import type { Scene, SceneElement } from './schema.ts';
import { resolvedKeys, resolveTime, resolveDuration } from './time.ts';
import { textUnits } from './text.ts';

/** Bound expansion to visible scene time and a UI budget; evaluator itself never expands repeats. */
export function timelineKeys(el: SceneElement, scene: Scene, limit = 2000): { times: number[]; readOnly: boolean; truncated: boolean } {
  const result = new Set<number>();
  let budget = limit;
  const readOnly = !!el.split || Object.values(el.transform ?? {}).some(tr => typeof tr === 'object' && (!!tr.repeat || tr.keys.some(k => typeof k.t !== 'number')));
  const units = el.split ? textUnits(el).filter(s => el.split !== 'word' || !/^\s+$/u.test(s)).length : 1;
  for (const [transform, count] of [[el.transform, 1], [el.unitTransform, units]] as const) {
    for (const track of Object.values(transform ?? {})) {
      if (typeof track !== 'object') continue;
      const keys = resolvedKeys(track, scene.tempo);
      const r = track.repeat;
      const period = r ? resolveDuration(r.every, scene.tempo) : Infinity;
      for (let u = 0; u < count && budget > 0; u++) {
        const delay = transform === el.unitTransform ? u * resolveDuration(el.stagger?.interval ?? 0, scene.tempo) : 0;
        const end = Math.min(scene.duration, resolveTime(el.outPoint ?? scene.duration, scene.tempo), r?.until !== undefined ? resolveTime(r.until, scene.tempo) + delay : Infinity);
        const begin = Math.max(0, resolveTime(el.inPoint ?? 0, scene.tempo));
        const firstCycle = r ? Math.max(0, Math.floor((begin - delay - keys[keys.length - 1].t) / period)) : 0;
        for (let cycle = firstCycle; cycle < (r?.count ?? (r ? Infinity : 1)) && budget > 0; cycle++) {
          const shift = delay + (cycle === 0 ? 0 : cycle * period);
          if (keys[0].t + shift >= end) break;
          for (const key of keys) {
            if (--budget < 0) break;
            const t = key.t + shift;
            if (t >= begin && t < end) result.add(t);
          }
        }
      }
    }
  }
  return { times: [...result].sort((a, b) => a - b), readOnly, truncated: budget <= 0 };
}
