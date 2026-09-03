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
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import parse_qs, unquote, urlparse

from PIL import Image, ImageOps

from .core import (
    APP_DIR, IO_CHUNK_BYTES, LOGGER, MAX_BODY_BYTES, PNG_SIGNATURE, STATIC_DIR,
    ClientError, ForbiddenClientError, ImageRecord, StaleMaskError,
    read_detection_confidence, _read_detection_parallelism, _read_mosaic_divisor,
    _read_save_suffix, _read_target_classes, public_error_params,
)
from . import state as state_module
from .state import STATE, StudioState
from .image_io import _decode_mask, _valid_color, calculate_block_size, inference_device_name, parse_png_chunks
from .model_downloads import ModelDownloadError, ModelDownloadInProgress


CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
_update_start_lock = threading.Lock()
_update_start_requested = False


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


def health_device(provider: str, gpu_device: int, gpus: list[dict[str, object]]) -> dict[str, object]:
    """Format health device data without probing a GPU for a CPU selection."""
    if provider != "gpu":
        return {"provider": "cpu", "runtimeBackend": "cpu", "gpuDevice": None, "device": "CPU"}
    selected = next((gpu for gpu in gpus if gpu["id"] == gpu_device), None)
    name = str(selected["name"]) if selected else "unavailable"
    backend = str(selected.get("backend", "cuda")) if selected else "unavailable"
    return {"provider": "gpu", "runtimeBackend": backend, "gpuDevice": gpu_device, "gpuName": name, "device": f"GPU {gpu_device}: {name}"}


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
            completed = subprocess.run(
                [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded_script],
                stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=300, shell=False, env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ClientError(failed_message, "model_picker_failed") from exc
        if completed.returncode:
            raise ClientError(failed_message, "model_picker_failed")
        encoded = completed.stdout.strip()
        if not encoded:
            return None
        try:
            return base64.b64decode(encoded, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise ClientError("選択結果が正しくありません。", "model_picker_invalid") from exc
    finally:
        state.native_picker_lock.release()


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


class MosaicHandler(BaseHTTPRequestHandler):
    server_version = "Mozarie/1.0"
    protocol_version = "HTTP/1.1"

    def _reject_unread_request(self, error: ClientError) -> None:
        self.close_connection = True
        raise error

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
        self._binary('''<!doctype html><html lang="ja"><meta charset="utf-8"><title>Mozarie</title><main><h1 data-key="workspaceRecovery.title"></h1><p data-key="workspaceRecovery.message"></p><button id="recreate" data-key="workspaceRecovery.recreate"></button><p id="message" aria-live="polite"></p></main><script>(()=>{const lang=localStorage.getItem('mozarie-language')==='en'?'en':'ja';const button=document.querySelector('#recreate');const message=document.querySelector('#message');let translations;const text=key=>translations[key];fetch('/i18n/'+lang+'.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('translations unavailable');return r.json();}).then(data=>{translations=data;document.documentElement.lang=lang;document.querySelectorAll('[data-key]').forEach(element=>{element.textContent=text(element.dataset.key);});button.addEventListener('click',async()=>{if(button.disabled||!confirm(text('workspaceRecovery.confirm')))return;button.disabled=true;try{const response=await fetch('/api/workspace/recreate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(response.ok){location.reload();return;}message.textContent=text('workspaceRecovery.failed');}catch(_error){message.textContent=text('workspaceRecovery.failed');}button.disabled=false;});}).catch(()=>{message.textContent='';});})();</script></html>'''.encode("utf-8"), "text/html; charset=utf-8")

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

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._require_local_host()
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
                # The state contract always includes gpuDeviceValid.  Keeping
                # absent values neutral also lets a narrow test/status adapter
                # report model readiness without pretending its GPU is invalid.
                configured = bool(status.get("gpuDeviceValid", True)) and all(model["valid"] for model in status["models"].values() if model["required"] or model["enabled"])
                payload: dict[str, Any] = {
                    "ok": True,
                    "modelsConfigured": configured,
                }
                if provider == "gpu":
                    payload.update(health_device(provider, int(models.get("gpu_device", 0)), status["gpus"]))
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
            elif path.startswith("/api/project/history/"):
                self._json(STATE.project_history_status(path.removeprefix("/api/project/history/")))
            elif path == "/api/job":
                STATE.cleanup_expired_browser_save_tokens()
                with STATE.lock:
                    self._json(STATE.job.as_dict())
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
                kind = path.removeprefix("/api/project/masks/")
                if kind not in {"mosaic", "exclude"}:
                    raise ClientError("マスク種別が正しくありません。", "input_invalid")
                with tempfile.NamedTemporaryFile(prefix="mozarie-masks-", suffix=".zip", delete=False) as output:
                    archive_path = Path(output.name)
                try:
                    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                        for image, png in STATE.iter_project_mask_exports(kind):
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
            self._client_error(exc, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep tracebacks in the terminal, not in browser.
            if STATE is not None and (gpu_oom := STATE.recover_gpu_oom_for_request(exc)) is not None:
                LOGGER.error("GET リクエストでGPUメモリが不足: %s", self.path)
                self._client_error(gpu_oom, HTTPStatus.BAD_REQUEST)
                return
            LOGGER.exception("GET リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if STATE is None:
                if path == "/api/workspace/recreate":
                    self._require_recovery_request()
                    self._read_json_body()
                    restored = state_module.recreate_workspace()
                    globals()["STATE"] = restored
                    self._json({"ok": True})
                    return
                self._require_local_host()
                self.close_connection = True
                if _is_api_path(path):
                    # The unavailable-state route does not consume arbitrary
                    # request bodies.  Close this connection so a rejected
                    # JSON body cannot be parsed as a second HTTP request.
                    self._workspace_recreate_required()
                else:
                    self._client_error(ClientError("ページが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
                return
            if path == "/api/import/file":
                self._require_binary_import_request()
                name = unquote(self.headers.get("X-Mozarie-Name", ""))
                relative_path = unquote(self.headers.get("X-Mozarie-Relative-Path", ""))
                client_key = unquote(self.headers.get("X-Mozarie-Client-Key", ""))
                source_identity = unquote(self.headers.get("X-Mozarie-Source-Id", ""))
                source_kind = self.headers.get("X-Mozarie-Source-Kind", "browser-files")
                raw_mtime = self.headers.get("X-Mozarie-File-Mtime", "0")
                raw_size = self.headers.get("X-Mozarie-File-Size", "0")
                if (source_identity and (len(source_identity) > 128 or not source_identity.replace("-", "").isalnum())
                        or source_kind not in {"browser-files", "browser-directory"}
                        or not raw_mtime.isdigit() or not raw_size.isdigit()):
                    raise ClientError("画像の更新情報が正しくありません。", "input_invalid")
                try:
                    STATE.begin_import_transfer()
                except ClientError as exc:
                    self._reject_unread_request(exc)
                try:
                    with STATE.import_staging_gate:
                        staged_path = self._read_binary_body_to_file()
                        requested_catalog = unquote(self.headers.get("X-Mozarie-Catalog-Id", ""))
                        try:
                            # Keep implicit API callers from splitting a
                            # parallel empty-catalog upload across IDs. This
                            # lock covers identity selection only; decoding
                            # and file copy below retain their parallelism.
                            with STATE.import_lock:
                                if requested_catalog and STATE.catalog_id != requested_catalog:
                                    if STATE.catalog_id is not None:
                                        raise ClientError("画像追加中にフォルダを切り替えることはできません。", "operation_in_progress")
                                    STATE.activate_browser_catalog(requested_catalog)
                                elif not STATE.catalog_id:
                                    # Imports create explicit unnamed work.
                                    STATE.catalog_id = STATE.workspace_store.ensure_provisional_catalog()
                                    STATE.browser_catalog_provisional = True
                            import_args = {
                                "name": name, "relative_path": relative_path, "client_key": client_key,
                                "include_images": False, "transfer_active": True,
                                "source_identity": source_identity or None,
                                "source_kind": source_kind,
                                "mtime_ns": int(raw_mtime) * 1_000_000,
                                "size_bytes": int(raw_size),
                            }
                            _images, imported = STATE.import_image_file_for_api(staged_path, **import_args)
                        finally:
                            staged_path.unlink(missing_ok=True)
                    self._json({"imported": imported, "catalogId": STATE.catalog_id, "provisional": STATE.browser_catalog_provisional})
                finally:
                    STATE.end_import_transfer()
                return
            self._require_json_request()
            payload = self._read_json_body()
            if path == "/api/folder":
                images = STATE.set_root(str(payload.get("path", "")))
                self._json({"images": images, "workspace": True})
            elif path == "/api/projects":
                self._json({"project": STATE.create_project(payload.get("name"))})
            elif path == "/api/project/name":
                self._json({"project": STATE.name_current_project(str(payload.get("name", "")))})
            elif path == "/api/project/complete":
                self._json({"project": STATE.complete_project()})
            elif path == "/api/project/close":
                STATE.close_project(); self._json({"ok": True})
            elif path == "/api/project/open":
                self._json(STATE.open_project(str(payload.get("projectId", ""))))
            elif path == "/api/project/resume":
                self._json({"project": STATE.resume_project(str(payload.get("projectId", "")))})
            elif path == "/api/project/mismatches":
                ids = payload.get("imageIds", [])
                if not isinstance(ids, list):
                    raise ClientError("画像IDの一覧が正しくありません。", "input_invalid")
                STATE.resolve_source_mismatches(ids, bool(payload.get("clearMasks")))
                self._json(STATE.catalog_snapshot())
            elif path == "/api/project/source-check":
                self._json({"projects": STATE.projects_for_source_root(str(payload.get("path", "")))})
            elif path.startswith("/api/project/history/"):
                image_id, action = _route_ids(path, "/api/project/history/")
                if action not in {"undo", "redo"}:
                    raise ClientError("履歴の操作が正しくありません。", "input_invalid")
                self._json(STATE.restore_project_history(image_id, action))
            elif path == "/api/workspace/catalog":
                if payload.get("provisional") is True:
                    if payload.get("catalogId"):
                        raise ClientError("仮カタログにIDは指定できません。", "input_invalid")
                    STATE.detach_catalog()
                    catalog_id = STATE.workspace_store.ensure_provisional_catalog()
                    STATE.catalog_id = catalog_id
                    STATE.browser_catalog_provisional = True
                    self._json({"catalogId": catalog_id, "provisional": True})
                else:
                    self._json({"catalogId": STATE.activate_browser_catalog(payload.get("catalogId")), "provisional": False})
            elif path == "/api/workspace/catalog/finalize":
                catalog_id, image_ids = STATE.finalize_browser_catalog()
                self._json({"catalogId": catalog_id, "imageIds": image_ids, "images": STATE.list_images(), "workspace": bool(catalog_id)})
            elif path == "/api/catalog/clear":
                STATE.clear_catalog()
                self._json({"images": []})
            elif path.startswith("/api/workspace/image/"):
                self._json(STATE.set_image_flags(path.removeprefix("/api/workspace/image/"), payload))
            elif path.startswith("/api/workspace/manual/"):
                STATE.save_manual_workspace(path.removeprefix("/api/workspace/manual/"), payload)
                self._json({"ok": True})
            elif path == "/api/catalog/remove":
                self._json(STATE.remove_images_from_catalog(payload.get("imageIds", [])))
            elif path == "/api/masks/clear":
                self._json({"cleared": STATE.clear_masks(payload.get("imageIds", []))})
            elif path == "/api/detect":
                detect_args = (
                    payload.get("imageIds", []),
                    read_detection_confidence(payload.get("confidence", STATE.settings["detection"]["threshold"])),
                    _read_detection_parallelism(payload.get("parallelism", STATE.settings["detection"]["parallelism"])),
                )
                if "targetClasses" in payload:
                    STATE.start_detection(*detect_args, _read_target_classes(payload["targetClasses"]))
                else:
                    STATE.start_detection(*detect_args)
                self._json({"ok": True})
            elif path == "/api/candidates/batch":
                image_id = str(payload.get("imageId", ""))
                image_ids = payload.get("imageIds")
                if image_ids is not None:
                    if not isinstance(image_ids, list):
                        raise ClientError("画像IDの一覧が正しくありません。", "input_invalid")
                    revisions = STATE.batch_update_candidates_many(image_ids, payload)
                    self._json({"ok": True, "candidateRevisions": revisions})
                else:
                    revision = STATE.batch_update_candidates(image_id, payload)
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
                self._json(STATE.add_boundary_candidate(image_id, payload))
            elif path == "/api/save/prepare":
                entries = STATE.prepare_browser_save(
                    payload.get("imageIds", []),
                    _read_mosaic_divisor(payload.get("divisor")),
                    str(payload.get("suffix", "_censored")),
                    _read_bool(payload.get("deleteOriginal", False), "元画像削除"),
                )
                self._json({"entries": entries})
            elif path == "/api/save/render":
                copy_to_default = _read_bool(payload.get("copyToDefault", False), "既定の保存先へコピー")
                copy_to_browser = _read_bool(payload.get("copyToBrowser", False), "ブラウザ保存")
                rendered = STATE.render_browser_save(
                    str(payload.get("imageId", "")),
                    _read_candidate_revision(payload.get("candidateRevision")),
                    _read_mosaic_divisor(payload.get("divisor")),
                    payload.get("draft"),
                    copy_to_default=copy_to_default,
                    copy_to_browser=copy_to_browser,
                    suffix=_read_save_suffix(payload.get("suffix", "_censored")),
                )
                output, record, revision, save_token = rendered
                if copy_to_default:
                    self._json({"output": str(rendered.output_path), "candidateRevision": revision, "saveToken": save_token})
                else:
                    self._binary(
                        output,
                        mimetypes.guess_type(record.path.name)[0] or "application/octet-stream",
                        headers={
                            "X-Mozarie-Revision": str(revision),
                            "X-Mozarie-Save-Token": save_token,
                        },
                    )
            elif path == "/api/save/commit":
                self._json(STATE.commit_browser_save(
                    str(payload.get("imageId", "")),
                    _read_candidate_revision(payload.get("candidateRevision")),
                    payload.get("saveToken"),
                    payload.get("sourceAction"),
                ))
            elif path == "/api/save/status":
                self._json(STATE.browser_save_status(
                    str(payload.get("imageId", "")), _read_candidate_revision(payload.get("candidateRevision")),
                    str(payload.get("saveToken", "")), str(payload.get("sourceAction", "")),
                ))
            elif path == "/api/save/cancel":
                self._json(STATE.cancel_browser_save(
                    str(payload.get("imageId", "")), _read_candidate_revision(payload.get("candidateRevision")),
                    str(payload.get("saveToken", "")),
                ))
            elif path == "/api/apply":
                divisor = _read_mosaic_divisor(payload.get("divisor"))
                started = STATE.start_apply(
                    payload.get("imageIds", []), divisor, payload.get("drafts", {}),
                    _read_bool(payload.get("copyToDefault", False), "既定の保存先へコピー"),
                    _read_save_suffix(payload.get("suffix", "_censored")),
                )
                self._json({"ok": started, "cancelled": not started})
            elif path == "/api/job/pause":
                self._json(STATE.request_pause().as_dict())
            elif path == "/api/job/resume":
                self._json(STATE.resume_job().as_dict())
            elif path == "/api/job/cancel":
                self._json(STATE.request_cancel().as_dict())
            elif path.startswith("/api/candidate/"):
                image_id, candidate_id = _route_ids(path, "/api/candidate/")
                revision = STATE.set_candidate_state(image_id, candidate_id, payload)
                self._json({"ok": True, "candidateRevision": revision})
            else:
                self._client_error(ClientError("APIが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
        except ForbiddenClientError as exc:
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            self._client_error(exc, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            # Recovery can fail while no state exists.  It is not a GPU error,
            # and must still return the normal structured server error.
            if STATE is not None and (gpu_oom := STATE.recover_gpu_oom_for_request(exc)) is not None:
                LOGGER.error("POST リクエストでGPUメモリが不足: %s", self.path)
                self._client_error(gpu_oom, HTTPStatus.BAD_REQUEST)
                return
            LOGGER.exception("POST リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            path = unquote(urlparse(self.path).path)
            if STATE is None:
                self._require_local_host()
                if _is_api_path(path):
                    self._workspace_recreate_required()
                else:
                    self._client_error(ClientError("ページが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
                return
            self._require_mutation_request()
            if path.startswith("/api/catalog/image/"):
                image_id = path.removeprefix("/api/catalog/image/")
                self._json({"images": STATE.remove_image_from_catalog(image_id)})
            elif path.startswith("/api/project/"):
                project_id = path.removeprefix("/api/project/")
                if not project_id or "/" in project_id:
                    raise ClientError("プロジェクトが見つかりません。", "project_not_found")
                STATE.delete_project(project_id)
                self._json({"deleted": True})
            elif path.startswith("/api/candidate/"):
                image_id, candidate_id = _route_ids(path, "/api/candidate/")
                deleted = STATE.delete_candidate(image_id, candidate_id)
                self._json({"deleted": deleted, "candidateRevision": STATE._candidate_revision(image_id)})
            elif path.startswith("/api/workspace/manual/"):
                STATE.delete_manual_workspace(path.removeprefix("/api/workspace/manual/"))
                self._json({"ok": True})
            else:
                self._client_error(ClientError("APIが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
        except ForbiddenClientError as exc:
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            self._client_error(exc, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            if STATE is not None and (gpu_oom := STATE.recover_gpu_oom_for_request(exc)) is not None:
                LOGGER.error("DELETE リクエストでGPUメモリが不足: %s", self.path)
                self._client_error(gpu_oom, HTTPStatus.BAD_REQUEST)
                return
            LOGGER.exception("DELETE リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def _read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise ClientError("リクエストサイズが不正です。", "input_invalid")
        content_length = int(raw_length)
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ClientError("リクエストサイズが正しくありません。", "input_invalid")
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ClientError("JSONを読み込めません。", "input_invalid") from exc
        if not isinstance(payload, dict):
            raise ClientError("JSONオブジェクトが必要です。", "input_invalid")
        return payload

    def _read_binary_body_to_file(self) -> Path:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise ClientError("リクエストサイズが不正です。", "input_invalid")
        content_length = int(raw_length)
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ClientError("リクエストサイズが正しくありません。", "input_invalid")
        staging_dir = STATE.cache_dir / "import-staging"
        staging_dir.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        remaining = content_length
        try:
            with tempfile.NamedTemporaryFile(dir=staging_dir, suffix=".upload.tmp", delete=False) as handle:
                temporary_path = Path(handle.name)
                while remaining:
                    chunk = self.rfile.read(min(IO_CHUNK_BYTES, remaining))
                    if not chunk:
                        raise ClientError("画像データを最後まで読み込めません。", "image_read_failed")
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
            result = temporary_path
            temporary_path = None
            return result
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
            # Single-flight first: waiters for the same thumbnail do not consume a
            # global generation slot.  Only its cache-miss producer takes one.
            if not thumbnail_path.is_file():
                with STATE.thumbnail_gate:
                    if not thumbnail_path.is_file():
                        with STATE.lock:
                            current = STATE.images.get(image_id)
                            if current is None or STATE.asset_version(current) != asset_version:
                                raise ClientError("画像は更新されています。もう一度読み込んでください。", "stale_asset")
                        temporary_path: Path | None = None
                        try:
                            with Image.open(record.path) as image:
                                image = ImageOps.exif_transpose(image)
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
        if record is not None and (stat.st_mtime_ns != record.mtime_ns or stat.st_size != record.size_bytes):
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
