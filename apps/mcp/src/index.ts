// Motion Logic の MCP アダプター（stdio）。
// 状態は持たず、Motion Logic サーバーのHTTP APIを呼ぶだけ。UIと同じデータを読み書きする。
// サーバーが起動していなければ自動で立ち上げる。
// 注意: stdout はMCPの通信に使うので、ログは必ず stderr に出す。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.MLM_SERVER_URL ?? `http://127.0.0.1:${process.env.MLM_PORT ?? 4517}`;
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ACTOR = process.env.MLM_ACTOR ?? 'ai';

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<void> {
  if (await healthy()) return;
  if (process.env.MLM_SERVER_URL) throw new Error(`Motion Logic サーバー ${BASE} に接続できません`);
  spawn(process.execPath, [path.join(REPO_ROOT, 'apps/server/src/index.ts')], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return;
  }
  throw new Error(`Motion Logic サーバーを起動できませんでした。${REPO_ROOT} で \`npm run server\` を実行して原因を確認してください`);
}

async function call(method: string, url: string, body?: unknown): Promise<any> {
  await ensureServer();
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${json.error ?? res.statusText}${json.detail ? `\n${JSON.stringify(json.detail, null, 2)}` : ''}`);
  return json;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (value: unknown): Content => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

/** ハンドラの例外を、AIが読んで直せるエラー結果に変える。 */
function tool<A>(fn: (args: A) => Promise<Content[]>) {
  return async (args: A) => {
    try {
      return { content: await fn(args) };
    } catch (err) {
      return { content: [text(`エラー: ${(err as Error).message}`)], isError: true };
    }
  };
}

const GUIDE = `# Motion Logic 操作ガイド

Motion Logic は、参考映像の「動きと演出構成」を単純な図形のシーンに落として検証するためのアプリ。
人がブラウザのUI（${BASE}、開発時は http://localhost:5173）で同じプロジェクトを見ている。あなたの変更はすぐUIに反映される。

## 基本の流れ
1. list_projects / create_project でプロジェクトを決める。
2. import_media で元動画を取り込む（任意）。detect_cuts でカット候補のマーカーを置ける（候補であり、確認が必要）。
3. get_frames(kind="source") で元動画を見る。まず粗く全体、次に気になる区間を細かく。
   色や細部を確かめるときは単一フレーム（times に1つ）か cell_width を大きくする。
4. update_scene で図形と動きを書く。
5. get_frames(kind="compare") で元動画と簡略版を並べて確認し、差を直す。

## シーン (scene.json)
- 座標は px、原点は左上。要素の x,y は要素の中心。時刻はすべて秒（拍などに丸めない）。
- element: { id, name?, type: "rect"|"ellipse"|"text"|"group", parentId?, inPoint?, outPoint?, zIndex?,
    width?, height?, cornerRadius?, fill?, stroke?, strokeWidth?, text?, fontSize?, fontWeight?, transform?, note? }
- transform: { x, y, scaleX, scaleY, rotation(度), opacity(0..1) }。各値は数値（固定）か
    { keys: [{ t, v, ease? }, ...] }（キーフレーム、時刻順）。
- ease はそのキーから次のキーまでの補間: "linear"(既定) | "hold" | "easeIn" | "easeOut" | "easeInOut" |
    "overshoot" | "anticipate" | { cubic: [x1,y1,x2,y2] }（CSS cubic-bezier と同じ）。
- group は描画されない親。子の位置・回転・拡縮に合成される。opacity は親から継承しない。
- fill: "none" で塗りなし。未知のキーはエラーになる。
- markers: [{ t, kind: "cut"|"beat"|"downbeat"|"section"|"note", label?, origin?: "measured"|"estimated"|"manual" }]

## update_scene の ops
- { op: "upsertElement", element }            同じidは丸ごと置換、なければ追加
- { op: "patchElement", id, patch }           一部だけ上書き（transformはトラック単位でマージ）
- { op: "removeElement", id }
- { op: "setSceneProps", props: { width?, height?, fps?, duration?, background? } }
- { op: "setMarkers", markers }

## リビジョン
変更には base_revision（get_project_state で得た revision）が必要。人が先に変更していると拒否されるので、
読み直してからやり直す。revert_revision で過去の状態を新しいリビジョンとして復元できる。

## 記述の原則
- 観察（何がいつ動いたか）と仮説（なぜそうしたか）を混ぜない。要素の note には置換の理由を書く。
- 単語が一括で動くのか一文字ずつずれるのか等、動きの単位を潰さない。
- 現時点で未実装: 拍・区間などの音声解析、自動の分割・追跡、仮説・規則の保存、AE/Blender出力。
`;

const server = new McpServer({ name: 'motion-logic', version: '0.1.0' });

server.registerTool(
  'get_guide',
  { description: 'Motion Logic の使い方とシーン形式の説明を返す。初めて使うときに読む。', inputSchema: {} },
  tool(async () => [text(GUIDE)]),
);

server.registerTool(
  'list_projects',
  { description: 'プロジェクトの一覧（id・名前・リビジョン・元動画の有無）を返す。', inputSchema: {} },
  tool(async () => [text(await call('GET', '/api/projects'))]),
);

server.registerTool(
  'create_project',
  {
    description: '新しいプロジェクトを作る。template="demo" は動作確認用の小さなシーン入り。',
    inputSchema: { name: z.string(), template: z.enum(['empty', 'demo']).optional() },
  },
  tool(async (a: { name: string; template?: string }) => [text(await call('POST', '/api/projects', { ...a, actor: ACTOR }))]),
);

server.registerTool(
  'import_media',
  {
    description:
      'このPC上の動画ファイルを絶対パスで指定してプロジェクトに取り込む。fps・長さ・解像度を調べ、シーンの寸法と長さを動画に合わせる。',
    inputSchema: { project_id: z.string(), path: z.string() },
  },
  tool(async (a: { project_id: string; path: string }) => {
    const r = await call('POST', `/api/projects/${a.project_id}/media`, { path: a.path, actor: ACTOR });
    return [text({ project: r.project })];
  }),
);

server.registerTool(
  'get_project_state',
  {
    description: 'プロジェクトの現在の状態（revision、元動画情報、シーン全体）を返す。変更前に必ず読む。',
    inputSchema: { project_id: z.string(), include_scene: z.boolean().optional() },
  },
  tool(async (a: { project_id: string; include_scene?: boolean }) => {
    const r = await call('GET', `/api/projects/${a.project_id}`);
    return [text(a.include_scene === false ? { project: r.project, elementCount: r.scene.elements.length } : r)];
  }),
);

server.registerTool(
  'update_scene',
  {
    description:
      'シーンを部分更新する。ops の形式は get_guide を参照。base_revision が現在のリビジョンと違うと拒否される。成功すると新しい revision を返し、UIに即反映される。',
    inputSchema: {
      project_id: z.string(),
      base_revision: z.number().int(),
      ops: z.array(z.record(z.string(), z.unknown())).min(1),
      note: z.string().optional().describe('何をなぜ変えたか。履歴に残る。'),
    },
  },
  tool(async (a: { project_id: string; base_revision: number; ops: unknown[]; note?: string }) => {
    const r = await call('POST', `/api/projects/${a.project_id}/scene`, {
      baseRevision: a.base_revision,
      ops: a.ops,
      note: a.note ?? '',
      actor: ACTOR,
    });
    return [text({ revision: r.project.revision, elementCount: r.scene.elements.length })];
  }),
);

server.registerTool(
  'get_frames',
  {
    description:
      '指定時刻の画像を1枚のJPEGで返す。kind: "source"=元動画 / "render"=簡略シーン / "compare"=元と簡略を左右に並べる。' +
      'times（秒の配列）か from/to/count（等間隔）で時刻を指定。複数なら格子状のコンタクトシート。各コマに時刻とフレーム番号が入る。最大24コマ。',
    inputSchema: {
      project_id: z.string(),
      kind: z.enum(['source', 'render', 'compare']),
      times: z.array(z.number()).max(24).optional(),
      from: z.number().optional(),
      to: z.number().optional(),
      count: z.number().int().min(1).max(24).optional(),
      cell_width: z.number().int().min(64).max(1280).optional().describe('1コマの幅px。既定は単一640、複数320。'),
      columns: z.number().int().min(1).max(8).optional(),
    },
  },
  tool(async (a: { project_id: string; kind: string; times?: number[]; from?: number; to?: number; count?: number; cell_width?: number; columns?: number }) => {
    await ensureServer();
    const q = new URLSearchParams({ kind: a.kind });
    if (a.times?.length) q.set('times', a.times.join(','));
    if (a.from !== undefined) q.set('from', String(a.from));
    if (a.to !== undefined) q.set('to', String(a.to));
    if (a.count !== undefined) q.set('count', String(a.count));
    if (a.cell_width !== undefined) q.set('cellWidth', String(a.cell_width));
    if (a.columns !== undefined) q.set('columns', String(a.columns));
    const res = await fetch(`${BASE}/api/projects/${a.project_id}/frames?${q}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? res.statusText);
    }
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return [
      text({ kind: a.kind, times: res.headers.get('x-mlm-times')?.split(',').map(Number), revision: Number(res.headers.get('x-mlm-revision')) }),
      { type: 'image', data, mimeType: 'image/jpeg' },
    ];
  }),
);

server.registerTool(
  'render_preview',
  {
    description:
      '簡略シーンをMP4に書き出す（人が再生して確認する用。AIの確認には get_frames を使う）。元動画があれば同じフレームレートで、with_audio なら元の音声つき。一度に最大120秒。書き出したファイルのパスを返す。',
    inputSchema: {
      project_id: z.string(),
      from: z.number().optional(),
      to: z.number().optional(),
      width: z.number().int().min(160).max(3840).optional(),
      with_audio: z.boolean().optional(),
      layout: z.enum(['render', 'compare']).optional().describe('compare=左に元動画・右に簡略版'),
    },
  },
  tool(async (a: { project_id: string; from?: number; to?: number; width?: number; with_audio?: boolean; layout?: string }) => [
    text(
      await call('POST', `/api/projects/${a.project_id}/export`, {
        from: a.from,
        to: a.to,
        width: a.width,
        withAudio: a.with_audio,
        layout: a.layout,
      }),
    ),
  ]),
);

server.registerTool(
  'detect_cuts',
  {
    description:
      '元動画のカット候補を検出し、cut マーカー（origin: estimated）として保存する。画面全体の変化量で判定するため、フラッシュや強い動きも拾う。必ず get_frames で前後を見て確かめること。threshold は 1〜100（既定10、小さいほど多く拾う）。',
    inputSchema: { project_id: z.string(), base_revision: z.number().int(), threshold: z.number().min(1).max(100).optional() },
  },
  tool(async (a: { project_id: string; base_revision: number; threshold?: number }) => {
    const r = await call('POST', `/api/projects/${a.project_id}/detect-cuts`, {
      baseRevision: a.base_revision,
      threshold: a.threshold,
      actor: ACTOR,
    });
    return [text({ revision: r.project.revision, threshold: r.threshold, cuts: r.cuts })];
  }),
);

server.registerTool(
  'delete_project',
  {
    description: 'プロジェクトをごみ箱フォルダ（data/trash）へ移す。ユーザーが頼んだときだけ使う。',
    inputSchema: { project_id: z.string() },
  },
  tool(async (a: { project_id: string }) => [text(await call('DELETE', `/api/projects/${a.project_id}?actor=${encodeURIComponent(ACTOR)}`))]),
);

server.registerTool(
  'get_history',
  { description: 'リビジョンの履歴（誰が・いつ・何を）を返す。', inputSchema: { project_id: z.string() } },
  tool(async (a: { project_id: string }) => [text(await call('GET', `/api/projects/${a.project_id}/history`))]),
);

server.registerTool(
  'revert_revision',
  {
    description: '過去のリビジョンのシーンを、新しいリビジョンとして復元する。履歴は消えない。',
    inputSchema: { project_id: z.string(), to_revision: z.number().int(), base_revision: z.number().int() },
  },
  tool(async (a: { project_id: string; to_revision: number; base_revision: number }) => {
    const r = await call('POST', `/api/projects/${a.project_id}/revert`, {
      toRevision: a.to_revision,
      baseRevision: a.base_revision,
      actor: ACTOR,
    });
    return [text({ revision: r.project.revision })];
  }),
);

await server.connect(new StdioServerTransport());
console.error(`[motion-logic mcp] ready (server: ${BASE})`);
