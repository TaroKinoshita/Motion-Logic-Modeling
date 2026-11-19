# 演出選択と作家判定の再検証

2026-11-20。[初回判定](28_Style_Attribution_Control_Result.md)から[表示計画の生成試作](33_Phrase_Boundary_And_Generation_Pilot.md)までのデータを統合し、素材を評価側に外して再検証した。対象は同じ映像担当と申告された7抜粋、別担当と申告された6抜粋。

## 1. 比較データ

- 12抜粋の等間隔48区間について、34区間を採点可能とした。維持14・拡大2・文字を残して追加3・入れ替えや出入り15。最後の分類には初出と消失も含む。字が欠ける、遮られる、ひとまとまりと確定できないなどの14区間は理由を保存した。Lyricsample7はエフェクトがあるのでこの語単位の比較から外した。
- 先行字を残す／いったん入れ替える、単字の急減速、同じ語が続く間の静止に近い表示と回転、同一行内の大小差を、元コマと素材SHA付きで記録した。語を一斉に縮めた既知4件と、その後の文字の区切りは別枠。止まって見える区間と、速い動きから止まる区間を区別した。13抜粋の集計には両群の語の速度曲線を追跡した値ではなく、画面内の前景の速度変化を使った。
- 34区間の予測に使う画像は各区間の先頭コマだけ。音量の変化と周波数成分の立ち上がりは、そのコマまでの過去0.32秒から計算した。語の拡縮比較20件でも、結果のコマや次の語が出た時刻は予測入力に入れていない。拡縮履歴の文字同一性は目視で照合した。

[34区間の入力・全48区間の採否・確認コマの出典](../data/Style_Study_Review/decision-windows.json)

## 2. 演出選択

1素材を外すごとに、残りだけで欠測補完、標準化、最近傍またはリッジ回帰を計算した。尺度と正則化は固定し、各特徴を検証結果に合わせて選び直す工程は入れていない。

| 比較 | 規則／基準 | 似た事例を選ぶ | リッジ回帰 | リッジ回帰＋直前の音 |
| --- | ---: | ---: | ---: | ---: |
| 拡縮の等間隔16区間 | 常に維持 14/16 | 8/16 | 13/16 | 13/16 |
| 既知の縮小4件 | 画面幅による規則 2/4 | 0/4 | 0/4 | 0/4 |
| 文字の追加・交代も含む34区間、背景差分 | 常に交代 15/34 | 10/34 | 15/34 | 14/34 |
| 文字の追加・交代も含む34区間、局所コントラスト | 常に交代 15/34 | 17/34 | 15/34 | 15/34 |

最良の34区間条件でも均衡正答率は29.2%で、追加3件と拡大2件を正しく選ばなかった。近傍法が他の前景抽出では10件に下がる。拡縮試験の16区間には深い縮小がなく、4縮小は発見に使った2素材の例なので集計は分けた。これは画面や直前の音からの小規模な予測で、歌詞の意味・発音位置・事前の主役指定を用いたモデルは評価対象に入っていない。モデルを自動生成の既定値に採用する根拠は得られていない。

## 3. 作家判定

13本のSHA256、FFprobeのタイトル・担当に関係するタグ、音声指紋の重複を確認した。13本とも作品・担当を照合できるタグはなかった。全78組を時間方向にずらして比較し、24指紋語の平均ビット距離14%以下を候補としたとき、該当は0組。同一動画から先頭2秒を除いた確認用ペアでは0.91%で一致候補になった。この確認で、重複していない区間を使った同曲や、同シリーズの可能性は残る。今回の評価グループは暫定的に各抜粋を1単位とし、元作品・曲・担当範囲の最終照合は保留。

同じ5秒条件で、構図に前景の加速・減速・ジャーク・動き始め・停止の指標を追加した。前景の速度は短い連続区間だけを平滑化し、全画面変化や欠測をまたいで微分しない。縦の大小差の90パーセンタイルは運動曲線から独立に比較。中央の5秒・行ごとの背景差分を主設定とした。

| 判定に使った特徴 | 全13本 | Lyricsample7を除いた12本 |
| --- | ---: | ---: |
| 構図のみ | 9/13（69.0%） | 8/12（66.7%） |
| 構図＋速度の代表値 | 9/13（69.0%） | 7/12（58.3%） |
| 運動曲線のみ | 8/13（60.7%） | 7/12（58.3%） |
| 構図＋運動曲線 | 10/13（77.4%） | 9/12（75.0%） |
| 構図＋大きさの対比の上位値 | 10/13（76.2%） | 8/12（66.7%） |

括弧内は参考群と対照群を等しく評価した均衡正答率。構図＋運動曲線の主設定ではLyricsample3・6とLyricOther6を取り違えた。冒頭・中央・末尾と前景抽出2方法の6条件を通すと、構図＋運動曲線は70.2〜84.5%、構図のみは69.0〜92.9%。中央以外でも安定して改善する傾向は確認できない。6条件中5条件以上が一致した場合だけ判定を採用する集計では、全13本中9本が申告と一致し、4本は保留。7を除くと7本一致・5本保留。すべて同じコーパスの探索結果。

[素材の出典と音声重複照合](../data/Style_Study_Review/source-groups.json) · [個別判定・特徴の寄与・選択の全比較](../data/Style_Study_Review/comparisons.json)

## 再実行

```powershell
python scripts/audit-style-source-groups.py data/Style_Attribution/report.json data/Style_Study_Review/source-groups.json
python scripts/verify-style-attribution.py --inventory data/Lyricsample_Corpus_Intake/inventory.json --controls C:/Users/kinos/Downloads --out data/Style_Study_Review/attribution
python scripts/measure-style-decision-windows.py data/Style_Attribution/report.json data/Style_Phrase_Opportunities/opportunities.json data/Style_Phrase_Choice/choice-comparison.json data/Style_Study_Review/decision-windows.json
python scripts/compare-style-study-models.py data/Style_Study_Review/attribution/report.json data/Style_Study_Review/source-groups.json data/Style_Phrase_Choice/choice-comparison.json data/Style_Phrase_Opportunities/opportunities.json data/Style_Phrase_Choice/boundary-comparison.json data/Style_Study_Review/decision-windows.json
```
