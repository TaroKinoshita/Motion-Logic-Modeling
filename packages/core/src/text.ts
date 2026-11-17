import type { SceneElement } from './schema.ts';

export const FONT_STACK = '"Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif';
export type TextMeasurer = (text: string, element: SceneElement) => number;
export function fontSpec(el: SceneElement): string {
  return `${el.fontWeight ?? 700} ${el.fontSize ?? 48}px ${el.fontFamily ? JSON.stringify(el.fontFamily) : FONT_STACK}`;
}
export function canvasMeasurer(ctx: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>): TextMeasurer {
  return (text, el) => { ctx.font = fontSpec(el); return ctx.measureText(text).width; };
}
export function textUnits(el: SceneElement): string[] {
  const text = el.text ?? '';
  if (el.split === 'word') return text.match(/\s+|\S+/gu) ?? [];
  return [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].map(s => s.segment);
}
export function layoutText(el: SceneElement, measure: TextMeasurer) {
  const units = textUnits(el);
  const widths = units.map(s => measure(s, el));
  const gap = el.letterSpacing ?? 0;
  const width = widths.reduce((a, b) => a + b, 0) + Math.max(0, units.length - 1) * gap;
  let x = -width / 2;
  let rank = 0;
  const placed = units.map((text, index) => {
    const item = { text, index, rank: el.split === 'word' && /^\s+$/u.test(text) ? -1 : rank++, x: x + widths[index] / 2, width: widths[index] };
    x += widths[index] + gap;
    return item;
  });
  return { width, count: rank, units: placed };
}
