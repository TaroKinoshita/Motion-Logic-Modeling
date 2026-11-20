# 文字候補の矩形改善と先行字を残す重みの比較

## 文字検出

PP-OCRv5の候補に対し、周囲がほぼ同じ色の領域で、元コマの色差から文字領域を測り直した。大きな空白を挟んで横に並ぶ候補は分割する。画面の中で色差を分離できない候補はPP-OCRの値を保持する。判定者は従来どおり役割を分類し、人物・枠・ルビを本文に入れない。

比較には目視で別に記録した矩形を使い、重なりIoUが0.5以上の候補と対象を1対1で対応させた。既知4コマはルールの開発に使い、追加8コマは同じルールで採点した。追加には既知コマと同じ抜粋の別フレームもある。人手矩形は目安で、独立した採点者による一致率は未測定。全コマの認識精度や誤検出率を推定する試験ではない。

| 追加8コマ | 変更前 | 変更後 |
| --- | ---: | ---: |
| 照合対象の矩形が全部そろったコマ | 1/8 | 6/8 |
| 1対1で対応した本文の矩形 | 5/16 | 12/16 |
| 2ブロック以上をまとめた候補 | 4 | 1 |
| 対応した矩形の高さの相対誤差の中央値 | 29.7% | 2.0% |
| 1コマ当たりのCPU処理時間の中央値 | 約195ms | 約220ms |

高さ誤差はそれぞれで対応した枠の範囲であり、同じ枠だけの比較ではない。「青空」の左右は78F・83Fとも分離した。LyricOther5の425Fで縦に並ぶ「青」「に」はまだ結合。Lyricsample4の105Fでは対応が2件から1件に減り、小さな文字を含む構図に課題が残る。本文高さ比2倍・各側6コマという新規素材向けの確認条件は維持した。

[元コマ](../data/Style_OCR_Retention/source-checkpoints.jpg) · [変更前後の枠](../data/Style_OCR_Retention/ocr-before-after.jpg) · [全矩形・保留の根拠・集計](../data/Style_OCR_Retention/ocr-geometry.json) · [改良後の採点画面](../data/Style_OCR_Retention/review/review.html)

## 先行字を保持する選択

元コマ30場面を見直した。先行する字が読め、次の本文が現れた18場面を採点した。先行字を残した7件、切り替えた11件。字の同一性や画面端の欠けで判断できない7件、合字・空白・図形など別の判断に当たる5件は除いた。元作品の判断機会をすべて列挙したデータではない。

選択の直前の構図と2コマ前からの見かけの変化だけを使った。次に出る字や切り替え後のコマは入力に使わなかった。曖昧な場合は切り替えるという固定基準と、保持と切り替えの点数差をリッジ回帰で推定する方法を比較した。正則化係数は4で固定。素材を1本外すごとに残りからのみ標準化と重み推定を行った。音楽・発音や独立した歌詞の指定に基づく保持の手掛かりは今回は使っていない。

| 条件 | 固定基準 | 推定した重み |
| --- | ---: | ---: |
| 参考・対照を合わせた18件 | 11/18（保持0/7） | 13/18（保持2/7） |
| 参考群のみ、両方の選択例を学習側に置けたケース | 8/8 | 5/8 |

全18件で正しく予測できた保持の2件はいずれも対照群だった。参考群の保持2件はLyricsample4に集中した。同素材を外した2件では、学習側に保持例がなく、参考群だけでの予測を保留した。8/8の固定基準はこの2件を外した値。同じ担当による保持の重みを推定できるだけの事例はまだなく、生成器の既定値は試作の手指定のままとした。

[採否・各コマの出典・外した素材ごとの推定値](../data/Style_OCR_Retention/retention-weights.json) · 元コマ一覧 [1](../data/Style_OCR_Retention/retention-1.jpg) [2](../data/Style_OCR_Retention/retention-2.jpg) [3](../data/Style_OCR_Retention/retention-3.jpg) [4](../data/Style_OCR_Retention/retention-4.jpg)

```powershell
python scripts/compare-text-candidate-geometry.py data/Style_Attribution/report.json data/models/pp-ocrv5-mobile-det/inference.onnx data/Style_OCR_Retention/ocr-geometry.json
python scripts/fit-anchor-retention.py data/Style_Attribution/report.json data/Style_Study_Review/source-groups.json data/Style_Phrase_Choice/boundary-comparison.json data/Style_Validation_Complete/native-entry.json data/Style_OCR_Retention/retention-weights.json
```
