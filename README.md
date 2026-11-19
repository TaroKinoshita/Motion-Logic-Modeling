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

小節・楽曲区間のモデルによる推定、背景が複雑な動画の分解、別の実曲での受け入れ評価、AE/Blender出力が残る。通常編集画面は横幅の広い画面を前提にする。[最新の検証と制約](docs/17_Contour_Blocking_Result.md)。

書き出しは同期処理で一度に最大120秒。比較動画は内部で複数回FFmpegを呼ぶ（計画仕様書 §5 Phase 1）。

## 2026-11-17：スキーマv2

文字／単語分割と時間差、全体とは別の単位アニメーション、拍基準の時刻、繰り返し、アンカー、フォント指定に対応。
v1は読み込み時に移行し、次の変更時にv2で保存する。タイムラインの関係から展開したキーは読み取り専用、右のJSON欄から関係を編集できる。
BPMと文字の分割・秒の時間差は右パネルから変更できる。BPMを変えても元動画・音声・シーン尺は変わらない。
推定カットなどは右パネルで確定／却下／推定分の一括削除ができる（再解析で候補が再び出る場合あり）。

登録フォントは、この端末にある `MLM Arial`、`MLM Yu Gothic`、`MLM BIZ UD Gothic`、ウェイト400/700。Windowsの既存ファイルをブラウザとサーバーで共用する。フォント一覧は `GET /api/fonts`。

検証の再実行：`node scripts/verify-v2.mjs`。既存の合成サンプル `p_mwh3s99t2w85` を読み、`data/v2-validation/` に別プロジェクトとレポートを作る。既定ポート4518（`MLM_VERIFY_PORT`で変更可）。元プロジェクトは編集しない。

[v2の根拠・検証数値](docs/06_v2_Implementation_Results.md)。拍推定は下記の通り実装済み。実素材での計測、新曲への構成は未検証／未実装。

## 拍推定ワーカー（M2b）

初回セットアップ：`uv sync --project workers/beats --python 3.11`。依存はuv.lockで固定し、専用.venvへ入れる。
UIの「拍を推定」、MCPの`detect_beats`、HTTPの`POST /api/projects/:id/detect-beats`（baseRevision必須）から実行。
実行時はoffline/frozenで追加ダウンロードしない。元動画に音声が必要。BPM推定はシーンtempoを自動変更しない。
確認用：`node scripts/verify-beats.mjs`（先にverify-v2の検証データが必要）。結果と制約は文書07。

`get_frames` の `region: {x,y,w,h}` は元動画pxの切り出し領域、`grid_step` は座標目盛りの間隔。compareでは左右とも同じ領域を拡大する。動画がない場合はシーン座標。HTTPはregionをJSON文字列、gridStepを数値で指定する。

区間SSIM：MCP `compare_segment(project_id, from, to, width?)` または `POST /api/projects/:id/compare`（JSON: from/to/width）。最大120秒。元動画と簡略版を同じ寸法・フレームレートで比較する。検証は `node scripts/verify-beats-http.mjs`。

領域追跡：`uv sync --project workers/track --python 3.11`。CLI検証は `node scripts/verify-track.mjs C:/Users/kinos/mlm_samples/kinetic_sample.mp4`。HTTP/MCPからも実行でき、観察と近似を分離保存する。輪郭による領域追跡は、観測点の誤差を制限したcubic近似に対応する。 [領域追跡の検証](docs/12_Lyricsample1_Followup.md)

## 輪郭と動きの工程比較

固定フレームレートで背景がほぼ単色の素材を取り込み、「輪郭と動きを解析」を選ぶ。編集しているシーンは履歴に保持される。「工程比較」で入力、動き、関係と時刻、最終調整を4画面または単独で再生できる。箱の修正、区間の再計測、軌道の分割、ブロックのまとめ・解除、出来事の確定・却下、仮説と規則の編集、4面出力をここから行える。解析と4面書き出しはジョブとして進捗、中断、再試行に対応する。

輪郭追跡のPython依存は `workers/track/blocking-requirements.txt`。検証環境はPython 3.11。別の環境を使う場合は `MLM_BLOCKING_PYTHON` を指定する。OCRの重みがない環境でも輪郭を計測できる。 [検証結果と再実行](docs/17_Contour_Blocking_Result.md)

「ブロックの修正」で「同じ文字の断片から代表形を作る」を選び、2〜48コマの範囲と代表のコマ、接触前後の断片を指定する。範囲の終了Fは含まない。固定の輪郭と変形キーが別プロジェクトに保存される。「外観を文字へ置換」で、親の動きを使って別の文字を表示できる。近似には既存の `workers/track` のuv環境を使い、別の実行先は `MLM_TRACK_PYTHON` で指定する。 [実装計画と検証結果](docs/19_Editable_Motion_And_Style_Plan.md)

計測版の工程比較で「全編を固定形状とキーに変換」を実行できる。変換結果は別プロジェクトに保存される。輪郭の特徴が大きく変わる箇所は固定形状を区間ごとに選び、出来事に候補を表示する。輪郭を計測した実素材では `node scripts/verify-lyrics-sequence-model.mjs <元プロジェクトID> <前回の報告JSON> <出力先>` で、Lyricsample1の全編モデルと採点資料を再生成できる。

Lyricsample2〜7の全編比較、文字差し替え、実音源への転用結果は [文書22](docs/22_Corpus_Editable_Review.md)。比較画面の作品一覧から各モデルを開ける。「輪郭と動きを解析」では、素材に合わせて明暗・単色背景と色文字・枠と文字・暗地の高コントラスト文字を選ぶ。

## M3・M4の初版（API / MCP）

実素材の計測と再現については [Lyricsample1 の再計測](docs/12_Lyricsample1_Followup.md)。`track-region` は明暗のはっきりした字形用の `method:"silhouette"` を選択可能。`observe-glyphs` で合字の部品・ルビを観察として保存できる。既存の日本語フォントと字間の指定、切替の吸着はインスペクターから行える。

レビュー対応：拍指定を新曲へ対応させて保持、常時表示要素の複数区間割当、`hold_group`による複数トラック停止を追加。[仕様と制限](docs/11_Review_Relations_Fix.md)。

MCPの `model_project(project_id, operation, input)` で次を実行できる。入力形式は `get_guide` に記載。HTTPは同名の `POST /api/projects/:id/<operation>`。更新にはbaseRevision、再構成にはtargetRevisionも必要。

- `track-region`：領域追跡→観察保存→線形キー適用。
- `measure-events` / `model`：イベントと拍の差を計測し、その観察に紐づく仮説・規則を保存。
- `variant`：停止長・文字の時間差を変更した別プロジェクトを生成。
- `music`：新規プロジェクトにローカル音声を取り込み（黒背景動画に変換、120秒以内）。続いて `detect_beats` で解析。
- `adapt`：全要素の区間対応と理由を明示し、対象曲へ時間を割り当てた別プロジェクトを生成。
- `adapt-baselines`：全体速度変更、拍の両端合わせ、固定テンプレートの3比較版を生成。
- `documents`：観察・仮説・規則・近似・再構成の文書を取得。これは読取なのでinput不要。

工程比較の「観察・仮説・規則」で、拍との照合、モデルの編集、比較版生成、転用区間の指定と比較基準生成を行える。小節頭・区間は手で修正できる。転用時はシーンと輪郭、出来事、外観の時刻を変換する。実曲への転用の受け入れ試験は残る。

同じ画面で発音区間を手で記録し、確定した出来事を発音・拍・小節頭・オンセットと照合できる。2つの輪郭の中心から画面内の角度を計測できる。`style-study` は作品クレジットと観察のリビジョンを保存し、`variant-pair` は共通素材で元の設定と規則を1件変更した比較版を生成する。MCPの入力形式は `get_guide` を参照。

工程比較では代表形のアフィン近似、回転のキー化、停止・速度・占有率の観察、確認コマの別採点を利用できる。`lyric-study` は歌詞区間と作品比較の規則を指定して、基準版・全規則版・規則を1つずつ外した版を同じ音源で生成する。実素材と合成音源での書き出し再現は `node scripts/verify-lyrics-phases.mjs <輪郭プロジェクトID> <出力先>`。 [比較方法と結果](docs/19_Editable_Motion_And_Style_Plan.md)

「観察・仮説・規則」から、ブロックの短い区間を流し・横つぶれ・回転の型として保存できる。`lyric-study` の `comparison: "motion-layout"` は時刻規則を共通にして動きと配置の組み合わせを比較する。行の動きは `motion`、文字別の動きは `glyphMotion`、配置は `layout` で指定する。外観の差し替えでは親文字の読みと表示位置も設定できる。 [設定と実測](docs/20_Motion_Vocabulary_Plan.md)

`comparison: "composition-compound"` は、合字の表示時刻と動きを固定し、文字の大小・配置と、合字に合わせた白黒反転を4条件で比較する。「新しい歌詞から規則比較を生成」の設定例から試せる。 [設定と実測](docs/20_Motion_Vocabulary_Plan.md#合字と構図の比較2026-11-19)

統合検証：`node scripts/verify-modeling.mjs C:/Users/kinos/mlm_samples/kinetic_sample.mp4`。隔離した `data/modeling-validation/` にテスト用プロジェクトとreport.jsonを保存する。[根拠・検証・制限](docs/10_M3_M4_Implementation.md)。
