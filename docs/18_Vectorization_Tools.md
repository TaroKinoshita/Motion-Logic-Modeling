# 代表形と変形キーを検証するためのツール

## VTracer

PyPIの `vtracer==0.6.15` を `external/vtracer/.venv` に隔離して導入。Python 3.11.9、CPUでバイナリ・cutout・splineのSVG出力を確認した。Lyricsample1の82Fから切り出した「飯」のSVGは約44KB、入力切り出しとSVGを描画した二値前景のIoUは0.984。同じコマを使った形状変換の確認値。採用検討では、代表形あたりの制御点・データ量と、穴や細い線が保たれるかを現行ポリゴンと比べる。 [公式配布](https://pypi.org/project/vtracer/)・[ソース](https://github.com/visioncortex/vtracer)

## Fast Sprite Decomposition

公式コードを `external/sprite-decompose` に取得。コミットは `b5185bb0663f95e62e10b4dfb533c523458d29b9`。MLM本体と切り分け、`external/sprite-decompose/.venv` にPython 3.10.11を使用する。公式確認環境はPython 3.10＋CUDA 11.3。Windows用にPyTorch 2.0.1とtorchvision 0.15.2のCUDA 11.8版を使用し、PyAV 11.0.0の代わりにWindows用wheelがある12.3.0を `windows-overrides.txt` で指定する。初期分割には公式コード指定のSAM ViT-BとXMemを使う。 [公式リポジトリ](https://github.com/CyberAgentAILab/sprite-decompose)

比較するデータは各スプライトの固定テクスチャ、フレームごとのアフィン行列と不透明度。MLMで編集可能な少数キーに落とす場合は、出力にキー近似をかけ、短い区間でIoU、キー数、IDの対応、人の修正時間を測る。 [論文](https://arxiv.org/html/2408.03923v1)

## アプリへの接続

工程比較の「ブロックの修正」で、開始F、終了Fと開始コマの領域を指定して「Fast Spriteで代表形を生成」を押す。終了Fは含めない。2〜48コマを対象に、1つの領域を手がかりに1スプライトを生成する。既存の解析ジョブに進捗・中断・再試行を委ね、結果は別の比較プロジェクトに保存する。APIは `POST /api/projects/:id/blocking/analyze` の `{baseRevision, engine:"sprite", from, to, region:[left,top,width,height]}`。

解析用映像は長辺384pxまで縮小し、30反復でサイズと実行時間を抑える。SAM ViT-BとXMemの初期分割後、Fast Spriteが固定テクスチャと変形を推定する。XMemはエンコーダー込みの厳密な重み読み込みを行うため、重複するImageNet事前初期化を省いた。元動画に対する閉じた処理にするため、ジョブ開始前に必要な重みの存在を確認する。SAM ViT-BのMeta配布先が接続をリセットしたため、公開ミラーから取得し、複数の配布先で一致するSHA-256を照合した。 [照合した重み](https://huggingface.co/sam-hq-team/sam-hq-training/blob/main/pretrained_checkpoint/sam_vit_b_01ec64.pth)

固定テクスチャの不透明部分をVTracerで1回だけベジェ輪郭に変換する。形状は既存シーンの子として保存し、親の移動・回転・縦横拡縮・横せん断と子の不透明度を別のキーにする。Fast Spriteの正規化アフィン行列を元動画のピクセル座標へ戻し、既存の単調cubicの誤差制約付き近似を再利用する。輪郭描画はプレビューとMP4で共用する。前景色は開始コマの指定範囲、背景色は画面端から採る。いずれも単色の中央値を使い、アルファは輪郭化時に二値化する。重なりによる字の結合や形状の非アフィン変形、複数色の素材はこの初版の制約となる。

Python実行先は既定で各ツールの `.venv`。必要に応じて `MLM_FSD_PYTHON`、`MLM_VTRACER_PYTHON` で指定できる。

ブラウザの操作でLyricsample1の82〜89Fを生成し、別プロジェクト `p_mwlxnr58xhgv` で同期表示・MP4出力まで確認した。固定の輪郭1個、変形・不透明度キー計37個。処理時間約5.1秒（Python起動と映像準備を除く）、PyTorchのピーク割当約2.95GiB。同区間で、元動画に対する前景IoUの平均はトレース版0.979、代表形版0.663。比較MP4の各960×540ペインで輝度100超を前景とした。この数値は82〜89Fの単色前景を対象とし、接触のID維持や別の素材への転用は含まない。元の映像の雰囲気を保つには、形と不透明度の推定に改善の余地がある。

## SAM 3.1

端末上の確認済み場所はユーザー提供。コードは `C:/Users/kinos/AppData/Local/vrecon/src/sam3`、Pythonは `C:/Users/kinos/AppData/Local/vrecon/envs/observe/Scripts/python.exe`、重みは `C:/Users/kinos/.cache/huggingface/hub/models--facebook--sam3.1`。今回の実行セッションからコードとPythonのパスを確認できず、キャッシュ内の `sam3.1_multiplex.pt`（3,502,755,717バイト）は確認できた。元の環境で短い接触区間を試す際に速度とピークVRAMを測る。

## Lottie生成モデルの調査

- OmniLottieは動画を入力でき、推論コードと4Bモデルが公開されている。公式推論のVRAMは15.2GB。Hugging Face形式の重みは2ファイル合計約7.67GBで、標準構成を8GB機の比較候補に入れる根拠は薄い。公式リポジトリのコードはApache 2.0、MMLottie-2M学習データはCC BY-NC-SA 4.0。 [公式手順](https://github.com/OpenVGLab/OmniLottie)・[配布ファイル](https://huggingface.co/OmniLottie/OmniLottie/tree/main)
- LottieGPTの公式リポジトリはテキスト・画像・キーフレームを条件として挙げ、推論コードとモデル重みを公開予定としている。公開済みのデータセットはCC BY-NC-SA 4.0。現時点で動画からの再構成のローカル比較にはOmniLottieの方が近い。 [公式リポジトリ](https://github.com/yisuanwang/LottieGPT)

MLMの設計では、Lottieのように、レイヤーのID・親子・表示時刻、形状または文字、変形トラックを独立して持つ。代表の輪郭1つを文字や別の輪郭に置き換えたとき、表示順とタメが保たれるかを試す。Lottieのトークン化や生成モデルの導入は今回の比較には含めない。 [OmniLottie論文のレイヤー定義](https://arxiv.org/html/2603.02138v1#S4.SS1)
