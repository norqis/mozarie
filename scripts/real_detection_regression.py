"""Run the three user-reported images through the configured GPU vit_h pipeline.

This is an opt-in local regression check.  It never downloads models, alters
settings, or requires the external images in CI.
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
import tempfile
import weakref
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.core import ImageRecord
from mozarie.state import StudioState


DEFAULT_IMAGES_DIR = Path(r"G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\output")
SAMPLES = {
    "Scene_00060.png": {
        "required_labels": {"hand", "fluid"},
        "fluid_area": (20_000, 45_000),
        "fluid_bbox": (250, 760, 740, 1340),
        "regions": (("left", (280, 830, 430, 980), .20), ("right", (590, 830, 706, 980), .20), ("pool", (450, 1210, 570, 1295), .26)),
        "negative_regions": (("shirt", (300, 650, 600, 750)), ("far-right", (720, 750, 800, 900))),
    },
    "Scene_00072.png": {
        "required_labels": {"fluid"},
        "fluid_area": (10_000, None),
        "regions": (("upper", (400, 880, 520, 960), .20), ("center", (420, 950, 535, 1089), .25)),
        "negative_regions": (("face", (250, 250, 650, 650)), ("left-shirt", (80, 650, 280, 1100)), ("right-shirt", (620, 650, 840, 1100))),
    },
    "Scene_cowgirl_00023.png": {},
}


def _mask_metrics(path: Path) -> tuple[int, tuple[int, int, int, int] | None]:
    mask = np.asarray(Image.open(path).convert("L")) > 0
    rows, columns = np.nonzero(mask)
    if not rows.size:
        return 0, None
    return int(rows.size), (int(columns.min()), int(rows.min()), int(columns.max()) + 1, int(rows.max()) + 1)


def _region_rate(path: Path, region: tuple[int, int, int, int]) -> float:
    left, top, right, bottom = region
    mask = np.asarray(Image.open(path).convert("L")) > 0
    crop = mask[top:bottom, left:right]
    return float(np.count_nonzero(crop) / crop.size)


def _record_for(path: Path) -> ImageRecord:
    with Image.open(path) as image:
        width, height = image.size
    stat = path.stat()
    return ImageRecord(f"real-regression-{path.stem}", path, path.name, width, height, stat.st_mtime_ns, stat.st_size)


def _assert_scene(name: str, candidates) -> list[str]:
    expected = SAMPLES[name]
    labels = {candidate.label_token for candidate in candidates}
    lines = [f"{name}: labels={','.join(sorted(labels)) or 'none'}"]
    details = []
    for candidate in candidates:
        area, bbox = _mask_metrics(candidate.mask_path)
        details.append(f"{candidate.label_token}(area={area},bbox={bbox},source={candidate.source},forced={candidate.forced})")
    lines.append(f"  candidates: {', '.join(details) or 'none'}")
    missing_labels = expected.get("required_labels", set()) - labels
    if missing_labels:
        raise RuntimeError(f"{name}: missing required labels {sorted(missing_labels)}")
    if name == "Scene_cowgirl_00023.png":
        if not {"penis", "pussy"}.issubset(labels) or labels & {"hand", "fluid"}:
            raise RuntimeError(f"{name}: expected penis/pussy APPLY only, got {', '.join(details)}")
        return lines
    fluid = next((candidate for candidate in candidates if candidate.label_token == "fluid"), None)
    if fluid is None:
        raise RuntimeError(f"{name}: fluid candidate was not detected")
    area, bbox = _mask_metrics(fluid.mask_path)
    lines.append(f"  fluid: area={area}, bbox={bbox}")
    lower, upper = expected["fluid_area"]
    if area < lower or (upper is not None and area > upper):
        raise RuntimeError(f"{name}: fluid area {area} outside {expected['fluid_area']}")
    expected_bbox = expected.get("fluid_bbox")
    if expected_bbox is not None:
        left, top, right, bottom = bbox or (0, 0, 0, 0)
        allowed_left, allowed_top, allowed_right, allowed_bottom = expected_bbox
        if left < allowed_left or top < allowed_top or right > allowed_right or bottom > allowed_bottom:
            raise RuntimeError(f"{name}: fluid bbox {bbox} outside {expected_bbox}")
    for label, region, minimum in expected["regions"]:
        rate = _region_rate(fluid.mask_path, region)
        lines.append(f"  {label}: {rate:.3f}")
        if rate < minimum:
            raise RuntimeError(f"{name}: fluid area={area}, bbox={bbox}; {label} rate {rate:.3f} below {minimum:.2f}")
    for label, region in expected.get("negative_regions", ()):
        rate = _region_rate(fluid.mask_path, region)
        lines.append(f"  {label}: {rate:.3f}")
        if rate > .001:
            raise RuntimeError(f"{name}: {label} rate {rate:.3f} exceeds .001")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images-dir", type=Path, default=DEFAULT_IMAGES_DIR)
    parser.add_argument("--settings-file", type=Path, required=True, help="local.json containing the configured model paths")
    parser.add_argument("--gpu-device", type=int, default=None)
    parser.add_argument("--artifacts", type=Path, help="optional directory for the generated candidate masks")
    parser.add_argument("--scene23-repeats", type=int, default=1, help="run the hand regression repeatedly in this process")
    args = parser.parse_args()
    missing = [name for name in SAMPLES if not (args.images_dir / name).is_file()]
    if missing:
        raise SystemExit(f"missing regression images: {', '.join(missing)}")
    if not args.settings_file.is_file():
        raise SystemExit(f"settings file not found: {args.settings_file}")
    if args.scene23_repeats < 1:
        raise SystemExit("--scene23-repeats must be positive")
    if args.artifacts is not None:
        args.artifacts.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="mozarie-real-regression-") as temporary:
        root = Path(temporary)
        state = StudioState(cache_dir=root / "cache", session_base_dir=root / "sessions")
        failures: list[str] = []
        try:
            state.settings = state.settings_store.validate_update(json.loads(args.settings_file.read_text(encoding="utf-8")))
            state.settings["models"]["provider"] = "gpu"
            state.settings["detection"]["mode"] = "high_precision"
            state.settings["models"]["sam_model_type"] = "vit_h"
            if args.gpu_device is not None:
                state.settings["models"]["gpu_device"] = args.gpu_device
            state._require_supported_gpu()
            import torch
            device = state.settings["models"]["gpu_device"]
            baseline = (int(torch.cuda.memory_allocated(device)), int(torch.cuda.memory_reserved(device)))
            state.models = state._load_detection_models()
            models_ref = weakref.ref(state.models)
            for name in SAMPLES:
                for repeat in range(args.scene23_repeats if name == "Scene_cowgirl_00023.png" else 1):
                    record = _record_for(args.images_dir / name)
                    state.images = {record.image_id: record}
                    state.order = [record.image_id]
                    state.candidates = {}
                    state.candidate_revisions = {record.image_id: 0}
                    candidates = state._detect_image(state.models, record, .5, mode="high_precision")
                    if args.artifacts is not None:
                        for index, candidate in enumerate(candidates):
                            Image.open(candidate.mask_path).save(args.artifacts / f"{Path(name).stem}-{repeat}-{index}-{candidate.label_token}.png")
                    try:
                        print(*_assert_scene(name, candidates), sep="\n")
                    except RuntimeError as exc:
                        failure = f"{name} run {repeat + 1}: {exc}"
                        print(failure)
                        failures.append(failure)
            state._release_gpu_job_memory()
            gc.collect()
            allocated = int(torch.cuda.memory_allocated(device))
            reserved = int(torch.cuda.memory_reserved(device))
            state._release_gpu_job_memory()
            gc.collect()
            settled = (int(torch.cuda.memory_allocated(device)), int(torch.cuda.memory_reserved(device)))
            print(f"VRAM: before={baseline}, after=({allocated}, {reserved}), settled={settled}")
            if models_ref() is not None or settled != (allocated, reserved):
                raise RuntimeError("GPU resources were retained or grew after cleanup")
        finally:
            state.shutdown()
    if failures:
        raise SystemExit("\n".join(failures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
