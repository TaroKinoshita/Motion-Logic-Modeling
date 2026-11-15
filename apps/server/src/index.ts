// Motion Logic サーバー。UI（ブラウザ）とMCPアダプターの両方がこのHTTP APIを使う。
// ローカル利用が前提なので 127.0.0.1 にだけ待ち受ける。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { applyOps, demoScene, emptyScene, SceneOpSchema } from '@mlm/core';
import type { Scene } from '@mlm/core';
import { exportVideo } from './export.ts';
import { clearCache, detectCuts, mediaTarget, probe, sourcePath, waveform } from './media.ts';
import { renderSheet, spreadTimes } from './render.ts';
import type { FrameKind } from './render.ts';
import {
  commit,
  createProject,
  DATA_DIR,
  events,
  getProject,
  HttpError,
  listHistory,
  listProjects,
  projectDir,
  REPO_ROOT,
  revertTo,
  trashProject,
} from './store.ts';
import type { ChangeEvent } from './store.ts';

const PORT = Number(process.env.MLM_PORT ?? 4517);
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, detail: err.detail ?? null }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: (err as Error).message ?? 'internal error' }, 500);
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'リクエストの形式が不正です', r.error.issues);
  return r.data;
}

const Actor = z.string().min(1).max(40).default('human');

app.get('/api/health', (c) => c.json({ ok: true, app: 'motion-logic', dataDir: DATA_DIR }));

app.get('/api/projects', (c) => c.json({ projects: listProjects() }));

app.post('/api/projects', async (c) => {
  const body = parse(
    z.object({ name: z.string().min(1).max(100), template: z.enum(['empty', 'demo']).default('empty'), actor: Actor }),
    await c.req.json(),
  );
  return c.json(createProject(body.name, body.template === 'demo' ? demoScene() : emptyScene(), body.actor), 201);
});

app.get('/api/projects/:id', (c) => c.json(getProject(c.req.param('id'))));

// シーンの部分更新（ops）または全体置換（scene）。baseRevision 必須。
app.post('/api/projects/:id/scene', async (c) => {
  const body = parse(
    z.object({
      baseRevision: z.number().int(),
      actor: Actor,
      note: z.string().max(500).default(''),
      ops: z.array(SceneOpSchema).optional(),
      scene: z.unknown().optional(),
    }),
    await c.req.json(),
  );
  if (!body.ops && body.scene === undefined) throw new HttpError(400, 'ops か scene のどちらかが必要です');
  return c.json(
    commit(c.req.param('id'), {
      baseRevision: body.baseRevision,
      actor: body.actor,
      note: body.note,
      scene: (current) => (body.ops ? applyOps(current, body.ops) : (body.scene as Scene)),
    }),
  );
});

app.get('/api/projects/:id/history', (c) => c.json({ history: listHistory(c.req.param('id')) }));

app.post('/api/projects/:id/revert', async (c) => {
  const body = parse(
    z.object({ toRevision: z.number().int(), baseRevision: z.number().int().nullable().default(null), actor: Actor }),
    await c.req.json(),
  );
  return c.json(revertTo(c.req.param('id'), body.toRevision, body.baseRevision, body.actor));
});

/** 取り込んだファイルを調べ、project.json に記録する。シーンの寸法・fps・長さは元動画に合わせる。 */
async function registerMedia(id: string, file: string, fileName: string, actor: string) {
  const source = await probe(file, fileName);
  clearCache(id);
  return commit(id, {
    baseRevision: null,
    actor,
    note: `元動画を取り込み: ${fileName}`,
    meta: (p) => {
      p.source = source;
    },
    scene: (s) => ({ ...s, width: source.width, height: source.height, fps: source.fps, duration: source.duration || s.duration }),
  });
}

// ローカルパスから取り込む（MCP経由・UIのパス入力）。ファイルはプロジェクト内へコピーする。
app.post('/api/projects/:id/media', async (c) => {
  const id = c.req.param('id');
  const body = parse(z.object({ path: z.string().min(1), actor: Actor }), await c.req.json());
  getProject(id);
  const src = path.resolve(body.path.replace(/^"|"$/g, ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new HttpError(400, `ファイルがありません: ${src}`);
  const target = mediaTarget(id, src);
  fs.copyFileSync(src, target.file);
  return c.json(await registerMedia(id, target.file, target.fileName, body.actor));
});

// ブラウザからのアップロード（本体をそのまま送る）。
app.post('/api/projects/:id/media/upload', async (c) => {
  const id = c.req.param('id');
  getProject(id);
  const body = c.req.raw.body;
  if (!body) throw new HttpError(400, '本体が空です');
  const target = mediaTarget(id, c.req.query('filename') ?? 'source.mp4');
  await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), fs.createWriteStream(target.file));
  return c.json(await registerMedia(id, target.file, target.fileName, 'human'));
});

app.delete('/api/projects/:id', (c) => c.json(trashProject(c.req.param('id'), c.req.query('actor') ?? 'human')));

// 音声の波形（表示用）。
app.get('/api/projects/:id/waveform', async (c) => {
  const { project } = getProject(c.req.param('id'));
  const q = parse(z.object({ buckets: z.coerce.number().int().min(50).max(8000).default(2000) }), c.req.query());
  return c.json(await waveform(project, q.buckets));
});

// カット候補を検出し、cut マーカー（origin: estimated）として保存する。
// 以前の推定カットは置き換え、人が置いたマーカーや他の種類のマーカーは残す。
app.post('/api/projects/:id/detect-cuts', async (c) => {
  const id = c.req.param('id');
  const body = parse(
    z.object({ threshold: z.number().min(1).max(100).default(10), baseRevision: z.number().int().nullable().default(null), actor: Actor }),
    await c.req.json().catch(() => ({})),
  );
  const { project } = getProject(id);
  const cuts = await detectCuts(project, body.threshold);
  const result = commit(id, {
    baseRevision: body.baseRevision,
    actor: body.actor,
    note: `カット候補を検出（しきい値 ${body.threshold}、${cuts.length} 件）`,
    scene: (s) => ({
      ...s,
      markers: [
        ...(s.markers ?? []).filter((m) => !(m.kind === 'cut' && m.origin === 'estimated')),
        ...cuts.map((cut) => ({ t: cut.t, kind: 'cut' as const, label: `cut? ${cut.score.toFixed(0)}`, origin: 'estimated' as const })),
      ].sort((a, b) => a.t - b.t),
    }),
  });
  return c.json({ cuts, threshold: body.threshold, project: result.project });
});

// 簡略シーンをMP4に書き出す（同期処理。短い区間向け）。
app.post('/api/projects/:id/export', async (c) => {
  const { project, scene } = getProject(c.req.param('id'));
  const body = parse(
    z.object({
      from: z.number().default(0),
      to: z.number().optional(),
      width: z.number().int().min(160).max(3840).optional(),
      withAudio: z.boolean().default(true),
      layout: z.enum(['render', 'compare']).default('render'),
    }),
    await c.req.json().catch(() => ({})),
  );
  const result = await exportVideo(project, scene, {
    layout: body.layout,
    from: body.from,
    to: body.to ?? scene.duration,
    width: body.width ?? scene.width,
    withAudio: body.withAudio,
  });
  return c.json({ ...result, url: `/api/projects/${project.id}/exports/${result.fileName}` });
});

app.get('/api/projects/:id/exports/:file', (c) => {
  const name = c.req.param('file');
  if (!/^[A-Za-z0-9_.-]+\.mp4$/.test(name)) throw new HttpError(400, '不正なファイル名です');
  const file = path.join(projectDir(c.req.param('id')), 'exports', name);
  if (!fs.existsSync(file)) throw new HttpError(404, '書き出しファイルがありません');
  return sendVideo(c.req.header('range'), file);
});

// 元動画の配信。
app.get('/api/projects/:id/media/source', (c) => {
  const { project } = getProject(c.req.param('id'));
  return sendVideo(c.req.header('range'), sourcePath(project));
});

/** 動画ファイルを返す。<video> のシークに必要な Range に対応する。 */
function sendVideo(rangeHeader: string | undefined, file: string): Response {
  const size = fs.statSync(file).size;
  const type = file.endsWith('.webm') ? 'video/webm' : file.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '');
  if (!range) {
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' },
    });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
    },
  });
}

// 画像の取得。times（カンマ区切り）か from/to/count で時刻を指定する。1つなら単一フレーム。
app.get('/api/projects/:id/frames', async (c) => {
  const { project, scene } = getProject(c.req.param('id'));
  const q = parse(
    z.object({
      kind: z.enum(['source', 'render', 'compare']).default('render'),
      times: z.string().optional(),
      from: z.coerce.number().optional(),
      to: z.coerce.number().optional(),
      count: z.coerce.number().int().min(1).max(24).default(8),
      cellWidth: z.coerce.number().int().min(64).max(1280).optional(),
      columns: z.coerce.number().int().min(1).max(8).optional(),
    }),
    c.req.query(),
  );
  const times = q.times
    ? q.times.split(',').map(Number).filter(Number.isFinite)
    : spreadTimes(q.from ?? 0, q.to ?? scene.duration, q.count);
  if (!times.length || times.length > 24) throw new HttpError(400, '時刻は1〜24個で指定してください');
  const cellWidth = q.cellWidth ?? (times.length === 1 ? 640 : 320);
  const jpeg = await renderSheet(project, scene, { kind: q.kind as FrameKind, times, cellWidth, columns: q.columns });
  return new Response(new Uint8Array(jpeg), {
    headers: { 'content-type': 'image/jpeg', 'x-mlm-times': times.join(','), 'x-mlm-revision': String(project.revision) },
  });
});

// 変更通知。UIはこれを受けて最新状態を読み直す（AIの変更が即座に画面へ反映される）。
app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    const onChange = (e: ChangeEvent) => void stream.writeSSE({ event: 'change', data: JSON.stringify(e) });
    events.on('change', onChange);
    stream.onAbort(() => void events.off('change', onChange));
    await stream.writeSSE({ event: 'hello', data: '{}' });
    while (!stream.aborted) {
      // UIはこのpingが一定時間届かなければ接続を張り直す（サーバー再起動時に開発用プロキシが接続を閉じないため）。
      await stream.sleep(10000);
      await stream.writeSSE({ event: 'ping', data: '{}' });
    }
  }),
);

// ビルド済みUI（apps/web/dist）があれば配信する。開発時は Vite(5173) を使う。
const WEB_DIST = path.join(REPO_ROOT, 'apps/web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
app.get('*', (c) => {
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(WEB_DIST, 'index.html');
  if (!fs.existsSync(file)) {
    return c.text('UIが未ビルドです。`npm run dev` で開発サーバーを使うか、`npm run build` を実行してください。', 404);
  }
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' },
  });
});

// 止める手段（`npm run stop`）。MCPアダプターが裏で自動起動したサーバーを終了させるために使う。
app.post('/api/shutdown', (c) => {
  setTimeout(() => process.exit(0), 100);
  return c.json({ ok: true });
});

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`Motion Logic server  http://127.0.0.1:${PORT}   data: ${DATA_DIR}`);
});
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中です。既に Motion Logic サーバーが動いている可能性があります（\`npm run stop\` で停止できます）。`);
    process.exit(1);
  }
  throw err;
});
