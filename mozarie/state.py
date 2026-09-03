from __future__ import annotations

import re
import sqlite3
import warnings
import atexit
import msvcrt
import os
import secrets
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .core import (
    APP_DIR, CACHE_BASE_DIR, DEFAULT_COLORS, LOGGER, SESSION_BASE_DIR,
    THUMBNAIL_WORKERS,
    BrowserSaveReceipt, BrowserSaveToken, Candidate, ClientError, ImageRecord,
    InferenceGate, Job, JobControl, torch_module,
)
from .config import SettingsError, SettingsStore, validate_output_directory_ready
from .runtime_types import DetectionModels
from .runtime import directml_devices, runtime_backend
from .catalog import CatalogMixin
from .saving import SavingMixin
from .detection import DetectionMixin
from .jobs import JobsMixin
from .model_downloads import ModelDownloadManager
from .workspace import WorkspaceOpenError, WorkspaceStore


def cuda_device_statuses(torch: Any) -> list[dict[str, object]]:
    """List CUDA devices that this PyTorch build can actually execute on."""
    cuda = torch.cuda
    # PyTorch emits a process-wide warning while merely enumerating an older
    # adapter. The Settings check reports that incompatibility itself.
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=r"\s*Found GPU\d+",
            category=UserWarning,
        )
        warnings.filterwarnings(
            "ignore",
            message=r"\s*NVIDIA .* with CUDA capability sm_\d+ is not compatible with the current PyTorch installation",
            category=UserWarning,
        )
        if not cuda.is_available():
            return []
        arch_list = cuda.get_arch_list()
        supported_majors = {
            int(match.group(1)) // 10
            for arch in arch_list
            if (match := re.fullmatch(r"sm_(\d+)(?:[af])?", arch))
        }
        devices = []
        for index in range(cuda.device_count()):
            major, minor = cuda.get_device_capability(index)
            architecture = f"sm_{major}{minor}"
            devices.append({
                "id": index,
                "name": cuda.get_device_name(index),
                "architecture": architecture,
                "totalMemory": int(cuda.get_device_properties(index).total_memory),
                # Match PyTorch's CUDA cubin check: an NVIDIA cubin is
                # compatible with devices from the same compute major.
                # With no embedded cubin list, PyTorch skips that warning.
                "supported": not arch_list or major in supported_majors,
            })
    return devices


def gpu_device_statuses(torch: Any) -> list[dict[str, object]]:
    backend = runtime_backend(torch_module=torch)
    if backend == "directml":
        try:
            return directml_devices()
        except (ImportError, OSError, RuntimeError):
            return []
    return cuda_device_statuses(torch) if backend == "cuda" else []


class StudioState(CatalogMixin, SavingMixin, DetectionMixin, JobsMixin):
    def __init__(self, cache_dir: Path | None = None, session_base_dir: Path | None = None) -> None:
        self.settings_store = SettingsStore(APP_DIR)
        self.workspace_store = WorkspaceStore(APP_DIR / "data")
        self.catalog_id: str | None = None
        self.project_read_only = False
        self.source_mismatches: dict[str, bool] = {}
        self.browser_import_hashes: dict[str, str] = {}
        self.browser_catalog_provisional = False
        self.settings = self.settings_store.load()
        self.lock = threading.RLock()
        self.import_lock = threading.RLock()
        self.active_import_count = 0
        self._cache_lock_handle: Any | None = None
        self._owns_process_cache = cache_dir is None
        if cache_dir is None:
            self._cleanup_stale_process_caches()
            self.cache_dir = CACHE_BASE_DIR / f"process-{os.getpid()}-{uuid.uuid4().hex}"
            self.cache_dir.mkdir(parents=True, exist_ok=False)
            self._cache_lock_handle = self._lock_directory(self.cache_dir)
        else:
            self.cache_dir = Path(cache_dir)
        self.session_base_dir = Path(session_base_dir) if session_base_dir is not None else SESSION_BASE_DIR
        self.session_dir: Path | None = None
        self.session_imports_dir: Path | None = None
        self._session_lock_handle: Any | None = None
        self.root: Path | None = None
        self.images: dict[str, ImageRecord] = {}
        self.order: list[str] = []
        self.candidates: dict[str, list[Candidate]] = {}
        self.candidate_revisions: dict[str, int] = {}
        # These locks only serialize work for the same catalogue record.  State
        # mutation still uses ``lock``; never acquire an image lock while that
        # global lock is held.
        self._image_io_locks: dict[str, threading.RLock] = {}
        self.thumbnail_gate = threading.BoundedSemaphore(THUMBNAIL_WORKERS)
        self.import_staging_gate = threading.BoundedSemaphore(10)
        self.browser_save_tokens: dict[str, BrowserSaveToken] = {}
        # A claimed token is being committed outside ``lock``.  Expiry polling
        # must leave its already-written copy alone until the commit finishes.
        self.browser_save_claims: set[str] = set()
        self.browser_save_receipts: dict[str, BrowserSaveReceipt] = {}
        self._pending_browser_save_cleanup: list[tuple[Path, tuple[int, int] | None]] = []
        self.output_destination_lock = threading.Lock()
        # Windows native dialogs are process-modal. Keep folder and model
        # pickers mutually exclusive without blocking unrelated work.
        self.native_picker_lock = threading.Lock()
        self.model_downloads = ModelDownloadManager(APP_DIR)
        self.reserved_output_paths: set[Path] = set()
        self.session_token = secrets.token_urlsafe(32)
        self.job = Job()
        self.catalog_generation = 0
        self.job_generation = 0
        self.worker_thread: threading.Thread | None = None
        self.job_control: JobControl | None = None
        self.models: DetectionModels | None = None
        self.hand_model: Any | None = None
        self.sam_predictor: Any | None = None
        self.sam_image_id: str | None = None
        self.sam_lock = threading.RLock()
        self.hand_segmentation_predictor: Any | None = None
        self.hand_segmentation_image_id: str | None = None
        # SAM and HandSegNet both retain large CUDA embeddings. One shared
        # re-entrant lock prevents their peak allocations from overlapping.
        self.hand_segmentation_lock = self.sam_lock
        self.inference_lock = InferenceGate()
        self._cleanup_stale_sessions()

    def update_settings(self, update: dict[str, Any]) -> dict[str, Any]:
        """Persist user-selected options and release only model objects that changed."""
        if not isinstance(update, dict):
            raise ClientError("設定の形式が正しくありません。", "invalid_settings")
        with self.inference_lock, self.lock:
            if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            previous_models = dict(self.settings.get("models", {}))
            try:
                settings = self.settings_store.validate_update(update)
            except SettingsError as exc:
                raise ClientError("設定の内容が正しくありません。", "invalid_settings") from exc
            try:
                validate_output_directory_ready(settings["saving"]["default_output_directory"])
            except (SettingsError, OSError) as exc:
                raise ClientError("保存先フォルダを使用できません。", "output_folder_unavailable") from exc
            self._require_supported_gpu(settings["models"])
            settings = self.settings_store.save(settings)
            self.settings = settings
            detection_keys = {
                "target_segmentation", "ntd11", "ntd11_enabled", "sensitive", "sensitive_enabled",
                "hand_detection", "hand_detection_enabled", "provider", "gpu_device",
            }
            sam_keys = {"sam_checkpoints", "sam_model_type", "provider", "gpu_device"}
            if any(settings["models"].get(key) != previous_models.get(key) for key in detection_keys):
                self.models = None
                self.hand_model = None
            if any(settings["models"].get(key) != previous_models.get(key) for key in sam_keys):
                self.sam_predictor = None
                self.sam_image_id = None
            if any(settings["models"].get(key) != previous_models.get(key) for key in {"hand_segmentation", "hand_segmentation_enabled", "provider", "gpu_device"}):
                self.hand_segmentation_predictor = None
                self.hand_segmentation_image_id = None
            resource_keys = detection_keys | sam_keys | {"hand_segmentation", "hand_segmentation_enabled"}
            if (previous_models.get("provider") == "gpu"
                    and any(settings["models"].get(key) != previous_models.get(key) for key in resource_keys)):
                self._release_gpu_cache(provider="gpu", gpu_device=int(previous_models.get("gpu_device", 0)))
            return self.settings

    @staticmethod
    def _gpu_selection_error() -> ClientError:
        return ClientError("選択したGPUは使用できません。対応しているGPUを選ぶか、CPUへ切り替えてください。", "gpu_unsupported")

    def _require_supported_gpu(self, models: dict[str, Any] | None = None) -> None:
        models = models or self.settings["models"]
        if models["provider"] != "gpu":
            return
        selected_gpu = next(
            (gpu for gpu in gpu_device_statuses(torch_module()) if gpu["id"] == models["gpu_device"]),
            None,
        )
        if not selected_gpu or not selected_gpu["supported"]:
            raise self._gpu_selection_error()

    def diagnose_gpu_runtime(self) -> tuple[str, ...]:
        """Exercise a disposable ONNX session without retaining it in model state."""
        from .inference.onnx import diagnose_runtime
        with self.inference_lock:
            with self.lock:
                if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                    raise ClientError("処理中はGPU推論を確認できません。", "operation_in_progress")
                models = dict(self.settings["models"])
            self._require_supported_gpu(models)
            try:
                return diagnose_runtime("gpu", int(models.get("gpu_device", 0)))
            except ClientError:
                raise
            except Exception as exc:
                raise ClientError("GPU推論を確認できません。CUDA環境とモデルファイルを確認してください。", "gpu_unavailable") from exc

    def reset_settings(self) -> dict[str, Any]:
        with self.inference_lock, self.lock:
            if self.active_import_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            previous_models = dict(self.settings.get("models", {}))
            try:
                settings = self.settings_store.default_settings()
            except SettingsError as exc:
                raise ClientError("設定の内容が正しくありません。", "invalid_settings") from exc
            try:
                validate_output_directory_ready(settings["saving"]["default_output_directory"])
            except (SettingsError, OSError) as exc:
                raise ClientError("保存先フォルダを使用できません。", "output_folder_unavailable") from exc
            self.settings = self.settings_store.reset(settings)
            self.models = None
            self.hand_model = None
            self.sam_predictor = None
            self.sam_image_id = None
            self.hand_segmentation_predictor = None
            self.hand_segmentation_image_id = None
            if previous_models.get("provider") == "gpu":
                self._release_gpu_cache(provider="gpu", gpu_device=int(previous_models.get("gpu_device", 0)))
            return self.settings

    def begin_import_transfer(self) -> None:
        """Block conflicting mutations from the first upload byte onward."""
        with self.lock:
            if self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は画像を追加できません。", "operation_in_progress")
            self.active_import_count += 1

    def end_import_transfer(self) -> None:
        with self.lock:
            if self.active_import_count:
                self.active_import_count -= 1

    def settings_status(self, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        """Report configured model files without loading model data."""
        models = (settings or self.settings)["models"]
        sam_enabled = (settings or self.settings)["detection"].get("mode") == "high_precision"
        result: dict[str, dict[str, Any]] = {}
        def add_status(key: str, *, required: bool, enabled: bool, required_suffix: str | None = None, raw_path: str | None = None) -> None:
            raw = str(models.get(key, "") if raw_path is None else raw_path).strip()
            if not required and not enabled:
                result[key] = {
                    "required": False,
                    "enabled": False,
                    "configured": bool(raw),
                    "exists": False,
                    "valid": False,
                    "reasonCode": None,
                }
                return
            path = Path(raw).expanduser() if raw else None
            exists = bool(path and path.is_file())
            valid = exists and (required_suffix is None or path.suffix.lower() == required_suffix)
            reason_code: str | None = None
            if not raw:
                reason_code = "not_configured"
            elif not exists:
                reason_code = "missing"
            elif not valid:
                reason_code = "invalid_format"
            if valid and key == "sam_checkpoint" and path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
                valid = False
                reason_code = "invalid_format"
            result[key] = {
                "required": required,
                "enabled": enabled,
                "configured": bool(raw),
                "exists": exists,
                "valid": valid,
                "reasonCode": reason_code,
            }

        add_status("target_segmentation", required=True, enabled=True, required_suffix=".onnx")
        add_status("ntd11", required=False, enabled=bool(models["ntd11_enabled"]), required_suffix=".onnx")
        add_status("sensitive", required=False, enabled=bool(models["sensitive_enabled"]), required_suffix=".onnx")
        add_status("hand_detection", required=False, enabled=bool(models["hand_detection_enabled"]), required_suffix=".onnx")
        add_status(
            "hand_segmentation",
            required=False,
            enabled=bool(models.get("hand_detection_enabled")) and bool(models.get("hand_segmentation_enabled")),
            required_suffix=".safetensors",
        )
        add_status("sam_checkpoint", required=sam_enabled, enabled=sam_enabled, raw_path=str(models["sam_checkpoints"].get(models["sam_model_type"], "")))
        sam_files = {
            "vit_b": "sam_vit_b_01ec64.pth",
            "vit_l": "sam_vit_l_0b3195.pth",
            "vit_h": "sam_vit_h_4b8939.pth",
        }
        sam_variants: dict[str, dict[str, Any]] = {}
        app_dir = self.settings_store.defaults_path.parent.parent.resolve()
        for variant, filename in sam_files.items():
            raw = str(models.get("sam_checkpoints", {}).get(variant, "")).strip()
            path = Path(raw).expanduser() if raw else None
            exists = bool(path and path.is_file())
            suffix_valid = bool(path and path.suffix.lower() in {".pth", ".pt", ".ckpt"})
            known_match = None
            if path:
                known_match = next((key for key, known in sam_files.items() if path.name.lower() == known.lower()), None)
            mismatch = known_match is not None and known_match != variant
            managed_path = (app_dir / "models" / filename).resolve()
            managed = bool(path and path.resolve() == managed_path)
            reason_code = None
            if not raw:
                reason_code = "not_configured"
            elif not exists:
                reason_code = "missing"
            elif not suffix_valid:
                reason_code = "invalid_format"
            elif mismatch:
                reason_code = "type_mismatch"
            sam_variants[variant] = {
                "path": raw,
                "configured": bool(raw),
                "exists": exists,
                "valid": exists and suffix_valid and not mismatch,
                "managed": managed,
                "reasonCode": reason_code,
            }
        torch = torch_module()
        backend = runtime_backend(torch_module=torch)
        gpus = gpu_device_statuses(torch)
        selected_gpu = next((gpu for gpu in gpus if gpu["id"] == models.get("gpu_device", 0)), None)
        gpu_device_valid = models["provider"] != "gpu" or bool(selected_gpu and selected_gpu["supported"])
        return {
            "models": result,
            "provider": models["provider"],
            "samModelType": models["sam_model_type"],
            "samVariants": sam_variants,
            "gpus": gpus,
            "runtimeBackend": backend,
            "gpuDevice": models.get("gpu_device", 0),
            "gpuDeviceValid": gpu_device_valid,
            "gpuDeviceReasonCode": None if gpu_device_valid else "gpu_unsupported",
        }

    def preview_settings_status(self, update: dict[str, Any]) -> dict[str, Any]:
        try:
            settings = self.settings_store.validate_update(update)
        except SettingsError as exc:
            raise ClientError("設定の内容が正しくありません。", "invalid_settings") from exc
        return self.settings_status(settings)

    @staticmethod
    def _lock_directory(directory: Path) -> Any:
        lock_handle = (directory / ".active.lock").open("w+b")
        try:
            lock_handle.write(b"1")
            lock_handle.flush()
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
            return lock_handle
        except Exception:
            lock_handle.close()
            raise

    @staticmethod
    def _release_directory_lock(lock_handle: Any | None) -> None:
        if lock_handle is None:
            return
        try:
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        lock_handle.close()

    @classmethod
    def _cleanup_stale_process_caches(cls) -> None:
        if not CACHE_BASE_DIR.is_dir():
            return
        cutoff = time.time() - 60
        for cache_dir in CACHE_BASE_DIR.glob("process-*"):
            if not cache_dir.is_dir():
                continue
            lock_path = cache_dir / ".active.lock"
            try:
                if not lock_path.exists():
                    if cache_dir.stat().st_mtime > cutoff:
                        continue
                    shutil.rmtree(cache_dir, ignore_errors=True)
                    continue
                with lock_path.open("a+b") as handle:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                shutil.rmtree(cache_dir, ignore_errors=True)
            except OSError:
                continue

    def _cleanup_stale_sessions(self) -> None:
        """Remove abandoned import sessions without touching a live instance."""
        if not self.session_base_dir.is_dir():
            return
        cutoff = time.time() - 60
        for session_dir in self.session_base_dir.glob("session-*"):
            try:
                if not session_dir.is_dir():
                    continue
                lock_path = session_dir / ".active.lock"
                if not lock_path.exists():
                    if session_dir.stat().st_mtime > cutoff:
                        continue
                    shutil.rmtree(session_dir, ignore_errors=True)
                    continue
                with lock_path.open("a+b") as handle:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                shutil.rmtree(session_dir, ignore_errors=True)
            except OSError:
                continue

    def _ensure_session(self) -> Path:
        if self.session_imports_dir is not None:
            return self.session_imports_dir
        self.session_base_dir.mkdir(parents=True, exist_ok=True)
        session_dir = self.session_base_dir / f"session-{uuid.uuid4().hex}"
        imports_dir = session_dir / "imports"
        imports_dir.mkdir(parents=True)
        lock_handle = (session_dir / ".active.lock").open("w+b")
        try:
            lock_handle.write(b"1")
            lock_handle.flush()
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
        except Exception:
            lock_handle.close()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        self.session_dir = session_dir
        self.session_imports_dir = imports_dir
        self._session_lock_handle = lock_handle
        return imports_dir

    def _detach_session_unchecked(self) -> tuple[Path | None, Any | None]:
        session_dir = self.session_dir
        lock_handle = self._session_lock_handle
        self.session_dir = None
        self.session_imports_dir = None
        self._session_lock_handle = None
        return session_dir, lock_handle

    @staticmethod
    def _release_detached_session(session: tuple[Path | None, Any | None]) -> None:
        session_dir, lock_handle = session
        if lock_handle is not None:
            try:
                lock_handle.seek(0)
                msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            lock_handle.close()
        if session_dir is not None:
            shutil.rmtree(session_dir, ignore_errors=True)

STATE: StudioState | None
STATE_STARTUP_ERROR: WorkspaceOpenError | sqlite3.DatabaseError | None = None
try:
    STATE = StudioState()
except (WorkspaceOpenError, sqlite3.DatabaseError) as exc:
    STATE = None
    STATE_STARTUP_ERROR = exc
else:
    atexit.register(STATE.shutdown)


def recreate_workspace() -> StudioState:
    """Explicit recovery action; source images are never part of this deletion."""
    global STATE, STATE_STARTUP_ERROR
    WorkspaceStore.recreate(APP_DIR / "data")
    STATE = StudioState()
    STATE_STARTUP_ERROR = None
    atexit.register(STATE.shutdown)
    return STATE
