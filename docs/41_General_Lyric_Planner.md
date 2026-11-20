# 歌詞と時刻から構成する共通処理

後続の最低文字サイズ・読む順・受け渡し条件とv2出力は[文書42](42_General_Planner_Readability.md)を参照。この文書の実行結果は初版のもの。

入力は、音源を取り込んだプロジェクト、行の開始・終了、語と開始時刻、強調指定。各場面の座標・文字サイズ・キーを入力せず、本文の実測寸法から配置を求める。左右の大小対比、上下の主役と脇役、段階的な配置の3候補を作り、本文同士の衝突を棄却する。主役の大小差、前行からの構図の変化、指定された変化量を点数にする。選択した構図の理由と全候補の点数を保存する。

文字数に応じて書体サイズを調整し、語の開始に合わせて緩急付きの移動と横の拡縮を生成する。行が連続するときは前の主役を上部に短時間持ち越す。持ち越しの条件・配置テンプレート・重みは今回定めた設計値で、作家の映像から学習したものではない。

## 実行結果

Test_audio1の6行と、文字数を変えた6行を同じ生成処理に通した。元歌詞は左右・上下を交互に選び、差し替えでは後半の一部に段階的な配置を選んだ。両方とも30fps・336コマ、すべてのコマで本文同士の重なりと画面外へのはみ出しが0件。変形キー、本文、採用した構図は編集可能。

表示時刻は前回の仮合わせを入力として使った。発音との同期、語の意味からの強調の選択、合字の自動提案、目標の作風と完成品質は今回の実行では確立していない。画面を見直すと、文字数の多い最終行は脇役が小さくなり、さらに読みやすさと動きの選択を詰める余地がある。

- [元歌詞の動画](../data/Test_audio1_General_Planner/supplied.mp4)
- [差し替えとの比較](../data/Test_audio1_General_Planner/comparison.mp4)
- [確認コマ](../data/Test_audio1_General_Planner/contact-sheet.jpg)
- [入力・構図の理由・検査結果](../data/Test_audio1_General_Planner/report.json)
- [元歌詞の入力](../data/Test_audio1_General_Planner/supplied-input.json)
- [編集可能なシーン](../data/Test_audio1_General_Planner/supplied-scene.json)

## アプリとAPI

音源付きプロジェクトに「歌詞と時刻から構成を生成」を追加した。入力JSONを保存すると別プロジェクトを生成する。APIは POST /api/projects/:id/lyric-plan。古いrevisionは拒否し、時刻はfpsに丸めてから区間の重複と語順を検査する。

生成関数からの保存・書き出し、全コマの寸法検査、同じ入力での再現、無効区間の拒否、型検査、既存32テスト、Webビルドを確認した。ローカルHTTPへの接続は実行環境でEACCESになり、HTTP経由とブラウザ操作は未確認。

```powershell
node scripts/verify-general-lyric-plan.mjs data/Test_audio1_Production/report.json data/Test_audio1_General_Planner
```
