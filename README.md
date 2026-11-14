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

操作：Space＝再生／停止、←→＝1フレーム移動、タイムラインをクリック＝シーク、行をクリック＝要素を選択して右のパネルでJSON編集、簡略版の図形をドラッグ＝移動、「MP4書き出し」＝簡略版を動画にする（元動画の音声つき）。

## AIから操作する（MCP）

MCPアダプターは `apps/mcp/src/index.ts`。サーバーが動いていなければ自動で起動する。

**Claude Code**（デスクトップアプリのCodeタブ／CLI）：このフォルダで開けば [.mcp.json](.mcp.json) が読まれる。初回は承認を求められる。

**Claude Desktop**（通常のチャット）：`%APPDATA%\Claude\claude_desktop_config.json` の `mcpServers` に追加し、アプリを完全に終了して開き直す。パスは実際の場所に合わせる。

```json
{
  "mcpServers": {
    "motion-logic": {
      "command": "node",
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

ツール：`get_guide` `list_projects` `create_project` `import_media` `get_project_state` `update_scene` `get_frames` `render_preview` `get_history` `revert_revision`。使い方とシーン形式は `get_guide` が返す。

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

音声解析、自動の分割・追跡、カット検出、仮説・規則の保存、AE/Blender出力、タイムライン上でのキー編集、ドラッグでの拡縮・回転。計画仕様書 §5・§7 を参照。
