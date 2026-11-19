# 深い縮小と寸法保持の追加検証

2026-11-20。[語単位の元コマ照合](29_Phrase_Motion_Control_Audit.md)で見つけた特徴を、別の抜粋にも適用した。発見に使ったLyricsample5・6は検出器の照合用に分けた。今回の比較素材は既に前回の観察に使っているため、追加検証は同じコーパス内の再走査として扱う。

## 判定条件

同じ語の文字がすべて見え、文字構成が前後で変わらない区間で、幅と高さの両方が1コマで直前の50%以下になる。縮小直後の寸法に対し、その次とさらに次のコマで各軸の変化がそれぞれ2%以内に収まる。元解像度で40・50・60の差分閾値すべてがこの条件を満たすことを確認条件とした。音との同期や意図はこの条件に含めない。

全コマの候補抽出は640×360で行い、丸めや輪郭抽出の違いを見込んで幅・高さの比を52%以下、保持中の差を2pxまたは4%の大きいほうまで許した。同一とみられる前景の輪郭が連続4コマ必要。出力された候補はすべて元コマで照合した。候補が出ない抜粋については、検出漏れを含み得る。

| 区分 | 抜粋 | 全コマ | 候補 | 確認結果 |
| --- | ---: | ---: | ---: | --- |
| 発見に使用したLyricsample5・6 | 2 | 622 | 6 | 既知の4件を再検出、1件を棄却、1件は測定不能 |
| 残りの参考群（Lyricsample1〜4） | 4 | 707 | 0 | 新たな確認例なし |
| 対照群（LyricOther1〜6） | 6 | 2,431 | 2 | いずれも棄却 |
| エフェクトのあるLyricsample7 | 1 | 252 | 1 | 比較集計から除外 |

## 候補の確認

- Lyricsample5の52→53F「顔が」は深く縮むが、次の2コマで約6%拡大するため条件外。同じ素材の138→139F「嘲られ」には縮小が見えるものの、直前の字形が画面端で切れ、語全体の幅を測れない。
- LyricOther5の422→423Fは「青」「に」の重なりが解けて字間が開く場面。432→433Fは「青に」が「混ざって」に替わる場面。どちらも同じ語全体の縮小としては数えなかった。
- Lyricsample7の190→191Fでは同じ文字列が縮むが、事前に指定したエフェクト付きの別枠に置いた。今回の確認例数には含めていない。

既知の4件を再検出できたが、発見に使った2本を外すと参考群に新しい確認例がなかった。作家判定のスコアには加えず、縮小と寸法保持を組み合わせる演出の候補として保持する。選択モデルで扱うには、同じ語を連続表示できる区間を先に定義し、縮小した場面と、縮小せず表示を続けた場面を同じ基準で数える。そうすれば「どう縮めたか」に加えて「どんな入力で縮小が選ばれるか」を検証できる。

```powershell
python scripts/audit-phrase-motion.py data/Style_Attribution/report.json data/Style_Phrase_Validation
python scripts/validate-deep-shrink.py data/Style_Phrase_Validation/candidates.json data/Style_Phrase_Motion/checkpoints.json data/Style_Phrase_Validation/validation.json
```

[全候補の元コマ](../data/Style_Phrase_Validation/deep-shrink-screen.jpg) · [候補、採否、閾値別の数値](../data/Style_Phrase_Validation/validation.json) · [全走査結果](../data/Style_Phrase_Validation/candidates.json)

続く[表示が続く区間の比較](31_Phrase_Continuation_Opportunities.md)では、縮小の有無と独立に48区間を採り、同じ文字列が表示された区間を両群で数えた。
