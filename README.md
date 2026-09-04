<p align="center"><img src="static/images/long_logo.png" alt="Mozarie" width="400"></p>

[English](README.en.md) · [最新版](https://github.com/norqis/mozarie/releases/latest) · [不具合を報告](https://github.com/norqis/mozarie/issues)

Mozarieは、画像のモザイク範囲をローカルで検出・確認・修正して保存できるWindowsアプリです。候補の採用、除外、手書き修正、保存先はすべて自分で決められます。

## 主な機能

- PNG、JPEG、WebPの画像・フォルダーを読み込み、現在の画像または全画像を自動検出
- 検出候補を表示・除外・削除し、モザイク／除外ブラシ、消しゴム、境界ツールで修正
- 手の領域を除外し、候補ごとの強制除外でモザイクより優先
- 現在画像、モザイクあり、確認済みから選んでコピー保存または元画像へ上書き

## インストール

### 動作環境

- Windows
- 64-bit Python（Python Launcher `py`）
  - NVIDIA/CUDA: Python 3.11〜3.14
  - AMD/DirectML: Python 3.11 または3.12
  - CPU: Python 3.11 または3.12

### セットアップ

```powershell
.\setup.bat
```

`setup.bat`はGPUを検出し、NVIDIAがある場合はCUDA、NVIDIAがなくAMDがある場合はDirectMLを選択します。両方ある環境では、既存のCUDA動作を維持するためNVIDIA/CUDAを優先します。必要に応じて、実行前にバックエンドを明示できます。

```powershell
$env:MOZARIE_RUNTIME = "cuda"      # NVIDIA/CUDA
$env:MOZARIE_RUNTIME = "directml"  # AMD/DirectML
$env:MOZARIE_RUNTIME = "cpu"       # CPUのみ
.\setup.bat
```

CUDA版とDirectML版のONNX Runtimeは同じ`.venv`へ混在させないでください。既存環境と選択されたバックエンドが異なる場合、`setup.bat`はパッケージを変更せず停止します。バックエンドを切り替える場合は、必要に応じて`.venv`をバックアップしてから削除し、`setup.bat`を再実行してください。

`run.bat`は、setup済みを示す`.venv`内の情報がない場合にも起動せず、`setup.bat`を案内します。

### 起動

```powershell
.\run.bat
```

初回起動後、**設定 > 検出**で基本モデルを指定します。

## モデル

### アプリからダウンロード

設定 > 検出で、使う項目の**ダウンロード**を押します。SAMは選択中の種類だけを取得します。

| 用途 | ファイル | 配布元 |
| --- | --- | --- |
| 輪郭補正・境界ツール・手の除外 | <ul><li><code>sam_vit_b_01ec64.pth</code></li><li><code>sam_vit_l_0b3195.pth</code></li><li><code>sam_vit_h_4b8939.pth</code></li></ul> | [Meta Segment Anything](https://github.com/facebookresearch/segment-anything#model-checkpoints) |
| アニメ調の手検出 | ONNX | [anime_hand_detection](https://huggingface.co/deepghs/anime_hand_detection) |
| 手の輪郭補正 | safetensors | [HandSegNet anime SDXL](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl) |

### 自分で用意するモデル

NTD11は成人向けモデルです。Civitai.comへログインして年齢確認を済ませ、ZIPを取得・展開してから使ってください。匿名アクセスでの取得は保証されません。

| 用途 | 用意するもの | 配布元・指定方法 |
| --- | --- | --- |
| 基本の性器検出 | 配布元のONNX | [配布元](https://huggingface.co/01miku/anime-nsfw-segm-yolo26)から取得し、**参照**から指定します。変換は不要です。 |
| NTD11補助検出 | NTD11のZIPに含まれる`.pt`を変換したONNX | [NTD11 ZIPを取得](https://civitai.com/api/download/models/2350456?fileId=2240838)して展開し、含まれる`.pt`を変換して、生成したONNXを**参照**から指定します。 |
| Sensitive補助検出 | Sensitiveの`.pt`を変換したONNX | [配布元](https://huggingface.co/sugarknight/sensitive-detect)から取得し、変換後のONNXを**参照**から指定します。 |

> **`.pt` ファイルの注意:** NTD を含むPyTorchの`.pt`は、読み込み時にpickle経由のコードを実行し得るため、ここに記載した配布元以外から入手した`.pt`は実行しないでください。

`setup.bat`実行後、MozarieフォルダーでPowerShellを開き、次のコマンドを実行します。

NTD11の変換:

```powershell
& ".\.venv\Scripts\yolo.exe" export model="ダウンロードしたNTD11の.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu
```

Sensitiveの変換:

```powershell
& ".\.venv\Scripts\yolo.exe" export model="ダウンロードしたSensitiveの.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu
```

変換すると同じフォルダーに同名の`.onnx`が生成されます。設定でそのONNXを指定し、モデルの状態が有効であることを確認してから検出を実行してください。

モデルの配布条件・ライセンスは、各配布元と[第三者ライセンス・モデル配布元](THIRD_PARTY_NOTICES.md)を確認してください。

## 使い方

自動検出の同時処理数は、GPU・CPUともに1〜4で設定できます。画像1枚だけを対象にした場合は1になります。

1. 画像またはフォルダーを読み込みます。
2. 現在の画像または全画像に自動検出を実行します。
3. 右側の候補を確認し、必要に応じてブラシ、消しゴム、境界ツールで修正します。
4. 保存対象を選び、コピー保存または元画像への上書きを行います。

GPU処理を使う場合は、**設定 > 検出**でGPUを選びます。GPUメモリが不足した場合は、ほかのGPUアプリを閉じるかCPUへ切り替えてください。

## 更新

設定の**更新を確認**、または`update.bat`を使います。適用前にMozarieを終了してください。設定、モデル、作業中の画像は更新しても残ります。

## 困ったとき

- **モデルを読み込めない:** ファイル形式と、SAMの種類・ファイルの組み合わせを確認してください。
- **GPU、CUDA、DirectMLのエラー:** ほかのGPUアプリを閉じる、別のGPUを選ぶ、またはCPUへ切り替えてください。
- **解決しない:** エラー文を添えて[Issues](https://github.com/norqis/mozarie/issues)へ報告してください。

## 実機確認

[実機確認手順](https://github.com/norqis/mozarie/blob/main/docs/manual-verification.md)に従って確認してください。

## ライセンス

Mozarieは[MIT License](LICENSE)で公開しています。第三者コンポーネントとモデル配布元は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を確認してください。
