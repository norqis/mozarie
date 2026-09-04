from __future__ import annotations

import hashlib
import json
import builtins
import threading
import io
from email.message import Message
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import numpy as np
from PIL import Image

from mozarie.boundary import polygon_mask, polygon_roi_and_point, validate_polygon
from mozarie.core import (
    ClientError,
    _read_mosaic_divisor,
    _read_target_classes,
    accepted_hand_sam_mask,
    arbitrate_segment_sources,
    confidence_for_source,
    mask_containment,
    mask_iou,
    read_boundary_request,
    read_detection_confidence,
    read_polygon_boundary_request,
    refine_mask_with_hand,
    sam_refinement_prompts,
    select_best_sam_mask,
    select_semantic_sam_mask,
    detection_tiles,
    tile_mask_bbox,
    tile_segments_overlap,
    torch_module,
)
from mozarie.config import (
    SettingsStore,
    SettingsError,
    _expect_bool,
    _expect_color,
    _expect_dict,
    _expect_number,
    _validate_output_directory,
    _validate_shortcut_actions,
    _validate_shortcuts,
    _validate_targets,
    validate_output_directory_ready,
)
from mozarie.fluid import white_fluid_mask
from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter, _class_names
from mozarie.inference.onnx import Letterbox
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.yolo_segment import TargetSegmenter
from mozarie.masks import compose_masks
from mozarie import image_io
from mozarie.model_downloads import (
    ModelDownload,
    ModelDownloadCancelled,
    ModelDownloadError,
    ModelDownloadInProgress,
    ModelDownloadManager,
    _HttpsOnlyRedirects,
    _sam_key,
)
from mozarie.jobs import JobsMixin
from mozarie.http import MosaicHandler, _pick_model_file, _read_bool, _read_candidate_revision, _request_version, _route_ids, _run_native_picker
from mozarie.saving import SavingMixin
from mozarie.core import BrowserSaveReceipt


class GeometryAndMaskCoverageTests(unittest.TestCase):
    def test_boundary_rejects_each_invalid_polygon_class(self) -> None:
        valid = ((1, 1), (8, 1), (8, 8), (1, 8))
        cases = (
            (valid[:3], "four points"),
            (((-1, 1), (8, 1), (8, 8), (1, 8)), "inside"),
            (((1, 1), (1, 1), (8, 8), (1, 8)), "distinct"),
            (((1, 1), (8, 8), (8, 1), (1, 8)), "intersect"),
            (((1, 1), (2, 1), (2, 2), (1, 2)), "too small"),
        )
        for points, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                validate_polygon(points, 10, 10)
        self.assertEqual(validate_polygon(valid, 10, 10), valid)
        mask = polygon_mask(valid, 10, 10)
        roi, point, roi_mask = polygon_roi_and_point(valid, 10, 10)
        self.assertEqual(mask.shape, (10, 10))
        self.assertEqual(roi, (1, 1, 9, 9))
        self.assertGreaterEqual(point[0], 1)
        self.assertIsNot(mask, roi_mask)

    def test_compose_masks_covers_manual_forced_and_all_shape_errors(self) -> None:
        source = np.zeros((3, 3), dtype=np.uint8)
        source[0, 0] = 255
        excluded = np.zeros((3, 3), dtype=np.uint8)
        excluded[0, 0] = 255
        added = np.zeros((3, 3), dtype=np.uint8)
        added[0, 1] = 255
        erased = np.zeros((3, 3), dtype=np.uint8)
        erased[0, 0] = 255
        forced = np.zeros((3, 3), dtype=np.uint8)
        forced[0, 1] = 255
        result = compose_masks((3, 3), [source], [excluded], added, excluded, [forced], True, erased)
        self.assertTrue(np.array_equal(result, np.array([[255, 0, 0], [0, 0, 0], [0, 0, 0]], dtype=np.uint8)))
        for keyword, kwargs in (
            ("apply", {"apply_masks": [np.zeros((2, 2), dtype=np.uint8)]}),
            ("exclude", {"exclude_masks": [np.zeros((2, 2), dtype=np.uint8)]}),
            ("manual exclude", {"manual_exclude": np.zeros((2, 2), dtype=np.uint8)}),
            ("exclusion erase", {"exclusion_erase": np.zeros((2, 2), dtype=np.uint8)}),
            ("manual add", {"manual_add": np.zeros((2, 2), dtype=np.uint8)}),
            ("forced exclude", {"forced_exclude_masks": [np.zeros((2, 2), dtype=np.uint8)]}),
        ):
            with self.subTest(keyword=keyword), self.assertRaisesRegex(ValueError, keyword):
                compose_masks((3, 3), kwargs.pop("apply_masks", []), kwargs.pop("exclude_masks", []), **kwargs)

    def test_fluid_empty_mask_returns_empty(self) -> None:
        self.assertFalse(np.any(white_fluid_mask(np.zeros((4, 4, 3), dtype=np.uint8), np.zeros((4, 4), dtype=np.uint8))))


class CoreCoverageTests(unittest.TestCase):
    def test_core_mask_and_source_edge_cases(self) -> None:
        empty = np.zeros((3, 3), dtype=np.uint8)
        filled = empty.copy(); filled[1, 1] = 255
        self.assertEqual(tile_mask_bbox(empty, 2, 3), (2, 3, 2, 3))
        left = {"class_name": "penis", "mask": filled, "tile_offset": (0, 0), "tile_bbox": (1, 1, 2, 2), "tile_area": 1}
        right = {**left, "class_name": "pussy"}
        self.assertFalse(tile_segments_overlap(left, right, .5, .5))
        self.assertEqual(mask_iou(empty, empty), 0)
        self.assertEqual(mask_containment(empty, filled), 0)
        accepted = arbitrate_segment_sources([
            {"class_name": "penis", "mask": filled, "source": "ntd11", "confidence": .6},
            {"class_name": "penis", "mask": filled, "source": "sensitive", "confidence": .7},
        ])
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["source"], "ntd11")
        self.assertEqual(detection_tiles(1, 1), [(0, 0, 1, 1)])

    def test_core_hand_mask_and_request_validation_edges(self) -> None:
        mask = np.full((10, 10), 255, dtype=np.uint8)
        self.assertEqual(refine_mask_with_hand(mask, np.zeros((9, 9), dtype=np.uint8))[1], "skipped")
        self.assertEqual(refine_mask_with_hand(mask, np.zeros((10, 10), dtype=np.uint8))[1], "unchanged")
        overlap_31 = np.zeros((10, 10), dtype=np.uint8); overlap_31.flat[:31] = 255
        self.assertEqual(refine_mask_with_hand(mask, overlap_31)[1], "unchanged")
        too_much = np.zeros((10, 10), dtype=np.uint8); too_much[:8] = 255
        self.assertEqual(refine_mask_with_hand(mask, too_much)[1], "over_cap")
        small = np.zeros((10, 10), dtype=np.uint8); small[:7] = 255
        self.assertEqual(refine_mask_with_hand(mask, small)[1], "too_small")
        with self.assertRaises(ClientError):
            accepted_hand_sam_mask(np.empty((0, 2, 2)), np.empty((0,)), (2, 2), (0, 0, 2, 2))
        rejected = accepted_hand_sam_mask(np.ones((1, 10, 10), dtype=np.uint8), np.asarray([.99]), (10, 10), (0, 0, 2, 2))
        self.assertIsNone(rejected)
        for value in (None, "bad"):
            with self.subTest(value=value), self.assertRaises(ClientError):
                read_detection_confidence(value)
                _read_mosaic_divisor(value)
        for payload in ({}, {"roi": {"left": 0, "top": 0, "right": 3, "bottom": 3}, "point": {"x": float("nan"), "y": 1}}, {"roi": {"left": 0, "top": 0, "right": 30, "bottom": 3}, "point": {"x": 1, "y": 1}}):
            with self.subTest(payload=payload), self.assertRaises(ClientError):
                read_boundary_request(payload, 10, 10)
        with self.assertRaises(ClientError):
            read_polygon_boundary_request({"points": "no"}, 10, 10)
        with self.assertRaises(ClientError):
            read_polygon_boundary_request({"points": [{"x": 1}]}, 10, 10)
        roi, _point, polygon = read_polygon_boundary_request({"points": [{"x": 1, "y": 1}, {"x": 8, "y": 1}, {"x": 8, "y": 8}, {"x": 1, "y": 8}]}, 10, 10)
        self.assertEqual((roi, polygon.shape), ((1, 1, 9, 9), (10, 10)))
        with self.assertRaises(ClientError):
            select_best_sam_mask(np.empty((0, 2, 2)), np.empty((0,)))

    def test_core_sam_and_configuration_edges(self) -> None:
        empty = np.zeros((8, 8), dtype=np.uint8)
        points, labels = sam_refinement_prompts(empty, empty)
        self.assertEqual((points.shape, labels.shape), ((0, 2), (0,)))
        source = np.zeros((8, 8), dtype=np.uint8); source[3, 3] = 255
        points, labels = sam_refinement_prompts(source, empty)
        self.assertEqual((points.tolist(), labels.tolist()), ([[3.0, 3.0]], [1]))
        masks = np.empty((2,), dtype=object)
        masks[:] = [np.zeros((8, 8), dtype=np.uint8), np.ones((7, 7), dtype=np.uint8)]
        self.assertIsNone(select_semantic_sam_mask(masks, np.asarray([.9, .8]), source, empty, points, labels))
        self.assertIsNone(select_semantic_sam_mask(np.empty((0, 8, 8), dtype=np.uint8), np.asarray([.9]), source, empty, points, labels))
        self.assertEqual(confidence_for_source("other", .4), .4)
        for value in (None, [], ["wrong"]):
            with self.subTest(value=value), self.assertRaises(ClientError):
                _read_target_classes(value)
        with self.assertRaises(ClientError):
            _read_mosaic_divisor(None)

    def test_torch_absence_has_a_safe_cuda_surface(self) -> None:
        original_import = builtins.__import__

        fake_torch = object()
        def has_torch(name, *args, **kwargs):
            if name == "torch":
                return fake_torch
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=has_torch):
            self.assertIs(torch_module(), fake_torch)

        def no_torch(name, *args, **kwargs):
            if name == "torch":
                raise ImportError("not installed")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=no_torch):
            module = torch_module()
        self.assertFalse(module.cuda.is_available())

    def test_core_sam_rejections_and_hand_candidates_continue_to_later_mask(self) -> None:
        source = np.zeros((8, 8), dtype=np.uint8); source[2:6, 2:6] = 255
        empty_points = np.empty((0, 2), dtype=np.float32)
        empty_labels = np.empty((0,), dtype=np.int32)
        no_area = np.zeros((8, 8), dtype=np.uint8)
        self.assertIsNone(select_semantic_sam_mask(np.asarray([no_area]), np.asarray([.9]), source, np.zeros_like(source), empty_points, empty_labels))
        hand = np.zeros_like(source); hand[2:4, 2:4] = 255
        hand_only = np.zeros_like(source); hand_only[2:4, 2:4] = 255
        self.assertIsNone(select_semantic_sam_mask(np.asarray([hand_only]), np.asarray([.9]), source, hand, empty_points, empty_labels))
        quarter = np.zeros_like(source); quarter[2:3, 2:6] = 255
        self.assertIsNone(select_semantic_sam_mask(np.asarray([quarter]), np.asarray([.9]), source, np.zeros_like(source), empty_points, empty_labels))
        masks = np.zeros((2, 10, 10), dtype=np.uint8)
        masks[0, 1:2, 1:2] = 255
        masks[1, 2:6, 2:6] = 255
        accepted = accepted_hand_sam_mask(masks, np.asarray([.99, .99]), (10, 10), (1, 1, 8, 8))
        self.assertTrue(np.any(accepted))


class ImageIoCoverageTests(unittest.TestCase):
    def png_data_url(self, mode: str = "L", size: tuple[int, int] = (2, 2)) -> str:
        import base64
        stream = __import__("io").BytesIO()
        Image.new(mode, size).save(stream, format="PNG")
        return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()

    def test_image_io_small_validation_and_mask_paths(self) -> None:
        self.assertFalse(image_io._valid_color("bad"))
        for raw in (b"not png", image_io.PNG_SIGNATURE + b"\x00"):
            with self.subTest(raw=raw), self.assertRaises(ClientError):
                image_io.parse_png_chunks(raw)
        for suffix in (".gif", ".bad"):
            with self.subTest(suffix=suffix), self.assertRaises(ClientError):
                image_io._expected_image_format(suffix)
        from PIL import Image
        image = Image.new("RGB", (2, 2))
        for block, mask in ((0, np.zeros((2, 2), dtype=np.uint8)), (1, np.zeros((3, 3), dtype=np.uint8))):
            with self.subTest(block=block), self.assertRaises(ClientError):
                image_io._apply_mosaic_to_image(image, mask, block)
        for value in (None, "data:image/png;base64,!", "data:image/png;base64,AAAA"):
            with self.subTest(value=value), self.assertRaises(ClientError):
                image_io._decode_mask(value, 2, 2)
        with self.assertRaises(ClientError):
            image_io.decode_draft_masks([], 2, 2)
        decoded = image_io._decode_mask(self.png_data_url(), 2, 2)
        self.assertEqual(decoded.shape, (2, 2))

    def test_image_io_device_and_file_state_paths(self) -> None:
        torch = Mock(); torch.cuda.is_available.return_value = False
        with patch("mozarie.image_io.torch_module", return_value=torch), patch("mozarie.image_io.runtime_backend", return_value="cpu"):
            self.assertIsNone(image_io.inference_device_name())
        with patch("mozarie.image_io.torch_module", return_value=torch), patch("mozarie.image_io.runtime_backend", return_value="directml"), patch("mozarie.image_io.directml_devices", return_value=[]):
            self.assertIsNone(image_io.inference_device_name())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "x.png"; candidate.write_bytes(b"x")
            self.assertEqual(image_io.unique_session_import_destination(candidate).name, "x_2.png")
            with self.assertRaises(ClientError):
                image_io._source_stat_fingerprint(root / "missing.png")
            image_path = root / "source.bmp"
            from PIL import Image
            Image.new("RGB", (2, 2)).save(image_path)
            stat = image_path.stat()
            record = image_io.ImageRecord("x", image_path, "source.bmp", 2, 2, stat.st_mtime_ns, stat.st_size)
            with self.assertRaises(ClientError):
                image_io.render_with_mask(record, np.zeros((2, 2), dtype=np.uint8), 1)

    def test_image_io_sync_and_backup_failures_do_not_escape(self) -> None:
        with patch("mozarie.image_io.os.open", side_effect=OSError("unsupported")):
            image_io._sync_directory(Path("C:/nope"))
        with patch("mozarie.image_io.os.open", return_value=3), patch("mozarie.image_io.os.fsync", side_effect=OSError("unsupported")), patch("mozarie.image_io.os.close") as close:
            image_io._sync_directory(Path("C:/nope"))
            close.assert_called_once_with(3)
        with patch.object(Path, "unlink", side_effect=OSError("locked")), patch("mozarie.image_io.LOGGER.warning") as warning:
            image_io._remove_incomplete_backup(Path("C:/locked"))
            warning.assert_called_once()


class JobsCoverageTests(unittest.TestCase):
    def make_jobs(self) -> JobsMixin:
        jobs = JobsMixin()
        jobs.lock = threading.RLock()
        jobs.import_lock = threading.Lock()
        jobs.settings = {"models": {"provider": "gpu", "gpu_device": 0}}
        jobs.job = __import__("mozarie.core", fromlist=["Job"]).Job()
        jobs.job_control = None
        jobs.order = []
        jobs.images = {}
        jobs.candidates = {}
        jobs.catalog_generation = 1
        jobs.image_io_lock = lambda _image_id: threading.RLock()
        return jobs

    def test_jobs_reject_invalid_controls_and_selected_records(self) -> None:
        jobs = self.make_jobs()
        self.assertFalse(jobs._is_gpu_out_of_memory(MemoryError()))
        torch = Mock(); torch.cuda.is_available.return_value = False
        jobs._empty_selected_gpu_cache(torch, 0)
        torch.cuda.empty_cache.assert_not_called()
        with self.assertRaises(ClientError): jobs.request_pause()
        with self.assertRaises(ClientError): jobs.resume_job()
        with self.assertRaises(ClientError): jobs.request_cancel()
        for ids in ("bad", ["x", "x"], []):
            with self.subTest(ids=ids), self.assertRaises(ClientError):
                jobs._records_for_ids(ids)
        with self.assertRaises(ClientError):
            jobs._records_for_ids_with_catalog("bad")
        jobs.import_lock.acquire()
        try:
            with self.assertRaises(ClientError):
                jobs._start_job("detect", [], lambda *_args: None)
        finally:
            jobs.import_lock.release()
        with self.assertRaises(ClientError):
            jobs.combined_candidate_mask("missing")

    def test_jobs_gpu_oom_recovery_and_success_current_guard(self) -> None:
        jobs = self.make_jobs()
        jobs.inference_lock = threading.RLock()
        jobs.sam_lock = threading.RLock()
        jobs.sam_predictor = None; jobs.sam_image_id = None
        jobs.hand_segmentation_predictor = None; jobs.hand_segmentation_image_id = None
        jobs.models = object(); jobs.hand_model = object()
        try:
            raise RuntimeError("CUDA out of memory")
        except RuntimeError as exc:
            with patch.object(jobs, "_release_gpu_cache") as release:
                error = jobs.recover_gpu_oom_for_request(exc)
            self.assertIsNone(exc.__traceback__)
        self.assertEqual(error.error_code, "gpu_out_of_memory")
        release.assert_called_once()
        jobs._job_is_current = lambda *_args: False
        jobs._record_job_success(0, "image", "out.png")
        self.assertEqual(jobs.job.outputs, [])


class HttpCoverageTests(unittest.TestCase):
    def handler(self, payload: bytes = b"", content_length: str | None = None) -> MosaicHandler:
        handler = object.__new__(MosaicHandler)
        handler.headers = Message()
        if content_length is not None:
            handler.headers["Content-Length"] = content_length
        handler.rfile = io.BytesIO(payload)
        handler.wfile = io.BytesIO()
        handler.close_connection = False
        return handler

    def test_http_body_and_route_validators_cover_invalid_and_valid_forms(self) -> None:
        for length, payload in ((None, b""), ("0", b""), ("3", b"[1]"), ("3", b"bad")):
            with self.subTest(length=length, payload=payload), self.assertRaises(ClientError):
                self.handler(payload, length)._read_json_body()
        self.assertEqual(self.handler(b'{"x":1}', "7")._read_json_body(), {"x": 1})
        for length in (None, "0"):
            with self.subTest(length=length), self.assertRaises(ClientError):
                self.handler(b"x", length)._read_binary_body_to_file()
        self.assertEqual(_request_version(""), None)
        for query in ("v=", "v=1&v=2"):
            with self.subTest(query=query), self.assertRaises(ClientError):
                _request_version(query)
        self.assertEqual(_request_version("v=42"), "42")
        for path in ("/api/masks/x", "/api/masks//y", "/api/masks/x/y/z"):
            with self.subTest(path=path), self.assertRaises(ClientError):
                _route_ids(path, "/api/masks/")
        self.assertEqual(_route_ids("/api/masks/x/y", "/api/masks/"), ("x", "y"))
        for value in (True, -1, "1"):
            with self.subTest(value=value), self.assertRaises(ClientError):
                _read_candidate_revision(value)
        with self.assertRaises(ClientError): _read_bool("true", "flag")
        self.assertTrue(_read_bool(True, "flag"))

    def test_native_picker_rejects_busy_missing_and_invalid_results(self) -> None:
        state = MagicMock()
        state.native_picker_lock.acquire.return_value = False
        with self.assertRaises(ClientError):
            _run_native_picker("", {}, failed_message="failed", busy_message="busy", state=state)
        state = MagicMock(); state.native_picker_lock.acquire.return_value = True
        with patch("mozarie.http.Path.is_file", return_value=False):
            with self.assertRaises(ClientError):
                _run_native_picker("", {}, failed_message="failed", busy_message="busy", state=state)
        state.native_picker_lock.release.assert_called_once()
        state = MagicMock(); state.native_picker_lock.acquire.return_value = True
        completed = type("Result", (), {"returncode": 0, "stdout": b"not-base64"})()
        with patch("mozarie.http.Path.is_file", return_value=True), patch("mozarie.http.subprocess.run", return_value=completed):
            with self.assertRaises(ClientError):
                _run_native_picker("$x=1", {}, failed_message="failed", busy_message="busy", state=state)
        state = MagicMock(); state.native_picker_lock.acquire.return_value = True
        completed = type("Result", (), {"returncode": 0, "stdout": b""})()
        with patch("mozarie.http.Path.is_file", return_value=True), patch("mozarie.http.subprocess.run", return_value=completed):
            self.assertIsNone(_run_native_picker("$x=1", {}, failed_message="failed", busy_message="busy", state=state))
        with self.assertRaises(ClientError):
            _pick_model_file("unknown", state=MagicMock())

    def test_http_static_log_and_stream_disconnect_paths(self) -> None:
        handler = self.handler()
        handler._json = Mock()
        handler._send_static("/../../secret")
        handler._json.assert_called_once()
        handler = self.handler()
        handler._binary = Mock()
        handler._send_static("style.css")
        self.assertEqual(handler._binary.call_args.args[1], "text/css")
        with patch("mozarie.http.LOGGER.warning") as warning:
            handler.log_message("%s", "bad")
            warning.assert_called_once()
        handler = self.handler()
        handler.send_response = Mock(side_effect=BrokenPipeError())
        handler.send_header = Mock(); handler.end_headers = Mock()
        with tempfile.NamedTemporaryFile() as file:
            file.write(b"image"); file.flush(); file.seek(0)
            handler._stream_file(file, None, "application/octet-stream", "no-store")
        self.assertTrue(handler.close_connection)

    def test_http_routes_dispatch_json_operations_without_a_live_server(self) -> None:
        state = MagicMock()
        state.settings = {"detection": {"threshold": .5, "parallelism": 1}}
        state.set_root.return_value = [{"id": "x"}]
        state.start_apply.return_value = True
        state.request_pause.return_value.as_dict.return_value = {"state": "paused"}
        handler = self.handler()
        handler._require_json_request = Mock()
        handler._client_error = Mock()
        handler._json = Mock()
        with patch("mozarie.http.STATE", state):
            for path, payload in (
                ("/api/folder", {"path": "C:/images"}),
                ("/api/catalog/clear", {}),
                ("/api/detect", {"imageIds": [], "confidence": .5, "parallelism": 1}),
                ("/api/masks/clear", {"imageIds": []}),
                ("/api/apply", {"imageIds": [], "divisor": 2, "drafts": {}}),
                ("/api/job/pause", {}),
            ):
                with self.subTest(path=path):
                    handler.path = path
                    handler._read_json_body = Mock(return_value=payload)
                    handler.do_POST()
        state.set_root.assert_called_once_with("C:/images")
        state.clear_catalog.assert_called_once()
        state.start_detection.assert_called_once_with([], .5, 1)
        state.clear_masks.assert_called_once_with([])
        state.start_apply.assert_called_once()
        state.request_pause.assert_called_once()

    def test_http_delete_routes_dispatch_and_unknown_route_is_not_found(self) -> None:
        state = Mock()
        state.delete_candidate.return_value = True
        state._candidate_revision.return_value = 3
        handler = self.handler()
        handler._require_mutation_request = Mock()
        handler._json = Mock(); handler._client_error = Mock()
        with patch("mozarie.http.STATE", state):
            for path in ("/api/catalog/image/x", "/api/candidate/x/y", "/api/workspace/manual/x", "/api/unknown"):
                with self.subTest(path=path):
                    handler.path = path
                    handler.do_DELETE()
        state.remove_image_from_catalog.assert_called_once_with("x")
        state.delete_candidate.assert_called_once_with("x", "y")
        state.delete_manual_workspace.assert_called_once_with("x")

    def test_http_get_routes_dispatch_json_and_asset_paths(self) -> None:
        state = MagicMock()
        state.settings = {"models": {"provider": "cpu"}}
        state.settings_status.return_value = {"models": {"target": {"valid": True, "required": True, "enabled": True}}, "gpus": []}
        state.job.as_dict.return_value = {"state": "idle"}
        state.catalog_snapshot.return_value = [{"id": "x"}]
        state.candidate_snapshot.return_value = []
        state.manual_workspace.return_value = {"add": None}
        handler = self.handler()
        handler._require_local_host = Mock(); handler._json = Mock(); handler._client_error = Mock()
        handler._send_image = Mock(); handler._send_candidate_mask = Mock()
        with patch("mozarie.http.STATE", state), patch("mozarie.http._local_version", return_value="0.4.11"), patch("mozarie.http._update_status", return_value={"available": False}):
            for path in ("/api/health", "/api/settings?status=0", "/api/model-download", "/api/update/status", "/api/images", "/api/job", "/api/candidates/x", "/api/workspace/manual/x", "/api/image/x?v=one", "/api/thumbnail/x?v=two", "/api/mask/x/y?v=3"):
                with self.subTest(path=path):
                    handler.path = path
                    handler.do_GET()
        state.cleanup_expired_browser_save_tokens.assert_called_once()
        handler._send_image.assert_any_call("x", thumbnail=False, version="one")
        handler._send_image.assert_any_call("x", thumbnail=True, version="two")
        handler._send_candidate_mask.assert_called_once_with("x", "y", "3")

    def test_http_post_routes_cover_settings_models_saves_and_jobs(self) -> None:
        state = MagicMock()
        state.settings = {"detection": {"threshold": .5, "parallelism": 1}}
        state.model_downloads.cancel.return_value = {"state": "cancelled"}
        state.resume_job.return_value.as_dict.return_value = {"state": "running"}
        state.request_cancel.return_value.as_dict.return_value = {"state": "running"}
        handler = self.handler()
        handler._require_json_request = Mock(); handler._json = Mock(); handler._client_error = Mock()
        routes = (
            ("/api/workspace/image/x", {"hidden": True}),
            ("/api/workspace/manual/x", {}),
            ("/api/catalog/remove", {"imageIds": []}),
            ("/api/candidates/batch", {"imageId": "x"}),
            ("/api/settings/status", {}),
            ("/api/settings/gpu-diagnostic", {}),
            ("/api/model-download/cancel", {}),
            ("/api/boundary", {"imageId": "x"}),
            ("/api/save/status", {"imageId": "x", "candidateRevision": 0, "saveToken": "t", "sourceAction": "keep"}),
            ("/api/save/cancel", {"imageId": "x", "candidateRevision": 0, "saveToken": "t"}),
            ("/api/job/resume", {}),
            ("/api/job/cancel", {}),
            ("/api/candidate/x/y", {}),
        )
        with patch("mozarie.http.STATE", state):
            for path, payload in routes:
                with self.subTest(path=path):
                    handler.path = path
                    handler._read_json_body = Mock(return_value=payload)
                    handler.do_POST()
        state.set_image_flags.assert_called_once_with("x", {"hidden": True})
        state.save_manual_workspace.assert_called_once_with("x", {})
        state.model_downloads.cancel.assert_called_once()
        state.resume_job.assert_called_once(); state.request_cancel.assert_called_once()


class SavingCoverageTests(unittest.TestCase):
    def test_start_apply_and_browser_status_edge_states(self) -> None:
        saving = SavingMixin()
        saving._assert_catalog_mutable = Mock()
        saving.lock = threading.RLock()
        saving.catalog_generation = 1
        saving.settings = {"saving": {"default_output_directory": tempfile.gettempdir(), "parallelism": 2}}
        record = image_io.ImageRecord("x", Path("C:/session.png"), "session.png", 2, 2, 1, 1, source_kind="session")
        saving.images = {"x": record}
        saving._records_for_ids_with_catalog = lambda _ids: ([record], 1)
        saving._start_job = Mock()
        self.assertFalse(saving.start_apply([], 2, {}))
        with self.assertRaises(ClientError):
            saving.start_apply(["x"], 2, {})
        record.source_kind = "filesystem"
        with self.assertRaises(ClientError):
            saving.start_apply(["x"], 2, [])
        saving.browser_save_receipts = {}
        saving.browser_save_tokens = {}
        self.assertEqual(saving.browser_save_status("x", 1, "missing", "keep"), {"state": "unknown"})
        saving.browser_save_receipts["done"] = BrowserSaveReceipt("x", 1, "keep", True, False, False, 1.0)
        self.assertEqual(saving.browser_save_status("x", 1, "done", "keep")["state"], "committed")
        self.assertEqual(saving.browser_save_status("wrong", 1, "done", "keep"), {"state": "unknown"})
        saving.browser_save_tokens["pending"] = type("Token", (), {"image_id": "x", "candidate_revision": 1})()
        self.assertEqual(saving.browser_save_status("x", 1, "pending", "keep"), {"state": "pending"})

    def test_prepare_and_start_apply_snapshot_a_filesystem_record(self) -> None:
        saving = SavingMixin()
        saving._assert_catalog_mutable = Mock()
        saving.lock = threading.RLock(); saving.catalog_generation = 4
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            saving.settings = {"saving": {"default_output_directory": str(output), "parallelism": 3}}
            record = image_io.ImageRecord("x", output / "source.png", "folder/source.png", 2, 2, 1, 1)
            saving.images = {"x": record}
            saving._records_for_ids_with_catalog = lambda _ids: ([record], 4)
            saving._candidate_revision = lambda _image_id: 7
            saving._start_job = Mock()
            prepared = saving.prepare_browser_save(["x"], 2, "_censored", True)
            self.assertEqual(prepared, [{"imageId": "x", "relativePath": "folder/source.png", "sourceKind": "filesystem", "candidateRevision": 7, "sourceAction": "deleted"}])
            self.assertTrue(saving.start_apply(["x"], 2, {}, copy_to_default=True))
            self.assertEqual(saving._start_job.call_args.args[0], "apply")


class SettingsCoverageTests(unittest.TestCase):
    def test_settings_primitives_reject_invalid_values(self) -> None:
        cases = (
            (_expect_dict, ([], "object")),
            (_expect_bool, (1, "bool")),
            (_expect_number, (True, "number", 0, 1)),
            (_expect_color, ("bad", "color")),
            (_validate_output_directory, ("",)),
            (_validate_output_directory, ("relative",)),
            (_validate_output_directory, ("C:\\bad\x00path",)),
            (_validate_targets, ([],)),
            (_validate_shortcuts, ([],)),
            (_validate_shortcut_actions, ([],)),
        )
        for function, args in cases:
            with self.subTest(function=function.__name__), self.assertRaises(SettingsError):
                function(*args)
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(validate_output_directory_ready(directory), Path(directory).resolve())
            with patch("mozarie.config.tempfile.NamedTemporaryFile", side_effect=OSError("read only")):
                with self.assertRaises(OSError):
                    validate_output_directory_ready(directory)
        with self.assertRaises(SettingsError):
            validate_output_directory_ready("relative")

    def test_validate_settings_reports_each_public_enum_and_model_type_error(self) -> None:
        defaults = json.loads((Path(__file__).resolve().parents[1] / "config" / "defaults.json").read_text(encoding="utf-8"))
        cases = (
            (("general", "language"), "de", "language"),
            (("models", "sam_model_type"), "unknown", "sam_model_type"),
            (("detection", "mode"), "quick", "mode"),
            (("models", "target_segmentation"), 7, "target_segmentation"),
            (("models", "sam_checkpoints", "vit_b"), 7, "sam_checkpoints.vit_b"),
        )
        for path, value, message in cases:
            candidate = json.loads(json.dumps(defaults))
            destination = candidate
            for key in path[:-1]:
                destination = destination[key]
            destination[path[-1]] = value
            with self.subTest(message=message), self.assertRaisesRegex(SettingsError, message):
                from mozarie.config import validate_settings
                validate_settings(candidate)
        bindings = dict(defaults["shortcuts"]["bindings"])
        bindings["undo"] = bindings["redo"]
        with self.assertRaises(SettingsError):
            _validate_shortcuts(bindings)

    def test_builtin_output_directory_handles_unresolvable_configured_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config" / "defaults.json").write_text('{"general":{},"models":{},"display":{},"importing":{},"detection":{}}', encoding="utf-8")
            store = SettingsStore(root)
            bad_directory = str(root / "configured-output")
            settings = {"saving": {"default_output_directory": bad_directory}}
            original_resolve = Path.resolve
            def resolve_or_fail(path, *args, **kwargs):
                if str(path) == bad_directory:
                    raise OSError("bad path")
                return original_resolve(path, *args, **kwargs)
            with patch("mozarie.config.Path.resolve", side_effect=resolve_or_fail, autospec=True):
                self.assertEqual(store._set_builtin_output_directory(settings)["saving"]["default_output_directory"], bad_directory)


class DownloadCoverageTests(unittest.TestCase):
    def entry(self, payload: bytes) -> ModelDownload:
        return ModelDownload("fixture", "fixture", "https://models.example/model", "models/model.onnx", len(payload), hashlib.sha256(payload).hexdigest())

    def test_download_state_and_protocol_rejections(self) -> None:
        with self.assertRaises(ModelDownloadError):
            _sam_key("unknown")
        with self.assertRaises(ModelDownloadError):
            _HttpsOnlyRedirects().redirect_request(None, None, 302, "", {}, "http://example.test")
        manager = ModelDownloadManager(Path(tempfile.mkdtemp()))
        self.assertEqual(manager.cancel()["state"], "idle")
        manager._job["state"] = "running"
        with self.assertRaises(ModelDownloadInProgress):
            manager.start("hand_detection", "vit_b")
        manager._cancel.set()
        manager._run(["hand_detection"])
        self.assertEqual(manager.snapshot()["state"], "cancelled")

    def test_download_rejects_corrupt_complete_partial_without_network(self) -> None:
        payload = b"verified"
        root = Path(tempfile.mkdtemp())
        manager = ModelDownloadManager(root)
        entry = self.entry(payload)
        part = entry.destination(root).with_name(".model.onnx.part")
        part.parent.mkdir(parents=True)
        part.write_bytes(b"wrong---")
        with patch("mozarie.model_downloads.build_opener") as opener:
            opener.return_value.open.side_effect = ModelDownloadError("stop")
            with self.assertRaises(ModelDownloadError):
                manager._download(entry)
        self.assertFalse(part.exists())


class OnnxDecoderCoverageTests(unittest.TestCase):
    def test_decoder_initializers_record_the_requested_input_size(self) -> None:
        for module, cls in (
            ("mozarie.inference.yolo_detect.BaseOnnxModel.__init__", HandDetector),
            ("mozarie.inference.yolo_segment.BaseOnnxModel.__init__", TargetSegmenter),
        ):
            with self.subTest(cls=cls.__name__), patch(module, return_value=None):
                instance = cls(Path("unused.onnx"), input_size=99)
                self.assertEqual(instance.input_size, 99)
        def initialise(instance, path, **_kwargs):
            instance.session = Mock()
            instance.session.get_modelmeta.return_value.custom_metadata_map = {"names": "['Penis']"}
        with patch("mozarie.inference.generic_yolo_segment.BaseOnnxModel.__init__", new=initialise):
            generic = GenericYoloSegmenter(Path("unused.onnx"), input_size=88)
        self.assertEqual((generic.input_size, generic.class_names), (88, ("penis",)))

    def test_hand_decoder_rejects_invalid_profiles_and_skips_low_or_invalid_boxes(self) -> None:
        invalid = (
            [],
            [np.zeros((1, 5, 1), dtype=np.float64)],
            [np.zeros((5, 1), dtype=np.float32)],
            [np.zeros((1, 4, 1), dtype=np.float32)],
            [np.zeros((1, 5, 0), dtype=np.float32)],
            [np.full((1, 5, 1), np.nan, dtype=np.float32)],
            [np.asarray([[[1], [1], [1], [1], [2]]], dtype=np.float32)],
        )
        for outputs in invalid:
            with self.subTest(shape=[value.shape for value in outputs]), self.assertRaises(ValueError):
                HandDetector._prediction_rows(outputs)
        detector = HandDetector.__new__(HandDetector)
        detector.input_size = 10
        detector.run = lambda _tensor: [np.asarray([[[5, 5], [5, 5], [6, 6], [6, 6], [0.1, 0.9]]], dtype=np.float32)]
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        with patch("mozarie.inference.yolo_detect.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)), patch("mozarie.inference.yolo_detect.restore_box", side_effect=[None, (2, 2, 8, 8)]):
            self.assertEqual(detector.detect_boxes(np.zeros((10, 10, 3), dtype=np.uint8), 0.05), [(2, 2, 8, 8)])

    def test_target_and_generic_invalid_output_profiles(self) -> None:
        for value in (np.zeros((2, 43), dtype=np.float32), np.zeros((1, 42, 1), dtype=np.float32)):
            with self.subTest(shape=value.shape), self.assertRaises(ValueError):
                TargetSegmenter._prediction_rows(value)
        with self.assertRaises(ValueError):
            TargetSegmenter._outputs([np.zeros((1, 2, 2), dtype=np.float32)])
        target = TargetSegmenter.__new__(TargetSegmenter)
        target.input_size = 10
        target.run = lambda _tensor: [np.zeros((1, 43, 1), dtype=np.float32), np.zeros((1, 32, 2, 2), dtype=np.float32)]
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), Letterbox(1, 0, 0, 10, 10, 10, 10))):
            self.assertEqual(target.detect(np.zeros((10, 10, 3), dtype=np.uint8), 0.5), [])
        for metadata in ({}, {"names": "1"}, {"names": "[]"}, {"names": "[' ']"}):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                _class_names(metadata)
        generic = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        generic.class_names = ("penis",)
        for value in (np.zeros((2, 37, 1), dtype=np.float32), np.zeros((1, 36, 1), dtype=np.float32)):
            with self.subTest(shape=value.shape), self.assertRaises(ValueError):
                generic._prediction_rows(value)
        with self.assertRaises(ValueError):
            generic._outputs([np.zeros((1, 2, 2), dtype=np.float32)])

    def test_segmenters_skip_unselected_and_unrestorable_boxes(self) -> None:
        transform = Letterbox(1, 0, 0, 10, 10, 10, 10)
        target = TargetSegmenter.__new__(TargetSegmenter)
        target.input_size = 10
        prediction = np.zeros((1, 43, 2), dtype=np.float32)
        prediction[0, :4, :] = np.asarray([[5, 5], [5, 5], [6, 6], [6, 6]], dtype=np.float32)
        prediction[0, 6, :] = .9
        prediction[0, -32:, :] = 1
        target.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        with patch("mozarie.inference.yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)), patch("mozarie.inference.yolo_segment.restore_box", return_value=None):
            self.assertEqual(target.detect(np.zeros((10, 10, 3), dtype=np.uint8), .5, {"pussy"}), [])
            self.assertEqual(target.detect(np.zeros((10, 10, 3), dtype=np.uint8), .5, {"penis"}), [])
        generic = GenericYoloSegmenter.__new__(GenericYoloSegmenter)
        generic.input_size = 10
        generic.class_names = ("penis",)
        prediction = np.zeros((1, 37, 1), dtype=np.float32)
        prediction[0, :4, 0] = (5, 5, 6, 6)
        prediction[0, 4, 0] = .9
        prediction[0, 5:, 0] = 1
        generic.run = lambda _tensor: [prediction, np.ones((1, 32, 4, 4), dtype=np.float32)]
        with patch("mozarie.inference.generic_yolo_segment.letterbox_bgr", return_value=(np.zeros((1, 3, 10, 10)), transform)), patch("mozarie.inference.generic_yolo_segment.restore_box", return_value=None):
            self.assertEqual(generic.detect(np.zeros((10, 10, 3), dtype=np.uint8), .5, "generic"), [])
