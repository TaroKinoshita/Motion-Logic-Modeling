// Final composition ("lockup") of a lyric line, designed before the motion (docs/48).
// Candidates are generated from a few arrangement families and sizes, then scored with layout-aesthetic
// measures used in automated layout research: balance of visual weight around the optical centre,
// coverage/negative space, alignment, hierarchy, readable minimum size, and variety between lines.
// References: Harrington et al. "Aesthetic measures for automated document layout"; Yang et al.
// "Automatic Generation of Visual-Textual Presentation Layout" (Microsoft Research); "Evaluation Metrics
// for Automated Typographic Poster Generation" (arXiv 2402.06945). Weights here are design values.

export interface LockupWord { text: string; emphasis: boolean; aspect: number }
export interface LockupItem { x: number; y: number; h: number; w: number; rotation: number }
export interface Lockup { kind: string; items: LockupItem[]; score: number; metrics: Record<string, number> }

const KINDS = ['stack-left', 'stack-center', 'stack-right', 'hero-top', 'inline', 'diagonal'] as const;

/** Design the resting layout. Items are centres in frame pixels; h is the ink height. */
export function designLockup(words: LockupWord[], W: number, H: number, rng: () => number, previous?: string): Lockup {
  if (!words.length) return { kind: 'empty', items: [], score: 0, metrics: {} };
  // Main word: emphasized, else the one with most kanji, else the longest.
  const kanji = (t: string) => Array.from(t).filter(c => /\p{Script=Han}/u.test(c)).length;
  let hero = words.findIndex(w => w.emphasis);
  if (hero < 0) hero = words.reduce((b, w, i) => kanji(w.text) * 10 + w.text.length > kanji(words[b].text) * 10 + words[b].text.length ? i : b, 0);
  const safeW = W * .84, safeH = H * .76, gap = H * .025;
  const candidates: Lockup[] = [];
  for (const kind of KINDS) for (const heroH of [.26, .34, .42]) for (const ratio of [2.2, 2.8]) {
    const h = words.map((_, i) => (i === hero ? heroH : heroH / ratio) * H);
    let w = words.map((word, i) => word.aspect * h[i]);
    // Rows: hero alone on its row (except inline); others packed in reading order.
    type Row = number[];
    const rows: Row[] = [];
    if (kind === 'inline') rows.push(words.map((_, i) => i));
    else {
      let current: Row = [];
      const flush = () => { if (current.length) rows.push(current); current = []; };
      for (let i = 0; i < words.length; i++) {
        if (i === hero) { flush(); rows.push([i]); continue; }
        const width = current.reduce((s, k) => s + w[k] + gap, 0) + w[i];
        if (current.length && width > safeW * .7) flush();
        current.push(i);
      }
      flush();
      if (kind === 'hero-top') { const at = rows.findIndex(r => r.includes(hero)); rows.unshift(...rows.splice(at, 1)); }
    }
    // Row sizes, then a uniform scale to fit the safe area.
    const rowW = rows.map(r => r.reduce((s, k) => s + w[k], 0) + gap * (r.length - 1));
    const rowH = rows.map(r => Math.max(...r.map(k => h[k])));
    const totalH = rowH.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
    const shrink = Math.min(1, safeW / Math.max(...rowW), safeH / totalH);
    const hs = h.map(v => v * shrink); w = w.map(v => v * shrink);
    const g = gap * shrink;
    const items: LockupItem[] = words.map(() => ({ x: 0, y: 0, h: 0, w: 0, rotation: 0 }));
    const blockW = Math.max(...rowW) * shrink;
    let y = -totalH * shrink / 2;
    rows.forEach((row, r) => {
      const rw = rowW[r] * shrink, rh = rowH[r] * shrink;
      const step = kind === 'diagonal' ? (r - (rows.length - 1) / 2) * W * .06 : 0;
      let x = kind === 'stack-left' ? -blockW / 2 : kind === 'stack-right' ? blockW / 2 - rw : -rw / 2;
      x += step;
      for (const k of row) {
        // Baseline-ish alignment: smaller words sit on the bottom of the row (inline) or centre (rows).
        const cy = kind === 'inline' ? y + rh - hs[k] / 2 : y + rh / 2;
        items[k] = { x: x + w[k] / 2, y: cy, h: hs[k], w: w[k], rotation: 0 };
        x += w[k] + g;
      }
      y += rh + g;
    });
    const tilt = kind === 'diagonal' ? (rng() < .5 ? -1 : 1) * (3 + rng() * 3) : 0;
    // Place the lockup at the optical centre (slightly above the middle) and apply the tilt.
    const cx = W / 2, cy = H * .48, rad = tilt * Math.PI / 180;
    for (const item of items) {
      const rx = item.x * Math.cos(rad) - item.y * Math.sin(rad), ry = item.x * Math.sin(rad) + item.y * Math.cos(rad);
      item.x = cx + rx; item.y = cy + ry; item.rotation = tilt;
    }
    // Measures.
    const area = items.map(i => i.w * i.h), total = area.reduce((a, b) => a + b, 0);
    const mx = items.reduce((s, i, k) => s + i.x * area[k], 0) / total, my = items.reduce((s, i, k) => s + i.y * area[k], 0) / total;
    const balance = Math.hypot(mx - W / 2, my - H * .47) / Math.hypot(W, H);
    const left = Math.min(...items.map(i => i.x - i.w / 2)), right = Math.max(...items.map(i => i.x + i.w / 2));
    const top = Math.min(...items.map(i => i.y - i.h / 2)), bottom = Math.max(...items.map(i => i.y + i.h / 2));
    const coverage = (right - left) * (bottom - top) / (W * H);
    const smallest = Math.min(...items.map(i => i.h)) / H;
    const heroShown = items[hero].h / H;
    let score = 0;
    score -= balance * 8;
    score -= coverage < .1 ? (.1 - coverage) * 20 : coverage > .26 ? (coverage - .26) * 14 : 0;
    score += Math.min(heroShown, .5) * 4;
    score -= smallest < .055 ? 3 : 0;
    score -= shrink < .7 ? (.7 - shrink) * 4 : 0;
    score -= kind === previous ? 1.5 : 0;
    score += kind === 'inline' && words.length > 3 ? -1 : 0;
    candidates.push({ kind, items, score, metrics: { balance, coverage, smallest, heroShown, shrink, heroH, ratio } });
  }
  candidates.sort((a, b) => b.score - a.score);
  const near = candidates.filter(c => c.score >= candidates[0].score - .4);
  return near[Math.floor(rng() * near.length)];
}
