# 文字候補の分類と、制約から構図を選ぶ試作

後続の[矩形改善と先行字の重み比較](40_OCR_Geometry_And_Anchor_Retention.md)に追加コマでの試験結果がある。

## 文字を囲む担当

公式PP-OCRv5 Mobileの検出モデルで本文・ルビ等の候補矩形を出す。採点時は素材名と担当群を伏せ、確認者が番号ごとに本文・ルビ・字幕・図形・枠・その他を指定する。確認者は素材の選定や群対応表の作成に関わっていない人を想定し、本試験の担当者はまだ未定。素材に見覚えがあるときは記録する。既存作品を知る制作者・利用者による確認は、操作と測定の予備試験に使う。 [PaddlePaddleの公開モデル](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx)

公式ONNXのSHAを照合し、CPUで実行した。960pxと480pxの2解像度で候補を出し、重複をまとめる。確率地図の文字領域の外接矩形を使っているので、表示された文字の実際の高さとの差は残る。欠落・結合・大きな矩形のずれで高さ比を判断できないコマは保留。見つからなかった文字の入ったコマは、単一ブロックの表示として数えない。

既存5本・9コマで動作を確認し、CPU推論中央値は約171ms。Lyricsample3の85Fでは枠内の左右の文字に候補が出た。LyricOther4の235Fでは人物図形にも候補が出たが、図形として分類すると比率から外れる。Lyricsample2の78Fでは別々に動く「青」「空」が一つの候補に結合したため保留とした。操作確認用の人手分類では9コマ中3コマを採点可能とし、6コマを保留にした。実素材全体への精度や、独立した採点者間の一致率は未確認。

[番号だけで判定する画面](../data/Style_Text_Detection_Pilot/review/review.html) · [検出候補](../data/Style_Text_Detection_Pilot/review/candidates.json) · [照合済みの予備採点](../data/Style_Text_Detection_Pilot/pilot-text-review.json)

採点者に渡す資料はHTMLと同じフォルダー内の採点用画像。素材の対応表は渡さず、判定を締め切ってから候補・判定・元素材を照合する。候補を取り直すと識別子が変わり、旧版への採点を流用できない。

```powershell
python scripts/export-style-text-checkpoints.py data/Style_Validation_Complete/confirmation-plan.json data/Style_Validation_Complete/text-review --detector data/models/pp-ocrv5-mobile-det/inference.onnx
python scripts/join-style-text-review.py data/Style_Validation_Complete/text-review/candidates.json style-text-roles.json data/Style_Validation_Complete/text-review/source-map.json text-review.json
python scripts/run-style-confirmation.py data/Style_Validation_Complete/confirmation-plan.json data/Style_Validation_Complete/confirmation-results.json --background-review background-review.json --text-review text-review.json
```

## 新規素材を見る前に固定する値

**本文の高さ比2倍、各ペアの各側で比較可能なコマ6点以上**は既存13本を見て決めた値。新規の確認試験では結果や欠測を理由にこの値を変更しない。欠測が多ければ、コマごとの保留理由と比較に残った本数を報告する。閾値を変える必要が出た場合は探索として記録し、別の未見素材で確認する。

## 制約から選択・描画する試作

手で構成した4.5秒を見本に、[形式化A](23_Theoretical_Modeling_Plan.md)の部分問題を実装した。入力は文字列・句の開始・手で指定した強調と部品関係。先行字を残す、大小差を付ける、部品から合字する、線を使う、の採否を全探索する。文字のない部品合成などを候補から外し、満たした制約の点数から追加要素の費用を引き、最大の案を編集可能なキーへ変換した。

定めた重みでは、大きい「風」を残しながら小さい続きを出し、線とともに左へ移動して「木＋木→林」へ渡す案を選んだ。保持の重みをゼロにすると、合字と線を保ちながら「風」の持ち越しを落とす案を選んだ。部品を提供しない反例でも合字が選ばれないことを確認した。いずれも108コマ・24fps、同じ音源。座標・加減速を作る描画テンプレートと重みは手で定めた。位置の全探索、作家の重みの学習、歌詞と発音への整合、作品としての評価は未実施。

[制約版と保持の重みを外した版の比較](../data/Style_Constraint_Composition_Pilot/comparison.mp4) · [コマ一覧](../data/Style_Constraint_Composition_Pilot/checkpoints.jpg) · [候補全件・点数・編集用ID](../data/Style_Constraint_Composition_Pilot/report.json)
