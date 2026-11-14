// サーバー側の描画。ブラウザと同じ drawFrame を @napi-rs/canvas 上で実行する。
// AIに返す画像（単一フレーム・コンタクトシート・元動画との比較）をここで作る。
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { drawFrame } from '@mlm/core';
import type { ProjectMeta, Scene } from '@mlm/core';
import { sourceFrame } from './media.ts';
import { HttpError } from './store.ts';

export type FrameKind = 'source' | 'render' | 'compare';

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
  kind: FrameKind;
  times: number[];
  /** 1コマ（compare では片側）の幅。 */
  cellWidth: number;
  columns?: number;
}

/**
 * 指定時刻のフレームを格子状に並べた1枚のJPEGを返す。times が1つなら単一フレーム。
 * 各コマに時刻とフレーム番号を焼き込むので、AIが画像だけ見ても時刻を取り違えない。
 */
export async function renderSheet(project: ProjectMeta, scene: Scene, opts: SheetOptions): Promise<Buffer> {
  const { kind, times, cellWidth } = opts;
  if (!times.length) throw new HttpError(400, 'times が空です');
  if (kind !== 'render' && !project.source && kind === 'source') {
    throw new HttpError(400, 'このプロジェクトには元動画が取り込まれていません');
  }
  const aspect = kind === 'source' && project.source ? project.source.height / project.source.width : scene.height / scene.width;
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
        const img = await loadImage(await sourceFrame(project, t, cellWidth));
        ctx.drawImage(img, x0, y0, cellWidth, paneH);
      } else {
        ctx.fillStyle = '#333333';
        ctx.fillRect(x0, y0, cellWidth, paneH);
      }
    }
    if (kind !== 'source') {
      drawScene(ctx, scene, t, kind === 'compare' ? x0 + cellWidth + gap : x0, y0, cellWidth);
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
