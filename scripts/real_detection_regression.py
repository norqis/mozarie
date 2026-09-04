"""Run the three user-reported images through the configured GPU vit_h pipeline.

This is an opt-in local regression check.  It never downloads models, alters
settings, or requires the external images in CI.
"""

from __future__ import annotations

import argparse
import ctypes
import gc
import json
import os
import sys
import tempfile
import weakref
from ctypes import wintypes
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.core import ImageRecord
from mozarie.state import StudioState


DEFAULT_IMAGES_DIR = Path(r"G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\output")
SAMPLES = {
    "Scene_00060.png": {
        "candidates": {
            "pussy": ("apply", "target", True),
            "hand": ("exclude", "hand_exclusion", True),
            "fluid": ("exclude", "fluid_exclusion", False),
        },
        "fluid_area": (20_000, 45_000),
        "fluid_bbox": (250, 760, 780, 1340),
        "regions": (("left", (280, 830, 430, 980), .20), ("right", (590, 830, 706, 980), .20), ("pool", (450, 1210, 570, 1295), .26), ("far-right", (720, 750, 800, 900), .02)),
        "negative_regions": (("shirt", (300, 650, 600, 750)),),
        "hand": ((1_000, 3_000), (480, 780, 580, 960)),
        "pussy": ((1_000, 12_000), (360, 780, 620, 1_080)),
    },
    "Scene_00072.png": {
        "candidates": {"fluid": ("exclude", "fluid_exclusion", False)},
        "fluid_area": (10_000, None),
        "regions": (("upper", (400, 880, 520, 960), .20), ("center", (420, 950, 535, 1089), .25)),
        "negative_regions": (("face", (250, 250, 650, 650)), ("left-shirt", (80, 650, 280, 1100)), ("right-shirt", (620, 650, 840, 1100))),
    },
    "Scene_cowgirl_00023.png": {
        "candidates": {
            "penis": ("apply", "target", True),
            "pussy": ("apply", "target", True),
            "fluid": ("exclude", "fluid_exclusion", False),
        },
        "fluid_area": (1, None),
        "negative_regions": (
            ("breasts", (150, 400, 750, 800)),
            ("upper-torso", (250, 800, 650, 1_050)),
            ("far-thigh-background", (0, 900, 170, 1_250)),
        ),
    },
}

MEMORY_SOAK_CYCLES = 5
PRIVATE_BYTES_GROWTH_LIMIT = 256 * 1024 * 1024


class _ProcessMemoryCountersEx(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_uint32),
        ("PageFaultCount", ctypes.c_uint32),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def _process_memory_bytes() -> tuple[int, int]:
    """Return this process's Private Bytes and RSS (working set) on Windows."""
    if os.name != "nt":
        raise RuntimeError("real detection memory soak requires Windows")

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.argtypes = []
    get_current_process.restype = wintypes.HANDLE
    get_process_memory_info = psapi.GetProcessMemoryInfo
    get_process_memory_info.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_ProcessMemoryCountersEx),
        wintypes.DWORD,
    ]
    get_process_memory_info.restype = wintypes.BOOL

    counters = _ProcessMemoryCountersEx()
    counters.cb = ctypes.sizeof(counters)
    if not get_process_memory_info(get_current_process(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(counters.PrivateUsage), int(counters.WorkingSetSize)


def _settled_private_bytes_averages(samples: list[tuple[int, int]]) -> tuple[float, float]:
    """Compare the two early and two late post-warm-up Private Bytes samples."""
    settled = samples[1:]
    if len(settled) != 4:
        raise ValueError(f"expected {MEMORY_SOAK_CYCLES} memory samples, got {len(samples)}")
    early_average = sum(private_bytes for private_bytes, _rss in settled[:2]) / 2
    late_average = sum(private_bytes for private_bytes, _rss in settled[-2:]) / 2
    return early_average, late_average


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


def _record_for(path: Path, run_id: str) -> ImageRecord:
    with Image.open(path) as image:
        width, height = image.size
    stat = path.stat()
    return ImageRecord(f"real-regression-{path.stem}-{run_id}", path, path.name, width, height, stat.st_mtime_ns, stat.st_size)


def _assert_candidate(candidate, expected: tuple[str, str, bool]) -> None:
    role, source, forced = expected
    actual = (candidate.role.value, candidate.source, candidate.forced)
    if actual != expected:
        raise RuntimeError(f"{candidate.label_token}: expected role/source/forced={expected}, got {actual}")


def _assert_mask_range(name: str, candidate, area_range: tuple[int, int], bbox_limit: tuple[int, int, int, int]) -> str:
    area, bbox = _mask_metrics(candidate.mask_path)
    lower, upper = area_range
    if area < lower or area > upper:
        raise RuntimeError(f"{name}: area {area} outside {area_range}")
    left, top, right, bottom = bbox or (0, 0, 0, 0)
    allowed_left, allowed_top, allowed_right, allowed_bottom = bbox_limit
    if left < allowed_left or top < allowed_top or right > allowed_right or bottom > allowed_bottom:
        raise RuntimeError(f"{name}: bbox {bbox} outside {bbox_limit}")
    return f"  {name}: area={area}, bbox={bbox}"


def _assert_scene(name: str, candidates) -> list[str]:
    expected = SAMPLES[name]
    by_label = {candidate.label_token: candidate for candidate in candidates}
    labels = set(by_label)
    lines = [f"{name}: labels={','.join(sorted(labels)) or 'none'}"]
    details = []
    for candidate in candidates:
        area, bbox = _mask_metrics(candidate.mask_path)
        details.append(f"{candidate.label_token}(area={area},bbox={bbox},source={candidate.source},forced={candidate.forced})")
    lines.append(f"  candidates: {', '.join(details) or 'none'}")
    if len(by_label) != len(candidates):
        raise RuntimeError(f"{name}: duplicate candidate labels: {', '.join(details)}")
    required = set(expected["candidates"])
    missing_labels = required - labels
    if missing_labels:
        raise RuntimeError(f"{name}: missing required labels {sorted(missing_labels)}")
    unexpected = labels - required
    if unexpected:
        raise RuntimeError(f"{name}: unexpected labels {sorted(unexpected)}")
    for label, metadata in expected["candidates"].items():
        _assert_candidate(by_label[label], metadata)
    if "fluid" not in expected["candidates"]:
        return lines
    fluid = by_label["fluid"]
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
    for label, region, minimum in expected.get("regions", ()):
        rate = _region_rate(fluid.mask_path, region)
        lines.append(f"  {label}: {rate:.3f}")
        if rate < minimum:
            raise RuntimeError(f"{name}: fluid area={area}, bbox={bbox}; {label} rate {rate:.3f} below {minimum:.2f}")
    for label, region in expected.get("negative_regions", ()):
        rate = _region_rate(fluid.mask_path, region)
        lines.append(f"  {label}: {rate:.3f}")
        if rate > .001:
            raise RuntimeError(f"{name}: {label} rate {rate:.3f} exceeds .001")
    for label in ("hand", "pussy"):
        if label in expected:
            lines.append(_assert_mask_range(label, by_label[label], *expected[label]))
    return lines


def _run_cycle(state: StudioState, images_dir: Path, artifacts: Path | None, scene23_repeats: int, cycle: int) -> list[str]:
    state.models = state._load_detection_models()
    models = state.models
    lines: list[str] = []
    for name in SAMPLES:
        repeats = scene23_repeats if name == "Scene_cowgirl_00023.png" else 1
        for repeat in range(repeats):
            record = _record_for(images_dir / name, f"{cycle}-{repeat}")
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            state.candidates = {}
            state.candidate_revisions = {record.image_id: 0}
            candidates = state._detect_image(models, record, .5, mode="high_precision")
            if artifacts is not None:
                for index, candidate in enumerate(candidates):
                    with Image.open(candidate.mask_path) as image:
                        image.save(artifacts / f"{Path(name).stem}-{cycle}-{repeat}-{index}-{candidate.label_token}.png")
            lines.extend(_assert_scene(name, candidates))
    models_ref = weakref.ref(models)
    del models
    state._release_gpu_job_memory()
    gc.collect()
    if models_ref() is not None:
        raise RuntimeError(f"cycle {cycle}: detection models remain alive after cleanup")
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
            torch.cuda.synchronize(device)
            baseline = (int(torch.cuda.memory_allocated(device)), int(torch.cuda.memory_reserved(device)))
            settled_cycles: list[tuple[int, int]] = []
            memory_samples: list[tuple[int, int]] = []
            for cycle in range(1, MEMORY_SOAK_CYCLES + 1):
                try:
                    print(*_run_cycle(state, args.images_dir, args.artifacts, args.scene23_repeats, cycle), sep="\n")
                except RuntimeError as exc:
                    failure = f"cycle {cycle}: {exc}"
                    print(failure)
                    failures.append(failure)
                    state._release_gpu_job_memory()
                    gc.collect()
                torch.cuda.synchronize(device)
                settled = (int(torch.cuda.memory_allocated(device)), int(torch.cuda.memory_reserved(device)))
                settled_cycles.append(settled)
                private_bytes, rss_bytes = _process_memory_bytes()
                memory_samples.append((private_bytes, rss_bytes))
                print(
                    f"cycle {cycle} after cleanup: GPU allocated={settled[0]}, reserved={settled[1]}; "
                    f"process private={private_bytes}, rss={rss_bytes}"
                )
            if any(current[0] > previous[0] or current[1] > previous[1] for previous, current in zip(settled_cycles, settled_cycles[1:])):
                raise RuntimeError(f"GPU memory grew across cleanup cycles: before={baseline}, settled={settled_cycles}")
            early_average, late_average = _settled_private_bytes_averages(memory_samples)
            growth = late_average - early_average
            print(
                "Private Bytes settled averages: "
                f"early={early_average:.0f}, late={late_average:.0f}, growth={growth:.0f}"
            )
            if growth > PRIVATE_BYTES_GROWTH_LIMIT:
                raise RuntimeError(
                    "Private Bytes grew persistently across settled cycles: "
                    f"early_average={early_average:.0f}, late_average={late_average:.0f}, "
                    f"growth={growth:.0f}, limit={PRIVATE_BYTES_GROWTH_LIMIT}"
                )
        finally:
            state.shutdown()
    if failures:
        raise SystemExit("\n".join(failures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
