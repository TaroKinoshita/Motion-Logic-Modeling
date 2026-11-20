# 大小差の集計訂正と文字ブロックによる追試

採点者が囲む作業を減らすため、[PP-OCRで候補を出して分類する手順](39_Blind_Text_Review_And_Constraint_Pilot.md)に更新した。高さ比2倍と各側6コマを新規確認試験で固定する。

## 既存の数値を訂正

集計の条件を作家判定の再試験と揃えた。元の43.6%には、背景の条件を満たさなかったLyricsample7が入っていた。

| 既存の前景成分を使う集計 | 参考 | 対照 | 差 |
| --- | ---: | ---: | ---: |
| 訂正後、再試験と同じ対象 | 41.1%（6本） | 23.6%（5本） | 17.5ポイント |
| 枠の多いLyricsample3をさらに外す感度確認 | 31.8%（5本） | 23.6%（5本） | 8.1ポイント |

感度確認の中央値は参考31.4%、対照21.1%。両側の記述的な入れ替え p=0.230。Lyricsample3の85F・101Fを確認すると、旧指標は3.46倍・3.73倍だったが、枠を外し左右の文字だけを測るとどちらも1.04倍だった。この2コマは誤計測の確認例。群の推定には使わない。

[訂正後の集計](../data/Style_Review_Fixed/permutations.json) · [確認コマ一覧](../data/Style_Review_Fixed/text-block-calibration.jpg) · [Lyricsample3の文字矩形と比率](../data/Style_Review_Fixed/text-block-calibration.json)

## 新しい素材で固定する測定

同じ相対位置に置いた5秒窓3つから、各窓の0.5・1.5・2.5・3.5・4.5秒の元コマを事前に選ぶ。重複したフレームは1回だけ数える。撮影上のフレーム番号と各コマの矩形は元素材のハッシュにひも付ける。確認用画像では群ラベルを出さない。作品が見覚えのある場合は記録し、独立した採点者が迷ったコマは保留する。

- 採点単位は本文の字・語のブロック。独立した位置・大きさ・動きで配置された本文を分けて囲む。同じ行で同じ大きさ・動きを共有する連続した本文は一組にする。外接枠には本文の実際の字形を含める。別の字の一部や、枠と文字が接触しただけの形を新しい本文ブロックとして数えない。
- ルビ・訳字幕・図形・外枠は注釈へ残せる。比率の計算には本文として確認した枠だけが入る。本文がどれか決められない、あるいは欠け・遮蔽で外接高さが判断できないコマは保留。目視で無地と確認した区間に限る。
- 主指標は、**本文のブロックが2つ以上見えるコマのうち、上位2ブロックの高さ比が2以上の割合**。元作品ごとに割合を計算し、1ブロック以下、保留、背景条件外のコマ数も記録する。各ペアの両側で条件に合うコマが6点以上必要。6点は初回の採点運用上の基準で、測定の安定性は別に確認する。

[作品の入力表](../scripts/style-confirmation-intake.example.json) · [背景の確認表](../scripts/style-confirmation-background.example.json) · [文字ブロックの確認表](../scripts/style-confirmation-text.example.json)

## ペア数と検定

曲やシリーズを共有するペアは一つの独立グループとして扱う。両側の符号入れ替えで、方向がすべて一致する場合の最小値は 2/2ⁿ。独立5組では0.0625、6組で0.03125。**収集の目標は採点可能な独立10〜15組**。これは検出力の保証ではなく、まずデータからペア差のばらつきと欠測を把握する。実素材の確認試験は新規の登録待ち。

```powershell
python scripts/prepare-style-confirmation.py work-intake.json data/Style_Attribution/report.json data/Style_Validation_Complete/confirmation-plan.json
python scripts/export-style-text-checkpoints.py data/Style_Validation_Complete/confirmation-plan.json data/Style_Validation_Complete/text-review
python scripts/run-style-confirmation.py data/Style_Validation_Complete/confirmation-plan.json data/Style_Validation_Complete/confirmation-results.json --background-review background-review.json --text-review text-review.json
```

## 構図の短い作画試作

4画面の生成試験とは別に、同じ実音源で4.5秒を手で構成した。大きい「風」を先に出し、同じ要素IDで表示を維持しながら小さい続きを出す。「風」と線を左へ引き、次の二つの「木」と同居させる。「木」の間隔が詰まるのに合わせて線を縮め、「林」とルビを出す。構図と受け渡しを確認する試作で、仮の歌詞は歌声と同期していない。作風の評価は未収集。

[動画](../data/Style_Composition_Revision/composition-pilot.mp4) · [確認コマ](../data/Style_Composition_Revision/checkpoints.jpg) · [編集用プロジェクトとキュー](../data/Style_Composition_Revision/composition-pilot.json)
