# 作家性・演出選択の検証結果と出力一覧

## 結果

| 項目 | 実測した結果 | 現時点の扱い |
| --- | --- | --- |
| 作家判定 | 旧設定では10/13、均衡77.4%。構図に運動を加えた差の入れ替え p=0.275。抜粋長だけでも10/13。帯と背景を調整した再試験は6/11、均衡55.0%。 | 暫定の近さの比較。元作品、抜粋の選び方、配色が担当差と交絡。 |
| 大小の対比 | 除外条件の訂正後、旧前景指標は参考41.1%、対照23.6%。枠が多いLyricsample3も外すと31.8%対23.6%。 | 旧指標は枠を拾う。新規素材では[確認済みの文字ブロック](38_Text_Hierarchy_Correction.md)だけで追試する。 |
| 1コマでの文字の切り替え | 等間隔に採った48短区間から、文字が変わった18区間を元コマで確認。参考は一斉1・段階4・保留2・対象外1。対照は一斉3・段階1・保留6。 | 採点できた9区間では参考1/5、対照3/4。保留の影響が大きく、群の傾向は未確定。 |
| 同じ語の深い縮小 | 1コマで幅・高さが半分以下になり、次の2コマもほぼ保持した既知4件を再検出。 | 発見に使用した2本の事例。全場面での出現率は未確定。 |
| 演出を選ぶ予測 | 34区間で最大17/34、固定基準15/34。追加3件・拡大2件は最良条件でも外れた。音を加えた学習でも既知の縮小は0/4。 | 自動選択の既定値に採用する根拠は得られていない。 |

1コマの監査では、見える文字が連続する元コマでまとまって提示された場合を一斉とし、字形や文字の順序に途中状態がある場合を段階とした。画面端での欠け、遮蔽、文字の範囲が不明な場合を保留し、主役が図形へ移る場面は対象外。1コマは各素材の18〜30fpsを単位とする。深い縮小の検証とは別の分母で、短区間の外にまたがる演出は数えていない。 [判定データ](../data/Style_Validation_Complete/native-entry.json) · 元コマ [前半](../data/Style_Validation_Complete/entry-review-1.jpg) [後半](../data/Style_Validation_Complete/entry-review-2.jpg)

## 別担当の素材から取り出した実音源による生成

LyricOther2の音声と、試験用に書いた「風をほどいて」「林」「朝へ走る」「明」で4版を生成した。既存描画と編集可能なシーンを使い、同じ音源・書体・表示時刻・合字時刻で、構図の変更と合字直後の反転を組み合わせた。合字結果は55F・150F、反転ありの版は次の56F・151Fで切り替わる。位置の移動、漢字の部品、ルビ、結果の大小差を元コマで確認した。

1280×720、24fps、203コマ（約8.46秒）。4版のデコード後の音声は一致。Librosaによる推定は約126 BPM。拍は目安として表示時刻を置くために用いた。歌詞は試験用で、歌声の書き起こし・発音時刻との照合は未実施。LyricOther2は作家判定の対照に使った素材で、既存の生成試作とは別の音源ファイルである。元作品・クレジットの照合や作風の独立評価は未実施。

[4画面比較動画](../data/Style_Real_Audio_Review/comparison.mp4) · [確認コマ](../data/Style_Real_Audio_Review/comparison-checkpoints.jpg) · [条件・選択の出典・編集用プロジェクトID](../data/Style_Real_Audio_Review/reveal-and-results.json) · [評価者用の採点表](../data/Style_Real_Audio_Review/REVIEW.md)

## 未見素材の確認試験

[入力表](../scripts/style-confirmation-intake.example.json)からペアを組み、同じ位置で抽出した区間の文字を照合する。既存13本とのSHA重複を拒否し、同じ曲・シリーズは同じ検証グループにまとめる。[背景の目視確認表](../scripts/style-confirmation-background.example.json)と[文字ブロックの確認表](../scripts/style-confirmation-text.example.json)はどちらも必須。両側の入れ替えの最小到達値が0.05を下回るのは独立6組から。目標を採点可能な独立10〜15組とした。

新規の確認素材は未登録。既存13本からの結果を未見素材の成績へ移さない。空の入力表を実行すると待機状態を出力する。 [窓の準備結果](../data/Style_Validation_Complete/confirmation-plan.json) · [確認試験の状態](../data/Style_Validation_Complete/confirmation-results.json)

```powershell
python scripts/audit-native-entry-windows.py data/Style_Phrase_Opportunities/opportunities.json data/Style_Validation_Complete/native-entry.json
python scripts/prepare-style-confirmation.py scripts/style-confirmation-intake.example.json data/Style_Attribution/report.json data/Style_Validation_Complete/confirmation-plan.json
python scripts/run-style-confirmation.py data/Style_Validation_Complete/confirmation-plan.json data/Style_Validation_Complete/confirmation-results.json
node scripts/verify-style-real-audio.mjs data/Style_Attribution/app-study.json data/Lyricsample1_Staging_Output/report.json data/Style_Real_Audio_Review
```

## データと動画

| 内容 | 参照先 |
| --- | --- |
| 1〜3の統合結果と再検証 | [集計と誤判定](34_Style_Study_Integrated_Review.md) · [固定手順](35_Style_Review_Fixed_Protocol.md) · [入れ替え検定と交絡](36_Style_Review_Fixed_Results.md) |
| 作家判定の数値と素材 | [採点・全条件の比較](../data/Style_Study_Review/comparisons.json) · [素材・音声照合](../data/Style_Study_Review/source-groups.json) · [入れ替え集計](../data/Style_Review_Fixed/permutations.json) · [背景を調整した測定](../data/Style_Review_Fixed/controlled.json) |
| 理論・元コマ・演出選択 | [言葉の理論](24_Verbal_Theory.md) · [語単位の元コマ照合](29_Phrase_Motion_Control_Audit.md) · [深い縮小の再検証](30_Deep_Shrink_Validation.md) · [48区間の比較](31_Phrase_Continuation_Opportunities.md) · [拡縮の選択](32_Phrase_Scale_Choice_Context.md) |
| 復元・差し替え | [Lyricsample1全編比較](../data/Lyricsample1_Full_Model_Output/full_comparison.mp4) · [Lyricsample2〜7修正版一覧](../data/Lyricsample_Corpus_Editable/Corrections/INDEX.md) |
| 合成音源での試作 | [試作の定義](33_Phrase_Boundary_And_Generation_Pilot.md) · [選択と補間の4画面](../data/Style_Phrase_Choice_Pilot/comparison.mp4) |
| 以前のコーパス内の実音源比較 | [区間転用と基準の動画](../data/Lyricsample_Corpus_Editable/M4-Real-Audio/sections-vs-baselines.mp4) · [計測値](../data/Lyricsample_Corpus_Editable/M4-Real-Audio/report.json) |
