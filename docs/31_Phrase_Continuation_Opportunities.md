# 同じ語の表示が続く区間で、どの変化が選ばれたか

2026-11-20。[縮小を再検証した結果](30_Deep_Shrink_Validation.md)を受け、縮小の候補を基準にせず区間を選んだ。エフェクト付きのLyricsample7は除き、参考6本・対照6本それぞれの全長20%、40%、60%、80%を中心に約0.20秒分の全コマを抽出した。合計48区間。素材名と群を画像には表示せず、順番を固定シードで入れ替えて確認した。判定は1名で、素材を見た経験があるため、独立したブラインド評価には当たらない。

比較できる区間は、主な文字列が2字以上で、同じ文字がすべてのコマで読め、画面端や図形で隠れないもの。ルビや別行の小さい字幕は主な文字列に含めなかった。文字追加・交代、1字だけの場面、字の同一性やまとまりを確認できないものは理由を記録した。ここで数えるのは等間隔に採った短区間で、1作品中のすべての演出機会を数えたものではない。

| 集計 | 参考群 | 対照群 |
| --- | ---: | ---: |
| 観察した短区間 | 24 | 24 |
| 同じ文字列が全コマで見える | 7区間（4本） | 9区間（5本） |
| 上記のうち、大きな一斉変化なし | 5 | 9 |
| 上記のうち、一斉に拡大 | 2 | 0 |
| 上記のうち、1コマで半分以下に縮小して寸法を保持 | 0 | 0 |
| 字のまとまりを決められず保留 | 4 | 1 |

「大きな一斉変化なし」には、同じ語を回転・移動させる場面も含む。判定した48区間のいずれにも、前回確認した縮小4件の切り替えコマは入らなかった。したがって、この表から縮小の出現率や作家差を推定しない。

## 演出の選択モデルへの反映

- P32（Lyricsample6の119〜125F）では同じ「やめろよ」が一斉に拡大する。119→120Fで幅は約1.84倍、高さは約1.66倍。数コマ後の128→129Fでは同じ語が一斉に縮む。文字列の同一性や長さだけで拡大と縮小を選ぶモデルでは、この1場面の中でも説明がつかない。120Fの拡大率は前回の「やめろよ」と同じ画面領域、同じ3閾値で再計測した。 [拡大の計測値](../data/Style_Phrase_Opportunities/yamero-expansion.json)
- P20（Lyricsample4の39〜44F）でも「経った」は表示を続けながら拡大した。表示継続を比較するときは、維持・拡大・縮小の候補を同じ場面に並べる。文字列を保持できることは候補を出す条件として扱い、縮小を選ぶ条件は未確定とした。
- 次の比較では、切り替えの直前に観測できる「主役の画面占有率」「直前に拡大したか」「語・行の次の切り替えが予定されているか」を別に記録する。映像を見た後でしか分からない情報と、歌詞・音源・生成計画から得られる情報を分ける。既知の縮小例はこの表と別に保持する。

```powershell
python scripts/sample-phrase-opportunities.py data/Style_Attribution/report.json data/Style_Phrase_Opportunities
python scripts/summarize-phrase-opportunities.py data/Style_Phrase_Opportunities/windows.json scripts/phrase-opportunity-review.json
```

[区間ごとの元コマ番号・判定・理由](../data/Style_Phrase_Opportunities/opportunities.json) · 元コマ一覧 [1](../data/Style_Phrase_Opportunities/windows-1.jpg) [2](../data/Style_Phrase_Opportunities/windows-2.jpg) [3](../data/Style_Phrase_Opportunities/windows-3.jpg) [4](../data/Style_Phrase_Opportunities/windows-4.jpg)

続く[直前の画面と演出選択の比較](32_Phrase_Scale_Choice_Context.md)で、維持・拡大・縮小を画面占有率や直前の動きで選ぶ基準を試した。
