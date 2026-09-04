from __future__ import annotations

import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import sys


PROFILES = {"cuda", "directml", "cpu"}
RUNTIME_DISTRIBUTIONS = {
    "onnxruntime": "cpu",
    "onnxruntime-gpu": "cuda",
    "onnxruntime-directml": "directml",
}
MARKER_NAME = ".mozarie-runtime.json"


class ProfileError(RuntimeError):
    pass


def normalize_profile(value: str | None) -> str | None:
    profile = (value or "").strip().lower()
    if not profile:
        return None
    if profile not in PROFILES:
        raise ProfileError(f"Unknown MOZARIE_RUNTIME value: {value!r}. Use cuda, directml, or cpu.")
    return profile


def marker_path(venv: Path) -> Path:
    return venv / MARKER_NAME


def read_marker(venv: Path) -> dict[str, object] | None:
    path = marker_path(venv)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def installed_distributions() -> dict[str, str]:
    installed: dict[str, str] = {}
    for distribution, profile in RUNTIME_DISTRIBUTIONS.items():
        try:
            installed[distribution] = metadata.version(distribution)
        except metadata.PackageNotFoundError:
            continue
    return installed


def installed_profile() -> str | None:
    profiles = {RUNTIME_DISTRIBUTIONS[name] for name in installed_distributions()}
    if len(profiles) > 1:
        raise ProfileError(
            "Multiple ONNX Runtime variants are installed. Back up and recreate .venv; "
            "CPU, CUDA, and DirectML variants must not share one environment."
        )
    return next(iter(profiles), None)


def preflight(profile: str) -> None:
    requested = normalize_profile(profile)
    assert requested is not None
    current = installed_profile()
    if current is not None and requested != current:
        raise ProfileError(
            f"The existing environment is {current}, but setup selected {requested}. "
            "The environment was not changed. Back up or remove .venv before changing runtimes."
        )
    if current is None:
        return
    try:
        import onnxruntime as ort
    except Exception as exc:
        raise ProfileError(f"The existing ONNX Runtime cannot be imported: {exc}") from exc
    providers = set(ort.get_available_providers())
    expected = {
        "cuda": "CUDAExecutionProvider",
        "directml": "DmlExecutionProvider",
        "cpu": "CPUExecutionProvider",
    }[current]
    if expected not in providers:
        raise ProfileError(
            f"The installed {current} distribution does not expose {expected}. "
            "The environment is inconsistent; back up and recreate .venv."
        )


def _probe_onnx(
    ort: object,
    onnx: object,
    np: object,
    profile: str,
    gpu_device: int,
    *,
    directml_identity: object | None = None,
) -> str:
    expected = {
        "cuda": "CUDAExecutionProvider",
        "directml": "DmlExecutionProvider",
        "cpu": "CPUExecutionProvider",
    }[profile]
    provider_device = int(gpu_device)
    if profile == "directml":
        if directml_identity is None:
            raise ProfileError(
                "DirectML GPU identity is required to map the selected device to an ONNX Runtime adapter."
            )
        try:
            from .runtime import directml_onnx_device_id

            provider_device = directml_onnx_device_id(
                gpu_device,
                module=directml_identity,
            )
        except (AttributeError, ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
            raise ProfileError(
                f"The selected DirectML device {gpu_device} could not be mapped to an ONNX Runtime adapter."
            ) from exc

    providers: list[object] = [expected]
    if profile in {"cuda", "directml"}:
        providers = [(expected, {"device_id": provider_device})]

    helper = onnx.helper
    tensor_proto = onnx.TensorProto
    input_value = helper.make_tensor_value_info("input", tensor_proto.FLOAT, [1, 1])
    output_value = helper.make_tensor_value_info("output", tensor_proto.FLOAT, [1, 1])
    graph = helper.make_graph(
        [helper.make_node("Identity", ["input"], ["output"])],
        "mozarie-setup-diagnostic",
        [input_value],
        [output_value],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    options = ort.SessionOptions()
    if profile in {"cuda", "directml"}:
        options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    if profile == "directml":
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    try:
        session = ort.InferenceSession(model.SerializeToString(), sess_options=options, providers=providers)
        session.disable_fallback()
        active = list(session.get_providers())
        if not active or active[0] != expected:
            raise RuntimeError(f"ONNX Runtime selected {active[0] if active else 'no provider'}")
        outputs = session.run(None, {"input": np.ones((1, 1), dtype=np.float32)})
        if not outputs or float(outputs[0][0][0]) != 1.0:
            raise RuntimeError("the identity model returned an unexpected result")
    except Exception as exc:
        raise ProfileError(
            f"The ONNX {expected} probe failed on device {gpu_device}: {exc}"
        ) from exc
    return expected


def validate(profile: str, gpu_device: int = 0) -> dict[str, object]:
    selected = normalize_profile(profile)
    assert selected is not None
    current = installed_profile()
    if current != selected:
        raise ProfileError(
            f"The installed ONNX Runtime profile is {current or 'missing'}, not {selected}."
        )
    try:
        import numpy as np
        import onnx
        import torch
        import onnxruntime as ort
    except Exception as exc:
        raise ProfileError(f"Runtime packages cannot be imported: {exc}") from exc

    providers = list(ort.get_available_providers())
    devices: list[str] = []
    directml_identity: object | None = None
    if selected == "cuda":
        if not getattr(torch.version, "cuda", None) or "CUDAExecutionProvider" not in providers:
            raise ProfileError("CUDA PyTorch or CUDAExecutionProvider is unavailable.")
        if not torch.cuda.is_available():
            raise ProfileError("CUDA packages are installed, but no usable NVIDIA CUDA device was found.")
        if gpu_device < 0 or gpu_device >= torch.cuda.device_count():
            raise ProfileError(f"CUDA device {gpu_device} is unavailable.")
        devices = [torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())]
        probe = torch.ones(1, device=f"cuda:{gpu_device}") + 1
        if float(probe.cpu().item()) != 2.0:
            raise ProfileError("The CUDA tensor probe failed.")
    elif selected == "directml":
        if "DmlExecutionProvider" not in providers:
            raise ProfileError("onnxruntime-directml is installed, but DmlExecutionProvider is unavailable.")
        try:
            import torch_directml
        except Exception as exc:
            raise ProfileError(f"torch-directml cannot be imported: {exc}") from exc
        count = int(torch_directml.device_count())
        if count < 1:
            raise ProfileError("torch-directml did not find a DirectML device.")
        if gpu_device < 0 or gpu_device >= count:
            raise ProfileError(f"DirectML device {gpu_device} is unavailable.")
        devices = [str(torch_directml.device_name(index)).rstrip("\0") for index in range(count)]
        device = torch_directml.device(gpu_device)
        probe = torch.ones(1, device=device) + 1
        if float(probe.cpu().item()) != 2.0:
            raise ProfileError("The DirectML tensor probe failed.")
        directml_identity = torch_directml
    else:
        if "CPUExecutionProvider" not in providers:
            raise ProfileError("CPUExecutionProvider is unavailable.")
        probe = torch.ones(1) + 1
        if float(probe.item()) != 2.0:
            raise ProfileError("The CPU tensor probe failed.")

    onnx_provider = _probe_onnx(
        ort,
        onnx,
        np,
        selected,
        gpu_device,
        directml_identity=directml_identity,
    )

    return {
        "schema": 1,
        "profile": selected,
        "python": sys.version.split()[0],
        "providers": providers,
        "validated_provider": onnx_provider,
        "validated_device": gpu_device if selected != "cpu" else None,
        "devices": devices,
    }


def write_marker(venv: Path, result: dict[str, object]) -> None:
    path = marker_path(venv)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def selected_profile(venv: Path) -> str | None:
    explicit = normalize_profile(os.environ.get("MOZARIE_RUNTIME"))
    if explicit is not None:
        return explicit
    marker = read_marker(venv)
    if marker is not None and marker.get("schema") == 1:
        return normalize_profile(str(marker.get("profile", "")))
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("show", "preflight", "validate"))
    parser.add_argument("profile", nargs="?")
    parser.add_argument("--venv", type=Path, default=Path(__file__).resolve().parent / ".venv")
    parser.add_argument("--write-marker", action="store_true")
    parser.add_argument("--gpu-device", type=int, default=0)
    args = parser.parse_args()
    try:
        if args.command == "show":
            profile = selected_profile(args.venv)
            if profile is not None:
                print(profile)
            return 0
        if args.profile is None:
            raise ProfileError("A runtime profile is required.")
        if args.command == "preflight":
            preflight(args.profile)
            return 0
        result = validate(args.profile, args.gpu_device)
        if args.write_marker:
            write_marker(args.venv, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ProfileError as exc:
        print(f"[Mozarie] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
