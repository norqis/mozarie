<p align="center"><img src="static/images/long_logo.png" alt="Mozarie" width="400"></p>

[日本語](README.md) · [Latest release](https://github.com/norqis/mozarie/releases/latest) · [Report an issue](https://github.com/norqis/mozarie/issues)

Mozarie is a local Windows app for detecting, reviewing, editing, and saving mosaic areas in images. You decide which candidates to apply or exclude, make manual corrections, and choose where to save.

## Key features

- Load PNG, JPEG, and WebP images or folders; run automatic detection on the current image or the whole set.
- Show, exclude, remove, and edit candidates with mosaic/exclusion brushes, erasers, and the boundary tool.
- Exclude hand areas and force an exclusion to take priority over mosaic areas.
- Save the current image, mosaicked images, or reviewed images as copies, or overwrite the source.

## Installation

### Requirements

- Windows
- 64-bit Python (Python Launcher `py`)
  - NVIDIA/CUDA: Python 3.11–3.14
  - AMD/DirectML: Python 3.11 or 3.12
  - CPU: Python 3.11 or 3.12

### Setup

```powershell
.\setup.bat
```

`setup.bat` detects the GPU and selects CUDA when NVIDIA hardware is present, or DirectML when AMD hardware is present without NVIDIA. On systems with both vendors, NVIDIA/CUDA takes priority to preserve the existing CUDA behavior. You can explicitly select a backend before setup when needed.

```powershell
$env:MOZARIE_RUNTIME = "cuda"      # NVIDIA/CUDA
$env:MOZARIE_RUNTIME = "directml"  # AMD/DirectML
$env:MOZARIE_RUNTIME = "cpu"       # CPU only
.\setup.bat
```

Do not mix the CUDA and DirectML ONNX Runtime packages in the same `.venv`. If an existing environment does not match the selected backend, `setup.bat` stops without changing its packages. To switch backends, back up `.venv` if needed, remove it, and run `setup.bat` again.

`run.bat` does not start when its `.venv` setup information is missing; run `setup.bat` again.

### Run

```powershell
.\run.bat
```

After the first start, choose a primary model in **Settings > Detection**.

## Models

### Download in the app

In **Settings > Detection**, select **Download** for the model you need. Mozarie downloads only the selected SAM type.

| Use | File | Source |
| --- | --- | --- |
| Contour refinement, boundary tool, hand exclusion | <ul><li><code>sam_vit_b_01ec64.pth</code></li><li><code>sam_vit_l_0b3195.pth</code></li><li><code>sam_vit_h_4b8939.pth</code></li></ul> | [Meta Segment Anything](https://github.com/facebookresearch/segment-anything#model-checkpoints) |
| Anime-style hand detection | ONNX | [anime_hand_detection](https://huggingface.co/deepghs/anime_hand_detection) |
| Hand contour refinement | safetensors | [HandSegNet anime SDXL](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl) |

### Prepare yourself

NTD11 is an adult model. Sign in to Civitai.com and complete its age check before downloading and extracting its ZIP. Anonymous access is not guaranteed.

| Use | What to prepare | Source and selection |
| --- | --- | --- |
| Primary genital detection | ONNX from the source | Get it from the [source](https://huggingface.co/01miku/anime-nsfw-segm-yolo26), then select it with **Browse**. No conversion is required. |
| NTD11 supplemental detection | ONNX converted from the `.pt` file included in the NTD11 ZIP | [Download the NTD11 ZIP](https://civitai.com/api/download/models/2350456?fileId=2240838), extract it, convert the included `.pt` file, then select the generated ONNX file with **Browse**. |
| Sensitive supplemental detection | ONNX converted from a Sensitive `.pt` file | Get it from the [source](https://huggingface.co/sugarknight/sensitive-detect), convert it, then select the ONNX file with **Browse**. |

> **About `.pt` files:** PyTorch `.pt` files, including NTD files, can execute code through pickle while loading, so do not run a `.pt` obtained from any source other than those listed here.

After running `setup.bat`, open PowerShell in the Mozarie folder and run the command below.

Convert NTD11:

```powershell
& ".\.venv\Scripts\yolo.exe" export model="path\to\downloaded\NTD11.pt" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu
```

Convert Sensitive:

```powershell
& ".\.venv\Scripts\yolo.exe" export model="path\to\downloaded\Sensitive.pt" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu
```

The conversion creates a same-stem `.onnx` file in the same folder. Select that ONNX file in Settings, confirm its model status is valid, then run detection.

Review the source terms and licenses for each model and the [third-party notices and model sources](THIRD_PARTY_NOTICES.md).

## Use

Choose one to four workers for automatic detection on either GPU or CPU. A job targeting one image uses one worker.

1. Import images or a folder.
2. Run automatic detection for the current image or all images.
3. Review the candidates at right and correct them with brushes, erasers, or the boundary tool when needed.
4. Choose a save target, then save a copy or overwrite the source.

To use GPU processing, select a GPU in **Settings > Detection**. If GPU memory runs out, close other GPU apps or switch to CPU.

## Updates

Use **Check for updates** in Settings or run `update.bat`. Close Mozarie before applying an update. Your settings, models, and working images remain in place.

## Troubleshooting

- **A model cannot load:** Check the file format and the selected SAM type/file combination.
- **GPU, CUDA, or DirectML error:** Close other GPU apps, select another GPU, or switch to CPU.
- **Still stuck:** Include the error text in a [GitHub issue](https://github.com/norqis/mozarie/issues).

## Manual verification

Follow the [manual verification guide](docs/manual-verification.md).

## License

Mozarie is released under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components and model sources.
