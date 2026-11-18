// Canvas 2D への描画。ブラウザのプレビューとサーバー側のフレーム書き出しで同じ関数を使う。
import { canvasMeasurer, fontSpec } from './text.ts';
import { evaluateScene } from './evaluate.ts';
import type { Scene } from './schema.ts';

export { FONT_STACK } from './text.ts';

export interface DrawOptions {
  /** true なら背景を塗らず透明にする（元動画への重ね表示用）。 */
  transparent?: boolean;
}

/**
 * シーン座標 (0,0)-(width,height) に時刻 t の状態を描く。
 * 縮小・拡大は呼び出し側が ctx に変換を設定してから呼ぶ。
 */
export function drawFrame(ctx: CanvasRenderingContext2D, scene: Scene, t: number, options: DrawOptions = {}): void {
  ctx.save();
  if (options.transparent) {
    ctx.clearRect(0, 0, scene.width, scene.height);
  } else {
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
  for (const ev of evaluateScene(scene, t, canvasMeasurer(ctx))) {
    if (ev.opacity <= 0) continue;
    const el = ev.element;
    const [a, b, c, d, e, f] = ev.matrix;
    ctx.save();
    ctx.transform(a, b, c, d, e, f);
    ctx.globalAlpha = ev.opacity;
    ctx.fillStyle = el.fill ?? '#ffffff';
    const w = ev.width;
    const h = ev.height;
    if (el.type === 'text') {
      ctx.font = fontSpec(el);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(el.text ?? '', 0, 0);
      if (el.stroke) {
        ctx.strokeStyle = el.stroke;
        ctx.lineWidth = el.strokeWidth ?? 1;
        ctx.strokeText(el.text ?? '', 0, 0);
      }
    } else {
      ctx.beginPath();
      if (el.outline) {
        for (const polygon of el.outline) {
          ctx.moveTo((polygon[0]/4096-.5)*w, (polygon[1]/4096-.5)*h);
          for (let i = 2; i < polygon.length; i += 2) ctx.lineTo((polygon[i]/4096-.5)*w, (polygon[i+1]/4096-.5)*h);
          ctx.closePath();
        }
      } else if (el.type === 'ellipse') {
        ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else if (el.cornerRadius) {
        ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(el.cornerRadius, w / 2, h / 2));
      } else {
        ctx.rect(-w / 2, -h / 2, w, h);
      }
      if (el.fill !== 'none') ctx.fill(el.outline?'evenodd':'nonzero');
      if (el.stroke) {
        ctx.strokeStyle = el.stroke;
        ctx.lineWidth = el.strokeWidth ?? 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
