# 表示の区切りと、語全体の変形を選ぶ試作

2026-11-20。[直前の画面と演出選択の比較](32_Phrase_Scale_Choice_Context.md)に続き、20場面で主な文字列に別の語が加わる、入れ替わる、または主な文字列が消えるまでを元映像で確認した。色や字形が変わっても同じ語が続いている場合は保持として記録した。0〜0.67秒の7点を照合し、変化は前後の標本のフレーム番号の範囲として保存した。標本間だけの短い変化は観測から漏れ得る。

## 元映像の検証

- 等間隔で採った16場面のうち、直後約0.33秒に文字列の変化が見えたのは7場面。7件とも縮小を選んでいない。「食・反」が「飯」になる場面や、先行する文字列を保ちながら次の語を加える場面も含む。
- 既知の縮小4件では、直後約0.33秒に別の語への交代や追加はなかった。「ユラユラ」「カラカラ」は縮んだまま少し続いた後に切り替わる。「やめろよ」「回った」は0.67秒後の標本でも同じ語が残った。
- 「0.33秒以内に別の語が出るなら縮小」という選択は、等間隔の16場面で7件正解、既知の縮小4場面で0件。実際の映像から事後に読んだ境界を使っても改善しなかった。これらの結果から、縮小の用途として短い間の強調や大きさの対比は検討できるが、音や歌詞の意味に対する選択理由は未確定。

[境界の判定データ](../data/Style_Phrase_Choice/boundary-comparison.json) · 元コマ [前半](../data/Style_Phrase_Choice/boundaries-1.jpg) [後半](../data/Style_Phrase_Choice/boundaries-2.jpg)

## アプリで編集できる比較4版

合成音源と新しい4行の歌詞で、選択と補間の違いだけを比べる試作を作った。各行の表示時間、配置、書体、配色、開始時の寸法は共通。語全体を親グループの拡縮キーで動かすので、文字列の差し替えとキーの編集ができる。

| 位置 | 版 | 選択と描画 |
| --- | --- | --- |
| 左上 | A | 画面幅25%以下なら拡大、50%以上なら縮小 |
| 右上 | B | 表示計画で主役として導入するときに拡大。現在の主役を譲る指定と次の行が近い条件が揃えば縮小。変化は1コマ |
| 左下 | C | 行の大きさを維持 |
| 右下 | D | Bと同じ選択と変化量を、同じ開始時点から6コマの緩急付き補間で描画 |

Bの「風がほどける」は5Fで拡大し、23Fで直前の42%に縮小する。「夜を越えて」は表示幅69%でも維持する。「朝を迎える」は譲る指定があっても次の行が予定されていないため維持する。42%は元映像の確認例に合わせた試作値。導入・譲る・維持の指定は先に書いた表示計画の入力で、元映像や作家ラベルから推定した値ではない。この比較動画では見せ方の差を確認できる。実曲での転用、作家への類似性、独立した判定者による評価は未実施。

5秒・24fps。比較動画は1280×720、120コマ、4版共通の音声付き。書き出しは既存のMLM描画処理を使用。変形キーを評価してB・Dの選択と最終値が一致し、Dだけ途中値を持つことを確認した。映像から抜いたコマでも文字の切り替えと寸法の差を確認した。

[4画面比較動画](../data/Style_Phrase_Choice_Pilot/comparison.mp4) · [比較のコマ一覧](../data/Style_Phrase_Choice_Pilot/comparison-checkpoints.jpg) · [選択理由・編集用プロジェクトID](../data/Style_Phrase_Choice_Pilot/report.json)

```powershell
python scripts/review-phrase-boundaries.py data/Style_Attribution/report.json data/Style_Phrase_Choice/choice-comparison.json
python scripts/evaluate-phrase-boundaries.py data/Style_Phrase_Choice/choice-comparison.json
node scripts/verify-phrase-choice-pilot.mjs p_mwma337xwygp data/Style_Phrase_Choice_Pilot data/Style_Phrase_Choice/boundary-comparison.json
```
