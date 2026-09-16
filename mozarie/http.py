import base64
import io
import json
import mimetypes
import os
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import parse_qs, unquote, urlparse

from PIL import Image, ImageOps

from .core import (
    APP_DIR, IO_CHUNK_BYTES, LOGGER, PNG_SIGNATURE, STATIC_DIR,
    ClientError, ForbiddenClientError, ImageRecord, StaleMaskError,
    read_detection_confidence, _read_detection_parallelism, _read_mosaic_divisor,
    _read_save_suffix, _read_target_classes, public_error_params,
)
from . import state as state_module
from .state import STATE, StudioState
from .image_io import IMAGE_DECODE_ERRORS, _decode_mask, _valid_color, calculate_block_size, inference_device_name, open_image_without_png_text, parse_png_chunks
from .model_downloads import ModelDownloadError, ModelDownloadInProgress
from .config import SettingsError, validate_output_directory_ready


CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
_update_start_lock = threading.Lock()
_update_start_requested = False


def _is_canonical_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, AttributeError, TypeError):
        return False


def _reserve_update_start() -> bool:
    """Avoid launching two updater consoles from repeated UI clicks."""
    global _update_start_requested
    with _update_start_lock:
        if _update_start_requested:
            return False
        _update_start_requested = True
        return True


def _is_api_path(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


_POST_OPERATION_LABELS = {
    "/api/import/file": "ブラウザー画像の読み込み",
    "/api/import/start": "ブラウザー画像の読み込み開始",
    "/api/import/finish": "ブラウザー画像の読み込み確定",
    "/api/folder": "フォルダー読み込み",
    "/api/projects": "プロジェクト作成",
    "/api/project/name": "プロジェクト名変更",
    "/api/project/complete": "プロジェクト完了",
    "/api/project/close": "プロジェクトを閉じる",
    "/api/project/open": "プロジェクトを開く",
    "/api/project/resume": "プロジェクトを再開",
    "/api/project/mismatches": "元画像の差分解決",
    "/api/project/source-check": "元フォルダー確認",
    "/api/project/source/relink": "元フォルダー再指定",
    "/api/catalog/clear": "画像一覧クリア",
    "/api/workspace/images": "画像状態の一括変更",
    "/api/catalog/remove": "画像一覧から削除",
    "/api/catalog/delete-source": "元画像を完全削除",
    "/api/catalog/delete-source/prepare": "元画像削除の確認",
    "/api/catalog/delete-source/claim": "元画像削除の所有権確定",
    "/api/catalog/delete-source/release": "元画像削除の所有権解除",
    "/api/catalog/delete-source/status": "元画像削除の状態確認",
    "/api/catalog/delete-source/cancel": "元画像削除の取消",
    "/api/catalog/delete-source/ack": "元画像削除の確認完了",
    "/api/masks/clear": "モザイク指定クリア",
    "/api/detect": "自動検出",
    "/api/candidates/batch": "候補の一括変更",
    "/api/workspace/recreate": "作業データ再作成",
    "/api/settings": "設定保存",
    "/api/settings/gpu-diagnostic": "GPU診断",
    "/api/settings/reset": "設定初期化",
    "/api/model-file/pick": "モデルファイル選択",
    "/api/output-directory/pick": "保存先フォルダー選択",
    "/api/model-download/start": "モデルダウンロード開始",
    "/api/model-download/cancel": "モデルダウンロード取消",
    "/api/update/start": "更新開始",
    "/api/boundary": "境界候補追加",
    "/api/save/prepare": "ブラウザー保存準備",
    "/api/save/render": "ブラウザー保存レンダー",
    "/api/save/reserve": "ブラウザー保存予約",
    "/api/save/commit": "ブラウザー保存確定",
    "/api/save/status": "ブラウザー保存状態確認",
    "/api/save/ack": "ブラウザー保存確定受領",
    "/api/save/cancel": "ブラウザー保存取消",
    "/api/apply": "ファイル保存",
    "/api/job/pause": "バックグラウンド処理一時停止",
    "/api/job/resume": "バックグラウンド処理再開",
    "/api/job/cancel": "バックグラウンド処理取消",
}

_DELETE_OPERATION_LABELS = {
    "/api/catalog/image/": "画像一覧から削除",
    "/api/project/": "プロジェクト削除",
}

_PER_IMAGE_OPERATION_ROUTES = {
    "/api/import/file",
    "/api/save/reserve",
    "/api/save/render",
    "/api/save/commit",
    "/api/save/ack",
}


def _operation_log_spec(method: str, path: str) -> tuple[str, str] | None:
    """Return a user-facing operation name and an ID-free route for CMD logs."""
    if method == "POST":
        label = _POST_OPERATION_LABELS.get(path)
        if label is not None:
            return label, path
        if path.startswith("/api/workspace/manual/"):
            if "/layer/" in path:
                return "手描きマスク転送", "/api/workspace/manual/layer"
            if path.endswith("/begin"):
                return "手描きマスク転送開始", "/api/workspace/manual/begin"
            if path.endswith("/commit"):
                return "手描きマスク転送確定", "/api/workspace/manual/commit"
            if path.endswith("/cancel"):
                return "手描きマスク一時転送を破棄", "/api/workspace/manual/cancel"
        if path.startswith("/api/project/history/"):
            return "プロジェクト履歴", "/api/project/history"
        if path.startswith("/api/workspace/image/"):
            return "画像状態変更", "/api/workspace/image"
        if path.startswith("/api/images/") and path.endswith("/transform"):
            return "画像反転", "/api/images/transform"
        if path.startswith("/api/candidate/"):
            return "候補変更", "/api/candidate"
        return None
    if method == "DELETE":
        for prefix, label in _DELETE_OPERATION_LABELS.items():
            if path.startswith(prefix):
                return label, prefix.rstrip("/")
        if path.startswith("/api/candidate/"):
            return "候補削除", "/api/candidate"
        if path.startswith("/api/workspace/manual/"):
            return "手描き範囲削除", "/api/workspace/manual"
    return None


def _operation_log_details(path: str, payload: dict[str, Any]) -> str:
    details: list[str] = []
    image_ids = payload.get("imageIds")
    if isinstance(image_ids, list):
        details.append(f"対象={len(image_ids)}件")
    if path in {"/api/folder", "/api/project/source-check", "/api/project/source/relink", "/api/output-directory/pick"}:
        source_path = payload.get("path") if path != "/api/output-directory/pick" else payload.get("currentPath")
        if isinstance(source_path, str) and source_path:
            details.append(f"パス={source_path}")
    return f" {' '.join(details)}" if details else ""


def _log_operation_started(operation: tuple[str, str] | None, path: str, payload: dict[str, Any]) -> float | None:
    if operation is None:
        return None
    label, route = operation
    if route in _PER_IMAGE_OPERATION_ROUTES:
        # A browser import/save session already logs its start and completion.
        # Per-image successes make the CMD output noisy without adding a useful
        # operation-level signal; failures remain warnings below.
        return time.monotonic()
    LOGGER.info("操作開始: %s [%s]%s", label, route, _operation_log_details(path, payload))
    return time.monotonic()


def _log_operation_finished(operation: tuple[str, str] | None, started_at: float | None) -> None:
    if operation is None or started_at is None:
        return
    label, route = operation
    if route in _PER_IMAGE_OPERATION_ROUTES:
        return
    LOGGER.info("操作完了: %s [%s] status=200 所要=%.2f秒", label, route, time.monotonic() - started_at)


def _log_operation_failed(operation: tuple[str, str] | None, started_at: float | None, status: HTTPStatus, error: Exception) -> None:
    if operation is None or started_at is None:
        return
    label, route = operation
    error_code = error.error_code if isinstance(error, ClientError) else "internal_error"
    LOGGER.warning("操作失敗: %s [%s] status=%d error_code=%s 所要=%.2f秒", label, route, int(status), error_code, time.monotonic() - started_at)


def _read_fluid_color_fill_options(payload: dict[str, Any], settings: dict[str, Any]) -> tuple[bool, int]:
    """Read the per-run fluid expansion snapshot without accepting coercions."""

    enabled_key = "fluidColorFillEnabled"
    tolerance_key = "fluidColorFillTolerance"
    provided = {key for key in (enabled_key, tolerance_key) if key in payload}
    if provided and provided != {enabled_key, tolerance_key}:
        raise ClientError("精液候補の色拡張設定が正しくありません。", "input_invalid")
    if not provided:
        detection = settings["detection"]
        return bool(detection["fluid_color_fill_enabled"]), int(detection["fluid_color_fill_tolerance"])
    enabled = payload[enabled_key]
    tolerance = payload[tolerance_key]
    if not isinstance(enabled, bool) or isinstance(tolerance, bool) or not isinstance(tolerance, int) or not 0 <= tolerance <= 255:
        raise ClientError("精液候補の色拡張設定が正しくありません。", "input_invalid")
    return enabled, tolerance


def health_device(provider: str, gpu_device: int, gpus: list[dict[str, object]], *, runtime_backend: str = "cpu", runtime_ready: bool = True) -> dict[str, object]:
    """Format health device data without probing a GPU for a CPU selection."""
    if provider != "gpu":
        return {"provider": "cpu", "runtimeBackend": "cpu", "gpuDevice": None, "device": "CPU"}
    selected = next((gpu for gpu in gpus if gpu["id"] == gpu_device), None)
    name = str(selected["name"]) if selected else "unavailable"
    backend = str(selected.get("backend", runtime_backend)) if selected else runtime_backend
    return {"provider": "gpu", "runtimeBackend": backend, "runtimeReady": runtime_ready, "gpuDevice": gpu_device, "gpuName": name, "device": f"GPU {gpu_device}: {name}"}


def _run_native_picker(script: str, environment: dict[str, str], *, failed_message: str, busy_message: str, state: StudioState) -> str | None:
    """Run one Windows picker, owned by an invisible topmost native window."""
    if not state.native_picker_lock.acquire(blocking=False):
        raise ClientError(busy_message, "model_picker_busy")
    try:
        executable = Path(os.environ.get("SystemRoot", r"C:\\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if not executable.is_file():
            raise ClientError(failed_message, "model_picker_failed")
        encoded_script = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        try:
            process = subprocess.Popen(
                [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded_script],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while True:
                try:
                    stdout, _stderr = process.communicate(timeout=0.1)
                    break
                except subprocess.TimeoutExpired:
                    if state.shutdown_requested.is_set():
                        process.terminate()
                        process.communicate()
                        raise ClientError(failed_message, "model_picker_failed")
        except OSError as exc:
            raise ClientError(failed_message, "model_picker_failed") from exc
        if process.returncode:
            raise ClientError(failed_message, "model_picker_failed")
        encoded = stdout.strip()
        if not encoded:
            return None
        try:
            return base64.b64decode(encoded, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise ClientError("選択結果が正しくありません。", "model_picker_invalid") from exc
    finally:
        state.native_picker_lock.release()


def _picker_hint_path(current_path: str) -> Path | None:
    """Return an existing absolute directory that is safe to pass to Windows."""
    if not current_path or "\x00" in current_path:
        return None
    try:
        candidate = Path(current_path.strip()).expanduser()
        if not candidate.is_absolute() or not candidate.is_dir():
            return None
        return candidate.resolve()
    except (OSError, ValueError):
        return None


_MODEL_PICKER_SUFFIXES = {
    "target_segmentation": {".onnx"}, "ntd11": {".onnx"}, "sensitive": {".onnx"}, "hand_detection": {".onnx"},
    "hand_segmentation": {".safetensors"}, "sam_checkpoint": {".pth", ".pt", ".ckpt"},
}


def _pick_model_file(model_key: str, state: StudioState = STATE, current_path: str = "") -> str | None:
    suffixes = _MODEL_PICKER_SUFFIXES.get(model_key)
    if suffixes is None:
        raise ClientError("選択するモデルの種類が正しくありません。", "model_picker_invalid")
    with state.lock:
        if state.active_import_count or state.job.state in {"running", "pausing", "paused"} or state._has_active_worker():
            raise ClientError("処理中はモデルを選択できません。", "job_running")
    pattern = ";".join(f"*{suffix}" for suffix in sorted(suffixes))
    script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.OpenFileDialog
try {{
  $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.TopMost = $true
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Show(); $owner.Activate(); $owner.BringToFront()
  $dialog.Filter = 'Model files ({pattern})|{pattern}'
  $dialog.CheckFileExists = $true; $dialog.Multiselect = $false; $dialog.RestoreDirectory = $true
  $initial = $env:MOZARIE_MODEL_INITIAL_DIRECTORY
  if ($initial -and [System.IO.Directory]::Exists($initial)) {{ $dialog.InitialDirectory = $initial }}
  if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) {{ exit 0 }}
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.FileName)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
}} finally {{ $dialog.Dispose(); $owner.Close(); $owner.Dispose() }}
"""
    picker_environment = os.environ.copy()
    candidate = Path(current_path).expanduser() if isinstance(current_path, str) and current_path else None
    if candidate is not None and candidate.is_absolute() and candidate.parent.is_dir():
        picker_environment["MOZARIE_MODEL_INITIAL_DIRECTORY"] = str(candidate.parent)
    selected = _run_native_picker(script, picker_environment, failed_message="モデルファイルの選択を開けませんでした。", busy_message="ファイルの選択を開いています。", state=state)
    if selected is None:
        return None
    path = Path(selected)
    if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in suffixes:
        raise ClientError("選択したモデルファイルが正しくありません。", "model_picker_invalid")
    return str(path.resolve())


def _pick_output_directory(state: StudioState = STATE, current_path: str = "") -> str | None:
    """Pick and verify a writable directory; a browser handle has no full path."""
    with state.lock:
        if state.active_import_count or state.job.state in {"running", "pausing", "paused"} or state._has_active_worker():
            raise ClientError("処理中は保存先を変更できません。", "job_running")
    script = """
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.TopMost = $true
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Show(); $owner.Activate(); $owner.BringToFront()
  $initial = $env:MOZARIE_OUTPUT_INITIAL_DIRECTORY
  if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }
  if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
} finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }
"""
    environment = os.environ.copy()
    candidate = _picker_hint_path(current_path) if isinstance(current_path, str) else None
    if candidate is not None and candidate.is_dir():
        environment["MOZARIE_OUTPUT_INITIAL_DIRECTORY"] = str(candidate.resolve())
    try:
        selected = _run_native_picker(
            script, environment,
            failed_message="保存先フォルダーの選択を開けませんでした。",
            busy_message="保存先フォルダーを選択しています。", state=state,
        )
    except ClientError as exc:
        if exc.error_code in {"model_picker_failed", "model_picker_invalid"}:
            raise ClientError("保存先フォルダーの選択を完了できません。", "output_folder_unavailable") from exc
        raise
    if selected is None:
        return None
    try:
        return str(validate_output_directory_ready(selected))
    except (SettingsError, OSError) as exc:
        raise ClientError("選択した保存先フォルダーを使用できません。", "output_folder_unavailable") from exc


class MosaicHandler(BaseHTTPRequestHandler):
    server_version = "Mozarie/1.0"
    protocol_version = "HTTP/1.1"

    def _reject_unread_request(self, error: ClientError) -> None:
        self.close_connection = True
        raise error

    def _request_body_length(self, *, required: bool = False) -> int:
        """Validate the only request framing this HTTP/1.1 server accepts."""
        get_all = getattr(self.headers, "get_all", None)
        def header_values(name: str) -> list[str]:
            if get_all:
                return get_all(name, [])
            return [self.headers[name]] if name in self.headers else []

        transfer_encodings = header_values("Transfer-Encoding")
        if transfer_encodings:
            self._reject_unread_request(ClientError("リクエスト形式が正しくありません。", "input_invalid"))
        lengths = header_values("Content-Length")
        if not lengths:
            if required:
                self._reject_unread_request(ClientError("リクエストサイズが不正です。", "input_invalid"))
            return 0
        if len(lengths) != 1:
            self._reject_unread_request(ClientError("リクエストサイズが不正です。", "input_invalid"))
        raw_length = lengths[0]
        if not raw_length or not raw_length.isascii() or not raw_length.isdecimal():
            self._reject_unread_request(ClientError("リクエストサイズが不正です。", "input_invalid"))
        try:
            content_length = int(raw_length)
        except ValueError:
            self._reject_unread_request(ClientError("リクエストサイズが正しくありません。", "input_invalid"))
        if required and content_length <= 0:
            self._reject_unread_request(ClientError("リクエストサイズが正しくありません。", "input_invalid"))
        return content_length

    def _require_local_host(self) -> str:
        host = self.headers.get("Host", "")
        expected_host = f"127.0.0.1:{self.server.server_port}"
        if host != expected_host:
            self._reject_unread_request(ForbiddenClientError("許可されていない接続先です。", "session_expired"))
        return expected_host

    def _require_mutation_request(self) -> None:
        expected_host = self._require_local_host()
        origin = self.headers.get("Origin", "")
        if origin != f"http://{expected_host}":
            self._reject_unread_request(ForbiddenClientError("許可されていない送信元です。", "session_expired"))
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            self._reject_unread_request(ForbiddenClientError("許可されていない送信元です。", "session_expired"))
        if self.headers.get("X-Mozarie-Token", "") != STATE.session_token:
            self._reject_unread_request(ForbiddenClientError("この画面の操作ではありません。再読み込みしてください。", "session_expired"))

    def _require_json_request(self) -> None:
        self._require_mutation_request()
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._reject_unread_request(ClientError("JSON形式のリクエストだけを受け付けます。", "session_expired"))

    def _require_recovery_request(self) -> None:
        expected_host = self._require_local_host()
        if self.headers.get("Origin", "") != f"http://{expected_host}":
            self._reject_unread_request(ForbiddenClientError("許可されていない送信元です。", "session_expired"))
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self._reject_unread_request(ClientError("JSON形式のリクエストだけを受け付けます。", "session_expired"))

    def _send_workspace_recovery_page(self) -> None:
        self._binary((Path(__file__).with_name("workspace_recovery.html")).read_bytes(), "text/html; charset=utf-8")

    def _send_workspace_recovery_translation(self, path: str) -> None:
        """Serve only the two canonical locale files needed by recovery."""
        locale = {"/i18n/ja.json": "ja.json", "/i18n/en.json": "en.json"}[path]
        self._binary((STATIC_DIR / "i18n" / locale).read_bytes(), "application/json; charset=utf-8")

    def _workspace_recreate_required(self) -> None:
        self._client_error(
            ClientError("作業データを作り直してから操作してください。", "workspace_recreate_required"),
            HTTPStatus.CONFLICT,
        )

    def _require_binary_import_request(self) -> None:
        self._require_mutation_request()
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/octet-stream":
            self._reject_unread_request(ClientError("画像バイナリのリクエストだけを受け付けます。", "session_expired"))

    def _catalog_expectation(self, payload: dict[str, Any] | None = None) -> tuple[str | None, int]:
        """Read the catalogue epoch carried by every mutating browser request."""
        payload = payload or {}
        raw_project = payload.get("expectedProjectId", self.headers.get("X-Mozarie-Expected-Project-Id"))
        raw_generation = payload.get("expectedCatalogGeneration", self.headers.get("X-Mozarie-Expected-Catalog-Generation"))
        if raw_project is None: raw_project = ""
        if not isinstance(raw_project, str) or raw_generation is None:
            raise ClientError("プロジェクト一覧の版番号がありません。再読み込みしてください。", "stale_catalog")
        if isinstance(raw_generation, str) and raw_generation.isdigit():
            try:
                raw_generation = int(raw_generation)
            except ValueError as exc:
                raise ClientError("プロジェクト一覧の版番号が正しくありません。", "input_invalid") from exc
        if isinstance(raw_generation, bool) or not isinstance(raw_generation, int) or raw_generation < 0:
            raise ClientError("プロジェクト一覧の版番号が正しくありません。", "input_invalid")
        return (raw_project or None, raw_generation)

    def _catalog_mutation(self, expected_project_id: str | None, expected_catalog_generation: int, operation: Any) -> Any:
        """Keep one request's catalogue epoch available at its state commit."""
        with STATE.catalog_request(expected_project_id, expected_catalog_generation):
            return operation()

    def _catalog_transition_snapshot(self, operation: Any) -> tuple[Any, dict[str, Any]]:
        """Capture a transition result and its catalogue version without interleaving another transition."""
        with STATE.import_lock:
            result = operation()
            return result, STATE.catalog_snapshot()

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._require_local_host()
            if self._request_body_length() > 0:
                self._reject_unread_request(ClientError("GETリクエストに本文は指定できません。", "input_invalid"))
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if STATE is None:
                if path == "/api/workspace/recovery":
                    self._json({"required": True, "errorCode": "workspace_recreate_required"})
                elif path in {"/", "/index.html"}:
                    self._send_workspace_recovery_page()
                elif path in {"/i18n/ja.json", "/i18n/en.json"}:
                    self._send_workspace_recovery_translation(path)
                elif _is_api_path(path):
                    self._workspace_recreate_required()
                else:
                    self._client_error(ClientError("ページが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
                return
            if path == "/api/health":
                models = STATE.settings.get("models", {})
                provider = str(models.get("provider", "cpu"))
                status = STATE.settings_status()
                # The state contract always includes gpuDeviceValid. Keeping
                # absent values neutral lets a minimal status adapter report
                # model readiness without pretending its GPU is invalid.
                runtime_ready = bool(status.get("runtimeReady", status.get("gpuDeviceValid", True)))
                configured = (provider != "gpu" or runtime_ready) and bool(status.get("gpuDeviceValid", True)) and all(model["valid"] for model in status["models"].values() if model["required"] or model["enabled"])
                payload: dict[str, Any] = {
                    "ok": True,
                    "modelsConfigured": configured,
                }
                if provider == "gpu":
                    payload.update(health_device(
                        provider, int(models.get("gpu_device", 0)), status["gpus"],
                        runtime_backend=str(status.get("runtimeBackend", "cpu")),
                        runtime_ready=bool(status.get("runtimeReady", status.get("gpuDeviceValid", True))),
                    ))
                else:
                    payload.update(health_device(provider, 0, []))
                self._json(payload)
            elif path == "/api/settings":
                payload = {"settings": STATE.settings, "version": _local_version()}
                if parse_qs(parsed.query).get("status", ["1"])[0] != "0":
                    payload["status"] = STATE.settings_status()
                self._json(payload)
            elif path == "/api/model-download":
                self._json(STATE.model_downloads.snapshot())
            elif path == "/api/update/status":
                self._json(_update_status())
            elif path == "/api/images":
                self._json(STATE.catalog_snapshot())
            elif path == "/api/projects":
                self._json({"projects": STATE.projects(parse_qs(parsed.query).get("sort", ["updated_desc"])[0])})
            elif path == "/api/project/mismatches":
                self._json({"images": STATE.source_mismatch_snapshot()})
            elif path == "/api/project/source-check":
                raw_path = parse_qs(parsed.query).get("path", [""])[0]
                self._json({"projects": STATE.projects_for_source_root(raw_path)})
            elif path == "/api/project/source-status":
                query = parse_qs(parsed.query)
                project_id = query.get("projectId", [""])[0]
                image_id = query.get("imageId", [""])[0]
                self._json({"exists": bool(project_id and image_id and STATE.workspace_store.project_has_image(project_id, image_id))})
            elif path.startswith("/api/project/history/"):
                self._json(STATE.project_history_status(path.removeprefix("/api/project/history/")))
            elif path == "/api/job":
                self._json(STATE.job_snapshot())
            elif path.startswith("/api/image/"):
                self._send_image(path.removeprefix("/api/image/"), thumbnail=False, version=_request_version(parsed.query))
            elif path.startswith("/api/thumbnail/"):
                self._send_image(path.removeprefix("/api/thumbnail/"), thumbnail=True, version=_request_version(parsed.query))
            elif path.startswith("/api/candidates/"):
                image_id = path.removeprefix("/api/candidates/")
                self._json(STATE.candidate_snapshot(image_id))
            elif path.startswith("/api/workspace/manual/"):
                self._json({"draft": STATE.manual_workspace(path.removeprefix("/api/workspace/manual/"))})
            elif path.startswith("/api/mask/"):
                image_id, candidate_id = _route_ids(path, "/api/mask/")
                self._send_candidate_mask(image_id, candidate_id, _request_version(parsed.query))
            elif path.startswith("/api/project/mask/"):
                image_id, kind = _route_ids(path, "/api/project/mask/")
                image = STATE.workspace_store.project_image(image_id)
                if image is None:
                    raise ClientError("画像が見つかりません。", "image_not_found")
                filename = Path(str(image["relativePath"])).name + f".{kind}.png"
                self._binary(STATE.export_mask_png(image_id, kind), "image/png", headers={"Content-Disposition": f'attachment; filename="{filename}"'})
            elif path.startswith("/api/project/masks/"):
                project_id, kind = _route_ids(path, "/api/project/masks/")
                if kind not in {"mosaic", "exclude"}:
                    raise ClientError("マスク種別が正しくありません。", "input_invalid")
                if STATE.workspace_store.project(project_id) is None:
                    raise ClientError("プロジェクトが見つかりません。", "project_not_found")
                with tempfile.NamedTemporaryFile(dir=STATE.cache_dir, prefix="mozarie-masks-", suffix=".zip", delete=False) as output:
                    archive_path = Path(output.name)
                try:
                    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                        for image, png in STATE.iter_project_mask_exports(project_id, kind):
                            # Keep source identity and original extension so
                            # same-named files from different folders cannot
                            # collide in one project archive.
                            display = "".join(char if char not in r'\\/:*?\"<>|' else "_" for char in str(image.get("sourceDisplay", "source"))) or "source"
                            name = f"{display}-{str(image.get('sourceId', 'source'))[:8]}/{Path(image['relativePath']).as_posix()}.{kind}.png"
                            archive.writestr(name, png)
                    self._stream_path(archive_path, "application/zip", {"Content-Disposition": f'attachment; filename="{kind}-masks.zip"'})
                finally:
                    archive_path.unlink(missing_ok=True)
            else:
                self._send_static(path)
        except StaleMaskError as exc:
            self._client_error(exc, HTTPStatus.NOT_FOUND, "mask_not_found")
        except ForbiddenClientError as exc:
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            self._client_error(exc, HTTPStatus.CONFLICT if exc.error_code == "stale_catalog" else HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep tracebacks in the terminal, not in browser.
            if STATE is not None and (gpu_oom := STATE.recover_gpu_oom_for_request(exc)) is not None:
                LOGGER.error("GET リクエストでGPUメモリが不足: %s", self.path)
                self._client_error(gpu_oom, HTTPStatus.BAD_REQUEST)
                return
            LOGGER.exception("GET リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def do_POST(self) -> None:  # noqa: N802
        operation: tuple[str, str] | None = None
        operation_started_at: float | None = None
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            operation = _operation_log_spec("POST", path)
            operation_started_at = _log_operation_started(operation, path, {})
            if STATE is None:
                if path == "/api/workspace/recreate":
                    self._require_recovery_request()
                    self._read_json_body()
                    restored = state_module.recreate_workspace()
                    globals()["STATE"] = restored
                    self._json({"ok": True})
                    _log_operation_finished(operation, operation_started_at)
                    return
                self._require_local_host()
                self.close_connection = True
                if _is_api_path(path):
                    # The unavailable-state route does not consume arbitrary
                    # request bodies.  Close this connection so a rejected
                    # JSON body cannot be parsed as a second HTTP request.
                    error = ClientError("作業データを作り直してから操作してください。", "workspace_recreate_required")
                    _log_operation_failed(operation, operation_started_at, HTTPStatus.CONFLICT, error)
                    self._workspace_recreate_required()
                else:
                    self._client_error(ClientError("ページが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
                return
            if path == "/api/import/file":
                self._require_binary_import_request()
                content_length = self._request_body_length(required=True)
                name = unquote(self.headers.get("X-Mozarie-Name", ""))
                relative_path = unquote(self.headers.get("X-Mozarie-Relative-Path", ""))
                client_key = unquote(self.headers.get("X-Mozarie-Client-Key", ""))
                source_identity = unquote(self.headers.get("X-Mozarie-Source-Id", ""))
                source_kind = self.headers.get("X-Mozarie-Source-Kind", "browser-files")
                import_intent = self.headers.get("X-Mozarie-Import-Intent", "")
                import_session_id = self.headers.get("X-Mozarie-Import-Session", "")
                raw_mtime = self.headers.get("X-Mozarie-File-Mtime", "0")
                raw_size = self.headers.get("X-Mozarie-File-Size", "0")
                if (source_identity and not _is_canonical_uuid(source_identity)
                        or source_kind not in {"browser-files", "browser-directory"}
                        or import_intent not in {"add", "restore"}
                        or not raw_mtime.isdigit() or not raw_size.isdigit()):
                    self._reject_unread_request(ClientError("画像の更新情報が正しくありません。", "input_invalid"))
                try:
                    mtime_ns = int(raw_mtime) * 1_000_000
                    size_bytes = int(raw_size)
                except ValueError as exc:
                    self._reject_unread_request(ClientError("画像の更新情報が正しくありません。", "input_invalid"))
                try:
                    expected_project_id, expected_catalog_generation = self._catalog_expectation()
                except ClientError as exc:
                    self._reject_unread_request(exc)
                try:
                    STATE.begin_import_transfer(import_session_id, expected_project_id, expected_catalog_generation)
                except ClientError as exc:
                    self._reject_unread_request(exc)
                except Exception:
                    self.close_connection = True
                    raise
                response = None
                succeeded = False
                try:
                    staged_path: Path | None = None
                    try:
                        staged_path = self._read_binary_body_to_file(content_length)
                        STATE.record_import_transfer_bytes(import_session_id, content_length)
                        requested_catalog = unquote(self.headers.get("X-Mozarie-Catalog-Id", ""))
                        # Keep implicit API callers from splitting a
                        # parallel empty-catalog upload across IDs. This
                        # lock only verifies that the browser is still
                        # importing into its already-open project;
                        # decoding and file copy below retain their
                        # parallelism.  A request header never opens or
                        # changes a project.
                        with STATE.import_lock:
                            if requested_catalog and STATE.catalog_id != requested_catalog:
                                raise ClientError("画像追加中にフォルダを切り替えることはできません。", "operation_in_progress")
                        import_args = {
                            "name": name, "relative_path": relative_path, "client_key": client_key,
                            "include_images": False, "transfer_active": True,
                            "import_session_id": import_session_id,
                            "import_project_id": expected_project_id,
                            "import_catalog_generation": expected_catalog_generation,
                            "source_identity": source_identity or None,
                            "source_kind": source_kind,
                            "intent": import_intent,
                            "mtime_ns": mtime_ns,
                            "size_bytes": size_bytes,
                        }
                        _images, imported = STATE.import_image_file_for_api(staged_path, **import_args)
                        STATE.cleanup_browser_save_files()
                    finally:
                        if staged_path is not None:
                            staged_path.unlink(missing_ok=True)
                    response = {"imported": imported, "catalogId": STATE.catalog_id,
                                "catalogGeneration": STATE.catalog_snapshot()["catalogGeneration"]}
                    succeeded = True
                finally:
                    STATE.end_import_transfer(import_session_id, succeeded=succeeded)
                self._json(response)
                _log_operation_finished(operation, operation_started_at)
                return
            manual_parts = path.split("/")
            if len(manual_parts) == 8 and manual_parts[1:4] == ["api", "workspace", "manual"] and manual_parts[5] == "layer":
                image_id, session_id, layer = manual_parts[4], manual_parts[6], manual_parts[7]
                self._require_binary_import_request()
                content_length = self._request_body_length(required=True)
                try:
                    expected_project_id, expected_catalog_generation = self._catalog_expectation()
                    target = self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                    lambda: STATE.manual_upload_layer_path(image_id, session_id, layer))
                except ClientError as exc:
                    self._reject_unread_request(exc)
                try:
                    self._read_binary_body_to_path(target, content_length)
                    self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                           lambda: STATE.finish_manual_upload_layer(image_id, session_id, layer, content_length))
                except Exception:
                    STATE.abort_manual_upload_layer(image_id, session_id, layer)
                    raise
                self._json({"ok": True})
                _log_operation_finished(operation, operation_started_at)
                return
            self._require_json_request()
            payload = self._read_json_body()
            expected_project_id, expected_catalog_generation = self._catalog_expectation(payload)
            if operation is not None and (details := _operation_log_details(path, payload)):
                LOGGER.info("操作対象: %s [%s]%s", operation[0], operation[1], details)
            if path == "/api/import/start":
                self._json(STATE.start_import_session(str(payload.get("sessionId", "")), expected_project_id,
                                                      expected_catalog_generation))
            elif path == "/api/import/finish":
                completed = payload.get("completed", 0)
                if isinstance(completed, bool) or not isinstance(completed, int) or completed < 0:
                    raise ClientError("画像追加の完了件数が正しくありません。", "input_invalid")
                if any(not isinstance(payload.get(name, False), bool) for name in ("failed", "cancelled")):
                    raise ClientError("画像追加の完了状態が正しくありません。", "input_invalid")
                self._json(STATE.finish_import_session(str(payload.get("sessionId", "")), expected_project_id,
                                                        expected_catalog_generation, {
                                                            "completed": completed,
                                                            "failed": bool(payload.get("failed", False)),
                                                            "cancelled": bool(payload.get("cancelled", False)),
                                                        }))
            elif path == "/api/folder":
                _result, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.set_root(str(payload.get("path", "")), expected_project_id=expected_project_id,
                                           expected_catalog_generation=expected_catalog_generation)
                )
                with STATE.lock:
                    scan_failures = [dict(failure) for failure in STATE.last_folder_scan_failures]
                self._json({**snapshot, "importFailures": scan_failures})
            elif path == "/api/projects":
                project, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.create_project(payload.get("name"), expected_project_id=expected_project_id,
                                                 expected_catalog_generation=expected_catalog_generation)
                )
                self._json({"project": project, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path == "/api/project/name":
                project, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.name_current_project(str(payload.get("name", "")), str(payload.get("projectId", "")),
                                                       expected_project_id=expected_project_id,
                                                       expected_catalog_generation=expected_catalog_generation)
                )
                self._json({"project": project, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path == "/api/project/complete":
                project, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.complete_project(expected_project_id=expected_project_id,
                                                   expected_catalog_generation=expected_catalog_generation)
                )
                self._json({"project": project, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path == "/api/project/close":
                _result, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.close_project(expected_project_id=expected_project_id,
                                                expected_catalog_generation=expected_catalog_generation)
                )
                self._json({"ok": True, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path == "/api/project/open":
                data, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.open_project(str(payload.get("projectId", "")), expected_project_id=expected_project_id,
                                              expected_catalog_generation=expected_catalog_generation,
                                              resume=bool(payload.get("resume")))
                )
                self._json({**data, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path == "/api/project/resume":
                project, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.resume_project(str(payload.get("projectId", "")), expected_project_id=expected_project_id,
                                               expected_catalog_generation=expected_catalog_generation)
                )
                self._json({"project": project, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path == "/api/project/mismatches":
                ids = payload.get("imageIds", [])
                if not isinstance(ids, list):
                    raise ClientError("画像IDの一覧が正しくありません。", "input_invalid")
                _result, snapshot = self._catalog_transition_snapshot(
                    lambda: self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.resolve_source_mismatches(ids, bool(payload.get("clearMasks"))))
                )
                self._json(snapshot)
            elif path == "/api/project/source-check":
                self._json({"projects": STATE.projects_for_source_root(str(payload.get("path", "")))})
            elif path == "/api/project/source/relink":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.relink_project_native_source(
                    str(payload.get("projectId", "")), str(payload.get("sourceId", "")), str(payload.get("path", "")),
                )))
            elif path.startswith("/api/project/history/"):
                image_id, action = _route_ids(path, "/api/project/history/")
                if action not in {"undo", "redo"}:
                    raise ClientError("履歴の操作が正しくありません。", "input_invalid")
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.restore_project_history(image_id, action)))
            elif path == "/api/catalog/clear":
                generation = self._catalog_mutation(expected_project_id, expected_catalog_generation, STATE.clear_catalog)
                self._json({"images": [], "catalogGeneration": generation})
            elif path.startswith("/api/workspace/image/"):
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.set_image_flags(path.removeprefix("/api/workspace/image/"), payload)))
            elif path == "/api/workspace/images":
                self._json({"flags": self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                              lambda: STATE.set_image_flags_bulk(payload))})
            elif path.startswith("/api/workspace/manual/") and path.endswith("/begin"):
                image_id = path.removeprefix("/api/workspace/manual/").removesuffix("/begin").rstrip("/")
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.begin_manual_upload(image_id, str(payload.get("sessionId", "")), payload.get("dirtyLayers"))))
            elif path.startswith("/api/workspace/manual/") and path.endswith("/commit"):
                image_id = path.removeprefix("/api/workspace/manual/").removesuffix("/commit").rstrip("/")
                self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                       lambda: STATE.commit_manual_upload(image_id, str(payload.get("sessionId", "")), payload))
                self._json({"ok": True})
            elif path.startswith("/api/workspace/manual/") and path.endswith("/cancel"):
                image_id = path.removeprefix("/api/workspace/manual/").removesuffix("/cancel").rstrip("/")
                self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                       lambda: STATE.cancel_manual_upload(image_id, str(payload.get("sessionId", ""))))
                self._json({"ok": True})
            elif path.startswith("/api/workspace/manual/"):
                self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                       lambda: STATE.save_manual_workspace(path.removeprefix("/api/workspace/manual/"), payload))
                self._json({"ok": True})
            elif path.startswith("/api/images/") and path.endswith("/transform"):
                image_id = path.removeprefix("/api/images/").removesuffix("/transform").rstrip("/")
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.set_image_transform(image_id, payload)))
            elif path == "/api/catalog/remove":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.remove_images_from_catalog(payload.get("imageIds", []))))
            elif path == "/api/catalog/delete-source/prepare":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.prepare_source_delete(payload)))
            elif path == "/api/catalog/delete-source/claim":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.claim_source_delete(str(payload.get("deleteToken", "")))))
            elif path == "/api/catalog/delete-source/release":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.release_source_delete_claim(str(payload.get("deleteToken", "")))))
            elif path == "/api/catalog/delete-source":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.delete_images_with_sources(payload)))
            elif path == "/api/catalog/delete-source/status":
                self._json(STATE.source_delete_status(str(payload.get("deleteToken", ""))))
            elif path == "/api/catalog/delete-source/cancel":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.cancel_source_delete(str(payload.get("deleteToken", "")))))
            elif path == "/api/catalog/delete-source/ack":
                self._json(STATE.acknowledge_source_delete(str(payload.get("deleteToken", ""))))
            elif path == "/api/masks/clear":
                self._json({"cleared": self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                                lambda: STATE.clear_masks(payload.get("imageIds", [])))})
            elif path == "/api/detect":
                detect_args = (
                    payload.get("imageIds", []),
                    read_detection_confidence(payload.get("confidence", STATE.settings["detection"]["threshold"])),
                    _read_detection_parallelism(payload.get("parallelism", STATE.settings["detection"]["parallelism"])),
                )
                fluid_color_fill = _read_fluid_color_fill_options(payload, STATE.settings)
                if "targetClasses" in payload:
                    self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                           lambda: STATE.start_detection(
                                               *detect_args,
                                               _read_target_classes(payload["targetClasses"]),
                                               fluid_color_fill=fluid_color_fill,
                                           ))
                else:
                    self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                           lambda: STATE.start_detection(*detect_args, fluid_color_fill=fluid_color_fill))
                self._json({"ok": True})
            elif path == "/api/candidates/batch":
                image_id = str(payload.get("imageId", ""))
                image_ids = payload.get("imageIds")
                if image_ids is not None:
                    if not isinstance(image_ids, list):
                        raise ClientError("画像IDの一覧が正しくありません。", "input_invalid")
                    revisions = self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                       lambda: STATE.batch_update_candidates_many(image_ids, payload))
                    self._json({"ok": True, "candidateRevisions": revisions})
                else:
                    revision = self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                      lambda: STATE.batch_update_candidates(image_id, payload))
                    self._json({"ok": True, "candidateRevision": revision})
            elif path == "/api/settings":
                settings = STATE.update_settings(payload)
                response = {"settings": settings, "version": _local_version()}
                if parse_qs(parsed.query).get("status", ["1"])[0] != "0":
                    response["status"] = STATE.settings_status()
                self._json(response)
            elif path == "/api/settings/status":
                self._json({"status": STATE.preview_settings_status(payload)})
            elif path == "/api/settings/gpu-diagnostic":
                self._json({"ok": True, "providers": list(STATE.diagnose_gpu_runtime())})
            elif path == "/api/settings/reset":
                settings = STATE.reset_settings()
                response = {"settings": settings, "version": _local_version()}
                if parse_qs(parsed.query).get("status", ["1"])[0] != "0":
                    response["status"] = STATE.settings_status()
                self._json(response)
            elif path == "/api/model-file/pick":
                selected = _pick_model_file(str(payload.get("modelKey", "")), current_path=str(payload.get("currentPath", "")))
                self._json({"path": selected} if selected else {"cancelled": True})
            elif path == "/api/output-directory/pick":
                selected = _pick_output_directory(current_path=str(payload.get("currentPath", "")))
                if selected is None:
                    self._json({"cancelled": True})
                else:
                    settings = STATE.update_settings({"saving": {"default_output_directory": selected}})
                    self._json({"settings": settings, "path": settings["saving"]["default_output_directory"]})
            elif path == "/api/model-download/start":
                try:
                    self._json(STATE.model_downloads.start(str(payload.get("modelKey", "")), str(payload.get("samType", ""))))
                except ModelDownloadInProgress as exc:
                    raise ClientError("", "operation_in_progress") from exc
                except ModelDownloadError as exc:
                    raise ClientError("", "model_download_invalid") from exc
            elif path == "/api/model-download/cancel":
                self._json(STATE.model_downloads.cancel())
            elif path == "/api/update/start":
                if STATE.model_downloads.snapshot().get("state") in {"running", "cancelling"}:
                    raise ClientError("", "operation_in_progress")
                if not _reserve_update_start():
                    raise ClientError("更新を開始しています。完了するまでお待ちください。", "operation_in_progress")
                self._json({"ok": True})
                threading.Thread(target=_start_update_after_response, args=(self.server,), daemon=True).start()
            elif path == "/api/boundary":
                image_id = str(payload.get("imageId", ""))
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.add_boundary_candidate(image_id, payload)))
            elif path == "/api/save/prepare":
                entries = self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.prepare_browser_save(
                    payload.get("imageIds", []),
                    _read_mosaic_divisor(payload.get("divisor")),
                    str(payload.get("suffix", "_censored")),
                    _read_bool(payload.get("deleteOriginal", False), "元画像削除"),
                ))
                self._json({"entries": entries})
            elif path == "/api/save/reserve":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.reserve_browser_save(
                    str(payload.get("imageId", "")), _read_candidate_revision(payload.get("candidateRevision")),
                    _read_client_save_token(payload.get("clientSaveToken")),
                    copy_to_default=_read_bool(payload.get("copyToDefault", False), "既定の保存先へコピー"),
                    suffix=_read_save_suffix(payload.get("suffix", "_censored")),
                    output_format=str(payload.get("format", "original")),
                    keep_metadata=_read_bool(payload.get("keepMetadata", True), "メタ情報の保持"),
                )))
            elif path == "/api/save/render":
                copy_to_default = _read_bool(payload.get("copyToDefault", False), "既定の保存先へコピー")
                copy_to_browser = _read_bool(payload.get("copyToBrowser", False), "ブラウザ保存")
                if copy_to_browser:
                    raise ClientError("コピー保存は選択済みの保存先へ実行してください。", "input_invalid")
                rendered = self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.render_browser_save(
                    str(payload.get("imageId", "")),
                    _read_candidate_revision(payload.get("candidateRevision")),
                    _read_mosaic_divisor(payload.get("divisor")),
                    payload.get("draft"),
                    copy_to_default=copy_to_default,
                    copy_to_browser=copy_to_browser,
                    client_save_token=_read_client_save_token(payload.get("clientSaveToken")),
                    suffix=_read_save_suffix(payload.get("suffix", "_censored")),
                    output_format=str(payload.get("format", "original")),
                    keep_metadata=_read_bool(payload.get("keepMetadata", True), "メタ情報の保持"),
                ))
                revision, save_token = rendered.candidate_revision, rendered.save_token
                if copy_to_default:
                    self._binary(
                        b"", "application/octet-stream",
                        headers={
                            "X-Mozarie-Revision": str(revision),
                            "X-Mozarie-Save-Token": save_token,
                            "X-Mozarie-Output-Path-B64": base64.urlsafe_b64encode(str(rendered.output_path).encode("utf-8")).decode("ascii"),
                            "X-Mozarie-No-Effect": "1" if rendered.no_effect else "0",
                        },
                    )
                else:
                    assert rendered.response_path is not None
                    try:
                        self._stream_path(rendered.response_path, rendered.mime_type, {
                            "X-Mozarie-Revision": str(revision),
                            "X-Mozarie-Save-Token": save_token,
                            "X-Mozarie-No-Effect": "1" if rendered.no_effect else "0",
                        })
                    finally:
                        if rendered.response_path_is_temporary:
                            rendered.response_path.unlink(missing_ok=True)
            elif path == "/api/save/commit":
                source_mtime_ms = payload.get("sourceMtimeMs")
                source_size_bytes = payload.get("sourceSizeBytes")
                if source_mtime_ms is not None and (not isinstance(source_mtime_ms, int) or isinstance(source_mtime_ms, bool) or source_mtime_ms < 0):
                    raise ClientError("保存後の元画像情報が正しくありません。", "input_invalid")
                if source_size_bytes is not None and (not isinstance(source_size_bytes, int) or isinstance(source_size_bytes, bool) or source_size_bytes < 0):
                    raise ClientError("保存後の元画像情報が正しくありません。", "input_invalid")
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.commit_browser_save(
                    str(payload.get("imageId", "")),
                    _read_candidate_revision(payload.get("candidateRevision")),
                    payload.get("saveToken"),
                    payload.get("sourceAction"),
                    source_mtime_ns=source_mtime_ms * 1_000_000 if source_mtime_ms is not None else None,
                    source_size_bytes=source_size_bytes,
                )))
            elif path == "/api/save/status":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.browser_save_status(
                    str(payload.get("imageId", "")), _read_candidate_revision(payload.get("candidateRevision")),
                    str(payload.get("saveToken", "")), str(payload.get("sourceAction", "")),
                )))
            elif path == "/api/save/ack":
                self._json(STATE.acknowledge_browser_save(str(payload.get("saveToken", ""))))
            elif path == "/api/save/cancel":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.cancel_browser_save(
                    str(payload.get("imageId", "")), _read_candidate_revision(payload.get("candidateRevision")),
                    str(payload.get("saveToken", "")),
                )))
            elif path == "/api/apply":
                divisor = _read_mosaic_divisor(payload.get("divisor"))
                started = self._catalog_mutation(expected_project_id, expected_catalog_generation, lambda: STATE.start_apply(
                    payload.get("imageIds", []), divisor, payload.get("drafts", {}),
                    _read_bool(payload.get("copyToDefault", False), "既定の保存先へコピー"),
                    _read_save_suffix(payload.get("suffix", "_censored")),
                    str(payload.get("format", "original")),
                    _read_bool(payload.get("keepMetadata", True), "メタ情報の保持"),
                ))
                self._json({"ok": started, "cancelled": not started})
            elif path == "/api/job/pause":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   STATE.request_pause))
            elif path == "/api/job/resume":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   STATE.resume_job))
            elif path == "/api/job/cancel":
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   STATE.request_cancel))
            elif path.startswith("/api/candidate/"):
                image_id, candidate_id = _route_ids(path, "/api/candidate/")
                revision = self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                  lambda: STATE.set_candidate_state(image_id, candidate_id, payload))
                self._json({"ok": True, "candidateRevision": revision})
            else:
                self._client_error(ClientError("APIが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
            _log_operation_finished(operation, operation_started_at)
        except ForbiddenClientError as exc:
            _log_operation_failed(operation, operation_started_at, HTTPStatus.FORBIDDEN, exc)
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            status = HTTPStatus.CONFLICT if exc.error_code == "stale_catalog" else HTTPStatus.BAD_REQUEST
            _log_operation_failed(operation, operation_started_at, status, exc)
            self._client_error(exc, status)
        except Exception as exc:
            # Recovery can fail while no state exists.  It is not a GPU error,
            # and must still return the normal structured server error.
            if STATE is not None and (gpu_oom := STATE.recover_gpu_oom_for_request(exc)) is not None:
                LOGGER.error("POST リクエストでGPUメモリが不足: %s", self.path)
                _log_operation_failed(operation, operation_started_at, HTTPStatus.BAD_REQUEST, gpu_oom)
                self._client_error(gpu_oom, HTTPStatus.BAD_REQUEST)
                return
            _log_operation_failed(operation, operation_started_at, HTTPStatus.INTERNAL_SERVER_ERROR, exc)
            LOGGER.exception("POST リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def do_DELETE(self) -> None:  # noqa: N802
        operation: tuple[str, str] | None = None
        operation_started_at: float | None = None
        try:
            path = unquote(urlparse(self.path).path)
            operation = _operation_log_spec("DELETE", path)
            operation_started_at = _log_operation_started(operation, path, {})
            content_length = self._request_body_length()
            if STATE is None:
                self._require_local_host()
                self.close_connection = True
                if _is_api_path(path):
                    error = ClientError("作業データを作り直してから操作してください。", "workspace_recreate_required")
                    _log_operation_failed(operation, operation_started_at, HTTPStatus.CONFLICT, error)
                    self._workspace_recreate_required()
                else:
                    self._client_error(ClientError("ページが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
                return
            self._require_mutation_request()
            payload: dict[str, Any] | None = None
            if content_length:
                self._require_json_request()
                payload = self._read_json_body(content_length)
            expected_project_id, expected_catalog_generation = self._catalog_expectation(payload)
            if path.startswith("/api/catalog/image/"):
                image_id = path.removeprefix("/api/catalog/image/")
                self._json(self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                   lambda: STATE.remove_image_from_catalog(image_id)))
            elif path.startswith("/api/project/"):
                project_id = path.removeprefix("/api/project/")
                if not project_id or "/" in project_id:
                    raise ClientError("プロジェクトが見つかりません。", "project_not_found")
                _result, snapshot = self._catalog_transition_snapshot(
                    lambda: STATE.delete_project(project_id, expected_project_id=expected_project_id,
                                                 expected_catalog_generation=expected_catalog_generation)
                )
                self._json({"deleted": True, "catalogGeneration": snapshot["catalogGeneration"]})
            elif path.startswith("/api/candidate/"):
                image_id, candidate_id = _route_ids(path, "/api/candidate/")
                deleted = self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                                  lambda: STATE.delete_candidate(image_id, candidate_id))
                self._json({"deleted": deleted, "candidateRevision": STATE._candidate_revision(image_id)})
            elif path.startswith("/api/workspace/manual/"):
                self._catalog_mutation(expected_project_id, expected_catalog_generation,
                                       lambda: STATE.delete_manual_workspace(path.removeprefix("/api/workspace/manual/")))
                self._json({"ok": True})
            else:
                self._client_error(ClientError("APIが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
            _log_operation_finished(operation, operation_started_at)
        except ForbiddenClientError as exc:
            _log_operation_failed(operation, operation_started_at, HTTPStatus.FORBIDDEN, exc)
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            status = HTTPStatus.CONFLICT if exc.error_code == "stale_catalog" else HTTPStatus.BAD_REQUEST
            _log_operation_failed(operation, operation_started_at, status, exc)
            self._client_error(exc, status)
        except Exception as exc:
            if STATE is not None and (gpu_oom := STATE.recover_gpu_oom_for_request(exc)) is not None:
                LOGGER.error("DELETE リクエストでGPUメモリが不足: %s", self.path)
                _log_operation_failed(operation, operation_started_at, HTTPStatus.BAD_REQUEST, gpu_oom)
                self._client_error(gpu_oom, HTTPStatus.BAD_REQUEST)
                return
            _log_operation_failed(operation, operation_started_at, HTTPStatus.INTERNAL_SERVER_ERROR, exc)
            LOGGER.exception("DELETE リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def _read_json_body(self, content_length: int | None = None) -> dict[str, Any]:
        if content_length is None:
            content_length = self._request_body_length(required=True)
        try:
            remaining = content_length
            # JSON operations are normally small, but keep framing safe even
            # when a catalogue has a long image list.  Large mask PNGs use the
            # binary transaction route and never pass through this parser.
            with tempfile.SpooledTemporaryFile(max_size=IO_CHUNK_BYTES, mode="w+b") as staged:
                while remaining:
                    chunk = self.rfile.read(min(IO_CHUNK_BYTES, remaining))
                    if not chunk:
                        self._reject_unread_request(ClientError("リクエストを最後まで読み込めません。", "input_invalid"))
                    staged.write(chunk)
                    remaining -= len(chunk)
                staged.seek(0)
                text = io.TextIOWrapper(staged, encoding="utf-8")
                try:
                    payload = json.load(text)
                finally:
                    text.detach()
        except ClientError:
            raise
        except (UnicodeDecodeError, ValueError) as exc:
            raise ClientError("JSONを読み込めません。", "input_invalid") from exc
        if not isinstance(payload, dict):
            raise ClientError("JSONオブジェクトが必要です。", "input_invalid")
        return payload

    def _read_binary_body_to_file(self, content_length: int | None = None) -> Path:
        if content_length is None:
            content_length = self._request_body_length(required=True)
        # Browser bytes belong with their final session import, not the
        # disposable render-cache volume.  This also keeps the upload and its
        # inspected image on one filesystem.
        temporary_path: Path | None = None
        remaining = content_length
        try:
            staging_dir = STATE._ensure_session()
            with tempfile.NamedTemporaryFile(dir=staging_dir, suffix=".upload.tmp", delete=False) as handle:
                temporary_path = Path(handle.name)
                while remaining:
                    chunk = self.rfile.read(min(IO_CHUNK_BYTES, remaining))
                    if not chunk:
                        self._reject_unread_request(ClientError("画像データを最後まで読み込めません。", "image_read_failed"))
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
            result = temporary_path
            temporary_path = None
            return result
        except Exception:
            self.close_connection = True
            raise
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def _read_binary_body_to_path(self, target: Path, content_length: int) -> None:
        """Stream one framed binary body to its private transaction directory."""
        temporary_path: Path | None = None
        remaining = content_length
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".upload.tmp", delete=False) as handle:
                temporary_path = Path(handle.name)
                while remaining:
                    chunk = self.rfile.read(min(IO_CHUNK_BYTES, remaining))
                    if not chunk:
                        self._reject_unread_request(ClientError("手描きマスクを最後まで読み込めません。", "image_read_failed"))
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
            temporary_path.replace(target)
            temporary_path = None
        except Exception:
            self.close_connection = True
            raise
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def _send_image(self, image_id: str, thumbnail: bool, version: str | None) -> None:
        with STATE.image_io_lock(image_id):
            record = STATE.image_snapshot(image_id)
            STATE._assert_record_stat_matches(record)
            asset_version = STATE.asset_version(record)
            if version is not None and version != asset_version:
                raise ClientError("画像は更新されています。もう一度読み込んでください。", "stale_asset")
            cache_control = "private, max-age=31536000, immutable" if version == asset_version else "no-store"
            if not thumbnail:
                try:
                    with record.path.open("rb") as handle:
                        self._stream_file(handle, record, mimetypes.guess_type(record.path.name)[0] or "application/octet-stream", cache_control)
                except FileNotFoundError as exc:
                    raise ClientError("画像ファイルが見つかりません。", "image_not_found") from exc
                return

            thumbnail_dir = STATE.cache_dir / "thumbnails"
            thumbnail_dir.mkdir(parents=True, exist_ok=True)
            thumbnail_path = thumbnail_dir / f"{record.image_id}-{asset_version}.jpg"
            # A visible thumbnail is single-flight by asset.  Unrelated visible
            # requests are not held behind a fixed process-wide worker count.
            if not thumbnail_path.is_file():
                with STATE.lock:
                    current = STATE.images.get(image_id)
                    if current is None or STATE.asset_version(current) != asset_version:
                        raise ClientError("画像は更新されています。もう一度読み込んでください。", "stale_asset")
                temporary_path: Path | None = None
                try:
                    with open_image_without_png_text(record.path) as image:
                        image = ImageOps.exif_transpose(image)
                        if record.flip_horizontal != record.source_flip_horizontal:
                            image = ImageOps.mirror(image)
                        if record.flip_vertical != record.source_flip_vertical:
                            image = ImageOps.flip(image)
                        image.thumbnail((280, 280), Image.Resampling.LANCZOS)
                        output = io.BytesIO()
                        image.convert("RGB").save(output, format="JPEG", quality=82)
                    with tempfile.NamedTemporaryFile(dir=thumbnail_dir, suffix=".thumbnail.tmp", delete=False) as handle:
                        temporary_path = Path(handle.name)
                        handle.write(output.getvalue())
                        handle.flush()
                    with STATE.lock:
                        current = STATE.images.get(image_id)
                        if current is None or STATE.asset_version(current) != asset_version:
                            raise ClientError("画像は更新されています。もう一度読み込んでください。", "stale_asset")
                    os.replace(temporary_path, thumbnail_path)
                    temporary_path = None
                except ClientError:
                    raise
                except IMAGE_DECODE_ERRORS as exc:
                    raise ClientError("サムネイルを作成できませんでした。画像ファイルと使用可能なメモリを確認してください。", "image_read_failed") from exc
                finally:
                    if temporary_path is not None:
                        temporary_path.unlink(missing_ok=True)
            try:
                with thumbnail_path.open("rb") as handle:
                    self._stream_file(handle, None, "image/jpeg", cache_control)
            except FileNotFoundError as exc:
                raise ClientError("サムネイルを作成できませんでした。", "image_read_failed") from exc

    def _send_candidate_mask(self, image_id: str, candidate_id: str, version: str | None) -> None:
        with STATE.lock:
            if image_id not in STATE.images:
                raise StaleMaskError("検出候補は既に更新されています。")
            revision = STATE._candidate_revision(image_id)
        mask_version = f"{revision}-{candidate_id}"
        if version is not None and version != mask_version:
            raise StaleMaskError("検出候補は既に更新されています。")
        cache_control = "private, max-age=31536000, immutable" if version == mask_version else "no-store"
        self._binary(
            STATE.read_candidate_mask_png(image_id, candidate_id, expected_revision=revision),
            "image/png",
            cache_control=cache_control,
        )

    def _send_static(self, path: str) -> None:
        requested = "index.html" if path in {"", "/"} else path.lstrip("/")
        file_path = (STATIC_DIR / requested).resolve()
        try:
            file_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self._json({"error_code": "api_not_found", "params": {}}, HTTPStatus.NOT_FOUND)
            return
        if not file_path.is_file():
            self._json({"error_code": "api_not_found", "params": {}}, HTTPStatus.NOT_FOUND)
            return
        data = file_path.read_bytes()
        if file_path.name == "index.html":
            data = data.replace(b"{{SESSION_TOKEN}}", STATE.session_token.encode("ascii"))
        self._binary(data, mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")

    def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._binary(json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def _client_error(self, error: Exception, status: HTTPStatus, default_code: str | None = None) -> None:
        if isinstance(error, ClientError):
            code, params = error.error_code, error.params
        elif isinstance(error, StaleMaskError):
            code, params = default_code or "mask_not_found", {}
        elif isinstance(error, sqlite3.DatabaseError):
            code, params = "workspace_database_error", {}
        else:
            code, params = default_code or "request_failed", {}
        self._json({"error_code": code, "params": public_error_params(code, params)}, status)

    def _binary(
        self,
        data: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        cache_control: str = "no-store",
        headers: dict[str, str] | None = None,
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache_control)
            self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            if self.close_connection:
                self.send_header("Connection", "close")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True
            return

    def _stream_path(self, path: Path, content_type: str, headers: dict[str, str]) -> None:
        with path.open("rb") as source:
            stat = os.fstat(source.fileno())
            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(stat.st_size))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("X-Content-Type-Options", "nosniff")
                for key, value in headers.items(): self.send_header(key, value)
                self.end_headers()
                while chunk := source.read(IO_CHUNK_BYTES): self.wfile.write(chunk)
            except CLIENT_DISCONNECT_ERRORS:
                self.close_connection = True
                return

    def _stream_file(self, handle: BinaryIO, record: ImageRecord | None, content_type: str, cache_control: str) -> None:
        stat = os.fstat(handle.fileno())
        if record is not None and (stat.st_mtime_ns, stat.st_size) != record.asset_fingerprint():
            raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。", "stale_asset")
        size = stat.st_size
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", cache_control)
            self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True
            return
        while chunk := handle.read(IO_CHUNK_BYTES):
            try:
                self.wfile.write(chunk)
            except CLIENT_DISCONNECT_ERRORS:
                self.close_connection = True
                return

    def log_message(self, format: str, *args: Any) -> None:
        try:
            status = int(args[1])
        except (IndexError, TypeError, ValueError):
            LOGGER.warning("HTTP %s", format % args)
            return

        path = urlparse(self.path).path
        if status < 500:
            return
        LOGGER.warning("HTTP %s %s -> %d", self.command, path, status)


def _request_version(query: str) -> str | None:
    values = parse_qs(query, keep_blank_values=True).get("v")
    if values is None:
        return None
    if len(values) != 1 or not values[0]:
        raise ClientError("画像の版番号が不正です。", "stale_asset")
    return values[0]


def _route_ids(path: str, prefix: str) -> tuple[str, str]:
    """Read the two required opaque ids from a fixed API route."""
    try:
        image_id, candidate_id = path.removeprefix(prefix).split("/", 1)
    except ValueError as exc:
        raise ClientError("APIの指定が正しくありません。", "input_invalid") from exc
    if not image_id or not candidate_id or "/" in candidate_id:
        raise ClientError("APIの指定が正しくありません。", "input_invalid")
    return image_id, candidate_id


def _read_candidate_revision(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ClientError("候補の版番号が不正です。", "input_invalid")
    revision = value
    if revision < 0:
        raise ClientError("候補の版番号が不正です。", "input_invalid")
    return revision


def _read_bool(value: Any, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ClientError(f"{field_name}はONまたはOFFで指定してください。", "input_invalid")
    return value


def _read_client_save_token(value: Any) -> str:
    if not isinstance(value, str) or not _is_canonical_uuid(value):
        raise ClientError("保存確認トークンが正しくありません。", "input_invalid")
    return value


def _local_version() -> str:
    from updater import display_version, read_local_version
    return display_version(read_local_version())


def _update_status() -> dict[str, Any]:
    from updater import display_version, fetch_latest_release, parse_version
    current = _local_version()
    latest = display_version(fetch_latest_release()["tag_name"])
    return {"current": current, "latest": latest, "available": parse_version(latest) > parse_version(current)}


def _start_update_after_response(http_server: ThreadingHTTPServer) -> None:
    time.sleep(0.2)
    http_server.mozarie_update_requested = True
    http_server.shutdown()
