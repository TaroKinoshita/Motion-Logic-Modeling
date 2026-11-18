// サーバー側の描画。ブラウザと同じ drawFrame を @napi-rs/canvas 上で実行する。
// AIに返す画像（単一フレーム・コンタクトシート・元動画との比較）をここで作る。
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { drawFrame } from '@mlm/core';
import type { ProjectMeta, Scene } from '@mlm/core';
import { sourceFrame } from './media.ts';
import { HttpError } from './store.ts';

export type FrameKind = 'source' | 'render' | 'compare';
export interface Region { x: number; y: number; w: number; h: number }

function drawScene(ctx: SKRSContext2D, scene: Scene, t: number, x: number, y: number, width: number): number {
  const scale = width / scene.width;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, scene.width, scene.height);
  ctx.clip();
  drawFrame(ctx as unknown as CanvasRenderingContext2D, scene, t);
  ctx.restore();
  return Math.round(scene.height * scale);
}

export interface SheetOptions {
  sceneAt?: (time:number)=>Scene;
  kind: FrameKind;
  times: number[];
  /** 1コマ（compare では片側）の幅。 */
  cellWidth: number;
  columns?: number;
  /** Source-pixel coordinates; render-only projects use scene coordinates. */
  region?: Region;
  gridStep?: number;
}

/**
 * 指定時刻のフレームを格子状に並べた1枚のJPEGを返す。times が1つなら単一フレーム。
 * 各コマに時刻とフレーム番号を焼き込むので、AIが画像だけ見ても時刻を取り違えない。
 */
export async function renderSheet(project: ProjectMeta, scene: Scene, opts: SheetOptions): Promise<Buffer> {
  const { kind, times, cellWidth } = opts;
  const refWidth = project.source?.width ?? scene.width;
  const refHeight = project.source?.height ?? scene.height;
  const region = opts.region ?? { x: 0, y: 0, w: refWidth, h: refHeight };
  if (![region.x, region.y, region.w, region.h].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.w <= 0 || region.h <= 0 || region.x + region.w > refWidth || region.y + region.h > refHeight) {
    throw new HttpError(400, 'regionは元画像の範囲内の整数pxで指定してください');
  }
  if (opts.gridStep !== undefined && (!Number.isInteger(opts.gridStep) || opts.gridStep < 8)) throw new HttpError(400, 'gridStepは8以上の整数です');
  if (!times.length) throw new HttpError(400, 'times が空です');
  if (kind !== 'render' && !project.source && kind === 'source') {
    throw new HttpError(400, 'このプロジェクトには元動画が取り込まれていません');
  }
  const aspect = opts.region ? region.h / region.w : kind === 'source' && project.source ? project.source.height / project.source.width : scene.height / scene.width;
  const paneH = Math.round(cellWidth * aspect);
  const panes = kind === 'compare' ? 2 : 1;
  const gap = 4;
  const cellW = cellWidth * panes + (panes - 1) * gap;
  const columns = Math.max(1, Math.min(opts.columns ?? (kind === 'compare' ? 2 : 4), times.length));
  const rows = Math.ceil(times.length / columns);
  const canvas = createCanvas(columns * cellW + (columns + 1) * gap, rows * paneH + (rows + 1) * gap);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const fps = project.source?.fps ?? scene.fps;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const x0 = gap + (i % columns) * (cellW + gap);
    const y0 = gap + Math.floor(i / columns) * (paneH + gap);
    if (kind !== 'render') {
      if (project.source) {
        const img = await loadImage(await sourceFrame(project, t, opts.region ? refWidth : cellWidth));
        if (opts.region) ctx.drawImage(img, region.x, region.y, region.w, region.h, x0, y0, cellWidth, paneH);
        else ctx.drawImage(img, x0, y0, cellWidth, paneH);
      } else {
        ctx.fillStyle = '#333333';
        ctx.fillRect(x0, y0, cellWidth, paneH);
      }
    }
    if (kind !== 'source') {
      const px = kind === 'compare' ? x0 + cellWidth + gap : x0;
      const projected=opts.sceneAt?.(t)??scene;
      if (opts.region) {
        ctx.save(); ctx.beginPath(); ctx.rect(px, y0, cellWidth, paneH); ctx.clip();
        ctx.translate(px - region.x * cellWidth / region.w, y0 - region.y * paneH / region.h);
        ctx.scale(cellWidth / region.w * refWidth / scene.width, paneH / region.h * refHeight / scene.height);
        drawFrame(ctx as unknown as CanvasRenderingContext2D, projected, t); ctx.restore();
      } else drawScene(ctx, projected, t, px, y0, cellWidth);
    }
    if (opts.gridStep) for (let pane = 0; pane < panes; pane++) {
      const px = x0 + pane * (cellWidth + gap);
      ctx.save(); ctx.beginPath(); ctx.rect(px, y0, cellWidth, paneH); ctx.clip();
      ctx.strokeStyle = 'rgba(0,255,255,0.55)'; ctx.fillStyle = '#00ffff'; ctx.lineWidth = 1; ctx.font = '11px sans-serif';
      for (let x = Math.ceil(region.x / opts.gridStep) * opts.gridStep; x < region.x + region.w; x += opts.gridStep) {
        const dx = px + (x - region.x) * cellWidth / region.w;
        ctx.beginPath(); ctx.moveTo(dx, y0); ctx.lineTo(dx, y0 + paneH); ctx.stroke(); ctx.fillText(String(x), dx + 2, y0 + 34);
      }
      for (let y = Math.ceil(region.y / opts.gridStep) * opts.gridStep; y < region.y + region.h; y += opts.gridStep) {
        const dy = y0 + (y - region.y) * paneH / region.h;
        ctx.beginPath(); ctx.moveTo(px, dy); ctx.lineTo(px + cellWidth, dy); ctx.stroke(); ctx.fillText(String(y), px + 2, dy - 2);
      }
      ctx.restore();
    }
    const label = `${t.toFixed(3)}s  f${Math.round(t * fps)}${kind === 'compare' ? '  元 | 簡略' : ''}`;
    ctx.font = '13px "Yu Gothic", "Meiryo", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x0, y0, ctx.measureText(label).width + 10, 20);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x0 + 5, y0 + 3);
  }
  return canvas.encode('jpeg', 85);
}

/** from〜to を count 個に等分した時刻（両端を含む）。 */
export function spreadTimes(from: number, to: number, count: number): number[] {
  if (count <= 1) return [from];
  return Array.from({ length: count }, (_, i) => Number((from + ((to - from) * i) / (count - 1)).toFixed(4)));
}
