"""File-backed boundary coverage for the job and save lifecycles."""
from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

from mozarie.core import BrowserSaveReceipt, BrowserSaveToken, ClientError, ImageRecord, Job, JobControl, SAVE_TOKEN_TTL_SECONDS
from mozarie.domain import Candidate, CandidateRole
import mozarie.jobs as jobs_module
from mozarie.jobs import JobsMixin
from mozarie.saving import SavingMixin


class JobsSavingCoverageTests(unittest.TestCase):
    def make_jobs(self) -> JobsMixin:
        state = JobsMixin()
        state.lock = threading.RLock()
        state.import_lock = threading.Lock()
        state.inference_lock = threading.RLock()
        state.sam_lock = threading.RLock()
        state.settings = {"models": {"provider": "gpu", "gpu_device": 2}}
        state.job = Job()
        state.job_control = None
        state.job_generation = 1
        state.catalog_generation = 1
        state.active_import_count = 0
        state.worker_thread = None
        state.models = None; state.hand_model = None
        state.sam_predictor = None; state.sam_image_id = None
        state.hand_segmentation_predictor = None; state.hand_segmentation_image_id = None
        state.order = []
        state.images = {}
        state.candidates = {}
        state.root = None
        state.session_imports_dir = None
        state.image_io_lock = lambda _image_id: threading.RLock()
        state._has_active_worker = lambda: False
        state._job_is_current = lambda generation, catalog: generation in (None, 1) and catalog in (None, 1)
        state._candidate_revision = lambda _image_id: 1
        state._allowed_root_for_record = lambda record, root, session: root
        state._assert_record_stat_matches = lambda _record: None
        state.image_for_id = lambda image_id: state.images[image_id]
        return state

    def record(self, directory: Path, image_id: str = "one") -> ImageRecord:
        path = directory / f"{image_id}.png"
        Image.new("RGB", (3, 2), "white").save(path)
        stat = path.stat()
        return ImageRecord(image_id, path, path.name, 3, 2, stat.st_mtime_ns, stat.st_size)

    def make_saving(self, directory: Path) -> SavingMixin:
        state = SavingMixin()
        state.lock = threading.RLock(); state.import_lock = threading.RLock()
        state.output_destination_lock = threading.Lock(); state.reserved_output_paths = set()
        state.catalog_generation = 1; state.active_import_count = 0
        state.settings = {"saving": {"default_output_directory": str(directory / "output"), "parallelism": 2}, "detection": {"exclude_forced_default": True}}
        state.images = {}; state.order = []; state.candidates = {}; state.candidate_revisions = {}
        state.browser_save_tokens = {}; state.browser_save_receipts = {}; state.browser_save_claims = set(); state._pending_browser_save_cleanup = []
        state.cache_dir = directory / "cache"; state._image_io_locks = {}
        state.workspace_store = Mock()
        state.image_io_lock = lambda _image_id: threading.RLock()
        state._has_active_worker = lambda: False
        state._candidate_revision = lambda image_id: state.candidate_revisions.get(image_id, 1)
        state.image_snapshot = lambda image_id: __import__("dataclasses").replace(state.images[image_id])
        state._records_for_ids_with_catalog = lambda ids: ([state.images[item] for item in ids], state.catalog_generation)
        state._assert_record_stat_matches = lambda _record: None
        state._touch_candidates = lambda image_id: state.candidate_revisions.__setitem__(image_id, state._candidate_revision(image_id) + 1)
        state._commit_candidate_snapshot = lambda image_id, candidates, **_kwargs: state.candidates.__setitem__(image_id, candidates)
        state.materialize_candidate_mask = lambda *_args: None
        state._delete_mask_files = lambda *_args: None
        state.invalidate_sam_image = lambda *_args: None
        state._release_browser_save_claim = lambda token: state.browser_save_claims.discard(token)
        state._discard_browser_save_token_unchecked = lambda token: state.browser_save_tokens.pop(token, None)
        state._take_browser_save_cleanup_unchecked = lambda: []
        state._unlink_browser_save_cleanup = lambda _items: None
        state._discard_browser_save_tokens_for_image_unchecked = lambda _image: None
        state.cleanup_expired_browser_save_tokens = lambda: None
        state._encode_workspace_mask = lambda value: value
        return state

    def test_job_control_and_record_guards(self) -> None:
        state = self.make_jobs()
        self.assertIsNone(state._gpu_oom_client_error(ClientError("x", "x")))
        state.settings["models"]["provider"] = "cpu"
        self.assertIsNone(state._gpu_oom_client_error(RuntimeError("CUDA out of memory")))
        state.settings["models"]["provider"] = "gpu"
        self.assertEqual(state.recover_gpu_oom_for_request(RuntimeError("ordinary")), None)
        state._job_is_current = lambda *_args: False
        state._set_job_parallelism(3)
        state._set_job_current("x")
        self.assertEqual(state.job.parallelism, 0)
        state.job.kind = "apply"; state.job.state = "running"; state.job.total = 2; state.job.completed = 0
        state.job_control = JobControl()
        state.job.active_count = 1
        self.assertEqual(state.request_pause().state, "pausing")
        state.job.state = "paused"; state.job.paused_at = time.time() - .01
        self.assertEqual(state.resume_job().state, "running")
        state.job.state = "running"
        self.assertTrue(state.request_cancel().cancel_requested)
        state.job.kind = "idle"
        for call in (state.request_pause, state.resume_job, state.request_cancel):
            with self.assertRaises(ClientError): call()
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory)
            state.images = {record.image_id: record}; state.order = [record.image_id]
            self.assertEqual(state._records_for_ids([]), [record])
            state.root = directory
            self.assertEqual(state._records_for_ids_with_catalog([record.image_id])[0], [record])
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id, record.image_id])
            state.root = directory / "other"
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id])
            state.root = directory
            record.path.unlink()
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id])

    def test_gpu_cache_candidate_mask_and_job_terminal_paths(self) -> None:
        state = self.make_jobs()
        cuda = Mock(); cuda.is_available.return_value = True
        cuda.device.return_value = object()
        # A non-context device uses the direct empty-cache fallthrough.
        state._empty_selected_gpu_cache(SimpleNamespace(cuda=cuda), 2)
        cuda.empty_cache.assert_called_once()
        sam = Mock(); hand_segmentation = Mock()
        state.sam_predictor = sam; state.hand_segmentation_predictor = hand_segmentation
        state.models = object(); state.hand_model = object()
        with patch.object(state, "_release_gpu_cache") as release:
            state._release_gpu_job_memory()
        sam.reset_image.assert_called_once(); hand_segmentation.reset_image.assert_called_once()
        release.assert_called_once_with(provider="gpu", gpu_device=2)
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory)
            state.images = {record.image_id: record}; state.root = directory
            state.candidates = {record.image_id: []}
            state.materialize_candidate_mask = Mock()
            self.assertIsNone(state.combined_candidate_mask(record.image_id))
            mask_path = directory / "bad.png"; Image.new("L", (1, 1), 255).save(mask_path)
            state.candidates[record.image_id] = [Candidate("bad", "penis", .9, mask_path, role=CandidateRole.APPLY)]
            with self.assertRaises(RuntimeError): state.combined_candidate_mask(record.image_id)
            Image.new("L", (3, 2), 255).save(mask_path)
            state.candidates[record.image_id] = [Candidate("exclude", "penis", .9, mask_path, role=CandidateRole.EXCLUDE, forced=True)]
            add = np.zeros((2, 3), dtype=np.uint8); add[0, 0] = 255
            self.assertIsNotNone(state.combined_candidate_mask(record.image_id, (add, None, None), lock_image=False))
        state.job = Job(kind="detect", state="running", total=1, image_ids=("one",), completed_image_ids=("one",), completed=1, active_count=1)
        state.job_control = JobControl(); state.job_control.pause_requested.set()
        state._finish_claimed_task(state.job_control, 1, 1)
        self.assertFalse(state.job_control.pause_requested.is_set())
        state.job = Job(kind="detect", state="running", total=1)
        with patch.object(state, "_release_gpu_job_memory") as release:
            state._cancel_job(1, 1); state._finish_job(1, 1)
        self.assertEqual(state.job.state, "complete"); release.assert_not_called()
        state._fail_job = Mock()
        state._run_fixed_workers([SimpleNamespace(image_id="one")], 1, lambda *_args: (_ for _ in ()).throw(RuntimeError("boom")), JobControl(), 1, 1)
        self.assertTrue(True)

    def test_worker_and_failure_classification_paths(self) -> None:
        state = self.make_jobs()
        self.assertEqual(state._run_fixed_workers([], 1, lambda *_args: None, None, 1, 1), [])
        state.job = Job(kind="detect", state="running", total=1)
        failures = state._run_fixed_workers([SimpleNamespace(image_id="one")], 1, lambda *_args: (_ for _ in ()).throw(ValueError("bad")), None, 1, 1)
        self.assertEqual(len(failures), 1)
        for exc, code in ((__import__("sqlite3").DatabaseError("x"), "workspace_database_error"), (ValueError("x"), "internal_error"), (RuntimeError("invalid graph"), "internal_error")):
            state.job = Job(kind="detect", state="running")
            state._fail_job(exc, 1, 1)
            self.assertEqual(state.job.error_code, code)
        state.job = Job(kind="apply", state="running")
        state._fail_job(OSError("x"), 1, 1)
        self.assertEqual(state.job.error_code, "output_unavailable")
        state.job = Job(kind="detect", state="running")
        state._fail_job(RuntimeError("CUDA out of memory"), 1, 1)
        self.assertEqual(state.job.error_code, "gpu_out_of_memory")

    def test_job_thread_releases_gpu_once_after_every_terminal_worker_path(self) -> None:
        for kind, terminal in (("detect", "complete"), ("apply", "complete"), ("detect", "cancelled"), ("detect", "failed"), ("detect", "oom")):
            with self.subTest(kind=kind, terminal=terminal):
                state = self.make_jobs()
                record = SimpleNamespace(image_id="one")
                retained_tracebacks = []

                def worker(_records, *, control, job_generation, catalog_generation):
                    if terminal == "complete":
                        state._finish_job(job_generation, catalog_generation)
                    elif terminal == "cancelled":
                        state._cancel_job(job_generation, catalog_generation)
                    else:
                        try:
                            raise RuntimeError("CUDA out of memory" if terminal == "oom" else "failure")
                        except RuntimeError as exc:
                            state._fail_job(exc, job_generation, catalog_generation)
                            retained_tracebacks.append(exc.__traceback__)
                    release.assert_not_called()

                with patch.object(state, "_release_gpu_job_memory") as release:
                    state._start_job(kind, [record], worker)
                    assert state.worker_thread is not None
                    state.worker_thread.join(2)
                release.assert_called_once_with()
                if terminal == "oom":
                    self.assertEqual(retained_tracebacks, [None])

    def test_terminal_release_keeps_cpu_model_cache(self) -> None:
        state = self.make_jobs()
        state.settings["models"]["provider"] = "cpu"
        state.models = object(); state.hand_model = object()
        state.sam_predictor = Mock(); state.hand_segmentation_predictor = Mock()
        with patch.object(jobs_module.gc, "collect") as collect, \
             patch.object(state, "_release_gpu_cache") as release:
            state._release_gpu_job_memory()
        self.assertIsNotNone(state.models); self.assertIsNotNone(state.hand_model)
        self.assertIsNotNone(state.sam_predictor); self.assertIsNotNone(state.hand_segmentation_predictor)
        collect.assert_not_called()
        release.assert_not_called()

    def test_cpu_cache_release_collects_without_calling_cuda(self) -> None:
        state = self.make_jobs()
        torch = Mock()
        with patch.object(jobs_module.gc, "collect") as collect, \
             patch.dict(jobs_module.sys.modules, {"torch": torch}), \
             patch.object(jobs_module, "runtime_backend") as backend:
            state._release_gpu_cache(provider="cpu")
        collect.assert_called_once_with()
        backend.assert_not_called()

    def test_terminal_release_discards_directml_models_without_cuda_cache(self) -> None:
        state = self.make_jobs()
        state.models = object(); state.hand_model = object()
        state.sam_predictor = Mock(); state.hand_segmentation_predictor = Mock()
        with patch.object(jobs_module, "runtime_backend", return_value="directml"), \
             patch.object(state, "_empty_selected_gpu_cache") as empty:
            state._release_gpu_job_memory()
        self.assertIsNone(state.models); self.assertIsNone(state.hand_model)
        self.assertIsNone(state.sam_predictor); self.assertIsNone(state.hand_segmentation_predictor)
        empty.assert_not_called()

    def test_terminal_release_blocks_settings_and_boundary_inference_until_cache_cleanup(self) -> None:
        state = self.make_jobs()
        cleanup_started = threading.Event()
        allow_cleanup = threading.Event()
        settings_entered = threading.Event()
        boundary_entered = threading.Event()

        class BlockingInferenceLock:
            def __init__(self) -> None:
                self.lock = threading.Lock()

            def __enter__(self):
                self.lock.acquire()
                return self

            def __exit__(self, *_args):
                self.lock.release()

        state.inference_lock = BlockingInferenceLock()

        def release_cache(**_kwargs):
            cleanup_started.set()
            self.assertTrue(allow_cleanup.wait(2))

        cleanup = threading.Thread(target=state._release_gpu_job_memory)

        def update_settings():
            with state.inference_lock:
                settings_entered.set()

        def run_boundary_inference():
            with state.inference_lock:
                boundary_entered.set()

        with patch.object(state, "_release_gpu_cache", side_effect=release_cache):
            cleanup.start()
            self.assertTrue(cleanup_started.wait(2))
            settings = threading.Thread(target=update_settings)
            boundary = threading.Thread(target=run_boundary_inference)
            settings.start(); boundary.start()
            self.assertFalse(settings_entered.wait(.1))
            self.assertFalse(boundary_entered.wait(.1))
            allow_cleanup.set()
            cleanup.join(2); settings.join(2); boundary.join(2)
        self.assertFalse(cleanup.is_alive())
        self.assertTrue(settings_entered.is_set())
        self.assertTrue(boundary_entered.is_set())

    def test_job_races_and_remaining_worker_branches(self) -> None:
        state = self.make_jobs()
        class DeviceContext:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
        cuda = Mock(); cuda.is_available.return_value = True; cuda.device.return_value = DeviceContext()
        state._empty_selected_gpu_cache(SimpleNamespace(cuda=cuda), 2)
        cuda.empty_cache.assert_called_once()
        no_device_cuda = Mock(); no_device_cuda.is_available.return_value = True; no_device_cuda.device = None
        state._empty_selected_gpu_cache(SimpleNamespace(cuda=no_device_cuda), 2)
        no_device_cuda.empty_cache.assert_called_once()
        state.job = Job(kind="apply", state="running", total=2); pause = JobControl(); state.job_control = pause
        class ChangePause:
            def __enter__(_self): state.job.state = "complete"
            def __exit__(_self, *_args): return False
        pause.claim_lock = ChangePause()
        with self.assertRaises(ClientError): state.request_pause()
        state.job = Job(kind="apply", state="running", total=2); cancel = JobControl(); state.job_control = cancel
        class ChangeCancel:
            def __enter__(_self): state.job.state = "complete"
            def __exit__(_self, *_args): return False
        cancel.claim_lock = ChangeCancel()
        with self.assertRaises(ClientError): state.request_cancel()
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory)
            state.images = {record.image_id: None}; state.order = [record.image_id]; state.root = directory
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id])
            state.images[record.image_id] = record; state._allowed_root_for_record = lambda *_args: None
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id])
            state._allowed_root_for_record = lambda *_args: directory
            mask = directory / "mask.png"; Image.new("L", (3, 2), 255).save(mask)
            state.candidates = {record.image_id: [Candidate("exclude", "penis", .9, mask, role=CandidateRole.EXCLUDE, forced=False)]}
            state.materialize_candidate_mask = lambda *_args: None
            add = np.zeros((2, 3), dtype=np.uint8); add[0, 0] = 255
            self.assertIsNotNone(state.combined_candidate_mask(record.image_id, (add, None, None)))
            revision = [1]
            state._candidate_revision = lambda _image: revision[0]
            state.materialize_candidate_mask = lambda *_args: revision.__setitem__(0, 2)
            with self.assertRaises(ClientError): state.combined_candidate_mask(record.image_id, (add, None, None))
        state._job_is_current = lambda *_args: False
        state._cancel_job(1, 1)
        state._fail_job(RuntimeError("x"), 1, 1)
        state._job_is_current = lambda *_args: True
        control = JobControl(); control.pause_requested.set(); pauses = [0]
        def wait_then_cancel(*_args):
            pauses[0] += 1
            if pauses[0] > 1: control.cancel_requested.set()
        state._wait_while_paused = wait_then_cancel
        state._run_fixed_workers([SimpleNamespace(image_id="x")], 1, lambda *_args: None, control, 1, 1)
        calls = [0]
        def current_once(*_args):
            calls[0] += 1
            return calls[0] < 2
        state._job_is_current = current_once
        state.job = Job(kind="detect", state="running")
        state._run_fixed_workers([SimpleNamespace(image_id="x")], 1, lambda *_args: None, None, 1, 1)

    def test_saving_input_and_render_boundary_failures(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            state._issue_browser_save_token_unchecked = lambda *_args, **_kwargs: "token"
            state._start_job = Mock()
            state._records_for_ids_with_catalog = lambda _ids: ([record], 1)
            state.catalog_generation = 2
            with self.assertRaises(ClientError): state.start_apply([record.image_id], 2, {})
            state.catalog_generation = 1
            with patch("mozarie.saving.validate_output_directory_ready", side_effect=__import__("mozarie.config", fromlist=["SettingsError"]).SettingsError("bad")):
                with self.assertRaises(ClientError): state.start_apply([record.image_id], 2, {}, copy_to_default=True)
            state.images[record.image_id] = object()
            with self.assertRaises(ClientError): state.prepare_browser_save([record.image_id], 2, "_x", False)
            state.images[record.image_id] = record
            with patch("mozarie.saving.decode_draft_masks", return_value=(None, None, None)):
                rendered = state.render_browser_save(record.image_id, 1, 2, {})
            self.assertTrue(rendered.no_effect)
            self.assertEqual(rendered.output, record.path.read_bytes())
            state.candidates[record.image_id] = [Candidate("missing", "penis", .9, directory / "missing.png")]
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            self.assertEqual(state.candidates[record.image_id], [])
            bad_mask = directory / "bad-mask.png"; Image.new("L", (1, 1), 255).save(bad_mask)
            state.candidates[record.image_id] = [Candidate("bad", "penis", .9, bad_mask)]
            state.materialize_candidate_mask = lambda *_args: None
            with patch("mozarie.saving.decode_draft_masks", return_value=(None, None, None)):
                with self.assertRaises(RuntimeError): state.render_browser_save(record.image_id, 1, 2, {})
            state.candidates[record.image_id] = []
            state.settings["saving"]["default_output_directory"] = str(directory / "missing-output")
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", return_value=b"png"):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {}, copy_to_default=True)

    def test_render_browser_save_epoch_and_candidate_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            state.image_snapshot = lambda _image: __import__("dataclasses").replace(record)
            state.images.pop(record.image_id)
            with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            state.images[record.image_id] = record; state._has_active_worker = lambda: True
            with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            state._has_active_worker = lambda: False
            with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 0, 2, {})
            forced_mask = directory / "forced.png"; Image.new("L", (3, 2), 0).save(forced_mask)
            state.candidates[record.image_id] = [Candidate("forced", "penis", .9, forced_mask, role=CandidateRole.EXCLUDE, forced=True)]
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", return_value=b"png"):
                state._issue_browser_save_token_unchecked = lambda *_args, **_kwargs: "token"
                rendered = state.render_browser_save(record.image_id, 1, 2, {})
            self.assertEqual(rendered.save_token, "token")
            zero_apply = directory / "zero.png"; Image.new("L", (3, 2), 0).save(zero_apply)
            state.candidates[record.image_id] = [Candidate("zero", "penis", .9, zero_apply)]
            with patch("mozarie.saving.decode_draft_masks", return_value=(None, None, None)):
                self.assertTrue(state.render_browser_save(record.image_id, 1, 2, {}).no_effect)
            state.candidates[record.image_id] = []
            def change_catalog(*_args):
                state.catalog_generation += 1
                return b"png"
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", side_effect=change_catalog):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            state.catalog_generation = 1; workers = [False]
            def after_render(*_args):
                workers[0] = True
                return b"png"
            state._has_active_worker = lambda: workers[0]
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", side_effect=after_render):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            state._has_active_worker = lambda: False
            state._issue_browser_save_token_unchecked = Mock(side_effect=ClientError("x", "x"))
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", return_value=b"png"):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})

    def test_saving_tokens_apply_worker_and_cleanup_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            output = directory / "output"; output.mkdir(); state.settings["saving"]["default_output_directory"] = str(output)
            first = state._reserve_output_destination(record, "_x", output)
            second = state._reserve_output_destination(record, "_x", output)
            self.assertNotEqual(first, second); state._release_output_destination(first); state._release_output_destination(second)
            self.assertEqual(state.browser_save_status("x", 1, "none", "keep"), {"state": "unknown"})
            state.browser_save_receipts["wrong"] = BrowserSaveReceipt("other", 1, "keep", True, False, False, 1)
            self.assertEqual(state.browser_save_status(record.image_id, 1, "wrong", "keep"), {"state": "unknown"})
            token = BrowserSaveToken(record.image_id, 1, (record.mtime_ns, record.size_bytes), 1, time.monotonic(), None)
            state.browser_save_tokens["pending"] = token
            self.assertEqual(state.cancel_browser_save("wrong", 1, "pending"), {"state": "unknown"})
            self.assertEqual(state.cancel_browser_save(record.image_id, 1, "pending"), {"state": "pending"})
            state._run_fixed_workers = lambda records, _workers, action, *_args: [action(index, item) for index, item in enumerate(records)] and []
            state._set_job_current = lambda *_args: None; state._record_job_success = lambda *_args: None
            state._job_is_current = lambda *_args: True; state._finish_job = Mock(); state._fail_job = Mock(); state._cancel_job = Mock()
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            state._apply_worker([record], 2, {record.image_id: np.zeros((2, 3), dtype=np.uint8)}, control=JobControl(), job_generation=1, catalog_generation=1)
            self.assertEqual(state.job.total, 1); state._finish_job.assert_called_once()

    def test_apply_worker_caps_4k_parallelism_by_render_memory_budget(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); record.width = 3840; record.height = 2160
            state = self.make_saving(directory); state.images[record.image_id] = record; state.order = [record.image_id]
            workers: list[int] = []
            state._run_fixed_workers = lambda records, count, action, *_args: workers.append(count) or [action(index, item) for index, item in enumerate(records)] and []
            state._set_job_current = lambda *_args: None; state._record_job_success = lambda *_args: None
            state._job_is_current = lambda *_args: True; state._finish_job = Mock(); state._fail_job = Mock(); state._cancel_job = Mock()
            state._apply_worker([record], 2, {record.image_id: np.zeros((2, 3), dtype=np.uint8)}, saving_parallelism=8,
                                control=JobControl(), job_generation=1, catalog_generation=1)
            self.assertEqual(workers, [2])

    def test_browser_commit_rechecks_and_handles_delete_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            token = BrowserSaveToken(record.image_id, 1, (record.mtime_ns, record.size_bytes), 1, time.monotonic(), None)
            state.browser_save_tokens["active"] = token
            state._has_active_worker = lambda: True
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "active", "keep")
            state._has_active_worker = lambda: False
            state.browser_save_tokens["expired"] = BrowserSaveToken(
                record.image_id, 1, (1, 1), 1, time.monotonic() - SAVE_TOKEN_TTL_SECONDS - 1, None
            )
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "expired", "keep")
            state.browser_save_tokens["changed"] = BrowserSaveToken(record.image_id, 1, (1, 1), 2, time.monotonic(), None)
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "changed", "keep")
            # The second locked lookup must reject a receipt that arrived after
            # the initial token lookup, rather than committing the wrong action.
            state.browser_save_tokens["raced"] = token
            class AddReceipt:
                def __enter__(_self):
                    state.browser_save_receipts["raced"] = BrowserSaveReceipt(record.image_id, 1, "deleted", False, True, False, 1)
                def __exit__(_self, *_args): return False
            state.image_io_lock = lambda _image: AddReceipt()
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "raced", "keep")
            state.image_io_lock = lambda _image: threading.RLock()
            # A database failure restores a filesystem source moved to quarantine.
            state.browser_save_tokens["rollback"] = token
            state.workspace_store.commit_save.side_effect = RuntimeError("db")
            with self.assertRaises(RuntimeError): state.commit_browser_save(record.image_id, 1, "rollback", "deleted")
            self.assertTrue(record.path.exists())
            state.workspace_store.commit_save.side_effect = None
            thumb = state.cache_dir / "thumbnails" / f"{record.image_id}-one.jpg"; thumb.parent.mkdir(parents=True); thumb.write_bytes(b"x")
            state.browser_save_tokens["deleted"] = token
            result = state.commit_browser_save(record.image_id, 1, "deleted", "deleted")
            self.assertEqual(result, {"cleared": True, "stale": False, "deleted": True})
            self.assertFalse(thumb.exists())

    def test_browser_commit_second_lookup_and_catalog_changes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            base = BrowserSaveToken(record.image_id, 1, (record.mtime_ns, record.size_bytes), 1, time.monotonic(), None)
            def second_lookup(token_name, mutate, action="keep"):
                state.browser_save_tokens = {token_name: base}; state.browser_save_receipts = {}
                class Mutate:
                    def __enter__(_self): mutate()
                    def __exit__(_self, *_args): return False
                state.image_io_lock = lambda _image: Mutate()
                return state.commit_browser_save(record.image_id, 1, token_name, action)
            result = second_lookup("receipt", lambda: state.browser_save_receipts.__setitem__("receipt", BrowserSaveReceipt(record.image_id, 1, "keep", True, False, False, 1)))
            self.assertEqual(result["cleared"], True)
            for name, mutate in (
                ("gone", lambda: state.browser_save_tokens.clear()),
                ("revision", lambda: state.browser_save_tokens.__setitem__("revision", BrowserSaveToken(record.image_id, 2, (1, 1), 1, time.monotonic(), None))),
                ("action", lambda: state.browser_save_tokens.__setitem__("action", BrowserSaveToken(record.image_id, 1, (1, 1), 1, time.monotonic(), directory / "rendered.png"))),
            ):
                with self.subTest(name=name), self.assertRaises(ClientError): second_lookup(name, mutate)
            state.image_io_lock = lambda _image: threading.RLock()
            record.source_kind = "session"; record.path.unlink()
            state.browser_save_tokens = {"session-delete": base}; state.browser_save_receipts = {}
            self.assertTrue(state.commit_browser_save(record.image_id, 1, "session-delete", "deleted")["deleted"])
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            token = BrowserSaveToken(record.image_id, 1, (record.mtime_ns, record.size_bytes), 1, time.monotonic(), None)
            state.browser_save_tokens["catalog"] = token
            state._assert_record_stat_matches = lambda _record: setattr(state, "catalog_generation", 2)
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "catalog", "keep")
            state.catalog_generation = 1; state._assert_record_stat_matches = lambda _record: None
            state.browser_save_tokens["removed"] = token
            state.workspace_store.commit_save.side_effect = lambda *_args, **_kwargs: state.images.pop(record.image_id)
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "removed", "keep")

    def test_apply_worker_and_candidate_remaining_branches(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            missing = directory / "missing.png"; state.candidates[record.image_id] = [Candidate("missing", "penis", .9, missing)]
            state.materialize_candidate_mask = lambda *_args: state.images.pop(record.image_id)
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            state.images[record.image_id] = record
            exclude = directory / "exclude.png"; Image.new("L", (3, 2), 0).save(exclude)
            state.candidates[record.image_id] = [Candidate("exclude", "penis", .9, exclude, role=CandidateRole.EXCLUDE, forced=False)]
            state.materialize_candidate_mask = lambda *_args: None; state._issue_browser_save_token_unchecked = lambda *_args, **_kwargs: "token"
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", return_value=b"png"):
                self.assertEqual(state.render_browser_save(record.image_id, 1, 2, {}).save_token, "token")
            state._run_fixed_workers = lambda records, _workers, action, *_args: [action(index, item) for index, item in enumerate(records)] and []
            state._set_job_current = lambda *_args: None; state._record_job_success = lambda *_args: None
            state._finish_job = Mock(); state._fail_job = Mock(); state._cancel_job = Mock()
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            state.combined_candidate_mask = lambda *_args, **_kwargs: None
            state._job_is_current = lambda *_args: True
            with patch("mozarie.saving.decode_draft_masks", return_value=(None, None, None)):
                state._apply_worker([record], 2, {record.image_id: {}}, control=JobControl(), job_generation=1, catalog_generation=1)
            nonempty = np.ones((2, 3), dtype=np.uint8)
            stage = Mock()
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            state._job_is_current = lambda *_args: False
            with patch("mozarie.saving._stage_save_with_mask", return_value=stage):
                state._apply_worker([record], 2, {record.image_id: nonempty}, control=JobControl(), job_generation=1, catalog_generation=1)
            stage.rollback.assert_called_once()
            state._job_is_current = lambda *_args: True; state.workspace_store.commit_save.side_effect = RuntimeError("db")
            stage = Mock(); state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            with patch("mozarie.saving._stage_save_with_mask", return_value=stage):
                state._apply_worker([record], 2, {record.image_id: nonempty}, control=JobControl(), job_generation=1, catalog_generation=1)
            stage.rollback.assert_called_once(); state._fail_job.assert_called()
            state.workspace_store.commit_save.side_effect = RuntimeError("db")
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            output = directory / "output"; output.mkdir(exist_ok=True)
            state._reserve_output_destination = lambda *_args: output / "copy.png"; state._release_output_destination = lambda *_args: None
            with patch("mozarie.saving.render_with_mask", return_value=b"png"), patch("mozarie.saving.write_rendered_copy", side_effect=lambda path, data: path.write_bytes(data)):
                state._apply_worker([record], 2, {record.image_id: nonempty}, copy_to_default=True, output_directory=output, control=JobControl(), job_generation=1, catalog_generation=1)
            self.assertFalse((output / "copy.png").exists())
            state.workspace_store.commit_save.side_effect = None; state._job_is_current = lambda *_args: False
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            with patch("mozarie.saving.render_with_mask", return_value=b"png"), patch("mozarie.saving.write_rendered_copy", side_effect=lambda path, data: path.write_bytes(data)):
                state._apply_worker([record], 2, {record.image_id: nonempty}, copy_to_default=True, output_directory=output, control=JobControl(), job_generation=1, catalog_generation=1)
            state.workspace_store.commit_save.side_effect = None; state._job_is_current = lambda *_args: False
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            state._apply_worker([record], 2, {record.image_id: np.zeros((2, 3), dtype=np.uint8)}, control=JobControl(), job_generation=1, catalog_generation=1)
            state._run_fixed_workers = Mock(side_effect=RuntimeError("worker")); state._fail_job = Mock()
            state._apply_worker([record], 2, {}, control=JobControl(), job_generation=1, catalog_generation=1)
            state._fail_job.assert_called_once()
