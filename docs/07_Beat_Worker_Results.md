# M2b 拍推定：実装と検証

2026-11-17。前段のv2/M2dはコミット `0eda660`。この文書の拍推定追加はその後の作業。

## 判断の根拠

- 既存Pythonは3.11.9、既存librosaは0.11.0。最新PyPI表示は1.0.1/Python>=3.12だったため、Python更新を増やさず0.11.0を専用環境に固定した。
- 一次資料：https://pypi.org/project/librosa/ 、https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html （2026-11-17確認）。公式説明はオンセット強度→テンポ推定→テンポと整合するピーク選択。拍と音種の検出は区別する。
- hop_length=256、22050Hzで時間刻みは約11.6ms。30fpsの1フレーム33.3msより細かく評価する。trim=Falseで先頭末尾の弱い拍も候補として残す。
- ユーザーがPyPIダウンロードを承認。librosa/numpy/soundfileを固定し、全依存はuv.lockで固定。27パッケージを専用.venvに導入。初回Numbaコンパイルには時間を要した。
- 解析時はuv offline/frozen。タイムアウトは音声抽出120秒・ワーカー180秒。同期処理で進捗・キャンセルはまだない。
- 推定BPMをscene.tempoへ自動適用しない。計測の追加で既存モーションを変えてしまうことを防ぐ。
- project.audioAnalysisに解析値、版、パラメータ、WAVハッシュと元動画ハッシュを保存する。取り込み直しでは旧解析を除去する。履歴シーンにはマーカーが残るが解析結果全体の版別保存は未実装。

## 実装

workers/beatsのCLI、HTTP detect-beats、MCP detect_beats（計13ツール）、UIボタン。
秒のbeatマーカーをestimatedとして追加。再実行時は以前の推定beatだけ置換、manualは保持。
onsetsとRMSも保存するがUIグラフは未実装。downbeat・小節・区間・キック検出は未実装。

## 実測

既存の10秒・120BPM合成動画からFFmpegでmono/22050Hz WAVを抽出。
専用環境でワーカー実行成功。サーバーのdetectBeats関数を隔離プロジェクトへ2回実行した。

- 推定BPM：120.18531976744185。
- 20拍。正解の0.5秒グリッドに対する最大誤差0.028662秒。20/20拍が±1フレーム以内。
- 再実行時の推定マーカー置換、manual保持、scene.tempo不変をassertで確認。
- 4.0秒の拍も推定される。キックが欠けることを示す試験は未達。onset/RMSからキックの有無を断定しない。
- 生データ：data/v2-validation/beats-result.json、beats-verification.json。
- TypeScript型チェック、既存core20テスト、UIビルド成功。

HTTP/MCP/UIの新しい入口そのものの実操作試験、無音・短音源・実曲の試験、過去解析結果の保存方法の整理は残っている。M2b全体の受け入れ完了とはしない。


## 追試：HTTP・MCP・UIと境界条件

- `node scripts/verify-beats-http.mjs`：HTTPとMCPのdetect_beats成功。手動マーカーとscene.tempoを保持。
- 古いrevision、解析要求と同時に入る編集は409、入力メディアなしは400。別の編集を解析結果で上書きしない。
- ブラウザの「拍を推定」から実行し、r18→r19、履歴に120.19BPMが保存されることを確認。scene.tempoは100のまま。
- 専用環境で `python -m unittest test_beats`：無音・100サンプルの極短音声・NaN・空音声の4試験成功。極短音声はlibrosaが窓長の警告を出すが拍は捏造されない。
- UIの解析中表示を「拍を解析中…」へ修正。
- 残り：実曲、キックの不在を評価する方法、解析結果全体の履歴管理。上のHTTP/MCP/UI未検証という記述はこの追試で更新する。
