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

ツール（12）：`get_guide` `list_projects` `create_project` `import_media` `get_project_state` `update_scene` `get_frames` `render_preview`（`layout: "compare"` で比較動画） `detect_cuts` `get_history` `revert_revision` `delete_project`（ごみ箱へ移す）。使い方とシーン形式は `get_guide` が返す。

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
