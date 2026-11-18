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
6. compare_segment(project_id, from, to, width?) で区間SSIMを計測。数値にはrevision・元動画ハッシュ・寸法・フレーム数が付く。画素の類似度であり、演出理解や要素位置の誤差ではない。

## シーン (scene.json)
- schemaVersionは2。v1は読み込み時に移行。座標はpx、原点は左上。x,yはアンカー位置（既定は中心）。数値時刻は秒で計測値を丸めない。
- element: { id, name?, type: "rect"|"ellipse"|"text"|"group", parentId?, inPoint?, outPoint?, zIndex?,
    width?, height?, cornerRadius?, fill?, stroke?, strokeWidth?, text?, fontSize?, fontWeight?, transform?, note? }
- transform: { x, y, scaleX, scaleY, rotation(度), opacity(0..1) }。各値は数値（固定）か
    { keys: [{ t, v, ease? }, ...] }（キーフレーム、時刻順）。
- ease はそのキーから次のキーまでの補間: "linear"(既定) | "hold" | "easeIn" | "easeOut" | "easeInOut" |
    "overshoot" | "anticipate" | { cubic: [x1,y1,x2,y2] }（CSS cubic-bezier と同じ）。
- group は描画されない親。子の位置・回転・拡縮に合成される。opacity は親から継承しない。
- fill: "none" で塗りなし。未知のキーはエラーになる。
- markers: [{ t, kind: "cut"|"beat"|"downbeat"|"section"|"note", label?, origin?: "measured"|"estimated"|"manual" }]

## 拍推定
- detect_beatsは元動画の音声をlibrosaで解析し、推定beatマーカーを保存する。手動マーカーは保持。再解析は推定beatだけ置き換える。
- 推定BPM、onsets、RMS、ライブラリ版・パラメータ・入力ハッシュはproject.audioAnalysisに保存。scene.tempoは変更しない。
- 拍は打楽器が止まる区間でも続き得る。キック検出・小節・サビの推定ではない。

## M2〜M4の計測・モデル・再構成
- model_project(project_id, operation, input) を使う。documentsは読取（inputなし）。他はinput.baseRevisionが必須。actorはMCPが設定する。
- track-region: {baseRevision,from,to,region:{x,y,w,h},method?:"features"|"silhouette",polarity?:"dark"|"light",threshold?}。CFR動画の10秒以内。featuresは特徴点。silhouetteはコントラストが高い字形の重心・外接寸法を測り、線形または単調cubicで近似。初期領域は対象だけを余白つきで囲む。欠測を記録し、矩形のキーとして確認できる。
- track-regionにtargetElementIdを指定すると、silhouette結果を既存の文字へ直接適用。親なし・分割なしの文字の表示区間と、追跡するフレーム範囲を一致させる。位置・幅・高さ・アンカーを置換し、回転は0。最後まで追跡できなければ適用しない。
- observe-glyphs: {baseRevision,entries:[{from,to,relation:"combine",parts:[{text,elementId?}],result:{text,elementId?}} または {from,to,relation:"ruby",base:{text,elementId?},ruby:{text,elementId?}}]}。元動画で観察した文字構成を記録する。観察IDは仮説から参照できる。
- 合字の比較版にはcombine観察へcombineAt（秒）と全ての文字要素IDを記録。modelの規則は {id,hypothesisId,kind:"glyph_combine",observationId,partCompanions?:{部品ID:[付随要素ID]},resultCompanions?:[付随要素ID]}。対象の観察を仮説にも紐づける。variantのsecondsは登場の間隔、order:"reverse"は部品順の反転、mergeOffsetSecondsは合体時刻の変化。付随要素のキーもずらす。合体後の表示が観察区間外に出る変更は拒否する。
- measure-events: {baseRevision,events:[{label,t,origin:"manual"|"measured"|"estimated",elementId?}]}。最寄りbeatとの差。負=イベント先行、正=遅延。同距離は前の拍。
- model: {baseRevision,hypotheses:[{id,text,observationIds:[ID],status:"proposed"|"accepted"|"rejected"}],rules:[{id,hypothesisId,kind:"hold",elementId,property:"x"|"y"|"scaleX"|"scaleY"|"rotation"|"opacity",keyIndex} または {id,hypothesisId,kind:"stagger",elementId}]}。既定はID単位で追加・更新。全置換はinput.mode="replace"を明示。規則の仮説はacceptedが必要。採用は仮説の証明ではない。
- variant: {baseRevision,ruleId,seconds,name}。別プロジェクトを作成。holdは同値の連続キー間隔と後続キー時刻を変更（当該トラックだけ、繰返し不可、表示区間超過は拒否）。staggerは文字の時間差を変更。規則保存後にシーンが変わっていたら再確認が必要。
- 複数トラックの連動停止はrulesに {id,hypothesisId,kind:"hold_group",targets:[{elementId,property,keyIndex}]}。対象の停止開始・終了が同じであることを検査し、variantのsecondsで一括変更する。全対象が成功したときだけ生成する。音声は変更しない。
- music: {baseRevision,path}。ローカルの120秒以内の音声を黒背景の動画として取り込む。既存と同じ再生・書き出し経路を使う。新規プロジェクトで実行後detect_beats、必要なら推定拍を修正する。
- adapt: {baseRevision,targetProjectId,targetRevision,name,sections:[{sourceFrom,sourceTo,targetFrom,targetTo,elementIds:[ID],reason}]}。全要素の割当を明示。常時表示の背景・親・タイトルは連続する複数区間に同じIDを含める（複製しない）。親子は別区間も可能。秒キーは区間倍率で変換し、拍キーは新曲の拍へ対応、beatとtempoを保持。不等間隔な拍との差はoffsetSecondsに保存。拍情報がない場合に関係を秒へ黙って焼き込むことはしない。区間外の明示した表示範囲も保持。自動の曲構成理解は行わない。
- adapt-baselines: {baseRevision,targetProjectId,targetRevision,name}。全体速度のみ、最初/最後の拍合わせのみ、固定テンプレートの3版を作る。両シーンに2拍以上必要。拍の局所補正はしない。
- blocking / blocking/analyze / blocking/edit: 工程比較の取得、輪郭計測ジョブの開始、工程の編集。更新はbaseRevision必須。解析はfrom/toをフレーム番号で指定し、regionは元動画pxの[x,y,w,h]。既存ブロックの再計測はblockIdとregionが必要。
- blocking/representative: {baseRevision,label,fragmentIds,from,to,shapeFrame,geometry?}。fromを含みtoの手前までの輪郭断片から、固定の代表形と変形キーを別プロジェクトに保存する。geometry:"affine" でせん断と回転も推定する。
- blocking/analyze: {baseRevision,engine:"sequence-model"} で計測済みの比較範囲を固定形状と変形キーに変換する。完了ジョブのresultProjectIdを開く。入力の観察・出来事・輪郭は元プロジェクトに残る。
- blocking/timing: operation:"lyric" で {baseRevision,text,reading?,from,to,uncertaintySeconds,replaces?} を秒で保存する。音声を実際に確認した時刻を使う。operation:"measure" は確定した出来事を発音・拍・小節頭・立ち上がりに照合し、符号付きの差を保存する。
- blocking/timing: operation:"orientation" の {baseRevision,label,from,to,anchors:[[輪郭断片ID,...],[輪郭断片ID,...]]} は2対象を結ぶ線の角度と距離を各コマで計測する。from/toはフレーム単位、toは含まない。
- blocking/timing: operation:"apply-orientation" の {baseRevision,observationId,shapeFrame,partIds} は選択コマの部品を固定して回転を別プロジェクトでキー化。operation:"motion" の {baseRevision,blockId,from,to,stationaryPx?} は停止・速度・加速度・画面占有率を計測する。
- blocking/timing: operation:"checkpoint" で {baseRevision,blockId,frame,box,note?} を保存。boxは元動画上の [左,上,幅,高さ] または非表示ならnull。採点した箱は近似に含めない。
- style-study: {baseRevision,works:[{projectId,revision,group,credit,creditBasis}],claims:[{id,axis,label,condition,evidence,exceptions?,generation?}]}。groupはauthor/control、axisはmotion/timing/screen/meaning。根拠と例外は {projectId,revision,observationId}。同じ素材の比較版は別作品として数えない。
- variant-pair: variantと同じ入力で、規則を1件変えた版と元の設定を共通素材で生成。応答のrevealは評価担当者へ渡す映像に含めない。
- lyric-study: {baseRevision,targetProjectId,targetRevision,name,lyrics:[{text,from,to,ruby?,parts?,tags?}],effects:[{claimId,kind,tag?,metric?}]}。歌詞は秒単位。効果は entrance/hold/stagger/invert/combine。作品比較で保存した生成範囲を使い、全規則・基準・各規則を外した版を同じ音源で生成。revealは条件の対応表。
- blocking/analyze に engine:"sprite"、from、to、region を指定すると、Fast Spriteの変形とVTracerの代表形を別プロジェクトへ保存する。toは含まない。結果のプロジェクトIDはジョブのresultProjectId。
- blocking/export-job: {baseRevision}で4画面のMP4を書き出すジョブを開始。blocking/job / blocking/cancel / blocking/retry: {jobId}で解析・書き出しジョブの状態を読み取り・中断・再試行。
- documentsでobservations/hypotheses/motion_rules/simplification/adaptationを読む。シーンと同じ履歴に保存しrevertで一緒に戻る。生成結果は通常のget_frames/render_preview/UIで確認できる。

## v2の関係記述（詳細）
- scene.tempo: {bpm, offset}。拍0の秒時刻がoffset。Key.tとinPoint/outPointは秒か{beat, offsetSeconds?}。
- 時刻=offset+beat*60/bpm+offsetSeconds。拍は0始まり・四分音符単位。長さは秒か{beats}（offsetを足さない）。
- textのsplit:"char"|"word"、stagger:{interval,order?:"forward"|"reverse"}、unitTransform。
  transformは全体に適用し、unitTransformだけを単位の順序×interval遅らせる。単位x/yは組版位置からの差分。
  登場前を隠すにはunitTransform.opacityを0から始める。charは書記素単位（空白も順序に数える）、wordは空白区切り（空白は幅のみ）。一行のみ。
- letterSpacingはsplit時のみ（UIの字間設定は必要に応じて文字分割を選ぶ）。認識された書体とウェイトはGET /api/fontsを参照。同じローカルファイルをUIとサーバーで使う。未登録指定はエラー。
- anchorX/anchorYは中心原点のローカルpx。行列はT(x,y) R S T(-anchor)。既定0でv1の見た目を保持。
- キートラックにrepeat:{every,count? または until?}。everyは正の長さ、countは初回込み。最初のキーから繰り返す。
  キー範囲は1周期以内。周期末は最終値を保持し、次周期の境界で先頭へ。終了後は終了直前の値を保持。
- BPM変更は拍指定だけに作用。秒指定・元動画音声・scene.durationは変わらない。キー順が逆転する更新は拒否。
- 分割・反復・拍キーのタイムライン表示は読取専用。JSON/opsで関係を変更する。
- 推定マーカーはsetMarkersでoriginをmanualにして確定、配列から除いて却下。UIの右パネルからも操作可能。

## update_scene の ops
- { op: "upsertElement", element }            同じidは丸ごと置換、なければ追加
- { op: "patchElement", id, patch }           一部だけ上書き（transformはトラック単位でマージ）
- { op: "removeElement", id }
- { op: "setSceneProps", props: { width?, height?, fps?, duration?, background?, tempo? } }
- { op: "setMarkers", markers }

## リビジョン
変更には base_revision（get_project_state で得た revision）が必要。人が先に変更していると拒否されるので、
読み直してからやり直す。revert_revision で過去の状態を新しいリビジョンとして復元できる。

## 記述の原則
- 観察（何がいつ動いたか）と仮説（なぜそうしたか）を混ぜない。要素の note には置換の理由を書く。
- 単語が一括で動くのか一文字ずつずれるのか等、動きの単位を潰さない。
- 現時点で未実装: 小節・区間の音声解析、自動の分割・追跡、仮説・規則の保存、AE/Blender出力。
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
      region: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), w: z.number().int().positive(), h: z.number().int().positive() }).optional().describe('元動画pxでの切り出し領域。compareは両側へ同じ領域を適用'),
      grid_step: z.number().int().min(8).max(2048).optional().describe('元動画pxでの座標目盛り間隔'),
    },
  },
  tool(async (a: { project_id: string; kind: string; times?: number[]; from?: number; to?: number; count?: number; cell_width?: number; columns?: number; region?: { x: number; y: number; w: number; h: number }; grid_step?: number }) => {
    await ensureServer();
    const q = new URLSearchParams({ kind: a.kind });
    if (a.times?.length) q.set('times', a.times.join(','));
    if (a.from !== undefined) q.set('from', String(a.from));
    if (a.to !== undefined) q.set('to', String(a.to));
    if (a.count !== undefined) q.set('count', String(a.count));
    if (a.cell_width !== undefined) q.set('cellWidth', String(a.cell_width));
    if (a.columns !== undefined) q.set('columns', String(a.columns));
    if (a.region) q.set('region', JSON.stringify(a.region));
    if (a.grid_step !== undefined) q.set('gridStep', String(a.grid_step));
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

server.registerTool('detect_beats', {
  description: '元動画の拍とBPMを推定してbeatマーカーを保存。手動修正を保持。シーンtempoは変更しない。',
  inputSchema: { project_id: z.string(), base_revision: z.number().int() },
}, tool(async (a: { project_id: string; base_revision: number }) => [text(await call('POST', `/api/projects/${a.project_id}/detect-beats`, { baseRevision: a.base_revision, actor: ACTOR }))]));

server.registerTool('model_project', {
  description: '計測・仮説・規則・比較版・別曲への区間対応。詳しい入力はget_guide。更新はbaseRevision必須。',
  inputSchema: { project_id:z.string(), operation:z.enum(['documents','track-region','measure-events','observe-glyphs','model','style-study','lyric-study','variant','variant-pair','adapt','adapt-baselines','music','blocking','blocking/analyze','blocking/edit','blocking/representative','blocking/timing','blocking/export-job','blocking/job','blocking/cancel','blocking/retry']), input:z.record(z.string(),z.unknown()).optional() },
}, tool(async (a:{project_id:string;operation:string;input?:Record<string,unknown>}) => {
  const base=`/api/projects/${encodeURIComponent(a.project_id)}`;
  if(['blocking/job','blocking/cancel','blocking/retry'].includes(a.operation)) {
    const id=encodeURIComponent(z.string().uuid().parse(a.input?.jobId));
    const action=a.operation.split('/')[1];
    return [text(await call(action==='job'?'GET':'POST',`${base}/blocking/jobs/${id}${action==='job'?'':'/'+action}`))];
  }
  const read=a.operation==='documents'||a.operation==='blocking';
  return [text(await call(read?'GET':'POST',`${base}/${a.operation}`,read?undefined:{...a.input,actor:ACTOR}))];
}));

server.registerTool('compare_segment', {
  description: '元動画と簡略版の指定区間をSSIMで比較。区間・revision・比較条件付きの数値を返す。最大120秒。',
  inputSchema: { project_id: z.string(), from: z.number().nonnegative(), to: z.number().positive(), width: z.number().int().min(160).max(1920).optional() },
}, tool(async (a: { project_id: string; from: number; to: number; width?: number }) => [text(await call('POST', `/api/projects/${a.project_id}/compare`, { from: a.from, to: a.to, width: a.width }))]));

await server.connect(new StdioServerTransport());
console.error(`[motion-logic mcp] ready (server: ${BASE})`);
