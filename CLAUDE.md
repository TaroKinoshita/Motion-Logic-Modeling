# Motion Logic — 作業ルール

作業を始める前に [docs/01_計画仕様書.md](docs/01_計画仕様書.md) を読む。企画の背景は [docs/Motion_Logic_Modeling_Codex_Handoff.md](docs/Motion_Logic_Modeling_Codex_Handoff.md)。次にやる作業は計画仕様書 §7。

## コマンド

- `npm run dev` — サーバー(4517)＋UI(5173)。`npm run stop` — サーバー停止。
- `npm test` / `npm run typecheck` — 変更後は両方通すこと。

## 構造上の約束

- **状態の持ち主は `apps/server` だけ。** UIとMCPは必ずHTTP APIを通す。MCPアダプター（`apps/mcp`）にロジックや状態を置かない。
- **描画は `packages/core` の `drawFrame` 一つ。** ブラウザ用とサーバー用で別の描画を書かない。見た目を変えるときはここを直す。
- **シーンの定義は `packages/core/src/schema.ts` が唯一の正。** 形式を変えたら、MCPの `get_guide` の説明文（`apps/mcp/src/index.ts`）と計画仕様書 §4.3 も合わせて直す。互換性を壊す変更は `SCHEMA_VERSION` を上げる。
- **変更は必ず `commit()`（`apps/server/src/store.ts`）を通す。** リビジョン・履歴・変更通知がそこで行われる。
- **時刻は秒の実数で保存する。** フレーム番号や拍に丸めて保存しない。
- **推定値と計測値と人の修正を区別して保存する**（マーカーの `origin` など）。観察と仮説を同じ場所に混ぜない。
- 中身のない器（空のスタブ、未接続のUI部品）を先に作らない。実データ・実描画がつながってから足す。

## 技術的な注意

- Node 24 がTypeScriptを直接実行する。そのため import は拡張子 `.ts` つきで書き、`enum`・パラメータプロパティなど型以外の構文は使わない（`erasableSyntaxOnly`）。
- **サーバーのコードを変えたのに挙動が変わらないときは、古いサーバーが残っている。** MCPアダプターはサーバーを裏で自動起動し、それは開発サーバーを止めても残る。`npm run stop` で止めてから `npm run dev` し直す（`npm run dev` は起動済みを検出すると知らせる）。
- MCPアダプターは stdout を通信に使う。ログは `console.error` のみ。
- MCPのツール一覧は小さく保つ（説明は短く、詳細は `get_guide` へ）。
- Pythonの解析コードは `workers/` に置き、研究実装ごとに別の環境（uv）で動かす。アプリ本体の依存に混ぜない。比較用にcloneするリポジトリは `external/`（Git管理外）。
- この端末のGPUは RTX 4060 Laptop 8GB。モデルを入れる前にVRAM使用量を測る。
- リポジトリはOneDrive配下にある。大きなデータは `MLM_DATA_DIR` でOneDrive外に置ける。

## 報告のしかた

ユーザーは率直で現実的な評価を求めている。動かして確かめたこと・未検証のこと・提案を分けて書く。「AIが演出を理解した」のような、計測や描画の裏づけがない表現をしない。
