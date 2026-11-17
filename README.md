# Motion Logic

Motion Logic Modeling（MLM）のアプリ。参考映像の「動きと演出構成」を単純な図形のシーンに落とし、元動画と並べて確かめるための土台。人はブラウザで、AIはMCPで、同じプロジェクトを読み書きする。

- 企画と調査：[docs/Motion_Logic_Modeling_Codex_Handoff.md](docs/Motion_Logic_Modeling_Codex_Handoff.md)
- 計画と仕様、現在の到達点：[docs/01_計画仕様書.md](docs/01_計画仕様書.md)

## 必要なもの

- Node.js 24 以上（TypeScriptを変換なしで直接実行する）
- FFmpeg と ffprobe（PATH上、または環境変数 `MLM_FFMPEG` / `MLM_FFPROBE`）

## 起動

```bash
npm install
```

```bash
npm run dev
```

ブラウザで http://localhost:5173 を開き、「デモを作成」で動作を確認できる。

| コマンド | 内容 |
|---|---|
| `npm run dev` | サーバー(4517)とUI(5173)を起動 |
| `npm run server` | サーバーだけ起動 |
| `npm run stop` | 起動中のサーバーを止める（MCPが裏で自動起動したものを含む） |
| `npm test` | コアのテスト |
| `npm run typecheck` | 全体の型チェック |
| `npm run build` | UIをビルド（サーバーが http://127.0.0.1:4517 で配信する） |

操作：

| 操作 | 内容 |
|---|---|
| Space | 再生／停止 |
| ← → | 1フレーム移動 |
| I / O（または「イン」「アウト」） | 区間の始点／終点を現在位置に。「ループ」で区間を繰り返し再生。区間があると書き出しもその区間になる |
| 速度の選択 | 0.25／0.5／1／2倍で再生 |
| タイムラインをクリック | シーク |
| タイムラインの行をクリック | 要素を選択して右のパネルでJSON編集。選択中の要素は軌道（1フレームごとの点。間隔が速さ）を表示 |
| タイムラインの◆を左右にドラッグ | そのキーの時刻を動かす |
| 簡略版の図形をドラッグ | 移動（親を持つ要素は親の回転・拡縮を打ち消して保存） |
| 四隅の□をドラッグ／丸いハンドルをドラッグ | 拡縮／回転（画面上端の要素では回転ハンドルは下側に出る） |
| 「カット候補を検出」 | 元動画のカット候補を `cut` マーカー（推定）として追加 |
| 「MP4書き出し」 | 簡略版だけ、または元動画と左右に並べた比較動画を書き出す（元動画の音声つき） |
| 「ごみ箱へ」 | プロジェクトを `data/trash/` へ移す（完全には消さない） |

ドラッグ1回が1リビジョンとして保存される。

## AIから操作する（MCP）

MCPアダプターは `apps/mcp/src/index.ts`。サーバーが動いていなければ自動で起動する。

**Claude Code**（デスクトップアプリのCodeタブ／CLI）：このフォルダで開けば [.mcp.json](.mcp.json) が読まれる。初回は承認を求められる。

**Claude Desktop**（通常のチャット）：`%APPDATA%\Claude\claude_desktop_config.json` の `mcpServers` に追加し、アプリを完全に終了して開き直す（タスクトレイからも終了）。パスは実際の場所に合わせる。`node` はフルパスで書くほうが確実（アプリからは PATH が通らない場合がある）。この端末では 2026-11-15 に追記済み（バックアップは同じフォルダの `claude_desktop_config.json.bak-mlm-20261115`）。接続は未確認。

```json
{
  "mcpServers": {
    "motion-logic": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\Motion Logic Modeling\\apps\\mcp\\src\\index.ts"]
    }
  }
}
```

**Codex CLI**：`~/.codex/config.toml` に追加。

```toml
[mcp_servers.motion-logic]
command = "node"
args = ['C:\path\to\Motion Logic Modeling\apps\mcp\src\index.ts']
```

ツール（15）：`get_guide` `list_projects` `create_project` `import_media` `get_project_state` `update_scene` `get_frames` `render_preview`（`layout: "compare"` で比較動画） `detect_cuts` `detect_beats` `compare_segment` `model_project` `get_history` `revert_revision` `delete_project`（ごみ箱へ移す）。使い方とシーン形式は `get_guide` が返す。

ChatGPTアプリは公開HTTPSのMCPが必要なため、現時点では対象外（計画仕様書 §3.4）。

## 構成

```
packages/core   スキーマ、時刻tでの評価、Canvas描画、部分更新（UIとサーバーで共用）
apps/server     HTTP API、保存、FFmpeg連携、画像書き出し、変更通知
apps/mcp        MCPアダプター（サーバーのHTTP APIを呼ぶだけ）
apps/web        UI
data/           プロジェクトの保存先（Git管理外。MLM_DATA_DIR で変更可）
```

## 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `MLM_PORT` | 4517 | サーバーのポート |
| `MLM_DATA_DIR` | `./data` | プロジェクトの保存先 |
| `MLM_FFMPEG` / `MLM_FFPROBE` | `ffmpeg` / `ffprobe` | 実行ファイルの場所 |
| `MLM_SERVER_URL` | — | MCPアダプターの接続先を固定する（自動起動しない） |
| `MLM_ACTOR` | `ai` | MCP経由の変更に記録する名前 |

## まだ無いもの

拍・区間などの音声解析（波形表示のみある）、自動の分割・追跡、ジョブ管理（長い処理の進捗・キャンセル）、仮説・規則の保存、AE/Blender出力、狭い画面幅への対応。計画仕様書 §5・§7 を参照。

書き出しは同期処理で一度に最大120秒。比較動画は内部で複数回FFmpegを呼ぶ（計画仕様書 §5 Phase 1）。

## 2026-11-17：スキーマv2

文字／単語分割と時間差、全体とは別の単位アニメーション、拍基準の時刻、繰り返し、アンカー、フォント指定に対応。
v1は読み込み時に移行し、次の変更時にv2で保存する。タイムラインの関係から展開したキーは読み取り専用、右のJSON欄から関係を編集できる。
BPMと文字の分割・秒の時間差は右パネルから変更できる。BPMを変えても元動画・音声・シーン尺は変わらない。
推定カットなどは右パネルで確定／却下／推定分の一括削除ができる（再解析で候補が再び出る場合あり）。

指定できる登録フォントは現在 `MLM Arial`、ウェイト400/700。Windowsの既存Arialファイルをブラウザとサーバーで共用し、未登録の指定はエラーにする。フォント一覧は `GET /api/fonts`。

検証の再実行：`node scripts/verify-v2.mjs`。既存の合成サンプル `p_mwh3s99t2w85` を読み、`data/v2-validation/` に別プロジェクトとレポートを作る。既定ポート4518（`MLM_VERIFY_PORT`で変更可）。元プロジェクトは編集しない。

[v2の根拠・検証数値](docs/06_v2_Implementation_Results.md)。拍推定は下記の通り実装済み。実素材での計測、新曲への構成は未検証／未実装。

## 拍推定ワーカー（M2b）

初回セットアップ：`uv sync --project workers/beats --python 3.11`。依存はuv.lockで固定し、専用.venvへ入れる。
UIの「拍を推定」、MCPの`detect_beats`、HTTPの`POST /api/projects/:id/detect-beats`（baseRevision必須）から実行。
実行時はoffline/frozenで追加ダウンロードしない。元動画に音声が必要。BPM推定はシーンtempoを自動変更しない。
確認用：`node scripts/verify-beats.mjs`（先にverify-v2の検証データが必要）。結果と制約は文書07。

`get_frames` の `region: {x,y,w,h}` は元動画pxの切り出し領域、`grid_step` は座標目盛りの間隔。compareでは左右とも同じ領域を拡大する。動画がない場合はシーン座標。HTTPはregionをJSON文字列、gridStepを数値で指定する。

区間SSIM：MCP `compare_segment(project_id, from, to, width?)` または `POST /api/projects/:id/compare`（JSON: from/to/width）。最大120秒。元動画と簡略版を同じ寸法・フレームレートで比較する。検証は `node scripts/verify-beats-http.mjs`。

領域追跡：`uv sync --project workers/track --python 3.11`。CLI検証は `node scripts/verify-track.mjs C:/Users/kinos/mlm_samples/kinetic_sample.mp4`。HTTP/MCPからも実行でき、観察と近似を分離保存して矩形のキーへ適用する。追跡の専用UIとcubic-bezier近似は未実装。[初期検証](docs/09_Tracking_Comparison_Results.md)、[アプリ接続とM3・M4](docs/10_M3_M4_Implementation.md)。

## M3・M4の初版（API / MCP）

MCPの `model_project(project_id, operation, input)` で次を実行できる。入力形式は `get_guide` に記載。HTTPは同名の `POST /api/projects/:id/<operation>`。更新にはbaseRevision、再構成にはtargetRevisionも必要。

- `track-region`：領域追跡→観察保存→線形キー適用。
- `measure-events` / `model`：イベントと拍の差を計測し、その観察に紐づく仮説・規則を保存。
- `variant`：停止長・文字の時間差を変更した別プロジェクトを生成。
- `music`：新規プロジェクトにローカル音声を取り込み（黒背景動画に変換、120秒以内）。続いて `detect_beats` で解析。
- `adapt`：全要素の区間対応と理由を明示し、対象曲へ時間を割り当てた別プロジェクトを生成。
- `adapt-baselines`：全体速度変更、拍の両端合わせ、固定テンプレートの3比較版を生成。
- `documents`：観察・仮説・規則・近似・再構成の文書を取得。これは読取なのでinput不要。

生成物は通常のプロジェクトとして既存UIで閲覧・編集・書き出しできる。専用フォームや楽曲構成の自動推定はまだない。実素材による演出評価も未完了。

統合検証：`node scripts/verify-modeling.mjs C:/Users/kinos/mlm_samples/kinetic_sample.mp4`。隔離した `data/modeling-validation/` にテスト用プロジェクトとreport.jsonを保存する。[根拠・検証・制限](docs/10_M3_M4_Implementation.md)。
