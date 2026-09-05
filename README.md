<p align="center"><img src="static/images/long_logo.png" alt="Mozarie" width="400"></p>

[English](README.en.md) · [最新版](https://github.com/norqis/mozarie/releases/latest) · [不具合を報告](https://github.com/norqis/mozarie/issues)

Mozarieは、画像のモザイク範囲をローカルで検出・編集するWindowsアプリ。

## 主な機能

- PNG、JPEG、WebPの画像・フォルダーを読み込み、現在または全画像を自動検出
- 候補の確認、除外、削除、モザイク／除外ブラシ・消しゴム・境界ツールによる修正
- 手の領域の除外と、モザイクより優先する強制除外
- 現在画像、モザイクあり、確認済みのコピー保存または元画像への上書き

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

`setup.bat`はGPUを検出し、NVIDIA/CUDA、AMD/DirectML、CPUの順に選択する。手動で選ぶ場合は、実行前に`MOZARIE_RUNTIME`を指定する。

| 値 | バックエンド |
| --- | --- |
| `cuda` | NVIDIA/CUDA |
| `directml` | AMD/DirectML |
| `cpu` | CPU |

AMD/DirectMLを指定する例:

```powershell
$env:MOZARIE_RUNTIME = "directml"
.\setup.bat
```

CUDA版とDirectML版のONNX Runtimeは同じ`.venv`へ混在させない。既存環境と選択したバックエンドが異なる場合、`setup.bat`はパッケージを変更せず停止する。バックエンドを切り替える場合は、必要に応じて`.venv`をバックアップして削除し、`setup.bat`を再実行する。

`run.bat`は`.venv`のセットアップ情報がない場合、起動せず`setup.bat`を案内する。

### 起動

```powershell
.\run.bat
```

初回起動後、**設定 > 検出**で基本モデルを指定する。

## モデル

### アプリからダウンロード

**設定 > 検出**で使うモデルの**ダウンロード**を選ぶ。SAMは選択中の種類だけを取得する。

| 用途 | ファイル | 配布元 |
| --- | --- | --- |
| 輪郭補正・境界ツール・手の除外 | <ul><li><code>sam_vit_b_01ec64.pth</code></li><li><code>sam_vit_l_0b3195.pth</code></li><li><code>sam_vit_h_4b8939.pth</code></li></ul> | [Meta Segment Anything](https://github.com/facebookresearch/segment-anything#model-checkpoints) |
| アニメ調の手検出 | ONNX | [anime_hand_detection](https://huggingface.co/deepghs/anime_hand_detection) |
| 手の輪郭補正 | safetensors | [HandSegNet anime SDXL](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl) |

### 自分で用意するモデル

NTD11は成人向けモデル。Civitai.comへログインして年齢確認を済ませ、ZIPを取得・展開する。匿名アクセスでの取得は保証されない。

モデルは**設定 > 検出**の**参照**から指定する。

| 用途 | 用意するもの | 配布元 |
| --- | --- | --- |
| 基本の性器検出 | 配布元のONNX（変換不要） | [配布元](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) |
| NTD11補助検出 | NTD11 ZIP内の`.pt`をONNXに変換 | [NTD11 ZIPを取得](https://civitai.com/api/download/models/2350456?fileId=2240838) |
| Sensitive補助検出 | Sensitiveの`.pt`をONNXに変換 | [配布元](https://huggingface.co/sugarknight/sensitive-detect) |

> **`.pt` ファイルの注意:** NTDを含むPyTorchの`.pt`は読み込み時にpickle経由でコードを実行し得るため、記載した配布元以外の`.pt`は使用しないこと。

`setup.bat`実行後、MozarieフォルダーでPowerShellを開き、変換コマンドを実行する。

NTD11の変換:

```powershell
& ".\.venv\Scripts\yolo.exe" export model="ダウンロードしたNTD11の.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu
```

Sensitiveの変換:

```powershell
& ".\.venv\Scripts\yolo.exe" export model="ダウンロードしたSensitiveの.ptファイルのパス" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu
```

変換したONNXは元の`.pt`と同じフォルダーに同名で保存される。設定でそのONNXを指定し、モデルの状態が有効なことを確認して検出を実行する。

モデルの配布条件・ライセンスは、各配布元と[第三者ライセンス・モデル配布元](THIRD_PARTY_NOTICES.md)を確認する。

## 使い方

自動検出の同時処理数は、GPU・CPUともに1〜4で指定する。対象が画像1枚のみの場合は1。

1. 画像またはフォルダーを読み込む。
2. 現在の画像または全画像に自動検出を実行する。
3. 右側の候補を確認し、必要に応じてブラシ、消しゴム、境界ツールで修正する。
4. 保存対象を選び、コピー保存または元画像へ上書きする。

GPUを使う場合は、**設定 > 検出**で選択する。GPUが対応しない演算はCPUが補助する。GPUの初期化・実行に失敗してもCPUで自動再試行しない。GPUメモリが不足した場合は、ほかのGPUアプリを閉じるかCPUへ切り替える。

## 更新

設定の**更新を確認**、または`update.bat`を使う。適用前にMozarieを終了する。設定、モデル、作業中の画像は更新後も保持される。

## 困ったとき

- **モデルを読み込めない:** ファイル形式と、SAMの種類・ファイルの組み合わせを確認する。
- **GPU、CUDA、DirectMLのエラー:** ほかのGPUアプリを閉じる、別のGPUを選ぶ、またはCPUへ切り替える。
- **解決しない:** エラー文を添えて[Issues](https://github.com/norqis/mozarie/issues)へ報告する。

## 実機確認

[実機確認手順](https://github.com/norqis/mozarie/blob/main/docs/manual-verification.md)に従って確認する。

## ライセンス

[MIT License](LICENSE)。第三者コンポーネントとモデルの情報は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照。
