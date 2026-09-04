import http.client
import hashlib
import base64
import copy
from dataclasses import replace
from contextlib import nullcontext
import io
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import ANY, MagicMock, Mock, patch

import numpy as np
import cv2
from PIL import Image, ImageOps, PngImagePlugin

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as server_entry  # noqa: E402
import mozarie.core as core_module  # noqa: E402
import mozarie.domain as domain_module  # noqa: E402
import mozarie.http as http_module  # noqa: E402
import mozarie.image_io as image_io_module  # noqa: E402
import mozarie.state as state_module  # noqa: E402
import mozarie.catalog as catalog_module  # noqa: E402
import mozarie.detection as detection_module  # noqa: E402
import mozarie.jobs as jobs_module  # noqa: E402
import mozarie.saving as saving_module  # noqa: E402
import updater  # noqa: E402
from mozarie.core import (  # noqa: E402
    Candidate, CandidateRole, ClientError, DEFAULT_DETECTION_CONFIDENCE,
    ImageRecord, JOB_LABELS, TARGET_CLASSES, accepted_hand_sam_mask,
    accepted_specialist_hand_mask, arbitrate_segment_sources, clip_mask_to_roi,
    confidence_for_source, detection_tiles, mask_iou, merge_segment,
    merge_tile_segment, materialize_tile_mask, restore_tile_mask,
    read_boundary_request, read_detection_confidence, padded_hand_box,
    refine_mask_with_hand, select_best_sam_mask, select_semantic_sam_mask,
    sam_refinement_prompts, LOG_DATE_FORMAT, LOG_FORMAT,
)
from mozarie.image_io import (  # noqa: E402
    calculate_block_size, save_with_mask, _apply_mosaic_to_image, _decode_mask,
    _default_output_destination, render_with_mask,
)
from mozarie.http import MosaicHandler, _read_mosaic_divisor, _read_detection_parallelism, _read_save_suffix  # noqa: E402
from mozarie.state import DetectionModels, StudioState  # noqa: E402
from server import _open_browser, _schedule_browser_open  # noqa: E402


class _MetaDevice:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def fake_catalog_torch(load_result=None):
    return types.SimpleNamespace(
        device=lambda _name: _MetaDevice(),
        load=Mock(return_value={} if load_result is None else load_result),
        cuda=types.SimpleNamespace(is_available=lambda: True),
    )


def reference_apply_mosaic(image, mask, block_size):
    """The pre block-row implementation, retained only for exactness tests."""
    image_array = np.asarray(image)
    width, height = image.size
    selected = mask > 0
    blocks_x = math.ceil(width / block_size)
    block_ids = ((np.arange(height)[:, None] // block_size) * blocks_x + (np.arange(width)[None, :] // block_size)).ravel()
    block_count = math.ceil(height / block_size) * blocks_x
    selected_flat = selected.ravel()
    counts = np.bincount(block_ids, weights=selected_flat.astype(np.int64), minlength=block_count).astype(np.int64)
    valid = counts > 0
    if image.mode == "RGBA":
        output = image_array.copy()
        alpha = image_array[..., 3].astype(np.int64).ravel()
        weights = alpha * selected_flat.astype(np.int64)
        alpha_sums = np.bincount(block_ids, weights=weights, minlength=block_count).astype(np.int64)
        rgb = image_array[..., :3].reshape(-1, 3).astype(np.int64)
        colors = np.zeros((block_count, 3), dtype=np.uint8)
        alpha_valid = alpha_sums > 0
        for channel in range(3):
            sums = np.bincount(block_ids, weights=rgb[:, channel] * weights, minlength=block_count).astype(np.int64)
            colors[alpha_valid, channel] = ((sums[alpha_valid] + alpha_sums[alpha_valid] // 2) // alpha_sums[alpha_valid]).astype(np.uint8)
        target = colors[block_ids].reshape(height, width, 3)
        output[..., :3] = np.where((selected & alpha_valid[block_ids].reshape(height, width))[..., None], target, output[..., :3])
        return output
    channels = 1 if image.mode == "L" else 3
    values = image_array.reshape(-1, channels).astype(np.int64) if channels > 1 else image_array.reshape(-1, 1).astype(np.int64)
    colors = np.zeros((block_count, channels), dtype=np.uint8)
    for channel in range(channels):
        sums = np.bincount(block_ids, weights=values[:, channel] * selected_flat, minlength=block_count).astype(np.int64)
        colors[valid, channel] = ((sums[valid] + counts[valid] // 2) // counts[valid]).astype(np.uint8)
    target = colors[block_ids].reshape(height, width, channels)
    if image.mode == "L":
        output = image_array.copy(); output[selected] = target[..., 0][selected]
        return output
    return np.where(selected[..., None], target, image_array)

def import_images_for_test(state, files):
    """Exercise the binary staging path without retaining the removed JSON API."""
    imported = []
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for index, file_data in enumerate(files):
            raw = file_data.get("raw")
            if raw is None:
                raw = base64.b64decode(file_data.get("data", ""))
            staged = root / f"{index}.upload"
            staged.write_bytes(raw)
            _images, item_imported = state.import_image_file_for_api(
                staged,
                name=file_data.get("name", ""),
                relative_path=file_data.get("relativePath", file_data.get("name", "")),
                client_key=file_data.get("clientKey", str(index)),
                include_images=False,
            )
            imported.extend(item_imported)
    return state.list_images(), imported


def import_image_list_for_test(state, files):
    return import_images_for_test(state, files)[0]


class MozarieTests(unittest.TestCase):
    def setUp(self) -> None:
        self._cache_directory = tempfile.TemporaryDirectory()
        self.cache_dir = Path(self._cache_directory.name) / "cache"
        self._app_directory = tempfile.TemporaryDirectory()
        self.app_dir = Path(self._app_directory.name) / "app"
        config_dir = self.app_dir / "config"
        config_dir.mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[1] / "config" / "defaults.json", config_dir / "defaults.json")
        self._states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in self._states:
            state.shutdown()
        self._app_directory.cleanup()
        self._cache_directory.cleanup()

    def new_state(self, app_dir: Path | None = None) -> StudioState:
        with patch.object(state_module, "APP_DIR", app_dir or self.app_dir):
            state = StudioState(self.cache_dir, self.cache_dir.parent / "sessions")
        self._states.append(state)
        return state

    @staticmethod
    def commit_candidates(state: StudioState, image_id: str) -> int:
        with state.image_io_lock(image_id):
            with state.lock:
                return state._commit_candidate_snapshot(image_id, state.candidates[image_id], replace=True)

    def test_workspace_restores_flags_masks_and_manual_edits_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.commit_candidates(state, image_id)
            state.set_image_flags(image_id, {"hidden": True, "reviewed": True})
            buffer = io.BytesIO(); Image.new("L", (16, 16), 255).save(buffer, format="PNG")
            manual = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
            state.save_manual_workspace(image_id, {"add": manual, "exclusion": "", "exclusionErase": "", "removedCandidateIds": ["candidate"], "candidateRevision": 1, "hasEffectiveMask": True})
            replacement = self.new_state()
            restored = replacement.open_project(state.catalog_id)["images"][0]
            self.assertEqual(restored["id"], image_id)
            self.assertTrue(restored["hidden"])
            self.assertTrue(restored["reviewed"])
            self.assertEqual(replacement.candidate_snapshot(image_id)["candidates"][0]["id"], "candidate")
            self.assertEqual(replacement.manual_workspace(image_id)["removedCandidateIds"], ["candidate"])
            # Candidate metadata is lazy after restart, but every renderer
            # must materialise the selected PNG before it consumes it.
            output, _record, _revision, _token = replacement.render_browser_save(image_id, 1, 100, None)
            self.assertEqual(Image.open(io.BytesIO(output)).size, (16, 16))

    def test_flag_change_keeps_the_visible_state_when_the_workspace_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]
            record = state.images[image_id]
            with patch.object(state.workspace_store, "set_image_flags", side_effect=sqlite3.DatabaseError("write failed")):
                with self.assertRaises(sqlite3.DatabaseError):
                    state.set_image_flags(image_id, {"hidden": True, "reviewed": True})
            self.assertFalse(record.hidden)
            self.assertFalse(record.reviewed)

    def test_detector_prepare_rolls_back_when_catalog_reloads_before_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            candidate = Candidate("candidate", "penis", .9, mask_path)
            generation = state.catalog_generation
            prepare = state.workspace_store.prepare_candidate_state

            def prepare_then_reload(*args, **kwargs):
                pending = prepare(*args, **kwargs)
                # Preserve the same image ID/revision while exercising the real
                # catalogue replacement path (including lock-map clearing).
                state._replace_catalog(record.path.parent, [record])
                return pending

            with state.image_io_lock(image_id), patch.object(state.workspace_store, "prepare_candidate_state", side_effect=prepare_then_reload):
                with self.assertRaises(ClientError):
                    state._commit_candidate_snapshot_outside_state_lock(
                        image_id, [candidate], replace=True, expected_revision=0, expected_catalog_generation=generation,
                    )
            self.assertEqual(state.workspace_store.hydrate_candidates(image_id, state.cache_dir, lambda *_: None), (0, []))
            self.assertEqual(state.candidates.get(image_id, []), [])

    def test_detector_preparation_does_not_block_catalog_polling(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            candidate = Candidate("candidate", "penis", .9, mask_path)
            entered, release = threading.Event(), threading.Event()
            original = state.workspace_store.prepare_candidate_state
            errors = []
            def delayed_prepare(*args, **kwargs):
                entered.set(); self.assertTrue(release.wait(5)); return original(*args, **kwargs)
            def commit() -> None:
                try:
                    with state.image_io_lock(image_id):
                        state._commit_candidate_snapshot_outside_state_lock(
                            image_id, [candidate], replace=True, expected_revision=0,
                            expected_catalog_generation=state.catalog_generation,
                        )
                except Exception as exc: errors.append(exc)
            with patch.object(state.workspace_store, "prepare_candidate_state", side_effect=delayed_prepare), \
                 patch.object(state, "_effective_mask_for_draft", return_value=True):
                worker = threading.Thread(target=commit); worker.start()
                self.assertTrue(entered.wait(2))
                started = time.perf_counter(); snapshot = state.catalog_snapshot(); elapsed = time.perf_counter() - started
                self.assertEqual(snapshot["images"][0]["id"], image_id)
                self.assertLess(elapsed, .25, f"catalog poll was blocked for {elapsed:.3f}s")
                release.set(); worker.join(5)
            self.assertFalse(worker.is_alive()); self.assertEqual(errors, [])

    def test_flag_change_does_not_publish_after_the_catalog_changes_during_a_write(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]
            record = state.images[image_id]
            def change_catalog(_image_id):
                with state.lock: state.catalog_generation += 1
                return False
            with patch.object(state.workspace_store, "has_image", side_effect=change_catalog):
                with self.assertRaises(ClientError) as raised:
                    state.set_image_flags(image_id, {"hidden": True})
            self.assertEqual(raised.exception.error_code, "operation_in_progress")
            self.assertFalse(record.hidden)

    def test_workspace_restore_rejects_corrupt_candidate_without_partial_display(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("a-valid.png", "b-corrupt.png"):
                Image.new("RGB", (16, 16), "white").save(root / name)
            state = self.new_state()
            image_ids = {item["relativePath"]: item["id"] for item in state.set_root(str(root))}
            for name, candidate_id in (("a-valid.png", "valid"), ("b-corrupt.png", "corrupt")):
                image_id = image_ids[name]
                mask_path = state.cache_dir / image_id / f"{candidate_id}.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (16, 16), 255).save(mask_path)
                state.candidates[image_id] = [Candidate(candidate_id, "penis", 0.9, mask_path)]
                self.commit_candidates(state, image_id)
            connection = sqlite3.connect(state.workspace_store.path)
            with connection as db:
                db.execute("UPDATE candidates SET mask_png=? WHERE image_id=? AND candidate_id=?", (b"not a PNG", image_ids["b-corrupt.png"], "corrupt"))
            connection.close()

            replacement = self.new_state()
            with self.assertRaisesRegex(ValueError, "PNG"):
                replacement.open_project(state.catalog_id)
            self.assertEqual(replacement.candidates, {})

    def test_workspace_restore_rejects_invalid_candidate_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.commit_candidates(state, image_id)
            connection = sqlite3.connect(state.workspace_store.path)
            with connection as db:
                db.execute("UPDATE candidates SET role=? WHERE image_id=?", ("not-a-role", image_id))
            connection.close()

            replacement = self.new_state()
            with self.assertRaisesRegex(ValueError, "not-a-role"):
                replacement.open_project(state.catalog_id)
            self.assertEqual(replacement.candidates, {})

    def test_lazy_workspace_candidates_survive_toggle_and_delete_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            candidates = []
            for candidate_id, value in (("first", 255), ("second", 128)):
                mask_path = state.cache_dir / image_id / f"{candidate_id}.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (16, 16), value).save(mask_path)
                candidates.append(Candidate(candidate_id, "penis", 0.9, mask_path))
            state.candidates[image_id] = candidates
            self.commit_candidates(state, image_id)

            reopened = self.new_state()
            reopened.open_project(state.catalog_id)
            self.assertFalse(any(candidate.mask_path.is_file() for candidate in reopened.candidates[image_id]))
            reopened.set_candidate_state(image_id, "first", {"enabled": False})

            after_toggle = self.new_state()
            after_toggle.open_project(state.catalog_id)
            # Listing metadata must not fetch the lazy PNG BLOBs.
            with patch.object(after_toggle.workspace_store, "candidate_png", side_effect=AssertionError("BLOB read")):
                restored = {candidate["id"]: candidate for candidate in after_toggle.candidate_snapshot(image_id)["candidates"]}
            self.assertEqual(set(restored), {"first", "second"})
            self.assertFalse(restored["first"]["enabled"])
            self.assertIsNotNone(after_toggle.workspace_store.candidate_png(image_id, "first"))
            self.assertIsNotNone(after_toggle.workspace_store.candidate_png(image_id, "second"))

            self.assertTrue(after_toggle.delete_candidate(image_id, "first"))
            after_delete = self.new_state()
            after_delete.open_project(state.catalog_id)
            self.assertEqual([candidate["id"] for candidate in after_delete.candidate_snapshot(image_id)["candidates"]], ["second"])

    def test_candidate_mutation_does_not_publish_when_workspace_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.commit_candidates(state, image_id)
            previous_revision = state._candidate_revision(image_id)
            state.save_manual_workspace(image_id, {
                "add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": ["candidate", "stale"],
                "candidateRevision": previous_revision, "hasEffectiveMask": False,
            })
            with state.workspace_store._connect() as db:
                before = tuple(db.execute("SELECT removed_candidate_ids,candidate_revision,has_effective_mask FROM manual_edits WHERE image_id=?", (image_id,)).fetchone())
            with patch.object(state.workspace_store, "commit_candidate_state", side_effect=sqlite3.OperationalError("injected")):
                with self.assertRaises(sqlite3.OperationalError):
                    state.set_candidate_state(image_id, "candidate", {"enabled": False})
            self.assertTrue(state.candidates[image_id][0].enabled)
            self.assertEqual(state._candidate_revision(image_id), previous_revision)
            with state.workspace_store._connect() as db:
                after = tuple(db.execute("SELECT removed_candidate_ids,candidate_revision,has_effective_mask FROM manual_edits WHERE image_id=?", (image_id,)).fetchone())
            self.assertEqual(after, before)

    def test_candidate_padding_rejects_more_than_the_image_long_edge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 10), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 10), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.commit_candidates(state, image_id)
            with self.assertRaisesRegex(ClientError, "0から18") as raised:
                state.set_candidate_state(image_id, "candidate", {"expandPx": 19})
            self.assertEqual(raised.exception.error_code, "input_invalid")

    def test_candidate_padding_updates_metadata_without_rewriting_the_durable_png(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 10), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 10), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.commit_candidates(state, image_id)
            before_png = state.workspace_store.candidate_png(image_id, "candidate")
            revision = state.set_candidate_state(image_id, "candidate", {"expandPx": 3})
            self.assertEqual(state.candidates[image_id][0].expand_px, 3)
            self.assertGreater(revision, 1)
            self.assertEqual(state.workspace_store.candidate_png(image_id, "candidate"), before_png)
            with state.workspace_store._connect() as db:
                self.assertEqual(db.execute("SELECT expand_px FROM candidate_metadata WHERE image_id=? AND candidate_id=?", (image_id, "candidate")).fetchone()["expand_px"], 3)
            self.assertGreater(state.set_candidate_state(image_id, "candidate", {"expandPx": 3}), revision)

    def test_batch_candidate_padding_updates_one_role_without_rewriting_pngs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (16, 10), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            paths = []
            for candidate_id, role in (("apply", CandidateRole.APPLY), ("exclude", CandidateRole.EXCLUDE)):
                path = state.cache_dir / image_id / f"{candidate_id}.png"; path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (16, 10), 255).save(path); paths.append(path)
                state.candidates.setdefault(image_id, []).append(Candidate(candidate_id, "penis" if role == CandidateRole.APPLY else "hand", .9, path, role=role))
            self.commit_candidates(state, image_id)
            before = [state.workspace_store.candidate_png(image_id, candidate_id) for candidate_id in ("apply", "exclude")]
            revision = state.batch_update_candidates(image_id, {"role": "apply", "operation": "set_padding", "expandPx": 4})
            self.assertGreater(revision, 1)
            self.assertEqual([candidate.expand_px for candidate in state.candidates[image_id]], [4, 0])
            self.assertEqual([state.workspace_store.candidate_png(image_id, candidate_id) for candidate_id in ("apply", "exclude")], before)
            for value in (True, 1.5, "4", -1, 19):
                with self.subTest(value=value), self.assertRaises(ClientError):
                    state.batch_update_candidates(image_id, {"role": "apply", "operation": "set_padding", "expandPx": value})

    def test_batch_candidate_padding_rejects_an_empty_role_and_skips_an_identical_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (16, 10), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "apply.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 10), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("apply", "penis", .9, mask_path, expand_px=4)]
            revision = self.commit_candidates(state, image_id)
            with self.assertRaisesRegex(ClientError, "更新する候補") as missing:
                state.batch_update_candidates(image_id, {"role": "exclude", "operation": "set_padding", "expandPx": 4})
            self.assertEqual(missing.exception.error_code, "candidate_not_found")
            self.assertEqual(state.batch_update_candidates(image_id, {"role": "apply", "operation": "set_padding", "expandPx": 4}), revision)
            self.assertEqual(state.candidates[image_id][0].expand_px, 4)

    def test_batch_candidate_padding_undo_redo_and_restart_restore_only_its_role(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (20, 12), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            candidates = []
            for candidate_id, label, role in (("apply-one", "penis", CandidateRole.APPLY), ("apply-two", "pussy", CandidateRole.APPLY), ("exclude", "hand", CandidateRole.EXCLUDE)):
                path = state.cache_dir / image_id / f"{candidate_id}.png"; path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (20, 12), 255).save(path)
                candidates.append(Candidate(candidate_id, label, .9, path, role=role, expand_px=2 if role == CandidateRole.EXCLUDE else 0))
            state.candidates[image_id] = candidates; self.commit_candidates(state, image_id)
            state.save_manual_workspace(image_id, {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": state._candidate_revision(image_id), "hasEffectiveMask": True})
            state.batch_update_candidates(image_id, {"role": "apply", "operation": "set_padding", "expandPx": 5})
            self.assertEqual([item.expand_px for item in state.candidates[image_id]], [5, 5, 2])
            state.restore_project_history(image_id, "undo")
            self.assertEqual([item.expand_px for item in state.candidates[image_id]], [0, 0, 2])
            state.restore_project_history(image_id, "redo")
            self.assertEqual([item.expand_px for item in state.candidates[image_id]], [5, 5, 2])
            reopened = self.new_state(); reopened.open_project(state.catalog_id)
            self.assertEqual([item.expand_px for item in reopened.candidates[image_id]], [5, 5, 2])

    def test_batch_candidate_padding_hundred_candidates_writes_one_history_and_no_png(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (64, 64), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            candidates = []
            for index in range(100):
                candidate_id = f"candidate-{index}"; path = state.cache_dir / image_id / f"{candidate_id}.png"; path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (64, 64), 255).save(path)
                candidates.append(Candidate(candidate_id, "penis", .9, path))
            state.candidates[image_id] = candidates; self.commit_candidates(state, image_id)
            before_pngs = [hashlib.sha256(state.workspace_store.candidate_png(image_id, item.candidate_id)).digest() for item in candidates]
            with state.workspace_store._connect() as db:
                history_before = db.execute("SELECT COUNT(*) AS count FROM history_entries WHERE image_id=?", (image_id,)).fetchone()["count"]
            revision = state._candidate_revision(image_id)
            self.assertEqual(state.batch_update_candidates(image_id, {"role": "apply", "operation": "set_padding", "expandPx": 7}), revision + 1)
            self.assertTrue(all(item.expand_px == 7 for item in state.candidates[image_id]))
            self.assertEqual([hashlib.sha256(state.workspace_store.candidate_png(image_id, item.candidate_id)).digest() for item in candidates], before_pngs)
            with state.workspace_store._connect() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) AS count FROM history_entries WHERE image_id=?", (image_id,)).fetchone()["count"], history_before + 1)

    def test_detect_and_boundary_candidates_receive_the_current_padding_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (20, 12), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]; record = state.image_for_id(image_id)
            state.settings["detection"]["default_candidate_padding_px"] = 4; state._active_detection_default_padding = 4
            mask = np.full((12, 20), 255, dtype=np.uint8)
            segments = [{"class_name": "penis", "confidence": .9, "mask": mask, "source": "target",
                         "image_exclusions": {"hand": mask}, "metadata_exclusions": {"fluid": mask}, "exclusions": {"hand": mask}}]
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                 patch.object(state, "_hand_refinement_context", return_value=(segments, np.zeros_like(mask), [])), \
                 patch.object(state, "_attach_hand_evidence", side_effect=lambda items, *_args: items), \
                 patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, items, *_args: items):
                detected = state._detect_image(Mock(), record, .5)
            self.assertEqual([(item.role.value, item.label_token, item.expand_px) for item in detected], [
                ("exclude", "hand", 4), ("exclude", "fluid", 4), ("apply", "penis", 4), ("exclude", "hand", 4),
            ])
            state.settings["detection"]["default_candidate_padding_px"] = 7; state._active_detection_default_padding = 7
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                 patch.object(state, "_hand_refinement_context", return_value=(segments, np.zeros_like(mask), [])), \
                 patch.object(state, "_attach_hand_evidence", side_effect=lambda items, *_args: items), \
                 patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, items, *_args: items):
                refreshed = state._detect_image(Mock(), record, .5)
            self.assertTrue(all(item.expand_px == 4 for item in detected))
            self.assertTrue(all(item.expand_px == 7 for item in refreshed))
            predictor = Mock(); predictor.predict.return_value = (np.asarray([mask > 0]), np.asarray([.9]), None)
            boundary_segment = [{"class_name": "penis", "mask": mask, "source": "boundary", "image_exclusions": {"hand": mask}, "exclusions": {"fluid": mask}}]
            with patch.object(state, "_sam_predictor_for", return_value=predictor), \
                 patch.object(state, "_boundary_hand_boxes", return_value=[]), \
                 patch.object(state, "_finalize_exclusions", return_value=boundary_segment):
                boundary = state.add_boundary_candidate(image_id, {"roi": {"left": 0, "top": 0, "right": 20, "bottom": 12}, "point": {"x": 10, "y": 6}})
            self.assertEqual([(item["role"], item["labelToken"], item["expandPx"]) for item in boundary["candidates"]], [
                ("apply", "boundary", 7), ("exclude", "hand", 7), ("exclude", "fluid", 7),
            ])

    def test_detector_epoch_stat_and_explicit_padding_guards_preserve_catalogue_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (20, 12), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            pending = state.cache_dir / image_id / ".mozarie-pending-stale.tmp"
            pending.parent.mkdir(parents=True, exist_ok=True); Image.new("L", (20, 12), 255).save(pending, format="PNG")
            candidate = Candidate("stale", "penis", .9, pending)
            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=Mock(), auxiliaries=[])), \
                    patch.object(state, "_detect_image", return_value=[candidate]), \
                    patch.object(state, "_job_is_current", return_value=True), \
                    patch.object(state, "_assert_record_stat_matches", side_effect=ClientError("changed", "stale_asset")), \
                    patch.object(state, "_fail_job") as failed:
                state._detect_worker([record], .5, 1, catalog_generation=None)
            self.assertEqual(failed.call_args.args[0].error_code, "stale_asset")
            self.assertFalse(pending.exists())
            self.assertEqual(state.candidates.get(image_id, []), [])

            # No durable pending transaction exists for a just-removed image,
            # but publication must still reject an old catalogue epoch.
            with patch.object(state.workspace_store, "has_image", return_value=False), \
                    self.assertRaises(ClientError) as stale:
                state._commit_candidate_snapshot_outside_state_lock(
                    image_id, [], replace=True, expected_revision=0,
                    expected_catalog_generation=state.catalog_generation - 1,
                )
            self.assertEqual(stale.exception.error_code, "catalog_changed")
            self.assertEqual(state.candidates.get(image_id, []), [])

            state._active_detection_default_padding = 9
            mask = np.ones((12, 20), dtype=np.uint8)
            segments = [{"class_name": "penis", "confidence": .9, "mask": mask, "source": "target"}]
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                    patch.object(state, "_hand_refinement_context", return_value=(segments, np.zeros_like(mask), [])), \
                    patch.object(state, "_attach_hand_evidence", side_effect=lambda items, *_args: items), \
                    patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, items, *_args: items):
                explicit = state._detect_image(Mock(), record, .5, default_padding=2)
            self.assertEqual([item.expand_px for item in explicit], [2])
            for item in explicit:
                item.mask_path.unlink(missing_ok=True)

    def test_detector_discards_before_publish_when_catalogue_changes_after_stat_check(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (12, 12), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]; record = state.image_for_id(image_id)
            pending = state.cache_dir / image_id / ".mozarie-pending-race.tmp"; pending.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (12, 12), 255).save(pending, format="PNG")
            candidate = Candidate("race", "penis", .9, pending)
            def remove_record(_record):
                state.images.pop(image_id); return None
            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=Mock(), auxiliaries=[])), \
                    patch.object(state, "_detect_image", return_value=[candidate]), \
                    patch.object(state, "_job_is_current", return_value=True), \
                    patch.object(state, "_assert_record_stat_matches", side_effect=remove_record):
                state._detect_worker([record], .5, 1, catalog_generation=state.catalog_generation)
            self.assertFalse(pending.exists())
            self.assertNotIn(image_id, state.candidates)

    def test_candidate_mutation_updates_manual_revision_removed_ids_and_effective_together(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = self.commit_candidates(state, image_id)
            state.save_manual_workspace(image_id, {
                "add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": ["stale"],
                "candidateRevision": revision, "hasEffectiveMask": True,
            })
            revision = state.set_candidate_state(image_id, "candidate", {"enabled": False})
            with state.workspace_store._connect() as db:
                row = db.execute("SELECT removed_candidate_ids,candidate_revision,has_effective_mask FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
            self.assertEqual(json.loads(row["removed_candidate_ids"]), [])
            self.assertEqual(row["candidate_revision"], revision)
            self.assertFalse(row["has_effective_mask"])

    def test_manual_save_failure_leaves_the_existing_workspace_row_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            original = {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": False}
            state.save_manual_workspace(image_id, original)
            before = state.manual_workspace(image_id)
            with patch.object(state.workspace_store, "save_manual", side_effect=sqlite3.OperationalError("injected")):
                with self.assertRaises(sqlite3.OperationalError):
                    state.save_manual_workspace(image_id, {**original, "manualEnabled": False})
            self.assertEqual(state.manual_workspace(image_id), before)

    def test_manual_save_and_candidate_toggle_serialize_to_one_final_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.commit_candidates(state, image_id)
            entered = threading.Event(); release = threading.Event()
            original_save = state.workspace_store.save_manual

            def delayed_save(*args, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                return original_save(*args, **kwargs)

            draft = {"add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": 1, "hasEffectiveMask": False}
            with patch.object(state.workspace_store, "save_manual", side_effect=delayed_save):
                manual = threading.Thread(target=lambda: state.save_manual_workspace(image_id, draft))
                manual.start(); self.assertTrue(entered.wait(2))
                toggle = threading.Thread(target=lambda: state.set_candidate_state(image_id, "candidate", {"enabled": False}))
                toggle.start(); time.sleep(0.05)
                self.assertTrue(toggle.is_alive())
                release.set(); manual.join(2); toggle.join(2)
            self.assertFalse(manual.is_alive()); self.assertFalse(toggle.is_alive())
            revision = state._candidate_revision(image_id)
            self.assertEqual(revision, 2)
            self.assertEqual(state.workspace_store.manual_mask_statuses([image_id])[image_id], (False, revision))

    def test_catalog_snapshot_uses_the_persisted_manual_effective_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("auto-manual.png", "manual-only.png", "erase-restored.png", "auto-only.png"):
                Image.new("RGB", (12, 12), "white").save(root / name)
            state = self.new_state()
            ids = {item["relativePath"]: item["id"] for item in state.set_root(str(root))}
            for name in ("auto-manual.png", "erase-restored.png", "auto-only.png"):
                image_id = ids[name]
                mask_path = state.cache_dir / image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(12, 12)).save(mask_path)
                state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
                self.commit_candidates(state, image_id)
            raw = io.BytesIO(); Image.fromarray(self._mask(12, 12)).save(raw, format="PNG")
            mask = "data:image/png;base64," + base64.b64encode(raw.getvalue()).decode("ascii")
            state.save_manual_workspace(ids["auto-manual.png"], {"add": "", "exclusion": mask, "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": 1, "hasEffectiveMask": False})
            state.save_manual_workspace(ids["manual-only.png"], {"add": mask, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": True})
            state.save_manual_workspace(ids["erase-restored.png"], {"add": "", "exclusion": mask, "exclusionErase": "", "removedCandidateIds": [], "candidateRevision": 1, "hasEffectiveMask": False})
            state.save_manual_workspace(ids["erase-restored.png"], {"add": "", "exclusion": mask, "exclusionErase": mask, "removedCandidateIds": [], "candidateRevision": 1, "hasEffectiveMask": True})

            expected = {
                ids["auto-manual.png"]: False,
                ids["manual-only.png"]: True,
                ids["erase-restored.png"]: True,
                ids["auto-only.png"]: True,
            }
            self.assertEqual({item["id"]: item["hasEffectiveMask"] for item in state.catalog_snapshot()["images"]}, expected)

            reopened = self.new_state()
            reopened.open_project(state.catalog_id)
            with patch.object(reopened.workspace_store, "manual", side_effect=AssertionError("manual draft read")):
                self.assertEqual({item["id"]: item["hasEffectiveMask"] for item in reopened.catalog_snapshot()["images"]}, expected)

    def test_incremental_exclusion_erase_keeps_the_other_manual_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (12, 12), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(12, 12)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", .9, mask_path)]
            revision = self.commit_candidates(state, image_id)
            raw = io.BytesIO(); Image.fromarray(self._mask(12, 12)).save(raw, format="PNG")
            mask = "data:image/png;base64," + base64.b64encode(raw.getvalue()).decode("ascii")
            state.save_manual_workspace(image_id, {
                "add": "", "exclusion": mask, "exclusionErase": "", "removedCandidateIds": [],
                "candidateRevision": revision, "hasEffectiveMask": False,
            })
            state.save_manual_workspace(image_id, {
                "dirtyLayers": ["exclusionErase"], "exclusionErase": mask, "removedCandidateIds": [],
                "candidateRevision": revision, "hasEffectiveMask": False,
            })
            restored = state.manual_workspace(image_id)
            self.assertEqual(restored["exclusion"], mask)
            self.assertEqual(restored["exclusionErase"], mask)
            self.assertTrue(restored["hasEffectiveMask"])

    def test_effective_mask_status_tracks_candidate_apply_and_full_exclude(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (12, 12), "white").save(root / "source.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            apply_path = state.cache_dir / image_id / "apply.png"; exclude_path = state.cache_dir / image_id / "exclude.png"
            apply_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(np.full((12, 12), 255, dtype=np.uint8)).save(apply_path)
            Image.fromarray(np.full((12, 12), 255, dtype=np.uint8)).save(exclude_path)
            state.candidates[image_id] = [
                Candidate("apply", "penis", 0.9, apply_path),
                Candidate("exclude", "hand", None, exclude_path, source="hand_exclusion", role=CandidateRole.EXCLUDE),
            ]
            self.commit_candidates(state, image_id)
            state.set_candidate_state(image_id, "apply", {"enabled": True})
            self.assertFalse(state.catalog_snapshot()["images"][0]["hasEffectiveMask"])
            state.set_candidate_state(image_id, "exclude", {"enabled": False})
            self.assertTrue(state.catalog_snapshot()["images"][0]["hasEffectiveMask"])
            state.set_candidate_state(image_id, "apply", {"enabled": False})
            self.assertFalse(state.catalog_snapshot()["images"][0]["hasEffectiveMask"])
            reopened = self.new_state(); reopened.open_project(state.catalog_id)
            self.assertFalse(reopened.catalog_snapshot()["images"][0]["hasEffectiveMask"])

    def test_session_import_path_collision_keeps_native_image_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native_path = root / "001.png"
            Image.new("RGB", (16, 16), "red").save(native_path)
            state = self.new_state()
            native_id = state.set_root(str(root))[0]["id"]
            state.set_image_flags(native_id, {"hidden": True, "reviewed": True})
            mask_path = state.cache_dir / native_id / "native.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("L", (16, 16), 255).save(mask_path)
            state.candidates[native_id] = [Candidate("native", "penis", 0.9, mask_path)]
            self.commit_candidates(state, native_id)

            upload = io.BytesIO(); Image.new("RGB", (16, 16), "blue").save(upload, format="PNG")
            with tempfile.TemporaryDirectory() as staging_directory:
                staged = Path(staging_directory) / "001.upload"
                staged.write_bytes(upload.getvalue())
                _images, imported = state.import_image_file_for_api(
                    staged, name="001.png", relative_path="001.png", client_key="collision", include_images=False,
                )
            added_id = imported[0]["imageId"]
            self.assertNotEqual(added_id, native_id)
            listed = {item["id"]: item for item in state.list_images()}
            self.assertEqual(listed[native_id]["relativePath"], "001.png")
            self.assertEqual(listed[added_id]["relativePath"], "001 (2).png")
            self.assertTrue(listed[native_id]["hidden"])
            self.assertTrue(listed[native_id]["reviewed"])
            self.assertEqual(state.candidate_snapshot(native_id)["candidates"][0]["id"], "native")

    def test_clear_masks_removes_workspace_manual_edits_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (12, 12), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            raw = io.BytesIO(); Image.new("L", (12, 12), 255).save(raw, format="PNG")
            draft = "data:image/png;base64," + base64.b64encode(raw.getvalue()).decode("ascii")
            state.save_manual_workspace(image_id, {"add": draft, "exclusion": draft, "exclusionErase": draft, "removedCandidateIds": ["old"], "candidateRevision": 0, "hasEffectiveMask": False})
            state.clear_masks([image_id])
            reopened = self.new_state()
            reopened.open_project(state.catalog_id)
            self.assertIsNone(reopened.manual_workspace(image_id))

    def _import_browser_manifest(self, state, files, catalog_id=None):
        if catalog_id is None:
            state.clear_catalog()
            state.catalog_id = state.workspace_store.ensure_provisional_catalog()
            state.browser_catalog_provisional = True
        else:
            state.activate_browser_catalog(catalog_id)
        imported = {}
        with tempfile.TemporaryDirectory() as directory:
            staging = Path(directory)
            for index, (relative_path, raw) in enumerate(files):
                upload = staging / f"{index}.upload"
                upload.write_bytes(raw)
                _images, items = state.import_image_file_for_api(
                    upload, name=Path(relative_path).name, relative_path=relative_path,
                    client_key=f"manifest-{index}", include_images=False, mtime_ns=20, size_bytes=len(raw),
                )
                imported[relative_path] = items[0]["imageId"]
        return imported

    def test_browser_import_creates_explicit_project_without_content_reuse(self):
        def png(color):
            buffer = io.BytesIO(); Image.new("RGB", (12, 12), color).save(buffer, format="PNG"); return buffer.getvalue()

        initial = [("a.png", png("red")), ("b.png", png("green")), ("nested/c.png", png("blue"))]
        first = self.new_state()
        self._import_browser_manifest(first, initial)
        first_catalog, _ = first.finalize_browser_catalog()
        second = self.new_state()
        self._import_browser_manifest(second, [("a.png", png("yellow")), *initial[1:]])
        second_catalog, remapped = second.finalize_browser_catalog()
        self.assertNotEqual(second_catalog, first_catalog)
        self.assertEqual(remapped, {})

    def test_browser_manifest_add_delete_and_same_name_content_are_isolated(self):
        def png(color):
            buffer = io.BytesIO(); Image.new("RGB", (10, 10), color).save(buffer, format="PNG"); return buffer.getvalue()

        first = self.new_state()
        files = [("folder/001.png", png("red")), ("folder/002.png", png("green")), ("folder/003.png", png("blue"))]
        self._import_browser_manifest(first, files)
        first_catalog, _ = first.finalize_browser_catalog()

        second = self.new_state()
        self._import_browser_manifest(second, [files[0], files[1], ("folder/new.png", png("white"))])
        second_catalog, _ = second.finalize_browser_catalog()
        self.assertNotEqual(second_catalog, first_catalog)

        # Same paths/folder names but different bytes cannot cross-contaminate.
        isolated = self.new_state()
        self._import_browser_manifest(isolated, [("folder/001.png", png("black")), ("folder/002.png", png("gray"))])
        isolated_catalog, _ = isolated.finalize_browser_catalog()
        self.assertNotEqual(isolated_catalog, first_catalog)

    def test_explicit_browser_catalog_never_reassigns_and_restores_state(self):
        buffer = io.BytesIO(); Image.new("RGB", (10, 10), "purple").save(buffer, format="PNG")
        files = [("same/001.png", buffer.getvalue()), ("same/002.png", buffer.getvalue())]
        first = self.new_state()
        ids = self._import_browser_manifest(first, files)
        catalog_id, _ = first.finalize_browser_catalog()
        assert catalog_id is not None
        first.set_image_flags(ids["same/001.png"], {"hidden": True, "reviewed": True})

        # Selecting the same File System Access handle is a full reimport,
        # not an append to the previous session directory.
        repeated_ids = self._import_browser_manifest(first, files, catalog_id)
        self.assertEqual({item["relativePath"] for item in first.list_images()}, {"same/001.png", "same/002.png"})
        repeated = {item["id"]: item for item in first.list_images()}
        self.assertTrue(repeated[repeated_ids["same/001.png"]]["hidden"])
        self.assertEqual(repeated_ids["same/001.png"], ids["same/001.png"])

        reopened = self.new_state()
        reopened_ids = self._import_browser_manifest(reopened, files, catalog_id)
        finalized, remapped = reopened.finalize_browser_catalog()
        self.assertEqual(finalized, catalog_id)
        self.assertEqual(remapped, {})
        restored = {item["id"]: item for item in reopened.list_images()}
        self.assertTrue(restored[reopened_ids["same/001.png"]]["hidden"])
        self.assertTrue(restored[reopened_ids["same/001.png"]]["reviewed"])

    def test_browser_manifest_never_reuses_native_catalog(self):
        def png(color):
            buffer = io.BytesIO(); Image.new("RGB", (10, 10), color).save(buffer, format="PNG"); return buffer.getvalue()

        files = [("same/a.png", png("red")), ("same/b.png", png("blue"))]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative_path, raw in files:
                path = root / relative_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
            native = self.new_state()
            native_ids = native.set_root(str(root))
            native_records = [native.image_for_id(item["id"]) for item in native_ids]
            native.workspace_store.reconcile_images(native.catalog_id, native_records)
            native_catalog = native.catalog_id

            browser = self.new_state()
            self._import_browser_manifest(browser, files)
            browser_catalog, _ = browser.finalize_browser_catalog()
            self.assertNotEqual(browser_catalog, native_catalog)

    def test_browser_manifest_is_never_content_matched(self):
        buffer = io.BytesIO(); Image.new("RGB", (8, 8), "teal").save(buffer, format="PNG")
        raw = buffer.getvalue()
        many = [(f"root/{index:03}.png", raw) for index in range(100)]
        target = self.new_state()
        self._import_browser_manifest(target, many)
        target_catalog, _ = target.finalize_browser_catalog()
        self.assertIsNone(target.workspace_store.best_catalog_for_manifest([], "f" * 32))

        one = [("only.png", raw)]
        single = self.new_state(); self._import_browser_manifest(single, one)
        single_catalog, _ = single.finalize_browser_catalog()
        self.assertIsNone(single.workspace_store.best_catalog_for_manifest([], "e" * 32))

        clone = self.new_state()
        clone_id = clone.workspace_store.ensure_catalog()
        self._import_browser_manifest(clone, one, clone_id)  # A separate finalized but equal folder.
        third = self.new_state(); self._import_browser_manifest(third, one)
        third_catalog, _ = third.finalize_browser_catalog()
        self.assertNotIn(third_catalog, {single_catalog, clone.catalog_id, target_catalog})

    def test_builtin_output_directory_is_created_for_default_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_dir = root / "app"
            config = app_dir / "config"
            config.mkdir(parents=True)
            defaults = json.loads((Path(__file__).resolve().parents[1] / "config" / "defaults.json").read_text(encoding="utf-8"))
            defaults["saving"].pop("default_output_directory")
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            source_dir = root / "images"
            source_dir.mkdir()
            Image.new("RGB", (16, 16), "white").save(source_dir / "source.png")

            state = self.new_state(app_dir)
            self.assertEqual(state.settings["saving"]["default_output_directory"], str((app_dir / "output").resolve()))
            image_id = state.set_root(str(source_dir))[0]["id"]
            self.assertTrue(state.start_apply([image_id], 100, {image_id: self._mask(16, 16)}, copy_to_default=True))
            assert state.worker_thread is not None
            state.worker_thread.join(2)

            self.assertEqual(state.job.state, "complete")
            self.assertTrue((app_dir / "output" / "source_censored.png").is_file())

    def test_apply_overwrite_updates_live_catalog_asset_version(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            asset_version = state.asset_version(record)
            asset_revision = record.asset_revision

            self.assertTrue(state.start_apply([image_id], 100, {image_id: self._mask(16, 16)}))
            assert state.worker_thread is not None
            state.worker_thread.join(2)

            self.assertFalse(state.worker_thread.is_alive())
            self.assertEqual(state.job.state, "complete")
            live_record = state.image_for_id(image_id)
            output_stat = source.stat()
            self.assertEqual(live_record.mtime_ns, output_stat.st_mtime_ns)
            self.assertEqual(live_record.size_bytes, output_stat.st_size)
            self.assertEqual(live_record.asset_revision, asset_revision + 1)
            self.assertNotEqual(state.asset_version(live_record), asset_version)

    def test_output_directory_picker_is_not_a_server_api(self):
        self.assertFalse(hasattr(http_module, "_pick_output_directory"))

    def test_model_file_picker_uses_fixed_powershell_and_validates_selection(self):
        state = self.new_state()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            executable.parent.mkdir(parents=True); executable.touch()
            selected = root / "model.onnx"; selected.touch()
            completed = types.SimpleNamespace(returncode=0, stdout=base64.b64encode(str(selected).encode("utf-8")))
            with patch.dict(http_module.os.environ, {"SystemRoot": str(root)}, clear=False), patch.object(http_module.subprocess, "run", return_value=completed) as run:
                self.assertEqual(http_module._pick_model_file("target_segmentation", state, str(selected)), str(selected.resolve()))
                picker_kwargs = run.call_args.kwargs
                command = run.call_args.args[0]
                with self.assertRaisesRegex(ClientError, "正しくありません"):
                    http_module._pick_model_file("sam_checkpoint", state)
            script = base64.b64decode(command[-1]).decode("utf-16le")
            self.assertIn("OpenFileDialog", script)
            self.assertIn("RestoreDirectory", script)
            self.assertIn("FormStartPosition]::CenterScreen", script)
            self.assertIn("ShowDialog($owner)", script)
            self.assertIn("$dialog.Dispose(); $owner.Close(); $owner.Dispose()", script)
            self.assertNotIn("-32000", script)
            self.assertFalse(picker_kwargs["shell"])
            self.assertEqual(picker_kwargs["env"]["MOZARIE_MODEL_INITIAL_DIRECTORY"], str(root))
            self.assertTrue(state.native_picker_lock.acquire(blocking=False)); state.native_picker_lock.release()
            state.native_picker_lock.acquire()
            try:
                with self.assertRaisesRegex(ClientError, "選択を開いています"):
                    http_module._pick_model_file("target_segmentation", state)
            finally:
                state.native_picker_lock.release()

    def test_import_staging_gate_allows_ten_concurrent_uploads(self):
        state = self.new_state()
        acquired = [state.import_staging_gate.acquire(blocking=False) for _ in range(10)]
        try:
            self.assertEqual(acquired, [True] * 10)
            self.assertFalse(state.import_staging_gate.acquire(blocking=False))
        finally:
            for acquired_one in acquired:
                if acquired_one: state.import_staging_gate.release()

    def test_model_file_picker_releases_its_lock_after_cancel_and_bad_results(self):
        state = self.new_state()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            executable.parent.mkdir(parents=True); executable.touch()
            cases = [
                (types.SimpleNamespace(returncode=0, stdout=b""), None),
                (types.SimpleNamespace(returncode=1, stdout=b""), "model_picker_failed"),
                (types.SimpleNamespace(returncode=0, stdout=b"not-base64"), "model_picker_invalid"),
            ]
            for completed, error_code in cases:
                with patch.dict(http_module.os.environ, {"SystemRoot": str(root)}, clear=False), \
                     patch.object(http_module.subprocess, "run", return_value=completed):
                    if error_code is None:
                        self.assertIsNone(http_module._pick_model_file("target_segmentation", state))
                    else:
                        with self.assertRaises(ClientError) as raised:
                            http_module._pick_model_file("target_segmentation", state)
                        self.assertEqual(raised.exception.error_code, error_code)
                self.assertTrue(state.native_picker_lock.acquire(blocking=False))
                state.native_picker_lock.release()

    def test_model_download_api_uses_existing_mutation_guards_and_allowlist(self):
        from http.server import ThreadingHTTPServer

        state = self.new_state()
        manager = Mock(snapshot=Mock(return_value={"state": "idle", "paths": {}}), start=Mock(return_value={"state": "running", "paths": {}}), cancel=Mock(return_value={"state": "cancelled", "paths": {}}))
        state.model_downloads = manager
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        origin = f"http://127.0.0.1:{httpd.server_port}"
        def request(method, path, payload=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                body = None if payload is None else json.dumps(payload).encode("utf-8")
                connection.request(method, path, body, headers or {})
                response = connection.getresponse(); data = response.read(); return response.status, data
            finally:
                connection.close()
        try:
            with patch.object(http_module, "STATE", state):
                status, body = request("GET", "/api/model-download")
                self.assertEqual(status, 200); self.assertEqual(json.loads(body)["state"], "idle")
                status, _ = request("POST", "/api/model-download/start", {"modelKey": "hand_detection", "samType": "vit_b"}, {"Content-Type": "application/json"})
                self.assertEqual(status, 403)
                headers = {"Content-Type": "application/json", "Origin": origin, "X-Mozarie-Token": state.session_token}
                status, _ = request("POST", "/api/model-download/start", {"modelKey": "hand_detection", "samType": "vit_b", "url": "https://evil.example/model"}, headers)
                self.assertEqual(status, 200)
                manager.start.assert_called_once_with("hand_detection", "vit_b")
                status, _ = request("POST", "/api/model-download/cancel", {}, headers)
                self.assertEqual(status, 200); manager.cancel.assert_called_once_with()
                manager.start.side_effect = http_module.ModelDownloadInProgress()
                status, body = request("POST", "/api/model-download/start", {"modelKey": "hand_detection", "samType": "vit_b"}, headers)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(body)["error_code"], "operation_in_progress")
        finally:
            httpd.shutdown(); httpd.server_close()

    def test_settings_status_preview_does_not_save_or_replace_settings(self):
        state = self.new_state()
        original = copy.deepcopy(state.settings)
        preview = copy.deepcopy(state.settings)
        preview["models"]["target_segmentation"] = "unsaved.onnx"
        status = {"models": {"target_segmentation": {"valid": False, "reasonCode": "missing"}}}
        with patch.object(state.settings_store, "validate_update", return_value=preview) as validate, \
             patch.object(state.settings_store, "save") as save, \
             patch.object(state, "settings_status", return_value=status) as settings_status:
            self.assertEqual(state.preview_settings_status(preview), status)
        validate.assert_called_once_with(preview)
        settings_status.assert_called_once_with(preview)
        save.assert_not_called()
        self.assertEqual(state.settings, original)

    def test_cuda_status_matches_pytorch_cubin_compatibility_and_keeps_cpu_fallback_valid(self):
        cuda = types.SimpleNamespace(
            is_available=lambda: True,
            get_arch_list=lambda: ["sm_80", "sm_86", "compute_89", "sm_120"],
            device_count=lambda: 3,
            get_device_capability=lambda index: [(8, 9), (6, 1), (12, 1)][index],
            get_device_name=lambda index: ["RTX 4090", "GTX 1060", "RTX 5090"][index],
            get_device_properties=lambda index: types.SimpleNamespace(total_memory=[24, 3, 32][index] * 1024 ** 3),
        )
        self.assertEqual(state_module.cuda_device_statuses(types.SimpleNamespace(cuda=cuda)), [
            {"id": 0, "name": "RTX 4090", "architecture": "sm_89", "totalMemory": 24 * 1024 ** 3, "supported": True},
            {"id": 1, "name": "GTX 1060", "architecture": "sm_61", "totalMemory": 3 * 1024 ** 3, "supported": False},
            {"id": 2, "name": "RTX 5090", "architecture": "sm_121", "totalMemory": 32 * 1024 ** 3, "supported": True},
        ])
        state = self.new_state()
        state.settings["models"].update({"provider": "gpu", "gpu_device": 1})
        with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=cuda)):
            status = state.settings_status()
        self.assertFalse(status["gpuDeviceValid"])
        self.assertEqual(status["gpuDeviceReasonCode"], "gpu_unsupported")
        state.settings["models"]["provider"] = "cpu"
        with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=cuda)):
            self.assertTrue(state.settings_status()["gpuDeviceValid"])

    def test_cuda_status_treats_an_empty_pytorch_arch_list_as_unchecked(self):
        cuda = types.SimpleNamespace(
            is_available=lambda: True,
            get_arch_list=lambda: [],
            device_count=lambda: 1,
            get_device_capability=lambda _index: (6, 1),
            get_device_name=lambda _index: "GTX 1060",
            get_device_properties=lambda _index: types.SimpleNamespace(total_memory=3 * 1024 ** 3),
        )
        self.assertTrue(state_module.cuda_device_statuses(types.SimpleNamespace(cuda=cuda))[0]["supported"])

    def test_health_reports_missing_gpu_but_keeps_cpu_configuration_valid(self):
        state = self.new_state()
        no_cuda = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        state.settings["models"].update({"provider": "gpu", "gpu_device": 0})
        with patch.object(state_module, "torch_module", return_value=no_cuda):
            missing = state.settings_status()
        self.assertEqual(missing["gpus"], [])
        self.assertFalse(missing["gpuDeviceValid"])
        self.assertEqual(missing["gpuDeviceReasonCode"], "gpu_unsupported")

        state.settings["models"]["provider"] = "cpu"
        with patch.object(state_module, "torch_module", return_value=no_cuda):
            cpu = state.settings_status()
        self.assertEqual(cpu["gpus"], [])
        self.assertTrue(cpu["gpuDeviceValid"])
        self.assertIsNone(cpu["gpuDeviceReasonCode"])

    def test_settings_rejects_an_unknown_or_unsupported_gpu_selection(self):
        cuda = types.SimpleNamespace(
            is_available=lambda: True,
            get_arch_list=lambda: ["sm_89"],
            device_count=lambda: 2,
            get_device_capability=lambda index: [(8, 9), (6, 1)][index],
            get_device_name=lambda index: ["RTX Test", "Legacy Test"][index],
            get_device_properties=lambda index: types.SimpleNamespace(total_memory=[16, 3][index] * 1024 ** 3),
        )
        state = self.new_state()
        state.settings["models"].update({"provider": "cpu", "gpu_device": 0})
        for gpu_device in (1, 9):
            with self.subTest(gpu_device=gpu_device):
                update = copy.deepcopy(state.settings)
                update["models"].update({"provider": "gpu", "gpu_device": gpu_device})
                with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=cuda)), \
                     patch.object(state.settings_store, "save") as save, \
                     self.assertRaisesRegex(ClientError, "選択したGPU") as raised:
                    state.update_settings(update)
                self.assertEqual(raised.exception.error_code, "gpu_unsupported")
                save.assert_not_called()

        update = copy.deepcopy(state.settings)
        update["models"].update({"provider": "gpu", "gpu_device": 0})
        with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=cuda)), \
             patch.object(state.settings_store, "save", return_value=update) as save:
            state.update_settings(update)
        save.assert_called_once_with(update)

        unchanged_invalid = copy.deepcopy(state.settings)
        unchanged_invalid["models"].update({"provider": "gpu", "gpu_device": 1})
        state.settings = unchanged_invalid
        with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=cuda)), \
             patch.object(state.settings_store, "save") as save, \
             self.assertRaisesRegex(ClientError, "選択したGPU") as raised:
            state.update_settings(unchanged_invalid)
        self.assertEqual(raised.exception.error_code, "gpu_unsupported")
        save.assert_not_called()

    def test_detection_rejects_an_unsupported_gpu_before_loading_models(self):
        state = self.new_state()
        state.settings["models"].update({"provider": "gpu", "gpu_device": 1})
        cuda = types.SimpleNamespace(
            is_available=lambda: True,
            get_arch_list=lambda: ["sm_89"],
            device_count=lambda: 2,
            get_device_capability=lambda index: [(8, 9), (6, 1)][index],
            get_device_name=lambda index: ["RTX Test", "Legacy Test"][index],
            get_device_properties=lambda index: types.SimpleNamespace(total_memory=[16, 3][index] * 1024 ** 3),
        )
        with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=cuda)), \
             patch.object(state, "_start_job") as start:
            with self.assertRaisesRegex(ClientError, "選択したGPU") as raised:
                state.start_detection([])
        self.assertEqual(raised.exception.error_code, "gpu_unsupported")
        start.assert_not_called()

    def test_cuda_status_ignores_ptx_only_arches(self):
        cuda = types.SimpleNamespace(
            is_available=lambda: True,
            get_arch_list=lambda: ["compute_61"],
            device_count=lambda: 1,
            get_device_capability=lambda _index: (6, 1),
            get_device_name=lambda _index: "GTX 1060",
            get_device_properties=lambda _index: types.SimpleNamespace(total_memory=3 * 1024 ** 3),
        )
        self.assertFalse(state_module.cuda_device_statuses(types.SimpleNamespace(cuda=cuda))[0]["supported"])

    def test_hand_segmentation_status_is_disabled_without_hand_detection(self):
        state = self.new_state()
        state.settings["models"].update({"hand_detection_enabled": False, "hand_segmentation_enabled": True})
        status = state.settings_status()["models"]["hand_segmentation"]
        self.assertFalse(status["enabled"])

    def test_sam_variant_statuses_are_lightweight_and_distinguish_managed_external_and_mismatch(self):
        state = self.new_state()
        managed = self.app_dir / "models" / "sam_vit_b_01ec64.pth"
        managed.parent.mkdir(); managed.write_bytes(b"b")
        external = self.app_dir.parent / "external.ckpt"; external.write_bytes(b"l")
        mismatch = self.app_dir.parent / "sam_vit_l_0b3195.pth"; mismatch.write_bytes(b"h")
        state.settings["models"]["sam_checkpoints"] = {
            "vit_b": str(managed), "vit_l": str(external), "vit_h": str(mismatch),
        }
        with patch.object(state_module, "torch_module", return_value=types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))):
            variants = state.settings_status()["samVariants"]
        self.assertTrue(variants["vit_b"]["valid"]); self.assertTrue(variants["vit_b"]["managed"])
        self.assertTrue(variants["vit_l"]["valid"]); self.assertFalse(variants["vit_l"]["managed"])
        self.assertFalse(variants["vit_h"]["valid"]); self.assertEqual(variants["vit_h"]["reasonCode"], "type_mismatch")

    def test_import_transfer_blocks_catalog_mutation_while_http_body_is_pending(self):
        from http.server import ThreadingHTTPServer

        state = self.new_state()
        source = state.cache_dir.parent / "source.png"
        source.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (8, 8), "white").save(source)
        record = self._record(source, 8, 8)
        state.root = source.parent
        state.images = {record.image_id: record}
        state.order = [record.image_id]
        state.candidates = {record.image_id: []}
        state.candidate_revisions = {record.image_id: 0}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        entered = threading.Event(); release = threading.Event(); result = {}
        staged = state.cache_dir / "pending.upload.tmp"
        staged.parent.mkdir(parents=True, exist_ok=True)
        origin = f"http://127.0.0.1:{httpd.server_port}"

        def read_body(_handler):
            entered.set()
            self.assertTrue(release.wait(3))
            _handler.rfile.read(1)
            staged.write_bytes(b"x")
            return staged

        def upload():
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                connection.request("POST", "/api/import/file", b"x", {
                    "Content-Type": "application/octet-stream", "X-Mozarie-Name": "image.png",
                    "X-Mozarie-Relative-Path": "image.png", "X-Mozarie-Client-Key": "client",
                    "X-Mozarie-Token": state.session_token, "Origin": origin,
                })
                response = connection.getresponse(); result["status"] = response.status; response.read()
            finally:
                connection.close()

        try:
            with patch.object(http_module, "STATE", state), \
                 patch.object(MosaicHandler, "_read_binary_body_to_file", read_body), \
                 patch.object(state, "import_image_file_for_api", return_value=([], [])):
                upload_thread = threading.Thread(target=upload)
                upload_thread.start()
                self.assertTrue(entered.wait(3))
                self.assertEqual(state.active_import_count, 1)
                mutations = [
                    ("/api/catalog/clear", {}),
                    ("/api/folder", {"path": str(source.parent)}),
                    ("/api/settings", state.settings),
                    ("/api/detect", {"imageIds": [record.image_id], "confidence": 0.5, "parallelism": 1}),
                ]
                for path, payload in mutations:
                    mutation = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        mutation.request("POST", path, json.dumps(payload).encode("utf-8"), {
                            "Content-Type": "application/json", "X-Mozarie-Token": state.session_token, "Origin": origin,
                        })
                        response = mutation.getresponse(); response.read()
                        self.assertEqual(response.status, 400, path)
                    finally:
                        mutation.close()
                release.set(); upload_thread.join(5)
                self.assertFalse(upload_thread.is_alive())
                self.assertEqual(result["status"], 200)
                self.assertEqual(state.active_import_count, 0)
                self.assertFalse(staged.exists())
        finally:
            release.set()
            httpd.shutdown(); httpd.server_close()

    def test_rejected_import_transfer_closes_the_unread_request_connection(self):
        from http.server import ThreadingHTTPServer

        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running", total=1)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(http_module, "STATE", state), patch.object(MosaicHandler, "_read_binary_body_to_file") as read_body:
                try:
                    connection.request("POST", "/api/import/file", b"unread", {
                        "Content-Type": "application/octet-stream", "X-Mozarie-Name": "image.png",
                        "X-Mozarie-Relative-Path": "image.png", "X-Mozarie-Client-Key": "client",
                        "X-Mozarie-Token": state.session_token, "Origin": f"http://127.0.0.1:{httpd.server_port}",
                    })
                    response = connection.getresponse(); response.read()
                except http_module.CLIENT_DISCONNECT_ERRORS:
                    response = None
                read_body.assert_not_called()
            if response is not None:
                self.assertEqual(response.status, 400)
                self.assertEqual(response.getheader("Connection"), "close")
        finally:
            connection.close()
            httpd.shutdown(); httpd.server_close()

    @staticmethod
    def _record(path: Path, width: int, height: int) -> ImageRecord:
        return ImageRecord(
            image_id="test", path=path, relative_path=path.name, width=width, height=height,
            mtime_ns=path.stat().st_mtime_ns, size_bytes=path.stat().st_size,
        )

    @staticmethod
    def _mask(width: int, height: int) -> np.ndarray:
        mask = np.zeros((height, width), dtype=np.uint8)
        mask[4:12, 4:12] = 255
        return mask

    @staticmethod
    def _jpeg_segment(marker: int, payload: bytes) -> bytes:
        return b"\xff" + bytes([marker]) + (len(payload) + 2).to_bytes(2, "big") + payload

    def test_block_size_uses_image_specific_divisor_and_minimum(self):
        self.assertEqual(calculate_block_size(300, 200, 100), 4)
        self.assertEqual(calculate_block_size(400, 220, 100), 4)
        self.assertEqual(calculate_block_size(401, 220, 100), 5)
        self.assertEqual(calculate_block_size(1000, 999, 100), 10)
        self.assertEqual(calculate_block_size(1216, 832, 100), 13)
        self.assertEqual(calculate_block_size(1301, 832, 100), 14)
        self.assertEqual(calculate_block_size(1301, 832, 200), 7)
        self.assertEqual(_read_mosaic_divisor("100"), 100)
        with self.assertRaises(ClientError):
            _read_mosaic_divisor(0)

    @staticmethod
    def _png_data_url(image: Image.Image) -> str:
        encoded = io.BytesIO()
        image.save(encoded, format="PNG")
        return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")

    def test_decode_mask_uses_alpha_not_transparent_rgb(self):
        rgba = np.full((8, 8, 4), 255, dtype=np.uint8)
        rgba[..., 3] = 0
        rgba[2:4, 3:5, 3] = 255

        decoded = image_io_module._decode_mask(self._png_data_url(Image.fromarray(rgba)), 8, 8)

        self.assertEqual(np.count_nonzero(decoded), 4)
        self.assertTrue(np.all(decoded[2:4, 3:5] == 255))

    def test_decode_mask_rejects_rgb_and_non_png_payloads(self):
        with self.assertRaises(ClientError):
            image_io_module._decode_mask(self._png_data_url(Image.new("RGB", (8, 8), "white")), 8, 8)

        encoded = io.BytesIO()
        Image.new("L", (8, 8), 255).save(encoded, format="JPEG")
        data_url = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")
        with self.assertRaises(ClientError):
            image_io_module._decode_mask(data_url, 8, 8)

    def test_rgba_mosaic_uses_alpha_aware_average(self):
        rgba = np.zeros((2, 2, 4), dtype=np.uint8)
        rgba[0, 0] = (255, 0, 0, 255)
        output = image_io_module._apply_mosaic_to_image(
            Image.fromarray(rgba), np.full((2, 2), 255, dtype=np.uint8), 2,
        )

        self.assertEqual(tuple(np.asarray(output)[0, 0]), (255, 0, 0, 255))

    def test_mosaic_average_ignores_unmasked_pixels_in_its_block(self):
        rgb = np.array([[[10, 0, 0], [250, 0, 0]], [[30, 0, 0], [250, 0, 0]]], dtype=np.uint8)
        mask = np.array([[255, 0], [255, 0]], dtype=np.uint8)
        output = np.asarray(image_io_module._apply_mosaic_to_image(Image.fromarray(rgb), mask, 2))
        self.assertEqual(tuple(output[0, 0]), (20, 0, 0))
        self.assertEqual(tuple(output[1, 0]), (20, 0, 0))
        self.assertEqual(tuple(output[0, 1]), (250, 0, 0))

    def test_mosaic_keeps_an_empty_partial_block_unchanged(self):
        image = Image.fromarray(np.arange(15, dtype=np.uint8).reshape(3, 5))
        mask = np.zeros((3, 5), dtype=np.uint8); mask[:2, :2] = 255
        output = np.asarray(image_io_module._apply_mosaic_to_image(image, mask, 2))
        self.assertTrue(np.array_equal(output[:, 4], np.asarray(image)[:, 4]))

    def test_mosaic_block_rows_are_bit_exact_for_rgb_rgba_and_l(self):
        random = np.random.default_rng(20260825)
        for mode, channels in (("RGB", 3), ("RGBA", 4), ("L", 1)):
            for width, height, block_size in ((1, 1, 1), (19, 17, 4), (101, 73, 13)):
                shape = (height, width, channels) if channels > 1 else (height, width)
                pixels = random.integers(0, 256, size=shape, dtype=np.uint8)
                mask = random.integers(0, 2, size=(height, width), dtype=np.uint8) * 255
                image = Image.fromarray(pixels, mode=mode)
                expected = reference_apply_mosaic(image, mask, block_size)
                actual = np.asarray(image_io_module._apply_mosaic_to_image(image, mask, block_size))
                self.assertTrue(np.array_equal(actual, expected), (mode, width, height, block_size))

    def test_standard_log_format_has_timestamp_level_and_message(self):
        record = logging.LogRecord("test", logging.INFO, __file__, 1, "起動: %s", ("OK",), None)
        output = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATE_FORMAT).format(record)
        self.assertRegex(output, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| INFO \| 起動: OK$")

    def test_browser_opener_logs_result_without_raising(self):
        with patch("server.webbrowser.open", return_value=True) as open_browser:
            with patch.object(core_module.LOGGER, "info") as info:
                _open_browser("http://127.0.0.1:8765")
        open_browser.assert_called_once_with("http://127.0.0.1:8765")
        info.assert_not_called()

        with patch("server.webbrowser.open", return_value=False):
            with self.assertLogs(core_module.LOGGER, "WARNING") as logs:
                _open_browser("http://127.0.0.1:8765")
        self.assertIn("ブラウザを自動で開けませんでした。次のURLを開いてください", "\n".join(logs.output))

    def test_browser_open_is_scheduled_once_as_daemon(self):
        with patch("server.threading.Timer") as timer_class:
            timer = timer_class.return_value
            _schedule_browser_open("http://127.0.0.1:8765")
        timer_class.assert_called_once_with(0.1, _open_browser, args=("http://127.0.0.1:8765",))
        self.assertTrue(timer.daemon)
        timer.start.assert_called_once_with()

    def test_main_configures_logging_and_schedules_one_browser_open(self):
        fake_server = Mock()
        fake_server.serve_forever.side_effect = KeyboardInterrupt
        fake_server.mozarie_update_requested = False
        with patch("server.logging.basicConfig") as basic_config, \
               patch("server.MaintenanceLock", return_value=nullcontext()), \
               patch("server.ThreadingHTTPServer", return_value=fake_server) as server_class, \
               patch("server._schedule_browser_open") as schedule_browser, \
               patch("subprocess.Popen") as popen, \
               patch.object(state_module.STATE, "shutdown") as shutdown, \
               patch.object(state_module.STATE, "cache_dir", self.cache_dir), \
              patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            server_entry.main()

        basic_config.assert_not_called()
        server_class.assert_called_once_with(("127.0.0.1", 9876), MosaicHandler)
        schedule_browser.assert_called_once_with("http://127.0.0.1:9876")
        fake_server.server_close.assert_called_once_with()
        shutdown.assert_called_once_with()
        popen.assert_not_called()

    def test_main_uses_saved_port_and_respects_open_browser_setting(self):
        fake_server = Mock(); fake_server.serve_forever.side_effect = KeyboardInterrupt
        fake_server.mozarie_update_requested = False
        original_settings = state_module.STATE.settings
        state_module.STATE.settings = {**original_settings, "general": {**original_settings["general"], "port": 9123, "open_browser": False}}
        try:
            with patch("server.ThreadingHTTPServer", return_value=fake_server) as server_class, \
                   patch("server.MaintenanceLock", return_value=nullcontext()), \
                   patch("server._schedule_browser_open") as schedule_browser, \
                   patch("subprocess.Popen") as popen, \
                   patch.object(state_module.STATE, "shutdown"), \
                   patch.object(state_module.STATE, "cache_dir", self.cache_dir), \
                   patch.object(sys, "argv", ["server.py"]):
                server_entry.main()
            server_class.assert_called_once_with(("127.0.0.1", 9123), MosaicHandler)
            schedule_browser.assert_not_called()
            popen.assert_not_called()
        finally:
            state_module.STATE.settings = original_settings

    def test_main_launches_update_only_after_the_server_requests_it(self):
        fake_server = Mock()
        fake_server.serve_forever.side_effect = KeyboardInterrupt
        fake_server.mozarie_update_requested = True
        with patch("server.ThreadingHTTPServer", return_value=fake_server), \
                patch("server.MaintenanceLock", return_value=nullcontext()), \
                patch("server._schedule_browser_open"), \
                patch("subprocess.Popen") as popen, \
                patch.object(state_module.STATE, "shutdown"), \
                patch.object(state_module.STATE, "cache_dir", self.cache_dir), \
                patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            server_entry.main()
        popen.assert_called_once_with(
            [str(server_entry.APP_DIR / "update.bat")], cwd=str(server_entry.APP_DIR),
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )

    def test_main_reports_the_specific_maintenance_lock_failure(self):
        for message_key in ("update_in_progress", "maintenance_lock_access"):
            with self.subTest(message_key=message_key):
                message = updater.tr(message_key)
                with patch("server.MaintenanceLock", side_effect=updater.UpdateError(message)), \
                        patch.object(core_module.LOGGER, "error") as error, \
                        patch.object(sys, "argv", ["server.py"]):
                    with self.assertRaises(SystemExit) as raised:
                        server_entry.main()
                self.assertEqual(raised.exception.code, 1)
                error.assert_called_once_with("%s", message)

    def test_main_reports_bind_error_without_traceback(self):
        bind_error = OSError("in use"); bind_error.winerror = 10048
        with patch("server.ThreadingHTTPServer", side_effect=bind_error), \
                patch.object(core_module.LOGGER, "error") as error, \
                patch.object(core_module.LOGGER, "exception") as exception, \
                patch.object(state_module.STATE, "shutdown") as shutdown, \
                patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            with self.assertRaises(SystemExit) as raised:
                server_entry.main()
        self.assertEqual(raised.exception.code, 1)
        error.assert_called_once_with("Mozarieを起動できません。ポート%sは使用中です。", 9876)
        exception.assert_not_called()
        shutdown.assert_called_once()

    def test_main_reports_non_port_bind_error_without_calling_it_a_port_conflict(self):
        bind_error = OSError("access denied"); bind_error.winerror = 5
        with patch("server.ThreadingHTTPServer", side_effect=bind_error), \
                patch.object(core_module.LOGGER, "error") as error, \
                patch.object(core_module.LOGGER, "exception") as exception, \
                patch.object(state_module.STATE, "shutdown") as shutdown, \
                patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            with self.assertRaises(SystemExit) as raised:
                server_entry.main()
        self.assertEqual(raised.exception.code, 1)
        error.assert_not_called()
        exception.assert_called_once_with("Mozarieを起動できませんでした。")
        shutdown.assert_called_once()

    def test_server_suppresses_normal_client_disconnect_tracebacks(self):
        server = Mock()
        with patch("server.sys.exc_info", return_value=(BrokenPipeError, BrokenPipeError(), None)), patch(
            "server.ThreadingHTTPServer.handle_error",
        ) as report:
            server_entry._handle_server_error(server, Mock(), ("127.0.0.1", 1))
        report.assert_not_called()

    def test_http_log_message_silences_success_and_client_errors(self):
        handler = object.__new__(MosaicHandler)
        handler.command = "GET"
        with patch.object(core_module.LOGGER, "info") as info, patch.object(core_module.LOGGER, "warning") as warning:
            handler.path = "/api/health"
            handler.log_message('"%s" %s %s', "GET /api/health HTTP/1.1", "200", "10")
            info.assert_not_called()
            warning.assert_not_called()

            handler.path = "/static/style.css"
            handler.log_message('"%s" %s %s', "GET /static/style.css HTTP/1.1", "200", "10")
            info.assert_not_called()
            warning.assert_not_called()

            handler.command = "POST"
            handler.path = "/api/detect"
            handler.log_message('"%s" %s %s', "POST /api/detect HTTP/1.1", "200", "10")
            info.assert_not_called()

            handler.command = "GET"
            handler.path = "/missing"
            handler.log_message('"%s" %s %s', "GET /missing HTTP/1.1", "404", "10")
            warning.assert_not_called()

            handler.path = "/api/failure"
            handler.log_message('"%s" %s %s', "GET /api/failure HTTP/1.1", "500", "10")
            warning.assert_called_once()

    def test_job_lifecycle_logs_start_completion_and_failure(self):
        state = self.new_state()
        record = ImageRecord(image_id="test", path=Path(__file__), relative_path="test.png", width=1, height=1, mtime_ns=0)
        with patch("server.threading.Thread"), patch.object(core_module.LOGGER, "debug") as debug:
            state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        debug.assert_called_once()

        with patch.object(core_module.LOGGER, "debug") as debug:
            state._finish_job()
        debug.assert_called_once()

        try:
            raise RuntimeError("test failure")
        except RuntimeError as exc:
            with self.assertLogs(jobs_module.LOGGER, "ERROR") as logs:
                state._fail_job(exc)
        self.assertIn("バックグラウンド処理に失敗", "\n".join(logs.output))

    def test_unknown_job_failure_hides_details_and_logs_the_original_traceback(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running")
        original = None
        try:
            raise RuntimeError("private worker details")
        except RuntimeError as raised:
            original = raised
            with patch.object(jobs_module.LOGGER, "error") as error:
                state._fail_job(raised)

        self.assertIsNotNone(original)
        self.assertEqual(state.job.error_code, "internal_error")
        self.assertNotIn("private worker details", state.job.error)
        self.assertIs(error.call_args.kwargs["exc_info"], original)
        self.assertNotIn("private worker details", " ".join(map(str, error.call_args.args)))
        self.assertIsNotNone(original.__traceback__)

    def test_known_job_failures_do_not_log_tracebacks(self):
        cases = (
            ("client", "detect", ClientError("safe", "safe_code"), "safe_code"),
            ("database", "detect", sqlite3.DatabaseError("private database details"), "workspace_database_error"),
            ("output", "apply", PermissionError("private output path"), "output_unavailable"),
            ("memory", "detect", MemoryError("private allocation details"), "memory_allocation_failed"),
            ("gpu_oom", "detect", RuntimeError("cuda out of memory"), "gpu_out_of_memory"),
        )
        for name, kind, failure, error_code in cases:
            with self.subTest(name=name):
                state = self.new_state()
                state.job = core_module.Job(kind=kind, state="running")
                with patch.object(jobs_module.LOGGER, "error") as error:
                    state._fail_job(failure)
                self.assertEqual(state.job.error_code, error_code)
                self.assertNotIn("exc_info", error.call_args.kwargs)

    def test_main_logs_bind_failure_and_exits(self):
        bind_error = OSError("port in use"); bind_error.winerror = 10048
        with patch("server.logging.basicConfig"), \
              patch("server.ThreadingHTTPServer", side_effect=bind_error), \
              patch.object(state_module.STATE, "shutdown") as shutdown, \
              patch.object(state_module.STATE, "cache_dir", self.cache_dir), \
              patch.object(sys, "argv", ["server.py", "--port", "9876"]):
            with self.assertLogs(jobs_module.LOGGER, "ERROR") as logs:
                with self.assertRaises(SystemExit) as raised:
                    server_entry.main()
        self.assertEqual(raised.exception.code, 1)
        shutdown.assert_called_once_with()
        self.assertIn("Mozarieを起動できません。ポート9876は使用中です。", "\n".join(logs.output))

    def test_server_imports_from_an_isolated_unrelated_working_directory(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            command = (
                "import os, runpy; "
                f"os.chdir({directory!r}); "
                f"runpy.run_path({str(root / 'server.py')!r}, run_name='mozarie_startup_probe')"
            )
            environment = os.environ.copy()
            environment.pop("PYTHONPATH", None)
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", command],
                cwd=directory,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_entrypoint_does_not_reexport_backend_surface(self):
        for name in ("Job", "JobControl", "CandidateRole", "InferenceGate", "STATE", "render_with_mask", "_decode_mask"):
            self.assertFalse(hasattr(server_entry, name), name)

    def test_png_metadata_is_preserved_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            pixels = np.zeros((16, 16, 3), dtype=np.uint8)
            pixels[:, :, 0] = np.arange(16, dtype=np.uint8)[None, :] * 15
            pixels[:, :, 1] = np.arange(16, dtype=np.uint8)[:, None] * 15
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 123}')
            metadata.add_itxt("workflow", '{"nodes": []}', lang="ja", tkey="workflow")
            Image.fromarray(pixels).save(path, format="PNG", pnginfo=metadata)
            original_stat = path.stat()
            original_mtime_ns = original_stat.st_mtime_ns

            record = ImageRecord(image_id="test", path=path, relative_path="source.png", width=16, height=16, mtime_ns=original_mtime_ns, size_bytes=original_stat.st_size)
            save_with_mask(record, self._mask(16, 16), 4)

            self.assertEqual(original_mtime_ns, path.stat().st_mtime_ns)
            with Image.open(path) as image:
                self.assertEqual(image.info["prompt"], '{"seed": 123}')
                self.assertEqual(image.info["workflow"], '{"nodes": []}')
                actual = np.asarray(image.convert("RGB"))
            self.assertTrue(np.array_equal(actual[0, 0], pixels[0, 0]))
            self.assertFalse(np.array_equal(actual[5:11, 5:11], pixels[5:11, 5:11]))

    def test_jpeg_metadata_is_preserved_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.jpg"
            exif = Image.Exif()
            exif[0x010E] = "Mozarie test"
            Image.new("RGB", (16, 16), "#6688aa").save(
                path,
                format="JPEG",
                exif=exif.tobytes(),
                icc_profile=b"Mozarie ICC profile",
            )
            original = path.read_bytes()
            xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>Mozarie</x:xmpmeta>"
            original = b"\xff\xd8" + self._jpeg_segment(0xE1, xmp) + self._jpeg_segment(0xFE, b"Mozarie comment") + original[2:]
            path.write_bytes(original)
            save_with_mask(self._record(path, 16, 16), self._mask(16, 16), 4)
            self.assertIn(xmp, path.read_bytes())
            self.assertIn(b"Mozarie comment", path.read_bytes())
            with Image.open(path) as image:
                self.assertEqual(image.getexif()[0x010E], "Mozarie test")
                self.assertEqual(image.info["icc_profile"], b"Mozarie ICC profile")
                image.load()

    def test_webp_metadata_is_preserved_after_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.webp"
            exif = Image.Exif()
            exif[0x010E] = "Mozarie test"
            Image.new("RGB", (16, 16), "#6688aa").save(
                path,
                format="WEBP",
                exif=exif.tobytes(),
                icc_profile=b"Mozarie ICC profile",
                xmp=b"<x:xmpmeta>Mozarie</x:xmpmeta>",
            )
            save_with_mask(self._record(path, 16, 16), self._mask(16, 16), 4)
            with Image.open(path) as image:
                self.assertEqual(image.info["icc_profile"], b"Mozarie ICC profile")
                self.assertEqual(image.info["xmp"], b"<x:xmpmeta>Mozarie</x:xmpmeta>")
                image.load()

    def test_exif_rotated_png_swaps_dimensions_and_preserves_other_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rotated.png"
            exif = Image.Exif()
            exif[274] = 6
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 1}')
            metadata.add_itxt("workflow", '{"nodes": []}', lang="ja", tkey="workflow")
            Image.new("RGB", (40, 20), "#6688aa").save(path, format="PNG", exif=exif.tobytes(), pnginfo=metadata)
            record = self._record(path, 20, 40)
            mask = np.zeros((40, 20), dtype=np.uint8)
            mask[4:12, 4:12] = 255

            output = image_io_module.render_with_mask(record, mask, 4)
            with Image.open(io.BytesIO(output)) as saved:
                self.assertEqual(saved.size, (20, 40))
                self.assertEqual(saved.getexif().get(274), 1)
                self.assertEqual(saved.text["prompt"], '{"seed": 1}')
                self.assertEqual(saved.info["workflow"], '{"nodes": []}')
                saved.load()

    def test_exif_rotated_webp_swaps_dimensions_and_preserves_other_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rotated.webp"
            exif = Image.Exif()
            exif[274] = 6
            Image.new("RGB", (40, 20), "#6688aa").save(
                path, format="WEBP", exif=exif.tobytes(), icc_profile=b"Mosaic ICC", xmp=b"<x:xmpmeta>test</x:xmpmeta>",
            )
            record = self._record(path, 20, 40)
            mask = np.zeros((40, 20), dtype=np.uint8)
            mask[4:12, 4:12] = 255

            output = image_io_module.render_with_mask(record, mask, 4)
            with Image.open(io.BytesIO(output)) as saved:
                self.assertEqual(saved.size, (20, 40))
                self.assertEqual(saved.getexif().get(274), 1)
                saved.load()

    def test_catalogue_only_accepts_scanned_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root / "nested"
            nested.mkdir()
            Image.new("RGB", (8, 8), "white").save(nested / "one.png")
            state = self.new_state()
            images = state.set_root(str(root))
            self.assertEqual(len(images), 1)
            self.assertEqual(state.image_for_id(images[0]["id"]).path, (nested / "one.png").resolve())
            with self.assertRaises(ClientError):
                state.image_for_id("..%2foutside")

    def test_rootless_import_is_available_for_lookup_and_detection_targets(self):
        raw_buffer = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("prompt", '{"seed": 123}')
        metadata.add_text("workflow", '{"nodes": []}')
        Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG", pnginfo=metadata)
        state = self.new_state()

        imported = import_image_list_for_test(state, [{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])[0]
        record = state.image_for_id(imported["id"])
        records, _generation = state._records_for_ids_with_catalog([imported["id"]])

        self.assertIsNone(state.root)
        self.assertEqual(record.source_kind, "session")
        self.assertEqual(records, [record])
        self.assertEqual(Image.open(record.path).text["prompt"], '{"seed": 123}')
        self.assertEqual(Image.open(record.path).text["workflow"], '{"nodes": []}')

    def test_catalog_snapshot_exposes_only_filesystem_source_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "画像 folder"
            root.mkdir()
            source = root / "space 名.png"
            Image.new("RGB", (8, 8), "white").save(source)
            state = self.new_state()
            filesystem = state.set_root(str(root))[0]
            filesystem_snapshot = state.catalog_snapshot()["images"][0]
            self.assertEqual(filesystem_snapshot["id"], filesystem["id"])
            self.assertEqual(filesystem_snapshot["sourcePath"], str(source.resolve()))

            raw = io.BytesIO()
            Image.new("RGB", (8, 8), "white").save(raw, format="PNG")
            session = self.new_state()
            imported = import_image_list_for_test(session, [{
                "name": "画像 space.png", "data": base64.b64encode(raw.getvalue()).decode("ascii"),
            }])[0]
            session_snapshot = session.catalog_snapshot()["images"][0]
            self.assertEqual(session_snapshot["id"], imported["id"])
            self.assertNotIn("sourcePath", session_snapshot)

    def test_import_preserves_safe_nested_relative_paths_and_same_names(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = io.BytesIO()
            Image.new("RGB", (8, 8), "white").save(raw, format="PNG")
            encoded = base64.b64encode(raw.getvalue()).decode("ascii")
            state = self.new_state()

            images = import_image_list_for_test(state, [
                {"name": "same.png", "relativePath": "album/one/same.png", "data": encoded},
                {"name": "same.png", "relativePath": "album/two/same.png", "data": encoded},
            ])

            self.assertEqual([image["relativePath"] for image in images], ["album/one/same.png", "album/two/same.png"])
            self.assertTrue((state.session_imports_dir / "album" / "one" / "same.png").is_file())
            self.assertTrue((state.session_imports_dir / "album" / "two" / "same.png").is_file())

    def test_import_rejects_unsafe_relative_paths(self):
        raw = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(raw, format="PNG")
        encoded = base64.b64encode(raw.getvalue()).decode("ascii")
        state = self.new_state()

        for relative_path in ("", "/absolute.png", "C:/drive.png", "one//two.png", "./image.png", "one/../image.png"):
            with self.subTest(relative_path=relative_path), self.assertRaisesRegex(ClientError, "^画像の相対パスが不正です。$"):
                import_image_list_for_test(state, [{"name": "image.png", "relativePath": relative_path, "data": encoded}])
    def test_import_keeps_original_bytes_under_the_session_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = io.BytesIO()
            Image.new("RGB", (10, 8), "white").save(source, format="PNG")
            raw = source.getvalue()
            state = self.new_state()
            state.set_root(str(root))
            images = import_image_list_for_test(state, [{"name": "dropped.png", "data": base64.b64encode(raw).decode("ascii")}])
            self.assertEqual(len(images), 1)
            imported = state.session_imports_dir / "dropped.png"
            self.assertEqual(imported.read_bytes(), raw)
            import_image_list_for_test(state, [{"name": "dropped.png", "data": base64.b64encode(raw).decode("ascii")}])
            self.assertTrue((state.session_imports_dir / "dropped_2.png").is_file())
            self.assertFalse((root / ".mozarie_imports").exists())

    def test_clear_masks_removes_candidates_without_touching_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            original = path.read_bytes()
            state = self.new_state()
            images = state.set_root(directory)
            image_id = images[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            self.assertEqual(state.clear_masks([image_id]), 1)
            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(path.read_bytes(), original)

    def test_delete_candidate_is_idempotent_and_removes_its_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]

            self.assertTrue(state.delete_candidate(image_id, "candidate"))
            self.assertFalse(mask_path.exists())
            self.assertEqual(state.list_candidates(image_id), [])
            self.assertFalse(state.delete_candidate(image_id, "candidate"))

    def test_image_listing_reports_enabled_candidates_for_gallery_filtering(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate-enabled.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [
                Candidate("enabled", "penis", 0.9, mask_path, enabled=True),
                Candidate("disabled", "penis", 0.9, mask_path, enabled=False),
            ]
            listed = state.list_images()[0]
            self.assertEqual(listed["candidateCount"], 2)
            self.assertEqual(listed["enabledCandidateCount"], 1)

    def test_clear_catalog_only_removes_images_from_the_screen_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            original = path.read_bytes()
            state = self.new_state()
            state.set_root(directory)
            image_id = state.order[0]
            state.image_io_lock(image_id)

            state.clear_catalog()

            self.assertEqual(state.list_images(), [])
            self.assertEqual(state._image_io_locks, {})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(state.root, Path(directory).resolve())

    def test_remove_image_from_catalog_discards_working_state_but_keeps_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            original = path.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            self.assertEqual(state.remove_image_from_catalog(image_id), [])

            self.assertEqual(path.read_bytes(), original)
            self.assertNotIn(image_id, state.images)
            self.assertNotIn(image_id, state.order)
            self.assertNotIn(image_id, state.candidates)
            self.assertNotIn(image_id, state.candidate_revisions)
            self.assertFalse((state.cache_dir / image_id).exists())

    def test_remove_saved_images_from_catalog_keeps_all_source_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "white").save(first)
            Image.new("RGB", (16, 16), "black").save(second)
            originals = {first: first.read_bytes(), second: second.read_bytes()}
            state = self.new_state()
            images = state.set_root(directory)
            first_id, second_id = (image["id"] for image in images)

            result = state.remove_images_from_catalog([first_id, second_id, first_id])

            self.assertEqual(result["images"], [])
            self.assertEqual(result["removedImageIds"], [first_id, second_id])
            self.assertEqual(state.list_images(), [])
            self.assertEqual({path: path.read_bytes() for path in originals}, originals)

    def test_remove_image_keeps_live_and_durable_state_when_database_delete_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            with patch.object(state.workspace_store, "delete_images", side_effect=OSError("locked")):
                with self.assertRaises(OSError):
                    state.remove_image_from_catalog(image_id)
            self.assertIn(image_id, state.images)
            self.assertTrue(state.workspace_store.has_image(image_id))

    def test_remove_image_from_catalog_rejects_active_work(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            state.job.state = "running"

            with self.assertRaisesRegex(ClientError, "処理が終了"):
                state.remove_image_from_catalog(image_id)
            self.assertIn(image_id, state.images)

    def test_remove_image_allows_terminal_worker_cleanup_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            state.worker_thread = types.SimpleNamespace(is_alive=lambda: True)
            state.job.state = "complete"
            invalidation_lock_states = []
            with patch.object(state, "invalidate_sam_image", side_effect=lambda _id: invalidation_lock_states.append(state.lock._is_owned())):
                self.assertEqual(state.remove_image_from_catalog(image_id), [])
            self.assertEqual(invalidation_lock_states, [False])

            state.worker_thread = None
            image_id = state.set_root(directory)[0]["id"]
            state.worker_thread = types.SimpleNamespace(is_alive=lambda: True)
            state.job.state = "paused"
            with self.assertRaisesRegex(ClientError, "処理が終了"):
                state.remove_image_from_catalog(image_id)
            state.job.state = "complete"
            with self.assertRaisesRegex(ClientError, "処理が終了"):
                state.detach_catalog()
            state.worker_thread = None

    def test_remove_session_image_cleans_masks_thumbnails_and_import_copy(self):
        encoded = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(encoded, format="PNG")
        state = self.new_state()
        images, _imported = import_images_for_test(state, [{
            "clientKey": "session", "name": "nested/source.png", "data": base64.b64encode(encoded.getvalue()).decode("ascii"),
        }])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16)).save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        thumbnail_dir = state.cache_dir / "thumbnails"
        thumbnail_dir.mkdir(parents=True, exist_ok=True)
        thumbnail = thumbnail_dir / f"{image_id}-test.jpg"
        thumbnail.write_bytes(b"thumbnail")

        state.remove_image_from_catalog(image_id)

        self.assertFalse(record.path.exists())
        self.assertFalse(mask_path.exists())
        self.assertFalse(thumbnail.exists())
        self.assertFalse((state.cache_dir / image_id).exists())
        self.assertFalse(record.path.parent.exists())

    def test_apply_is_overwrite_only_and_rejects_session_images(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            with patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)), patch.object(state, "_start_job") as start_job:
                state.start_apply([image_id], 100, {})
            self.assertEqual(start_job.call_args.args[3], 100)
            self.assertEqual(start_job.call_args.args[4], {})
            buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "white").save(buffer, format="PNG")
            imported = import_image_list_for_test(state, [{"name": "dropped.png", "data": base64.b64encode(buffer.getvalue()).decode("ascii")}])
            session_id = next(item["id"] for item in imported if item["sourceKind"] == "session")
            with self.assertRaisesRegex(ClientError, "コピー保存"):
                state.start_apply([session_id], 100, {})

    def test_apply_pause_resume_and_cancel_state_transitions(self):
        state = self.new_state()
        state.job = core_module.Job(kind="apply", state="running", total=2)
        state.job_control = core_module.JobControl()

        state.request_pause()
        self.assertTrue(state.job_control.pause_requested.is_set())
        self.assertEqual(state.job.state, "paused")
        state.resume_job()
        self.assertEqual(state.job.state, "running")
        self.assertFalse(state.job_control.pause_requested.is_set())

        state.request_cancel()
        self.assertTrue(state.job_control.cancel_requested.is_set())
        self.assertFalse(state.job_control.pause_requested.is_set())
        self.assertTrue(state.job.cancel_requested)

        state.job.state = "paused"
        state.request_cancel()
        self.assertTrue(state.job.cancel_requested)
        self.assertEqual(state.job.state, "paused")
        state._cancel_job()
        self.assertEqual(state.job.state, "cancelled")
        self.assertFalse(state.job.cancel_requested)

    def test_cancel_before_claim_never_starts_another_record(self):
        state = self.new_state()
        control = core_module.JobControl()
        state.job = core_module.Job(kind="detect", state="running", total=1)
        state.job_control = control
        processed = []

        state.request_cancel()
        state._run_fixed_workers(
            [ImageRecord(image_id="record", path=Path(__file__), relative_path="record.png", width=1, height=1, mtime_ns=0)], 1,
            lambda _index, record: processed.append(record.image_id), control, None, None,
        )

        self.assertEqual(processed, [])

    def test_detection_can_pause_and_resume(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running", total=2)
        state.job_control = core_module.JobControl()

        state.request_pause()
        self.assertTrue(state.job_control.pause_requested.is_set())
        self.assertEqual(state.job.state, "paused")
        state.resume_job()

        self.assertEqual(state.job.state, "running")
        self.assertFalse(state.job_control.pause_requested.is_set())

    def test_detect_cancel_is_cooperative_and_discards_the_inflight_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(first_id), state.image_for_id(second_id)]
            control = core_module.JobControl()
            state.job = core_module.Job(kind="detect", state="running", total=2, image_ids=(first_id, second_id))

            def detect_image(_models, record, _confidence, _mode="standard", _targets=None):
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
                if record.image_id == second_id:
                    control.cancel_requested.set()
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 1, control=control)

            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed, 1)
            self.assertEqual(state.job.completed_image_ids, (first_id,))
            self.assertEqual(len(state.candidates[first_id]), 1)
            self.assertEqual(state.candidates.get(second_id, []), [])
            self.assertFalse((state.cache_dir / second_id / "candidate.png").exists())

    def test_detect_cancel_between_inference_and_commit_preserves_existing_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            control = core_module.JobControl()
            state.job = core_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))

            old_mask_path = state.cache_dir / image_id / "old.png"
            old_mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(old_mask_path)
            old_candidate = Candidate("old", "penis", 0.8, old_mask_path)
            state.candidates[image_id] = [old_candidate]
            new_mask_path = state.cache_dir / image_id / "new.png"
            inject_cancel = False
            original_lock = state.lock

            class CancelBeforeCommit:
                def __enter__(self):
                    original_lock.__enter__()
                    if inject_cancel:
                        control.cancel_requested.set()
                    return self

                def __exit__(self, *args):
                    return original_lock.__exit__(*args)

            def detect_image(*_args):
                nonlocal inject_cancel
                Image.fromarray(self._mask(16, 16)).save(new_mask_path)
                inject_cancel = True
                return [Candidate("new", "penis", 0.9, new_mask_path)]

            state.lock = CancelBeforeCommit()
            try:
                with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                    state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, control=control)
            finally:
                state.lock = original_lock

            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed, 0)
            self.assertEqual(state.job.completed_image_ids, ())
            self.assertEqual(state.candidates[image_id], [old_candidate])
            self.assertTrue(old_mask_path.is_file())
            self.assertFalse(new_mask_path.exists())

    def test_successful_detection_replaces_a_seeded_hand_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            state.job = core_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))
            old_path = state.cache_dir / image_id / "old-hand.png"
            old_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(old_path)
            state._commit_candidate_snapshot(image_id, [
                Candidate("old-hand", "hand", None, old_path, source="hand_exclusion", role=CandidateRole.EXCLUDE),
            ], replace=True)
            pending_path = state.cache_dir / image_id / ".mozarie-pending-fresh.png"

            def fresh_detection(*_args):
                Image.fromarray(self._mask(16, 16)).save(pending_path)
                return [Candidate("fresh", "penis", .9, pending_path, source="target")]

            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=object())), \
                    patch.object(state, "_detect_image", side_effect=fresh_detection):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 1)

            self.assertEqual(state.job.state, "complete")
            self.assertEqual([(candidate.label_token, candidate.source) for candidate in state.candidates[image_id]], [("penis", "target")])
            self.assertFalse(old_path.exists())

    def test_detect_persistence_failure_removes_final_new_masks(self):
        """A failed candidate transaction must not leave a visible orphan mask."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            state.job = core_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))

            old_mask_path = state.cache_dir / image_id / "old.png"
            old_mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(old_mask_path)
            old_candidate = Candidate("old", "penis", 0.8, old_mask_path)
            state.candidates[image_id] = [old_candidate]
            pending_path = state.cache_dir / image_id / ".mozarie-pending-new.png"
            final_path = state.cache_dir / image_id / "new.png"

            def detect_image(*_args):
                Image.fromarray(self._mask(16, 16)).save(pending_path)
                return [Candidate("new", "penis", 0.9, pending_path)]

            with (
                patch.object(state, "_ensure_models", return_value=[]),
                patch.object(state, "_detect_image", side_effect=detect_image),
                patch.object(state, "_commit_candidate_snapshot_outside_state_lock", side_effect=OSError("database write failed")),
            ):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE)

            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.candidates[image_id], [old_candidate])
            self.assertTrue(old_mask_path.is_file())
            self.assertFalse(pending_path.exists())
            self.assertFalse(final_path.exists())

    def test_detect_job_can_be_cancelled_with_the_shared_control(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running", total=1)
        state.job_control = core_module.JobControl()
        state.request_cancel()
        self.assertTrue(state.job_control.cancel_requested.is_set())

    def test_detection_parallelism_is_limited_to_one_through_four(self):
        self.assertEqual(core_module._read_detection_parallelism(1), 1)
        self.assertEqual(core_module._read_detection_parallelism(4), 4)
        for value in (0, 5, True, "2"):
            with self.subTest(value=value), self.assertRaisesRegex(ClientError, "1から4"):
                core_module._read_detection_parallelism(value)

    def test_parallel_detection_shares_one_model_bundle_and_commits_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            images = state.set_root(directory)
            records = [state.image_for_id(image["id"]) for image in images]
            state.job = core_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            base_models = object()
            seen_models: list[int] = []

            def detect_image(models, record, _confidence, _mode="standard", _targets=None):
                seen_models.append(id(models))
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            with patch.object(state, "_ensure_models", return_value=base_models) as ensure, patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 2)

            ensure.assert_called_once()
            self.assertEqual(set(seen_models), {id(base_models)})
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.parallelism, 2)
            self.assertEqual(state.job.completed, 2)
            self.assertEqual(set(state.job.completed_image_ids), {record.image_id for record in records})
            self.assertTrue(all(state._candidate_revision(record.image_id) == 1 for record in records))

    def test_detection_cancel_stops_before_shared_model_use(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first.png", "second.png", "third.png"):
                Image.new("RGB", (16, 16), "white").save(root / name)
            state = self.new_state()
            records = [state.image_for_id(item["id"]) for item in state.set_root(str(root))]
            control = core_module.JobControl()
            state.job = core_module.Job(kind="detect", state="running", total=3, image_ids=tuple(record.image_id for record in records))

            def load_first_slot():
                control.cancel_requested.set()
                return object()

            with patch.object(state, "_ensure_models", side_effect=load_first_slot), patch.object(state, "_detect_image") as detect_image:
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 3, control=control)

            detect_image.assert_not_called()
            self.assertEqual(state.job.state, "cancelled")

    def test_detection_pause_before_workers_resumes_with_shared_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first.png", "second.png"):
                Image.new("RGB", (16, 16), "white").save(root / name)
            state = self.new_state()
            records = [state.image_for_id(item["id"]) for item in state.set_root(str(root))]
            control = core_module.JobControl()
            state.job = core_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            first_loaded = threading.Event()

            def load_first_slot():
                control.pause_requested.set()
                first_loaded.set()
                return object()

            worker = threading.Thread(target=state._detect_worker, args=(records, DEFAULT_DETECTION_CONFIDENCE, 2), kwargs={"control": control})
            with patch.object(state, "_ensure_models", side_effect=load_first_slot), patch.object(state, "_detect_image", return_value=[]):
                worker.start()
                self.assertTrue(first_loaded.wait(2))
                control.pause_requested.clear()
                worker.join(2)

            self.assertFalse(worker.is_alive())
            self.assertEqual(state.job.state, "complete")

    def test_parallel_detection_progress_never_moves_backward(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            state.settings["models"]["provider"] = "cpu"
            records = [state.image_for_id(image["id"]) for image in state.set_root(directory)]
            state.job = core_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            second_started = threading.Event()
            first_completed = threading.Event()
            release_second = threading.Event()
            observed_progress: list[int] = []
            original_set_current = state._set_job_current

            def set_current(current, *args, **kwargs):
                if current == records[1].relative_path and not second_started.is_set():
                    second_started.set()
                    self.assertTrue(release_second.wait(2))
                result = original_set_current(current, *args, **kwargs)
                observed_progress.append(state.job.completed)
                if current == records[0].relative_path and state.job.completed == 1:
                    first_completed.set()
                return result

            def detect_image(_models, record, _confidence, _mode="standard", _targets=None):
                if record is records[0]:
                    self.assertTrue(second_started.wait(2))
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            thread = threading.Thread(
                target=state._detect_worker,
                args=(records, DEFAULT_DETECTION_CONFIDENCE, 2),
            )
            with patch.object(state, "_ensure_models", return_value=object()), patch.object(state, "_load_detection_models", return_value=object()), patch.object(state, "_detect_image", side_effect=detect_image), patch.object(state, "_set_job_current", side_effect=set_current):
                thread.start()
                self.assertTrue(first_completed.wait(2))
                release_second.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(observed_progress, sorted(observed_progress))
            self.assertEqual(state.job.completed, 2)

    def test_parallel_detection_completes_empty_results_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            state.settings["models"]["provider"] = "cpu"
            records = [state.image_for_id(image["id"]) for image in state.set_root(directory)]
            state.job = core_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            completed: list[int] = []
            original = state._record_job_success

            def record_success(*args, **kwargs):
                original(*args, **kwargs)
                completed.append(state.job.completed)

            with patch.object(state, "_ensure_models", return_value=object()), patch.object(state, "_detect_image", return_value=[]), patch.object(state, "_record_job_success", side_effect=record_success):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 2)
            self.assertEqual(completed, sorted(completed))
            self.assertEqual(completed[-1], 2)
            self.assertEqual(state.job.state, "complete")

    def test_parallel_detection_cancellation_discards_all_inflight_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            state.settings["models"]["provider"] = "cpu"
            records = [state.image_for_id(image["id"]) for image in state.set_root(directory)]
            control = core_module.JobControl()
            started = threading.Event()
            release = threading.Event()

            def detect_image(_models, record, _confidence, _mode="standard", _targets=None):
                mask_path = state.cache_dir / record.image_id / "candidate.png"
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(self._mask(16, 16)).save(mask_path)
                if record is records[0]:
                    started.set()
                    self.assertTrue(release.wait(2))
                else:
                    self.assertTrue(started.wait(2))
                    control.cancel_requested.set()
                    release.set()
                return [Candidate(record.image_id, "penis", 0.9, mask_path)]

            state.job = core_module.Job(kind="detect", state="running", total=2, image_ids=tuple(record.image_id for record in records))
            with patch.object(state, "_ensure_models", return_value=object()), patch.object(state, "_load_detection_models", return_value=object()), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker(records, DEFAULT_DETECTION_CONFIDENCE, 2, control=control)

            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed, 0)
            self.assertTrue(all(not state.candidates.get(record.image_id) for record in records))
            self.assertTrue(all(state._candidate_revision(record.image_id) == 0 for record in records))

    def test_cancelled_or_failed_apply_reports_only_successfully_completed_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "#6688aa").save(first)
            Image.new("RGB", (16, 16), "#aa8866").save(second)
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(first_id), state.image_for_id(second_id)]
            masks = {first_id: self._mask(16, 16), second_id: self._mask(16, 16)}
            control = core_module.JobControl()
            state.job = core_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            original_save = saving_module._stage_save_with_mask

            def save_then_cancel(*args, **kwargs):
                result = original_save(*args, **kwargs)
                control.cancel_requested.set()
                return result

            with patch.object(saving_module, "_stage_save_with_mask", side_effect=save_then_cancel):
                state._apply_worker(records, 100, masks, control=control)
            self.assertEqual(state.job.state, "cancelled")
            self.assertEqual(state.job.completed_image_ids, (first_id,))

            state.job = core_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            call_count = 0

            def save_then_fail(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    raise RuntimeError("second image failed")
                return original_save(*args, **kwargs)

            with patch.object(saving_module, "_stage_save_with_mask", side_effect=save_then_fail):
                state._apply_worker(records, 100, masks)
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.completed_image_ids, (first_id,))

    def test_apply_worker_serializes_the_same_image_but_overlaps_distinct_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "first.png")
            Image.new("RGB", (16, 16), "black").save(root / "second.png")
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            first, second = (state.image_for_id(image_id) for image_id in (first_id, second_id))
            masks = {first_id: self._mask(16, 16), second_id: self._mask(16, 16)}
            state.job = core_module.Job(kind="apply", state="running", total=3, image_ids=(first_id, first_id, second_id))
            first_entered = threading.Event()
            second_entered = threading.Event()
            release = threading.Event()
            started: list[str] = []
            started_lock = threading.Lock()

            original_save = saving_module._stage_save_with_mask

            def delayed_save(record, mask, block_size):
                with started_lock:
                    started.append(record.image_id)
                    if record.image_id == first_id and started.count(first_id) == 1:
                        first_entered.set()
                    if record.image_id == second_id:
                        second_entered.set()
                self.assertTrue(release.wait(2))
                return original_save(record, mask, block_size)

            worker = threading.Thread(
                target=state._apply_worker,
                args=([first, first, second], 100, masks),
                kwargs={"saving_parallelism": 3},
            )
            with patch.object(saving_module, "_stage_save_with_mask", side_effect=delayed_save):
                worker.start()
                self.assertTrue(first_entered.wait(2))
                self.assertTrue(second_entered.wait(2))
                with started_lock:
                    self.assertEqual(started.count(first_id), 1)
                release.set()
                worker.join(3)

            self.assertFalse(worker.is_alive())
            self.assertEqual(started.count(first_id), 2)

    def test_queued_overwrite_preserves_externally_changed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_path = root / "first.png"
            second_path = root / "second.png"
            Image.new("RGB", (16, 16), "white").save(first_path)
            Image.new("RGB", (16, 16), "black").save(second_path)
            state = self.new_state()
            first_id, second_id = (image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in (first_id, second_id)]
            masks = {image_id: self._mask(16, 16) for image_id in (first_id, second_id)}
            state.job = core_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            first_entered = threading.Event()
            release_first = threading.Event()
            original_source_check = image_io_module._assert_source_stat_matches

            def hold_first_source_check(record, *args):
                if record.image_id == first_id:
                    first_entered.set()
                    self.assertTrue(release_first.wait(2))
                return original_source_check(record, *args)

            worker = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, masks),
                kwargs={"saving_parallelism": 1},
            )
            with patch.object(image_io_module, "_assert_source_stat_matches", side_effect=hold_first_source_check):
                worker.start()
                self.assertTrue(first_entered.wait(2))
                previous_stat = second_path.stat()
                Image.new("RGB", (16, 16), "green").save(second_path)
                os.utime(second_path, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns + 1_000_000_000))
                external_contents = second_path.read_bytes()
                release_first.set()
                worker.join(3)

            self.assertFalse(worker.is_alive())
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.completed_image_ids, (first_id,))
            self.assertEqual(second_path.read_bytes(), external_contents)

    def test_parallel_apply_starts_two_workers_and_publishes_results_in_input_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(4):
                Image.new("RGB", (16, 16), f"#{index}{index}{index}{index}{index}{index}").save(root / f"image-{index}.png")
            state = self.new_state()
            image_ids = tuple(image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in image_ids]
            masks = {image_id: self._mask(16, 16) for image_id in image_ids}
            state.job = core_module.Job(kind="apply", state="running", total=4, image_ids=image_ids)
            rendezvous = threading.Barrier(2)
            two_workers_started = threading.Event()
            release = threading.Event()
            non_first_finished = threading.Event()
            started: list[int] = []
            completion_order: list[int] = []
            started_lock = threading.Lock()
            completion_lock = threading.Lock()
            record_indexes = {record.image_id: index for index, record in enumerate(records)}
            output_paths = {record.image_id: root / "copies" / f"{index}.png" for index, record in enumerate(records)}
            written_paths: list[Path] = []

            def render_in_inverse_order(record, _mask, _block_size):
                index = record_indexes[record.image_id]
                with started_lock:
                    started.append(index)
                    if len(started) == 2:
                        two_workers_started.set()
                if index in (0, 1):
                    rendezvous.wait(timeout=2)
                    if not release.wait(2):
                        raise RuntimeError("test did not release both workers")
                if index == 0:
                    if not non_first_finished.wait(2):
                        raise RuntimeError("later records did not finish")
                else:
                    with completion_lock:
                        completion_order.append(index)
                        if len(completion_order) == 3:
                            non_first_finished.set()
                if index == 0:
                    with completion_lock:
                        completion_order.append(index)
                return f"rendered-{index}".encode("ascii")

            def capture_copy(destination, _output):
                written_paths.append(destination)

            def output_destination(record, _suffix, _reserved):
                return output_paths[record.image_id]

            thread = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, masks),
                kwargs={"copy_to_default": True, "saving_parallelism": 2},
            )
            with patch.object(state, "_reserve_output_destination", side_effect=lambda record, suffix, _directory: output_destination(record, suffix, state.reserved_output_paths)), \
                 patch.object(saving_module, "render_with_mask", side_effect=render_in_inverse_order), \
                 patch.object(saving_module, "write_rendered_copy", side_effect=capture_copy):
                thread.start()
                self.assertTrue(two_workers_started.wait(2))
                self.assertEqual(set(started), {0, 1})
                self.assertEqual(state.job.completed_image_ids, ())
                self.assertEqual(state.job.outputs, [])
                release.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(completion_order, [1, 2, 3, 0])
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.completed_image_ids, image_ids)
            self.assertEqual(state.job.outputs, [str(output_paths[record.image_id]) for record in records])
            self.assertEqual(set(written_paths), set(output_paths.values()))

    def test_parallel_apply_failure_stops_workers_from_claiming_more_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(4):
                Image.new("RGB", (16, 16), f"#{index}{index}{index}{index}{index}{index}").save(root / f"image-{index}.png")
            state = self.new_state()
            image_ids = tuple(image["id"] for image in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in image_ids]
            masks = {image_id: self._mask(16, 16) for image_id in image_ids}
            state.job = core_module.Job(kind="apply", state="running", total=4, image_ids=image_ids)
            second_started = threading.Event()
            first_failed = threading.Event()
            release_second = threading.Event()
            claimed: list[int] = []
            claimed_lock = threading.Lock()
            record_indexes = {record.image_id: index for index, record in enumerate(records)}
            output_paths = {record.image_id: root / "copies" / f"{index}.png" for index, record in enumerate(records)}

            def fail_first_render(record, _mask, _block_size):
                index = record_indexes[record.image_id]
                with claimed_lock:
                    claimed.append(index)
                if index == 0:
                    if not second_started.wait(2):
                        raise RuntimeError("second worker did not start")
                    first_failed.set()
                    raise RuntimeError("first record failed")
                if index != 1:
                    raise RuntimeError(f"unexpected record claimed after failure: {index}")
                second_started.set()
                if not release_second.wait(2):
                    raise RuntimeError("test did not release the second worker")
                return b"rendered-second"

            def output_destination(record, _suffix, _reserved):
                return output_paths[record.image_id]

            thread = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, masks),
                kwargs={"copy_to_default": True, "saving_parallelism": 2},
            )
            with patch.object(state, "_reserve_output_destination", side_effect=lambda record, suffix, _directory: output_destination(record, suffix, state.reserved_output_paths)), \
                 patch.object(saving_module, "render_with_mask", side_effect=fail_first_render), \
                 patch.object(saving_module, "write_rendered_copy"):
                thread.start()
                self.assertTrue(second_started.wait(2))
                self.assertTrue(first_failed.wait(2))
                release_second.set()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(set(claimed), {0, 1})
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.completed_image_ids, (image_ids[1],))

    def test_pause_waits_for_all_claimed_records_before_becoming_paused(self):
        state = self.new_state()
        records = [ImageRecord(image_id=str(index), path=Path(f"image-{index}.png"), relative_path=f"image-{index}.png", width=1, height=1, mtime_ns=0) for index in range(3)]
        control = core_module.JobControl()
        state.job = core_module.Job(kind="apply", state="running", total=3, image_ids=tuple(record.image_id for record in records))
        state.job_control = control
        claimed: list[int] = []
        claimed_lock = threading.Lock()
        started = threading.Barrier(3)
        release_first = threading.Event()
        release_second = threading.Event()
        release_third = threading.Event()
        first_settled = threading.Event()
        paused = threading.Event()
        third_started = threading.Event()
        original_finish = state._finish_claimed_task

        def finish_claimed(*args):
            active_count = original_finish(*args)
            if active_count == 1:
                first_settled.set()
            if state.job.state == "paused":
                paused.set()
            return active_count

        def process(index, _record):
            with claimed_lock:
                claimed.append(index)
            if index < 2:
                started.wait(timeout=2)
                release = release_first if index == 0 else release_second
                if not release.wait(2):
                    raise RuntimeError("test did not release an in-flight record")
            else:
                third_started.set()
                if not release_third.wait(2):
                    raise RuntimeError("test did not release the resumed record")

        thread = threading.Thread(
            target=state._run_fixed_workers,
            args=(records, 2, process, control, None, None),
        )
        with patch.object(state, "_finish_claimed_task", side_effect=finish_claimed):
            thread.start()
            started.wait(timeout=2)
            self.assertEqual(state.job.active_count, 2)
            state.request_pause()
            self.assertEqual(state.job.state, "pausing")
            self.assertEqual(set(claimed), {0, 1})

            release_first.set()
            self.assertTrue(first_settled.wait(2))
            self.assertEqual(state.job.state, "pausing")
            self.assertEqual(state.job.active_count, 1)
            self.assertEqual(set(claimed), {0, 1})

            release_second.set()
            self.assertTrue(paused.wait(2))
            self.assertEqual(state.job.active_count, 0)
            self.assertEqual(set(claimed), {0, 1})

            state.resume_job()
            self.assertEqual(state.job.state, "running")
            self.assertTrue(third_started.wait(2))
            release_third.set()
            thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertEqual(state.job.active_count, 0)

    def test_pause_request_during_the_final_completion_does_not_leave_the_job_paused(self):
        record = ImageRecord(image_id="final", path=Path("final.png"), relative_path="final.png", width=1, height=1, mtime_ns=0)
        state = self.new_state()
        control = core_module.JobControl()
        state.job = core_module.Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
        state.job_control = control
        started = threading.Barrier(2)
        release = threading.Event()

        def process(index, current):
            started.wait(timeout=2)
            self.assertTrue(release.wait(2))
            state._record_job_success(index, current.image_id, None)

        thread = threading.Thread(target=state._run_fixed_workers, args=([record], 1, process, control, None, None))
        thread.start()
        started.wait(timeout=2)
        state.request_pause()
        self.assertEqual(state.job.state, "pausing")
        release.set()
        thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertEqual(state.job.completed, state.job.total)
        self.assertNotEqual(state.job.state, "paused")
        self.assertFalse(control.pause_requested.is_set())
        state._finish_job()
        self.assertEqual(state.job.state, "complete")

    def test_inference_gate_reports_locks_held_by_another_thread(self):
        gate = core_module.InferenceGate()
        entered = threading.Event()
        release = threading.Event()

        def hold_gate():
            with gate:
                entered.set()
                self.assertTrue(release.wait(2))

        thread = threading.Thread(target=hold_gate)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.assertTrue(gate.locked())
        release.set()
        thread.join(2)

        self.assertFalse(thread.is_alive())
        self.assertFalse(gate.locked())

    def test_combined_mask_includes_draft_add_and_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            add = np.zeros((16, 16), dtype=np.uint8)
            add[2:10, 2:10] = 255
            exclusion = np.zeros((16, 16), dtype=np.uint8)
            exclusion[4:6, 4:6] = 255
            combined = state.combined_candidate_mask(image_id, (add, exclusion))
            self.assertEqual(combined[3, 3], 255)
            self.assertEqual(combined[4, 4], 0)

    def test_combined_mask_always_applies_auto_exclusions_before_manual_add(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(path)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            apply = self._mask(16, 16)
            exclude = np.zeros((16, 16), dtype=np.uint8); exclude[4:6, 4:6] = 255
            cache = state.cache_dir / image_id; cache.mkdir(parents=True)
            apply_path, exclude_path = cache / "apply.png", cache / "exclude.png"
            Image.fromarray(apply).save(apply_path); Image.fromarray(exclude).save(exclude_path)
            state.candidates[image_id] = [
                Candidate("apply", "penis", 0.9, apply_path),
                Candidate("exclude", "hand", None, exclude_path, source="hand_exclusion", role=domain_module.CandidateRole.EXCLUDE),
            ]
            combined = state.combined_candidate_mask(image_id)
            self.assertEqual(combined[4, 4], 0)

    def test_tile_layout_restores_masks_to_original_coordinates(self):
        specs = detection_tiles(100, 80)
        self.assertEqual(len(specs), 9)
        self.assertIn((35, 28, 65, 52), specs)
        local = np.zeros((52, 65), dtype=np.uint8)
        local[7:12, 9:15] = 255
        restored = restore_tile_mask(local, 100, 80, 35, 28)
        self.assertEqual(restored.shape, (80, 100))
        self.assertTrue(np.all(restored[35:40, 44:50] == 255))
        self.assertEqual(np.count_nonzero(restored), 30)

    def test_iou_merge_keeps_the_best_precise_duplicate_mask(self):
        first = np.zeros((12, 12), dtype=np.uint8)
        first[2:8, 2:8] = 255
        duplicate = np.zeros((12, 12), dtype=np.uint8)
        duplicate[2:8, 2:8] = 255
        separate = np.zeros((12, 12), dtype=np.uint8)
        separate[9:11, 9:11] = 255
        self.assertGreater(mask_iou(first, duplicate), 0.5)
        segments = []
        merge_segment(segments, "penis", 0.4, first, "ntd11")
        merge_segment(segments, "penis", 0.9, duplicate, "ntd11")
        merge_segment(segments, "penis", 0.7, separate)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["confidence"], 0.9)
        self.assertTrue(np.array_equal(segments[0]["mask"], duplicate))

    def test_ntd11_segment_wins_over_sensitive_duplicate(self):
        first = np.zeros((12, 12), dtype=np.uint8)
        first[2:8, 2:8] = 255
        secondary = np.zeros((12, 12), dtype=np.uint8)
        secondary[2:8, 2:8] = 255
        segments = []
        merge_segment(segments, "penis", 0.62, first, "ntd11")
        merge_segment(segments, "penis", 0.91, secondary, "sensitive")
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["source"], "ntd11")
        self.assertTrue(np.array_equal(segments[0]["mask"], first))

    def test_sparse_tile_merge_matches_full_mask_order_scores_and_pixels(self):
        width, height = 100, 80
        entries = []
        for source, confidence, x_offset, y_offset, tile_width, tile_height, box in (
            ("ntd11", 0.61, 0, 0, 65, 52, (20, 18, 48, 42)),
            ("ntd11", 0.87, 35, 0, 65, 80, (0, 18, 13, 42)),
            ("sensitive", 0.99, 35, 28, 65, 52, (0, 0, 13, 14)),
            ("ntd11", 0.71, 0, 28, 100, 52, (60, 15, 80, 35)),
        ):
            mask = np.zeros((tile_height, tile_width), dtype=np.uint8)
            left, top, right, bottom = box
            mask[top:bottom, left:right] = 255
            entries.append((source, confidence, mask, x_offset, y_offset))
        full = []
        sparse = []
        for source, confidence, mask, x_offset, y_offset in entries:
            merge_segment(full, "penis", confidence, restore_tile_mask(mask, width, height, x_offset, y_offset), source)
            merge_tile_segment(sparse, "penis", confidence, mask, x_offset, y_offset, source)
        materialized = [materialize_tile_mask(segment, width, height) for segment in sparse]
        self.assertEqual(
            [(segment["source"], segment["confidence"]) for segment in materialized],
            [(segment["source"], segment["confidence"]) for segment in full],
        )
        for actual, expected in zip(materialized, full):
            self.assertTrue(np.array_equal(actual["mask"], expected["mask"]))

    def test_detection_confidence_validation_and_auxiliary_floor(self):
        self.assertEqual(DEFAULT_DETECTION_CONFIDENCE, 0.50)
        self.assertEqual(read_detection_confidence("0.10"), 0.10)
        self.assertEqual(read_detection_confidence("1.00"), 1.00)
        self.assertAlmostEqual(confidence_for_source("ntd11", 0.60), 0.45)
        self.assertEqual(confidence_for_source("sensitive", 0.10), 0.50)
        self.assertEqual(confidence_for_source("sensitive", 0.85), 0.85)
        with self.assertRaises(ClientError):
            read_detection_confidence(0.09)
        with self.assertRaisesRegex(ClientError, "0.10から1.00"):
            read_detection_confidence(1.01)

    def test_target_source_replaces_only_overlapping_auxiliary_segments(self):
        precise = np.zeros((40, 40), dtype=np.uint8)
        precise[5:15, 5:15] = 255
        overlapping_legacy = np.zeros((40, 40), dtype=np.uint8)
        overlapping_legacy[4:18, 4:18] = 255
        unmatched_legacy = np.zeros((40, 40), dtype=np.uint8)
        unmatched_legacy[24:34, 24:34] = 255
        result = arbitrate_segment_sources([
            {"class_name": "penis", "confidence": 0.55, "mask": unmatched_legacy, "source": "ntd11"},
            {"class_name": "penis", "confidence": 0.80, "mask": overlapping_legacy, "source": "ntd11"},
            {"class_name": "penis", "confidence": 0.20, "mask": precise, "source": "target"},
        ])
        self.assertEqual(len(result), 2)
        self.assertEqual([segment["source"] for segment in result], ["target", "ntd11"])
        self.assertTrue(any(np.array_equal(segment["mask"], unmatched_legacy) for segment in result))

    def test_precise_arbitration_does_not_merge_nearby_organs(self):
        left = np.zeros((40, 40), dtype=np.uint8)
        left[5:13, 5:13] = 255
        right = np.zeros((40, 40), dtype=np.uint8)
        right[15:23, 15:23] = 255
        result = arbitrate_segment_sources([
            {"class_name": "pussy", "confidence": 0.5, "mask": left, "source": "target"},
            {"class_name": "pussy", "confidence": 0.5, "mask": right, "source": "target"},
        ])
        self.assertEqual(len(result), 2)

    def test_hand_refinement_removes_valid_overlap(self):
        genital = np.zeros((30, 30), dtype=np.uint8)
        genital[5:25, 5:25] = 255
        hand = np.zeros_like(genital)
        hand[5:8, 10:21] = 255
        refined, decision = refine_mask_with_hand(genital, hand)
        self.assertEqual(decision, "refined")
        self.assertTrue(np.all(refined[5:8, 10:21] == 0))
        self.assertLess(np.count_nonzero(refined), np.count_nonzero(genital))

    def test_hand_refinement_ignores_31_pixels_and_accepts_32_pixels(self):
        genital = np.full((20, 20), 255, dtype=np.uint8)
        overlap_31 = np.zeros_like(genital); overlap_31.flat[:31] = 255
        unchanged, decision = refine_mask_with_hand(genital, overlap_31)
        self.assertEqual(decision, "unchanged")
        self.assertTrue(np.array_equal(unchanged, genital))
        overlap_32 = np.zeros_like(genital); overlap_32.flat[:32] = 255
        refined, decision = refine_mask_with_hand(genital, overlap_32)
        self.assertEqual(decision, "refined")
        self.assertEqual(np.count_nonzero(refined), np.count_nonzero(genital) - 32)

    def test_hand_refinement_skips_over_cap(self):
        genital = np.zeros((30, 30), dtype=np.uint8)
        genital[5:25, 5:25] = 255
        large_hand = np.zeros_like(genital)
        large_hand[5:25, 5:25] = 255
        unchanged, decision = refine_mask_with_hand(genital, large_hand)
        self.assertEqual(decision, "over_cap")
        self.assertTrue(np.array_equal(unchanged, genital))

    def test_hand_refinement_requires_a_minimum_remaining_mask(self):
        genital = np.zeros((20, 20), dtype=np.uint8)
        genital[5:15, 5:15] = 255
        hand = np.zeros_like(genital)
        hand[5:15, 5:12] = 255
        unchanged, decision = refine_mask_with_hand(genital, hand)
        self.assertEqual(decision, "too_small")
        self.assertTrue(np.array_equal(unchanged, genital))

    def test_hand_sam_mask_rejects_low_quality_invalid_shape_and_empty_masks(self):
        mask = np.zeros((8, 8), dtype=bool)
        mask[2:6, 2:6] = True
        box = (0, 0, 8, 8)
        self.assertIsNone(accepted_hand_sam_mask(np.array([mask]), np.array([0.87]), (8, 8), box))
        self.assertIsNone(accepted_hand_sam_mask(np.array([mask]), np.array([0.95]), (9, 9), box))
        self.assertIsNone(accepted_hand_sam_mask(np.zeros((1, 8, 8), dtype=bool), np.array([0.95]), (8, 8), box))
        outside = np.zeros((8, 8), dtype=bool)
        outside[:2, :2] = True
        self.assertIsNone(accepted_hand_sam_mask(np.array([outside]), np.array([0.95]), (8, 8), (2, 2, 8, 8)))
        accepted = accepted_hand_sam_mask(np.array([mask]), np.array([0.88]), (8, 8), box)
        self.assertIsNotNone(accepted)
        self.assertTrue(np.all(accepted[2:6, 2:6] == 255))

    def test_hand_sam_mask_uses_next_highest_scoring_valid_proposal(self):
        outside = np.ones((10, 10), dtype=bool)
        valid = np.zeros((10, 10), dtype=bool)
        valid[3:7, 3:7] = True
        accepted = accepted_hand_sam_mask(
            np.array([outside, valid]), np.array([0.97, 0.95]), (10, 10), (2, 2, 8, 8)
        )
        self.assertTrue(np.array_equal(accepted, valid.astype(np.uint8) * 255))

    def test_padded_hand_box_uses_the_specified_bounded_padding(self):
        self.assertEqual(padded_hand_box((10, 10, 20, 30), (50, 50)), (8, 8, 22, 32))
        self.assertEqual(padded_hand_box((5, 5, 505, 505), (512, 512)), (0, 0, 512, 512))

    def test_semantic_sam_refinement_uses_safe_points_and_rejects_hand_overlap(self):
        source = np.zeros((16, 16), dtype=np.uint8); source[3:13, 3:13] = 255
        hand = np.zeros_like(source); hand[3:7, 3:7] = 255
        points, labels = sam_refinement_prompts(source, hand)
        self.assertLessEqual(np.count_nonzero(labels == 1), 3)
        self.assertLessEqual(np.count_nonzero(labels == 0), 1)
        self.assertTrue(all(source[int(y), int(x)] and not hand[int(y), int(x)] for (x, y), label in zip(points, labels) if label == 1))
        good = source.astype(bool); good[3:7, 3:7] = False
        bad = source.astype(bool)
        selected = select_semantic_sam_mask(np.asarray([bad, good]), np.asarray([0.99, 0.50]), source, hand, points, labels)
        self.assertIsNotNone(selected)
        self.assertEqual(selected[1], 1)

    def test_sam_refinement_points_are_vectorized_and_deterministic(self):
        source = np.zeros((2160, 3840), dtype=np.uint8)
        source[240:1920, 480:3360] = 255
        hand = np.zeros_like(source)
        with patch("builtins.sorted", side_effect=AssertionError("SAM prompt selection must not sort candidates")), patch.object(
            np, "nonzero", side_effect=AssertionError("SAM prompt selection must not materialize candidate coordinates")
        ):
            points, labels = sam_refinement_prompts(source, hand)
        safe = cv2.erode(np.asarray(source > 0, dtype=np.uint8), np.ones((3, 3), dtype=np.uint8))
        distance = cv2.distanceTransform(safe, cv2.DIST_L2, 3)
        expected_y, expected_x = np.unravel_index(int(np.argmax(distance)), distance.shape)
        self.assertEqual(points.shape, (3, 2))
        self.assertTrue(np.array_equal(labels, np.ones(3, dtype=np.int32)))
        self.assertEqual(tuple(points[0]), (expected_x, expected_y))
        self.assertEqual(len({tuple(point) for point in points}), 3)
        self.assertTrue(all(source[int(y), int(x)] and not hand[int(y), int(x)] for x, y in points))

    def test_specialist_hand_mask_requires_box_containment(self):
        accepted = np.zeros((1, 12, 12), dtype=bool); accepted[0, 4:8, 4:8] = True
        self.assertIsNotNone(accepted_specialist_hand_mask(accepted, (12, 12), (3, 3, 9, 9)))
        outside = np.zeros((1, 12, 12), dtype=bool); outside[0, :3, :3] = True
        self.assertIsNone(accepted_specialist_hand_mask(outside, (12, 12), (3, 3, 9, 9)))

    def test_import_rejects_malformed_and_suffix_mismatched_images(self):
        valid = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(valid, format="PNG")
        state = self.new_state()
        with self.assertRaises(ClientError):
            import_image_list_for_test(state, [{
                "name": "wrong.jpg", "data": base64.b64encode(valid.getvalue()).decode("ascii"),
            }])
        with self.assertRaises(ClientError):
            import_image_list_for_test(state, [{
                "name": "broken.png", "data": base64.b64encode(valid.getvalue()[:20]).decode("ascii"),
            }])

    def test_sam_cpu_setting_never_selects_cuda(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            checkpoint = Path(directory) / "sam.pth"; checkpoint.write_bytes(b"checkpoint")
            record = self._record(image_path, 8, 8)
            state = self.new_state()
            state.root = Path(directory); state.images = {record.image_id: record}; state.order = [record.image_id]
            state.settings["models"].update({"sam_checkpoints": {"vit_b": "", "vit_l": str(checkpoint), "vit_h": ""}, "sam_model_type": "vit_l", "provider": "cpu"})
            model = Mock(); predictor = Mock()
            fake_segment_anything = types.SimpleNamespace(
                SamPredictor=Mock(return_value=predictor), sam_model_registry={"vit_l": Mock(return_value=model)}
            )
            with patch.dict(sys.modules, {"segment_anything": fake_segment_anything}), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                state._sam_predictor_for(record, np.zeros((8, 8, 3), dtype=np.uint8))
            model.to.assert_called_once_with(device="cpu")
            fake_segment_anything.sam_model_registry["vit_l"].assert_called_once_with(checkpoint=None)
            model.load_state_dict.assert_called_once_with({}, strict=True, assign=True)

    def test_missing_sam_checkpoint_has_a_specific_error_code(self):
        state = self.new_state()
        state.settings["models"].update({
            "sam_checkpoints": {"vit_b": "", "vit_l": "", "vit_h": ""},
            "sam_model_type": "vit_b",
        })
        with self.assertRaises(ClientError) as raised:
            state._configured_sam_path()
        self.assertEqual(raised.exception.error_code, "sam_checkpoint_missing")

    def test_sam_constructor_checkpoint_error_is_a_client_error_but_device_error_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            checkpoint = Path(directory) / "sam.pth"; checkpoint.write_bytes(b"checkpoint")
            record = self._record(image_path, 8, 8)
            state = self.new_state()
            state.settings["models"].update({"sam_checkpoints": {"vit_b": str(checkpoint), "vit_l": "", "vit_h": ""}, "sam_model_type": "vit_b", "provider": "cpu"})
            constructor = Mock(side_effect=RuntimeError("bad state dict"))
            with patch.dict(sys.modules, {"segment_anything": types.SimpleNamespace(SamPredictor=Mock(), sam_model_registry={"vit_b": constructor})}), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                with self.assertRaises(ClientError) as raised:
                    state._sam_predictor_for(record, np.zeros((8, 8, 3), dtype=np.uint8))
            self.assertEqual(raised.exception.error_code, "sam_checkpoint_invalid")

            model = Mock(); model.to.side_effect = RuntimeError("out of memory")
            with patch.dict(sys.modules, {"segment_anything": types.SimpleNamespace(SamPredictor=Mock(), sam_model_registry={"vit_b": Mock(return_value=model)})}), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                with self.assertRaisesRegex(RuntimeError, "out of memory"):
                    state._sam_predictor_for(record, np.zeros((8, 8, 3), dtype=np.uint8))

    def test_job_error_response_exposes_only_public_error_code_and_params(self):
        state = self.new_state(); state.job = core_module.Job(kind="detect", state="running")
        state._fail_job(ClientError("out of memory: invalid checkpoint", "sam_checkpoint_invalid", {"model": "vit_b"}))
        data = state.job.as_dict()
        self.assertEqual(data["errorCode"], "sam_checkpoint_invalid")
        self.assertEqual(data["params"], {})
        self.assertNotIn("error", data)

    def test_detection_model_preparation_phase_tracks_real_loading_only(self):
        state = self.new_state(); state.job = core_module.Job(kind="detect", state="running")
        state._set_detection_model_preparation(True)
        state._set_detection_model_preparation(True)
        self.assertEqual(state.job.as_dict()["phase"], "preparing_models")
        state._set_detection_model_preparation(False)
        self.assertEqual(state.job.as_dict()["phase"], "preparing_models")
        state._set_detection_model_preparation(False)
        self.assertEqual(state.job.as_dict()["phase"], "")

    def test_job_active_elapsed_excludes_paused_time(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running", total=1, started_at=100.0)
        state.job_control = core_module.JobControl()
        with patch("mozarie.jobs.time.time", return_value=110.0):
            state.request_pause()
        with patch("mozarie.core.time.time", return_value=150.0):
            self.assertEqual(state.job.as_dict()["activeElapsed"], 10.0)
        with patch("mozarie.jobs.time.time", return_value=160.0):
            state.resume_job()
        with patch("mozarie.core.time.time", return_value=180.0):
            self.assertEqual(state.job.as_dict()["activeElapsed"], 30.0)

    def test_detection_maps_worker_gpu_memory_errors(self):
        for message, error_code in (
            ("out of memory", "internal_error"),
            ("failed to allocate memory", "internal_error"),
            ("bfcarena exhausted", "gpu_out_of_memory"),
            ("cuda out of memory", "gpu_out_of_memory"),
            ("Could not allocate tensor with 1073741824 bytes. There is not enough GPU video memory available!", "gpu_out_of_memory"),
        ):
            with self.subTest(message=message):
                with tempfile.TemporaryDirectory() as directory:
                    source = Path(directory) / "source.png"
                    Image.new("RGB", (16, 16), "white").save(source)
                    state = self.new_state()
                    image_id = state.set_root(directory)[0]["id"]
                    record = state.image_for_id(image_id)
                    state.job = core_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))
                    with patch.object(state, "_ensure_models", return_value=object()), \
                         patch.object(state, "_detect_image", side_effect=RuntimeError(message)):
                        state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 1)
                    self.assertEqual(state.job.state, "error")
                    self.assertEqual(state.job.error_code, error_code)

    def test_torch_oom_uses_effective_parallelism_and_never_exposes_runtime_text(self):
        torch_oom = type("OutOfMemoryError", (RuntimeError,), {"__module__": "torch.cuda"})
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running", parallelism=1)
        state._fail_job(torch_oom("Could not allocate tensor with 1073741824 bytes"))
        self.assertEqual(state.job.error_code, "gpu_out_of_memory")
        self.assertEqual(state.job.params, {"parallelism": 1})
        self.assertNotIn("1073741824", state.job.error)
        self.assertIn("vit_b", state.job.error)

    def test_detection_records_effective_parallelism_for_oom_guidance(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]; record = state.image_for_id(image_id)
            state.job = core_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))
            with patch.object(state, "_ensure_models", return_value=object()), \
                 patch.object(state, "_detect_image", side_effect=RuntimeError("cuda out of memory")):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 4)
            self.assertEqual(state.job.parallelism, 1)
            self.assertEqual(state.job.params, {"parallelism": 1})
            self.assertNotIn("同時実行数を1に下げる", state.job.error)

    def test_gpu_oom_discards_all_cached_models_once(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running")
        state.models = object(); state.sam_predictor = Mock(); state.hand_segmentation_predictor = Mock()
        state._fail_job(RuntimeError("cuda out of memory"))
        with patch.object(state, "_release_gpu_cache") as cache:
            state._release_gpu_job_memory()
        self.assertIsNone(state.models)
        self.assertIsNone(state.sam_predictor)
        self.assertIsNone(state.hand_segmentation_predictor)
        cache.assert_called_once_with(provider="gpu", gpu_device=0)

    def test_sam_and_handseg_share_the_default_gpu_lock(self):
        state = self.new_state()
        self.assertIs(state.sam_lock, state.hand_segmentation_lock)

    def test_detection_reports_a_raw_gpu_execution_error_as_internal(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running")
        with patch.object(state, "_release_gpu_job_memory") as release:
            state._fail_job(RuntimeError("no kernel image is available for execution on the device"))
        self.assertEqual(state.job.error_code, "internal_error")
        self.assertNotIn("kernel image", state.job.error)
        release.assert_not_called()

    def test_terminal_gpu_job_empties_the_pytorch_cache(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "gpu"
        state.job = core_module.Job(kind="detect", state="running")
        cuda = Mock(); cuda.is_available.return_value = True
        with patch.dict(jobs_module.sys.modules, {"torch": types.SimpleNamespace(cuda=cuda)}):
            state._release_gpu_job_memory()
        cuda.empty_cache.assert_called_once_with()

    def test_terminal_gpu_job_does_not_import_torch_just_to_empty_its_cache(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "gpu"
        state.job = core_module.Job(kind="detect", state="running")
        with patch.object(jobs_module.sys, "modules", {}):
            state._release_gpu_job_memory()

    def test_invalidate_sam_image_releases_only_that_image_embeddings(self):
        state = self.new_state()
        state.sam_predictor = Mock()
        state.hand_segmentation_predictor = Mock()
        state.sam_image_id = "current"
        state.hand_segmentation_image_id = "current"
        state.invalidate_sam_image("other")
        state.sam_predictor.reset_image.assert_not_called()
        state.hand_segmentation_predictor.reset_image.assert_not_called()
        state.invalidate_sam_image("current")
        state.sam_predictor.reset_image.assert_called_once_with()
        state.hand_segmentation_predictor.reset_image.assert_called_once_with()

    def test_sam_resets_handseg_embedding_before_setting_its_image(self):
        state = self.new_state()
        state.hand_segmentation_predictor = Mock(); state.hand_segmentation_image_id = "old"
        record = Mock(image_id="new")
        predictor = Mock(); predictor.set_image.return_value = None
        state.sam_predictor = predictor
        state._sam_predictor_for(record, np.zeros((8, 8, 3), dtype=np.uint8))
        state.hand_segmentation_predictor.reset_image.assert_called_once_with()
        self.assertIsNone(state.hand_segmentation_image_id)

    def test_raw_cpu_memory_runtime_error_is_internal(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "cpu"
        state.job = core_module.Job(kind="detect", state="running")
        state._fail_job(RuntimeError("BFCArena failed to allocate memory"))
        self.assertEqual(state.job.error_code, "internal_error")
        self.assertNotIn("GPU", state.job.error)

    def test_explicit_memory_error_has_a_stable_memory_code(self):
        state = self.new_state()
        state.job = core_module.Job(kind="detect", state="running")
        state._fail_job(MemoryError("private allocation details"))
        self.assertEqual(state.job.error_code, "memory_allocation_failed")
        self.assertNotIn("private", state.job.error)

    def test_detection_worker_maps_plain_exception_ort_oom(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            state.job = core_module.Job(kind="detect", state="running", total=1, image_ids=(image_id,))
            with patch.object(state, "_ensure_models", return_value=object()), \
                 patch.object(state, "_detect_image", side_effect=Exception("[ONNXRuntimeError] BFCArena failed to allocate memory")):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 1)
            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.job.error_code, "gpu_out_of_memory")

    def test_model_verification_occurs_once_for_a_loaded_model_set(self):
        state = self.new_state()
        state.settings["models"].update({"ntd11_enabled": False, "sensitive_enabled": False})
        precise = Mock()
        with patch.object(state, "_configured_model_path", return_value=Path("target.onnx")), patch.object(detection_module, "TargetSegmenter", return_value=precise) as segmenter:
            first = state._ensure_models()
            second = state._ensure_models()
        self.assertIs(first, second)
        self.assertEqual(segmenter.call_count, 1)

    def test_terminal_gpu_release_allows_detection_models_to_reload(self):
        state = self.new_state()
        first = object()
        second = object()
        with patch.object(state, "_load_detection_models", side_effect=[first, second]) as load:
            self.assertIs(state._ensure_models(), first)
            state._release_gpu_job_memory()
            self.assertIs(state._ensure_models(), second)
        self.assertEqual(load.call_count, 2)

    def test_auxiliary_setting_change_keeps_sam_cache(self):
        state = self.new_state()
        next_settings = copy.deepcopy(state.settings)
        next_settings["models"]["ntd11_enabled"] = not next_settings["models"]["ntd11_enabled"]
        state.models = object()
        predictor = object()
        state.sam_predictor = predictor
        state.sam_image_id = "image"
        with patch.object(state, "_require_supported_gpu"), patch.object(state.settings_store, "save", return_value=next_settings):
            state.update_settings(next_settings)
        self.assertIsNone(state.models)
        self.assertIs(state.sam_predictor, predictor)
        self.assertEqual(state.sam_image_id, "image")

    def test_settings_only_probe_a_changed_output_directory_and_saves_general_settings(self):
        state = self.new_state()
        unchanged = copy.deepcopy(state.settings)
        with patch.object(state, "_require_supported_gpu"), patch.object(state_module, "validate_output_directory_ready") as ready, \
             patch.object(state.settings_store, "save", return_value=unchanged) as save:
            state.update_settings(unchanged)
        ready.assert_called_once_with(unchanged["saving"]["default_output_directory"])
        save.assert_called_once_with(unchanged)

        changed = copy.deepcopy(state.settings)
        changed["general"]["language"] = "en" if changed["general"]["language"] == "ja" else "ja"
        with patch.object(state, "_require_supported_gpu"), patch.object(state_module, "validate_output_directory_ready") as ready, \
             patch.object(state.settings_store, "save", return_value=changed) as save:
            state.update_settings(changed)
        ready.assert_called_once_with(changed["saving"]["default_output_directory"])
        save.assert_called_once_with(changed)

        with tempfile.TemporaryDirectory() as directory:
            changed_output = copy.deepcopy(state.settings)
            changed_output["saving"]["default_output_directory"] = directory
            with patch.object(state, "_require_supported_gpu"), patch.object(state_module, "validate_output_directory_ready") as ready, \
                 patch.object(state.settings_store, "save", return_value=changed_output) as save:
                state.update_settings(changed_output)
        ready.assert_called_once_with(directory)
        save.assert_called_once_with(changed_output)

    def test_output_validation_uses_its_dedicated_user_error_and_does_not_save(self):
        state = self.new_state()
        changed = copy.deepcopy(state.settings)
        changed["saving"]["default_output_directory"] = r"C:\\unavailable"
        with patch.object(state_module, "validate_output_directory_ready", side_effect=OSError("denied")), \
             patch.object(state.settings_store, "save") as save:
            with self.assertRaises(ClientError) as raised:
                state.update_settings(changed)
        self.assertEqual(raised.exception.error_code, "output_folder_unavailable")
        save.assert_not_called()

    def test_failed_reset_output_validation_keeps_the_existing_machine_override(self):
        state = self.new_state()
        before = copy.deepcopy(state.settings)
        with patch.object(state.settings_store, "default_settings", return_value=copy.deepcopy(before)), \
             patch.object(state_module, "validate_output_directory_ready", side_effect=OSError("denied")), \
             patch.object(state.settings_store, "reset") as reset:
            with self.assertRaises(ClientError) as raised:
                state.reset_settings()
        self.assertEqual(raised.exception.error_code, "output_folder_unavailable")
        reset.assert_not_called()
        self.assertEqual(state.settings, before)

    def test_hand_segmentation_setting_keeps_onnx_sessions(self):
        state = self.new_state()
        state.settings["models"]["hand_detection_enabled"] = True
        next_settings = copy.deepcopy(state.settings)
        next_settings["models"]["hand_segmentation_enabled"] = True
        models = object()
        state.models = models
        with patch.object(state, "_require_supported_gpu"), patch.object(state.settings_store, "save", return_value=next_settings):
            state.update_settings(next_settings)
        self.assertIs(state.models, models)

    def test_model_path_change_releases_old_gpu_resources(self):
        state = self.new_state()
        state.models = object(); sam = object(); handseg = object()
        state.sam_predictor = sam; state.hand_segmentation_predictor = handseg
        next_settings = copy.deepcopy(state.settings)
        next_settings["models"]["target_segmentation"] = "another.onnx"
        with patch.object(state, "_require_supported_gpu"), patch.object(state.settings_store, "save", return_value=next_settings), \
             patch.object(state, "_release_gpu_cache") as release:
            state.update_settings(next_settings)
        self.assertIsNone(state.models)
        self.assertIs(state.sam_predictor, sam)
        self.assertIs(state.hand_segmentation_predictor, handseg)
        release.assert_called_once_with(provider="gpu", gpu_device=0)

    def test_sam_setting_change_keeps_detection_model_cache(self):
        state = self.new_state()
        next_settings = copy.deepcopy(state.settings)
        next_settings["models"]["sam_model_type"] = "vit_b" if next_settings["models"]["sam_model_type"] == "vit_l" else "vit_l"
        models = object()
        state.models = models
        state.sam_predictor = object()
        state.sam_image_id = "image"
        with patch.object(state, "_require_supported_gpu"), patch.object(state.settings_store, "save", return_value=next_settings):
            state.update_settings(next_settings)
        self.assertIs(state.models, models)
        self.assertIsNone(state.sam_predictor)
        self.assertIsNone(state.sam_image_id)

    def test_disabled_auxiliary_models_are_not_loaded(self):
        state = self.new_state()
        state.settings["models"].update({"ntd11_enabled": False, "sensitive_enabled": False})
        with patch.object(state, "_configured_model_path", return_value=Path("target.onnx")), patch.object(detection_module, "TargetSegmenter", return_value=Mock()) as segmenter:
            models = state._ensure_models()
        self.assertEqual(models.auxiliaries, [])
        self.assertEqual(segmenter.call_count, 1)

    def test_enabled_auxiliaries_load_in_priority_order(self):
        state = self.new_state()
        state.settings["models"].update({"ntd11_enabled": True, "sensitive_enabled": True})
        paths = iter((Path("target.onnx"), Path("ntd11.onnx"), Path("sensitive.onnx")))
        with patch.object(state, "_configured_model_path", side_effect=lambda *_args: next(paths)), patch.object(detection_module, "TargetSegmenter", return_value=Mock()), patch.object(
            detection_module, "GenericYoloSegmenter", side_effect=[Mock(), Mock()]
        ):
            models = state._load_detection_models()
        self.assertEqual([source for source, _model in models.auxiliaries], ["ntd11", "sensitive"])

    def test_model_logic_matrix_uses_only_enabled_models(self):
        """48 configuration rows cover runtime, mode and optional-model switches."""
        hand_modes = {
            "off": (False, False),
            "boxes": (True, False),
            "segmentation": (True, True),
        }
        rows = [
            (provider, mode, ntd11, sensitive, hand_mode)
            for provider in ("cpu", "gpu")
            for mode in ("standard", "high_precision")
            for ntd11 in (False, True)
            for sensitive in (False, True)
            for hand_mode in hand_modes
        ]
        self.assertEqual(len(rows), 48)
        for index, (provider, mode, ntd11, sensitive, hand_mode) in enumerate(rows):
            for fluid_enabled in (False, True):
                with self.subTest(provider=provider, mode=mode, ntd11=ntd11, sensitive=sensitive, hand=hand_mode, fluid=fluid_enabled):
                    hand_enabled, handseg_enabled = hand_modes[hand_mode]
                    state = self.new_state()
                    state.settings["models"].update({
                        "provider": provider, "gpu_device": 0,
                        "ntd11_enabled": ntd11, "sensitive_enabled": sensitive,
                        "hand_detection_enabled": hand_enabled, "hand_segmentation_enabled": handseg_enabled,
                    })
                    state.settings["detection"].update({"mode": mode, "fluid_exclusion_enabled": fluid_enabled})
                    target = Mock(name=f"target-{index}")
                    auxiliaries = [Mock(name=f"aux-{index}-0"), Mock(name=f"aux-{index}-1")]
                    hand = Mock(name=f"hand-{index}")
                    with patch.object(state, "_configured_model_path", side_effect=lambda key, _label: Path(f"{key}.onnx")), \
                            patch.object(detection_module, "TargetSegmenter", return_value=target) as target_constructor, \
                            patch.object(detection_module, "GenericYoloSegmenter", side_effect=auxiliaries) as auxiliary_constructor, \
                            patch.object(detection_module, "HandDetector", return_value=hand) as hand_constructor:
                        models = state._load_detection_models()
                        if hand_enabled:
                            self.assertIs(state._ensure_hand_model(models), hand)
                    self.assertIs(models.target, target)
                    self.assertEqual([source for source, _model in models.auxiliaries], [
                        source for source, enabled in (("ntd11", ntd11), ("sensitive", sensitive)) if enabled
                    ])
                    target_constructor.assert_called_once_with(Path("target_segmentation.onnx"), device=provider, gpu_device=0)
                    self.assertEqual(auxiliary_constructor.call_count, int(ntd11) + int(sensitive))
                    self.assertEqual(hand_constructor.call_count, int(hand_enabled))
                    self.assertIsNone(state.hand_segmentation_predictor)

    def test_disabled_optional_models_skip_status_validation(self):
        state = self.new_state()
        state.settings["models"].update({
            "ntd11": "missing-ntd11.onnx", "ntd11_enabled": False,
            "sensitive": "missing-sensitive.onnx", "sensitive_enabled": False,
            "hand_detection": "missing-hand.onnx", "hand_detection_enabled": False,
        })
        status = state.settings_status()["models"]
        self.assertFalse(status["ntd11"]["enabled"])
        self.assertFalse(status["sensitive"]["enabled"])
        self.assertFalse(status["hand_detection"]["enabled"])

    def test_disabled_optional_onnx_paths_are_never_constructed(self):
        state = self.new_state()
        state.settings["models"].update({
            "ntd11": "bad-ntd11.onnx", "ntd11_enabled": False,
            "sensitive": "bad-sensitive.onnx", "sensitive_enabled": False,
            "hand_detection": "bad-hand.onnx", "hand_detection_enabled": False,
        })
        with patch.object(state, "_configured_model_path", return_value=Path("target.onnx")), \
             patch.object(detection_module, "TargetSegmenter", return_value=Mock()), \
             patch.object(detection_module, "GenericYoloSegmenter") as generic, \
             patch.object(detection_module, "HandDetector") as hand:
            state._load_detection_models()
        generic.assert_not_called()
        hand.assert_not_called()

    def test_gpu_shape_error_is_not_elevated_to_gpu_unavailable(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "gpu"
        state.job = core_module.Job(kind="detect", state="running", total=1)
        state._fail_job(RuntimeError("CUDA model input shape is invalid"))
        self.assertNotEqual(state.job.error_code, "gpu_unavailable")

    def test_raw_invalid_model_outputs_are_reported_as_internal_without_decoder_details(self):
        for model_name in ("target", "ntd11", "sensitive", "hand"):
            with self.subTest(model_name=model_name):
                state = self.new_state()
                state.job = core_module.Job(kind="detect", state="running", total=1)
                state._fail_job(ValueError(f"{model_name} private decoder shape"))
                self.assertEqual(state.job.error_code, "internal_error")
                self.assertNotIn("private decoder", state.job.error)

    def test_active_onnx_model_loads_hide_runtime_details_for_each_model(self):
        cases = (
            ("target", {"ntd11_enabled": False, "sensitive_enabled": False, "hand_detection_enabled": False}, "_load_detection_models", "TargetSegmenter"),
            ("ntd11", {"ntd11_enabled": True, "sensitive_enabled": False, "hand_detection_enabled": False}, "_load_detection_models", "GenericYoloSegmenter"),
            ("sensitive", {"ntd11_enabled": False, "sensitive_enabled": True, "hand_detection_enabled": False}, "_load_detection_models", "GenericYoloSegmenter"),
            ("hand", {"ntd11_enabled": False, "sensitive_enabled": False, "hand_detection_enabled": True}, "_ensure_hand_model", "HandDetector"),
        )
        for model_name, settings, method_name, constructor_name in cases:
            with self.subTest(model_name=model_name):
                state = self.new_state(); state.settings["models"].update(settings)
                constructor = getattr(detection_module, constructor_name)
                with patch.object(state, "_configured_model_path", return_value=Path("model.onnx")), \
                     patch.object(detection_module, "TargetSegmenter", return_value=Mock()), \
                     patch.object(detection_module, "GenericYoloSegmenter", return_value=Mock()), \
                     patch.object(detection_module, "HandDetector", return_value=Mock()), \
                     patch.object(detection_module, constructor_name, side_effect=RuntimeError(f"{model_name} private model detail")):
                    with self.assertRaises(ClientError) as raised:
                        getattr(state, method_name)()
                self.assertEqual(raised.exception.error_code, "model_load_failed")
                self.assertNotIn("private model detail", str(raised.exception))

    def test_sam_status_is_required_only_for_high_precision(self):
        state = self.new_state()
        state.settings["models"]["sam_checkpoints"] = {"vit_b": "missing.pth", "vit_l": "", "vit_h": ""}
        standard = state.settings_status()["models"]["sam_checkpoint"]
        self.assertEqual((standard["required"], standard["enabled"], standard["valid"]), (False, False, False))
        state.settings["detection"]["mode"] = "high_precision"
        precise = state.settings_status()["models"]["sam_checkpoint"]
        self.assertEqual((precise["required"], precise["enabled"], precise["reasonCode"]), (True, True, "missing"))

    def test_health_allows_standard_mode_without_sam(self):
        from http.server import ThreadingHTTPServer

        state = self.new_state()
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        status = {
            "models": {
                "target_segmentation": {"required": True, "enabled": True, "valid": True},
                "sam_checkpoint": {"required": False, "enabled": False, "valid": False},
                "hand_segmentation": {"required": False, "enabled": False, "valid": False},
            },
            "gpus": [{"id": 0, "name": "Test GPU", "supported": True}],
        }

        def health(status_value):
            with patch.object(http_module, "STATE", state), patch.object(state, "settings_status", return_value=status_value):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                connection.request("GET", "/api/health")
                response = connection.getresponse(); payload = json.loads(response.read())
                connection.close()
            return payload["modelsConfigured"]

        try:
            for provider in ("cpu", "gpu"):
                state.settings["models"]["provider"] = provider
                self.assertTrue(health(status))
                handseg_missing = copy.deepcopy(status); handseg_missing["models"]["hand_segmentation"] = {"required": False, "enabled": True, "valid": False}
                self.assertFalse(health(handseg_missing))
                high_precision_missing_sam = copy.deepcopy(status); high_precision_missing_sam["models"]["sam_checkpoint"] = {"required": True, "enabled": True, "valid": False}
                self.assertFalse(health(high_precision_missing_sam))
        finally:
            httpd.shutdown(); httpd.server_close()

    def test_standard_detection_never_loads_sam_and_keeps_handseg_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (16, 16), "white").save(image_path)
            record = self._record(image_path, 16, 16)
            state = self.new_state(); state.root = Path(directory); state.images = {record.image_id: record}; state.order = [record.image_id]
            target_mask = np.zeros((16, 16), dtype=np.uint8); target_mask[2:14, 2:14] = 255
            hand_mask = np.zeros((16, 16), dtype=np.uint8); hand_mask[5:8, 5:8] = 255
            segments = [{"class_name": "penis", "confidence": 0.8, "mask": target_mask, "source": "target"}]
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                 patch.object(state, "_hand_refinement_context", return_value=([segments[0]], hand_mask, [(4, 4, 10, 10)])), \
                 patch.object(state, "_sam_predictor_for") as sam:
                candidates = state._detect_image(DetectionModels(target=object()), record, 0.5, mode="standard")
            sam.assert_not_called()
            self.assertEqual([candidate.source for candidate in candidates], ["hand_exclusion", "target"])

    def test_high_precision_loads_sam_once_only_when_targets_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (16, 16), "white").save(image_path)
            record = self._record(image_path, 16, 16)
            state = self.new_state(); state.root = Path(directory); state.images = {record.image_id: record}; state.order = [record.image_id]
            target_mask = np.zeros((16, 16), dtype=np.uint8); target_mask[2:14, 2:14] = 255
            segments = [{"class_name": "penis", "confidence": 0.8, "mask": target_mask, "source": "target"}]
            predictor = Mock()
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                 patch.object(state, "_hand_refinement_context", return_value=([segments[0]], np.zeros((16, 16), dtype=np.uint8), [])), \
                 patch.object(state, "_sam_predictor_for", return_value=predictor) as sam, \
                 patch.object(state, "_high_precision_segments_with_predictor", return_value=segments):
                state._detect_image(DetectionModels(target=object()), record, 0.5, mode="high_precision")
            sam.assert_called_once_with(record, ANY)

            with patch.object(state, "_detect_arbitrated_segments", return_value=[]), \
                 patch.object(state, "_hand_refinement_context", return_value=([], np.zeros((16, 16), dtype=np.uint8), [(1, 1, 4, 4)])), \
                 patch.object(state, "_sam_predictor_for") as sam:
                self.assertEqual(state._detect_image(DetectionModels(target=object()), record, 0.5, mode="high_precision"), [])
            sam.assert_not_called()

    def test_hand_segmentation_predictor_strictly_loads_vit_b_once_per_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            checkpoint = root / "handsegnet.safetensors"; checkpoint.write_bytes(b"checkpoint")
            record = self._record(image_path, 8, 8)
            state = self.new_state()
            state.settings["models"].update({"hand_segmentation": str(checkpoint), "provider": "cpu"})
            state_dict = {"mask_decoder.mask_tokens.weight": object()}
            load_file = Mock(return_value=state_dict)
            model = Mock(); predictor = Mock()
            vit_b = Mock(return_value=model)
            fake_safetensors = types.ModuleType("safetensors"); fake_safetensors.__path__ = []
            fake_safetensors_torch = types.ModuleType("safetensors.torch"); fake_safetensors_torch.load_file = load_file
            fake_segment_anything = types.SimpleNamespace(SamPredictor=Mock(return_value=predictor), sam_model_registry={"vit_b": vit_b})
            with patch.dict(sys.modules, {"safetensors": fake_safetensors, "safetensors.torch": fake_safetensors_torch, "segment_anything": fake_segment_anything}), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                rgb = np.zeros((8, 8, 3), dtype=np.uint8)
                self.assertIs(state._hand_segmentation_predictor_for(record, rgb), predictor)
                self.assertIs(state._hand_segmentation_predictor_for(record, rgb), predictor)
            load_file.assert_called_once_with(str(checkpoint), device="cpu")
            vit_b.assert_called_once_with(checkpoint=None)
            model.load_state_dict.assert_called_once_with(state_dict, strict=True, assign=True)
            model.to.assert_called_once_with(device="cpu")
            fake_segment_anything.SamPredictor.assert_called_once_with(model)
            predictor.set_image.assert_called_once()

    def test_hand_segmentation_state_dict_runtime_error_is_a_client_error(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "handsegnet.safetensors"; checkpoint.write_bytes(b"checkpoint")
            image_path = Path(directory) / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            state = self.new_state(); state.settings["models"].update({"hand_segmentation": str(checkpoint), "provider": "cpu"})
            model = Mock(); model.load_state_dict.side_effect = RuntimeError("mismatch")
            fake_safetensors = types.ModuleType("safetensors"); fake_safetensors.__path__ = []
            fake_torch = types.ModuleType("safetensors.torch"); fake_torch.load_file = Mock(return_value={})
            fake_sam = types.SimpleNamespace(SamPredictor=Mock(), sam_model_registry={"vit_b": Mock(return_value=model)})
            with patch.dict(sys.modules, {"safetensors": fake_safetensors, "safetensors.torch": fake_torch, "segment_anything": fake_sam}), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                with self.assertRaises(ClientError) as raised:
                    state._hand_segmentation_predictor_for(self._record(image_path, 8, 8), np.zeros((8, 8, 3), dtype=np.uint8))
            self.assertEqual(raised.exception.error_code, "model_load_failed")

    def test_hand_segmentation_gpu_oom_is_not_misclassified_as_a_bad_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "handsegnet.safetensors"; checkpoint.write_bytes(b"checkpoint")
            image_path = Path(directory) / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            state = self.new_state(); state.settings["models"].update({"hand_segmentation": str(checkpoint), "provider": "gpu"})
            model = Mock(); model.load_state_dict.side_effect = RuntimeError("Could not allocate tensor with 1073741824 bytes. There is not enough GPU video memory available!")
            fake_safetensors = types.ModuleType("safetensors"); fake_safetensors.__path__ = []
            fake_torch = types.ModuleType("safetensors.torch"); fake_torch.load_file = Mock(return_value={})
            fake_sam = types.SimpleNamespace(SamPredictor=Mock(), sam_model_registry={"vit_b": Mock(return_value=model)})
            with patch.dict(sys.modules, {"safetensors": fake_safetensors, "safetensors.torch": fake_torch, "segment_anything": fake_sam}), \
                 patch.object(catalog_module, "torch_module", return_value=fake_catalog_torch()):
                with self.assertRaisesRegex(RuntimeError, "not enough GPU video memory"):
                    state._hand_segmentation_predictor_for(self._record(image_path, 8, 8), np.zeros((8, 8, 3), dtype=np.uint8))

    def test_hand_segmentation_device_runtime_error_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "handsegnet.safetensors"; checkpoint.write_bytes(b"checkpoint")
            image_path = Path(directory) / "image.png"; Image.new("RGB", (8, 8), "white").save(image_path)
            state = self.new_state(); state.settings["models"].update({"hand_segmentation": str(checkpoint), "provider": "cpu"})
            model = Mock(); model.to.side_effect = RuntimeError("device")
            fake_safetensors = types.ModuleType("safetensors"); fake_safetensors.__path__ = []
            fake_torch = types.ModuleType("safetensors.torch"); fake_torch.load_file = Mock(return_value={})
            fake_sam = types.SimpleNamespace(SamPredictor=Mock(), sam_model_registry={"vit_b": Mock(return_value=model)})
            with patch.dict(sys.modules, {"safetensors": fake_safetensors, "safetensors.torch": fake_torch, "segment_anything": fake_sam}), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                with self.assertRaisesRegex(RuntimeError, "device"):
                    state._hand_segmentation_predictor_for(self._record(image_path, 8, 8), np.zeros((8, 8, 3), dtype=np.uint8))

    def test_target_and_auxiliary_segments_are_arbitrated_once(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "cpu"
        mask = np.zeros((10, 10), dtype=np.uint8); mask[2:8, 2:8] = 255
        target = Mock(); target.detect.return_value = [{"class_name": "penis", "confidence": 0.6, "mask": mask, "source": "target"}]
        auxiliary = Mock()
        auxiliary.detect.side_effect = lambda tile, _confidence, source, _targets: [{
            "class_name": "penis", "confidence": 0.9, "mask": np.full(tile.shape[:2], 255, dtype=np.uint8), "source": source,
        }]
        models = DetectionModels(target=target, auxiliaries=[("ntd11", auxiliary)])
        segments = state._detect_arbitrated_segments(models, np.zeros((10, 10, 3), dtype=np.uint8), 0.5)
        self.assertEqual([segment["source"] for segment in segments], ["target"])
        self.assertEqual(auxiliary.detect.call_count, len(detection_tiles(10, 10)))

    def test_auxiliaries_receive_default_and_selected_target_sets(self):
        state = self.new_state()
        target = Mock(); target.detect.return_value = []
        seen: list[tuple[str, set[str]]] = []

        def detect(tile, _confidence, source, targets):
            seen.append((source, set(targets)))
            return []

        models = DetectionModels(target=target, auxiliaries=[("ntd11", Mock(detect=detect)), ("sensitive", Mock(detect=detect))])
        image = np.zeros((10, 10, 3), dtype=np.uint8)
        for selected, expected in ((TARGET_CLASSES, {"penis", "pussy", "testicles"}), ({"penis"}, {"penis", "testicles"}), ({"pussy"}, {"pussy"})):
            seen.clear()
            state._detect_arbitrated_segments(models, image, 0.5, selected)
            self.assertTrue(seen)
            self.assertEqual({source for source, _targets in seen}, {"ntd11", "sensitive"})
            self.assertTrue(all(targets == expected for _source, targets in seen))

    def test_hand_model_verification_occurs_once_after_first_load(self):
        state = self.new_state()
        models = DetectionModels(Mock())
        hand = Mock()
        with patch.object(state, "_configured_model_path", return_value=Path("hand.onnx")), patch.object(detection_module, "HandDetector", return_value=hand) as detector:
            first = state._ensure_hand_model(models)
            second = state._ensure_hand_model(models)
        self.assertIs(first, second)
        self.assertEqual(detector.call_count, 1)

    def test_boundary_then_auto_reuses_one_hand_detector(self):
        state = self.new_state(); state.settings["models"]["hand_detection_enabled"] = True
        hand = Mock(); hand.detect_boxes.return_value = []
        with patch.object(state, "_configured_model_path", return_value=Path("hand.onnx")), patch.object(detection_module, "HandDetector", return_value=hand) as detector:
            state._boundary_hand_boxes(np.zeros((8, 8, 3), dtype=np.uint8))
            state._ensure_hand_model(DetectionModels(Mock()))
        self.assertEqual(detector.call_count, 1)

    def test_auto_then_boundary_reuses_one_hand_detector(self):
        state = self.new_state(); state.settings["models"]["hand_detection_enabled"] = True
        hand = Mock(); hand.detect_boxes.return_value = []
        with patch.object(state, "_configured_model_path", return_value=Path("hand.onnx")), patch.object(detection_module, "HandDetector", return_value=hand) as detector:
            state._ensure_hand_model(DetectionModels(Mock()))
            state._boundary_hand_boxes(np.zeros((8, 8, 3), dtype=np.uint8))
        self.assertEqual(detector.call_count, 1)

    def test_boundary_operation_keeps_cached_hand_model_until_a_job_ends(self):
        state = self.new_state(); state.settings["models"]["hand_detection_enabled"] = True
        hand = Mock(); hand.detect_boxes.return_value = []
        with patch.object(state, "_configured_model_path", return_value=Path("hand.onnx")), \
             patch.object(detection_module, "HandDetector", return_value=hand), \
             patch.object(state, "_release_gpu_job_memory") as release:
            state._boundary_hand_boxes(np.zeros((8, 8, 3), dtype=np.uint8))
        self.assertIs(state.hand_model, hand)
        release.assert_not_called()

    def test_hand_detector_is_dropped_with_gpu_model_cache(self):
        state = self.new_state(); state.hand_model = Mock()
        with patch.object(state, "_release_gpu_cache"):
            state._release_gpu_job_memory()
        self.assertIsNone(state.hand_model)

    def test_precise_segments_receive_hand_refinement(self):
        state = self.new_state()
        state.settings["models"]["hand_segmentation_enabled"] = False
        precise_mask = np.zeros((16, 16), dtype=np.uint8)
        precise_mask[4:12, 4:12] = 255
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0)
        sam_mask = np.zeros((1, 16, 16), dtype=bool)
        sam_mask[0, 4:8, 4:8] = True
        predictor = Mock()
        predictor.predict.return_value = sam_mask, np.asarray([0.95]), None
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 12, 12)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": precise_mask, "source": "target"}],
            )
        self.assertTrue(np.array_equal(result[0]["mask"], precise_mask))
        self.assertTrue(np.any(result[0]["_confirmed_hand"]))
        predictor.predict.assert_called_once()

    def test_specialist_hand_segmentation_success_never_uses_generic_sam(self):
        state = self.new_state()
        state.settings["models"]["hand_segmentation_enabled"] = True
        record = Mock(image_id="image")
        genital = np.zeros((16, 16), dtype=np.uint8); genital[4:12, 4:12] = 255
        specialist_mask = np.zeros((1, 16, 16), dtype=bool); specialist_mask[0, 4:8, 4:8] = True
        specialist = Mock(); specialist.predict.return_value = specialist_mask, np.asarray([0.5]), None
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_hand_segmentation_predictor_for", return_value=specialist
        ), patch.object(state, "_sam_predictor_for") as generic:
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": genital, "source": "target"}],
            )
        generic.assert_not_called()
        specialist.predict.assert_called_once()
        self.assertTrue(np.any(result[0]["_confirmed_hand"]))

    def test_specialist_handseg_rejection_uses_generic_sam(self):
        state = self.new_state()
        state.settings["models"]["hand_segmentation_enabled"] = True
        events: list[str] = []

        class TraceLock:
            def __enter__(self):
                events.append("specialist-enter")
                return self

            def __exit__(self, *_args):
                events.append("specialist-exit")
                return False

        state.hand_segmentation_lock = TraceLock()
        genital = np.zeros((16, 16), dtype=np.uint8); genital[4:12, 4:12] = 255
        invalid = np.zeros((1, 16, 16), dtype=bool)
        specialist = Mock()
        specialist.predict.side_effect = lambda **_kwargs: events.append("specialist-predict") or (invalid, np.asarray([0.5]), None)
        generic_mask = np.zeros((1, 16, 16), dtype=bool); generic_mask[0, 4:8, 4:8] = True
        generic = Mock(); generic.predict.return_value = generic_mask, np.asarray([0.95]), None

        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_hand_segmentation_predictor_for", return_value=specialist
        ), patch.object(state, "_sam_predictor_for", return_value=generic):
            result = state._refine_detected_segments(
                Mock(), Mock(image_id="image"), Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": genital, "source": "target"}],
            )
        self.assertEqual(events, ["specialist-enter", "specialist-predict", "specialist-exit"])
        generic.predict.assert_called_once()
        self.assertTrue(np.any(result[0]["_confirmed_hand"]))

    def test_specialist_client_error_propagates_without_generic_sam(self):
        state = self.new_state()
        state.settings["models"]["hand_segmentation_enabled"] = True
        genital = np.zeros((16, 16), dtype=np.uint8); genital[4:12, 4:12] = 255
        generic_mask = np.zeros((1, 16, 16), dtype=bool); generic_mask[0, 4:8, 4:8] = True
        generic = Mock(); generic.predict.return_value = generic_mask, np.asarray([0.95]), None
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_hand_segmentation_predictor_for", side_effect=ClientError("bad specialist", "hand_segmentation_invalid")
        ), patch.object(state, "_sam_predictor_for", return_value=generic):
            with self.assertRaisesRegex(ClientError, "bad specialist"):
                state._refine_detected_segments(
                    Mock(), Mock(image_id="image"), np.zeros((16, 16, 3), dtype=np.uint8),
                    [{"class_name": "penis", "confidence": 0.8, "mask": genital, "source": "target"}],
                )
        generic.assert_not_called()

    def test_handseg_checkpoint_failure_propagates(self):
        state = self.new_state()
        state.settings["models"]["hand_segmentation_enabled"] = True
        record = Mock(image_id="image")
        genital = np.zeros((16, 16), dtype=np.uint8); genital[4:12, 4:12] = 255
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), \
             patch.object(state, "_hand_segmentation_predictor_for", side_effect=ClientError("bad checkpoint", "hand_segmentation_invalid")) as specialist:
            with self.assertRaisesRegex(ClientError, "bad checkpoint"):
                state._hand_refinement_context(Mock(), record, np.zeros((16, 16, 3), dtype=np.uint8), [{"class_name": "penis", "confidence": 0.8, "mask": genital, "source": "target"}])
        specialist.assert_called_once()

    def test_hand_segmentation_load_mismatch_propagates_without_generic_sam(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "handsegnet.safetensors"; checkpoint.write_bytes(b"checkpoint")
            image_path = root / "image.png"; Image.new("RGB", (16, 16), "white").save(image_path)
            record = self._record(image_path, 16, 16)
            state = self.new_state()
            state.settings["models"].update({
                "hand_segmentation": str(checkpoint), "hand_segmentation_enabled": True, "provider": "cpu",
            })
            genital = np.zeros((16, 16), dtype=np.uint8); genital[4:12, 4:12] = 255
            model = Mock(); model.load_state_dict.side_effect = RuntimeError("mismatch")
            fake_safetensors = types.ModuleType("safetensors"); fake_safetensors.__path__ = []
            fake_torch = types.ModuleType("safetensors.torch"); fake_torch.load_file = Mock(return_value={})
            fake_sam = types.SimpleNamespace(SamPredictor=Mock(), sam_model_registry={"vit_b": Mock(return_value=model)})
            generic_mask = np.zeros((1, 16, 16), dtype=bool); generic_mask[0, 4:8, 4:8] = True
            generic = Mock(); generic.predict.return_value = generic_mask, np.asarray([0.95]), None

            with patch.dict(sys.modules, {
                "safetensors": fake_safetensors, "safetensors.torch": fake_torch, "segment_anything": fake_sam,
            }), patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
                state, "_sam_predictor_for", return_value=generic
            ), patch.object(
                catalog_module, "torch_module", return_value=fake_catalog_torch()
            ):
                with self.assertRaisesRegex(ClientError, "HandSegNet"):
                    state._refine_detected_segments(
                        Mock(), record, np.zeros((16, 16, 3), dtype=np.uint8),
                        [{"class_name": "penis", "confidence": 0.8, "mask": genital, "source": "target"}],
                    )

            model.load_state_dict.assert_called_once_with({}, strict=True, assign=True)
            model.to.assert_not_called()
            generic.assert_not_called()

    def test_full_hand_exclusion_is_kept_separate_from_the_apply_mask(self):
        state = self.new_state()
        final_mask = np.zeros((12, 12), dtype=np.uint8); final_mask[2:10, 2:10] = 255
        hand = np.zeros_like(final_mask); hand[2:6, 2:10] = 255
        segment = {"class_name": "penis", "mask": final_mask, "_confirmed_hand": hand}
        segment["image_exclusions"] = {"hand": hand}
        finalized = state._finalize_exclusions(np.zeros((12, 12, 3), dtype=np.uint8), [segment])[0]
        self.assertTrue(np.array_equal(finalized["image_exclusions"]["hand"], hand))

    def test_hand_sam_runs_once_per_detected_hand_and_is_reused_by_all_segments(self):
        state = self.new_state()
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0)
        base_mask = np.zeros((16, 16), dtype=np.uint8)
        base_mask[4:12, 4:12] = 255

        def predict(*, box, **_kwargs):
            mask = np.zeros((1, 16, 16), dtype=bool)
            if box[0] < 5:
                mask[0, 4:6, 4:6] = True
            else:
                mask[0, 10:12, 10:12] = True
            return mask, np.asarray([0.95]), None

        predictor = Mock()
        predictor.predict.side_effect = predict
        segments = [
            {"class_name": "penis", "confidence": 0.8, "mask": base_mask.copy(), "source": source}
            for source in ("target", "ntd11", "sensitive")
        ]
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8), (8, 8, 12, 12), (0, 0, 2, 2)]) as hand_boxes, patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(Mock(), record, Image.new("RGB", (16, 16), "white"), segments)
        hand_boxes.assert_called_once()
        self.assertEqual(predictor.predict.call_count, 2)
        self.assertTrue(all(np.count_nonzero(segment["_confirmed_hand"]) == 8 for segment in result))
        self.assertTrue(all(np.count_nonzero(segment["mask"]) == 64 for segment in result))

    def test_pussy_skips_white_fluid_refinement(self):
        state = self.new_state()
        pussy = np.zeros((16, 16), dtype=np.uint8)
        pussy[4:12, 4:12] = 255
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0)
        with patch.object(state, "_hand_boxes", return_value=[]), patch.object(detection_module, "white_fluid_mask") as fluid_mask:
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "pussy", "confidence": 0.8, "mask": pussy, "source": "target"}],
            )
        fluid_mask.assert_not_called()
        self.assertNotIn("refinement", result[0])

    def test_finalization_applies_fluid_to_every_nonempty_target_once(self):
        state = self.new_state()
        rgb = np.zeros((40, 40, 3), dtype=np.uint8)
        penis = np.zeros((40, 40), dtype=np.uint8); penis[2:18, 2:18] = 255
        pussy = np.zeros((40, 40), dtype=np.uint8); pussy[22:38, 22:38] = 255
        segments = [
            {"class_name": "penis", "mask": penis, "confidence": .8, "source": "target"},
            {"class_name": "pussy", "mask": pussy, "confidence": .8, "source": "target"},
        ]
        with patch.object(detection_module, "white_fluid_mask", side_effect=lambda _rgb, mask: mask) as fluid_mask:
            finalized = state._finalize_exclusions(rgb, segments)
        self.assertEqual(fluid_mask.call_count, 2)
        self.assertTrue(np.array_equal(finalized[0]["exclusions"]["fluid"] > 0, (penis > 0) | (pussy > 0)))
        self.assertEqual(finalized[1]["exclusions"], {})

    def test_finalization_skips_fluid_search_for_empty_apply_masks_and_when_disabled(self):
        state = self.new_state()
        rgb = np.zeros((16, 16, 3), dtype=np.uint8)
        empty = {"class_name": "penis", "mask": np.zeros((16, 16), dtype=np.uint8), "confidence": .8, "source": "target"}
        with patch.object(detection_module, "white_fluid_mask") as fluid_mask:
            finalized = state._finalize_exclusions(rgb, [empty])
        fluid_mask.assert_not_called()
        self.assertEqual(finalized[0]["exclusions"], {})

        state.settings["detection"]["fluid_exclusion_enabled"] = False
        nonempty = {"class_name": "pussy", "mask": np.ones((16, 16), dtype=np.uint8), "confidence": .8, "source": "target"}
        with patch.object(detection_module, "white_fluid_mask") as fluid_mask:
            finalized = state._finalize_exclusions(rgb, [nonempty])
        fluid_mask.assert_not_called()
        self.assertEqual(finalized[0]["exclusions"], {})

    def test_hand_exclusion_is_not_published_when_it_would_remove_most_of_a_target(self):
        state = self.new_state()
        mask = np.ones((20, 20), dtype=np.uint8)
        hand = np.zeros_like(mask); hand[:16, :] = 255
        segment = {"class_name": "penis", "mask": mask, "confidence": .8, "source": "target", "image_exclusions": {"hand": hand}}
        finalized = state._finalize_exclusions(np.zeros((20, 20, 3), dtype=np.uint8), [segment])
        self.assertFalse(np.any(finalized[0]["image_exclusions"].get("hand", np.zeros_like(mask))))
        self.assertTrue(np.array_equal(finalized[0]["mask"], mask))

    def test_hand_exclusion_does_not_reenter_an_unsafe_target_via_an_overlap(self):
        state = self.new_state()
        unsafe = np.zeros((30, 30), dtype=np.uint8); unsafe[:20, :20] = 255
        safe = np.zeros((30, 30), dtype=np.uint8); safe[14:30, 14:30] = 255
        hand = np.zeros((30, 30), dtype=np.uint8)
        hand[:16, :20] = 255
        hand[22:26, 22:30] = 255
        segments = [
            {"class_name": "penis", "mask": unsafe, "confidence": .8, "source": "target", "image_exclusions": {"hand": hand}},
            {"class_name": "pussy", "mask": safe, "confidence": .8, "source": "target"},
        ]
        finalized = state._finalize_exclusions(np.zeros((30, 30, 3), dtype=np.uint8), segments)
        published = finalized[0]["image_exclusions"]["hand"]
        self.assertFalse(np.any(published[unsafe > 0]))
        self.assertTrue(np.all(published[22:26, 22:30] == 255))

    def test_hand_and_fluid_refinement_metadata(self):
        state = self.new_state()
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        rgb[14:18, 14:18] = 255
        sam_mask = np.zeros((1, 24, 24), dtype=bool)
        sam_mask[0, 4:8, 2:10] = True
        predictor = Mock()
        predictor.predict.return_value = sam_mask, np.asarray([0.95]), None
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=24, height=24, mtime_ns=0)
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(
                Mock(), record, Image.fromarray(rgb),
                [{"class_name": "penis", "confidence": 0.8, "mask": penis, "source": "target"}],
            )
        result = state._finalize_exclusions(rgb, result)
        self.assertEqual(np.count_nonzero(result[0]["mask"]), 400)
        self.assertTrue(np.any(result[0]["image_exclusions"]["hand"]))
        self.assertTrue(np.any(result[0]["exclusions"]["fluid"]))

    def test_hand_mask_creates_an_image_exclusion_without_target_segments(self):
        state = self.new_state()
        record = Mock(image_id="image")
        hand = np.zeros((16, 16), dtype=bool); hand[4:8, 4:8] = True
        predictor = Mock(); predictor.predict.return_value = np.asarray([hand]), np.asarray([0.95]), None
        with patch.object(state, "_hand_boxes", return_value=[(4, 4, 8, 8)]), patch.object(
            state, "_sam_predictor_for", return_value=predictor
        ):
            result = state._refine_detected_segments(Mock(), record, np.zeros((16, 16, 3), dtype=np.uint8), [])
        self.assertEqual(result[0]["class_name"], "__hand_exclusion__")
        self.assertTrue(np.any(result[0]["image_exclusions"]["hand"]))

    def test_fluid_exclusion_can_be_disabled_without_changing_hand_refinement(self):
        state = self.new_state()
        state.settings["detection"]["fluid_exclusion_enabled"] = False
        penis = np.zeros((16, 16), dtype=np.uint8)
        penis[2:14, 2:14] = 255
        record = ImageRecord(image_id="image", path=Path(__file__), relative_path="image.png", width=16, height=16, mtime_ns=0)
        with patch.object(state, "_hand_boxes", return_value=[]), patch.object(detection_module, "white_fluid_mask") as fluid_mask:
            result = state._refine_detected_segments(
                Mock(), record, Image.new("RGB", (16, 16), "white"),
                [{"class_name": "penis", "confidence": 0.8, "mask": penis.copy(), "source": "target"}],
            )
        fluid_mask.assert_not_called()
        self.assertTrue(np.array_equal(result[0]["mask"], penis))
        result = state._finalize_exclusions(np.zeros((16, 16, 3), dtype=np.uint8), result)
        self.assertEqual(result[0]["exclusions"], {})

    def test_scene_metadata_fluid_search_uses_only_exact_tags_and_local_rois(self):
        self.assertEqual(detection_module._scene_fluid_tags({"scene_positive": " CUM_ON_BREASTS , cum on fingers"}), {"cum_on_breasts", "cum on fingers"})
        self.assertEqual(detection_module._scene_fluid_tags({"scene_info": '{"positive":"cum on ass"}'}), {"cum on ass"})
        for info in ({}, {"scene_info": "bad"}, {"scene_info": "[]"}, {"scene_positive": "not_cum_on_breasts"}, {"scene_positive": ["cum_on_breasts"]}):
            with self.subTest(info=info): self.assertEqual(detection_module._scene_fluid_tags(info), set())

        rgb = np.zeros((400, 400, 3), dtype=np.uint8)
        target = np.zeros((400, 400), dtype=np.uint8); target[160:210, 160:200] = 1
        hand = np.zeros_like(target); hand[100:120, 310:330] = 1; hand[250:270, 350:360] = 1
        face = np.zeros_like(target); face[20:40, 130:170] = 1
        with patch.object(detection_module, "white_fluid_mask", side_effect=lambda _rgb, search: np.asarray(search, dtype=np.uint8) * 255) as fluid:
            ass = self.new_state()._metadata_fluid_mask(rgb, [np.zeros_like(target), target], np.zeros_like(hand), [], frozenset({"cum on ass"}))
            fingers = self.new_state()._metadata_fluid_mask(rgb, [target], hand, [], frozenset({"cum on fingers"}))
            chest = self.new_state()._metadata_fluid_mask(
                rgb, [], np.zeros_like(target), [{"mask": np.zeros_like(face)}, {"mask": face}], frozenset({"cum_on_breasts"}),
            )
            absent = self.new_state()._metadata_fluid_mask(rgb, [], np.zeros_like(hand), [], frozenset({"cum on fingers"}))
        self.assertEqual(fluid.call_count, 3)
        self.assertEqual(ass[150, 100], 255)
        self.assertEqual(ass[314, 259], 255)
        self.assertEqual(ass[149, 180], 0)
        self.assertEqual(fingers[92, 281], 255)
        self.assertEqual(fingers[125, 358], 255)
        self.assertEqual(fingers[242, 321], 255)
        self.assertEqual(fingers[275, 388], 255)
        self.assertEqual(fingers[150, 180], 0)
        self.assertTrue(np.any(chest[53:73, 135:165]))
        self.assertFalse(np.any(chest[:40]))
        self.assertFalse(np.any(absent))

    def test_scene_metadata_fluid_only_detects_lower_deposits_in_the_tagged_local_roi(self):
        rgb = np.zeros((400, 400, 3), dtype=np.uint8)
        target = np.zeros((400, 400), dtype=np.uint8); target[160:210, 160:200] = 1
        rgb[120:140, 130:230] = 255  # White clothing above the ass ROI is not a candidate.
        rgb[250:255, 170:190] = 255  # A small bright lower deposit remains a candidate.
        detected = self.new_state()._metadata_fluid_mask(rgb, [target], np.zeros_like(target), [], frozenset({"cum on ass"}))
        untagged = self.new_state()._metadata_fluid_mask(rgb, [target], np.zeros_like(target), [], frozenset({"not_cum_on_ass"}))
        self.assertFalse(np.any(detected[120:140, 130:230]))
        self.assertTrue(np.any(detected[250:255, 170:190]))
        self.assertFalse(np.any(untagged))

    def test_scene_metadata_fluid_candidate_is_optional_and_can_exist_without_apply(self):
        state = self.new_state()
        rgb = np.zeros((40, 40, 3), dtype=np.uint8)
        target = np.zeros((40, 40), dtype=np.uint8); target[10:20, 10:20] = 255
        with patch.object(state, "_metadata_fluid_mask", return_value=np.ones((40, 40), dtype=np.uint8) * 255):
            finalized = state._finalize_exclusions(rgb, [{"class_name": "penis", "mask": target, "confidence": .8, "source": "target"}], frozenset({"cum on ass"}))
        self.assertIn("metadata_exclusions", finalized[0])
        self.assertNotIn("fluid", finalized[0]["exclusions"])
        with patch.object(state, "_metadata_fluid_mask", return_value=np.ones((40, 40), dtype=np.uint8) * 255):
            synthetic = state._finalize_exclusions(rgb, [{"class_name": "female_face", "mask": target}], frozenset({"cum_on_breasts"}))
        self.assertEqual(synthetic[-1]["class_name"], "__fluid_exclusion__")
        with patch.object(state, "_metadata_fluid_mask", return_value=np.zeros((40, 40), dtype=np.uint8)):
            unchanged = state._finalize_exclusions(rgb, [{"class_name": "female_face", "mask": target}], frozenset({"cum_on_breasts"}))
        self.assertEqual(len(unchanged), 1)

    def test_scene_metadata_fluid_is_a_non_forced_exclusion_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "scene.png"
            info = PngImagePlugin.PngInfo(); info.add_text("scene_positive", "cum_on_breasts")
            Image.new("RGB", (16, 16), "white").save(source, pnginfo=info)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]; record = state.images[image_id]
            mask = np.ones((16, 16), dtype=np.uint8) * 255
            with patch.object(state, "_detect_arbitrated_segments", return_value=[] ) as detect, \
                    patch.object(state, "_hand_refinement_context", return_value=([], np.zeros_like(mask), [])), \
                    patch.object(state, "_finalize_exclusions", return_value=[{"class_name": "__fluid_exclusion__", "metadata_exclusions": {"fluid": mask}}]):
                candidates = state._detect_image(Mock(), record, .5)
            self.assertEqual(detect.call_args.args[-1], frozenset({"cum_on_breasts"}))
            self.assertEqual(len(candidates), 1)
            self.assertEqual((candidates[0].label_token, candidates[0].role, candidates[0].forced), ("fluid", CandidateRole.EXCLUDE, False))

    def test_boundary_request_requires_a_valid_roi_and_click(self):
        roi, point = read_boundary_request(
            {"roi": {"left": 2.2, "top": 3.1, "right": 12.6, "bottom": 15.8}, "point": {"x": 7, "y": 9}},
            20,
            20,
        )
        self.assertEqual(roi, (2, 3, 13, 16))
        self.assertEqual(point, (7.0, 9.0))
        _, fractional_point = read_boundary_request(
            {"roi": {"left": 1, "top": 1, "right": 10.4, "bottom": 10.4}, "point": {"x": 9.6, "y": 8.4}},
            20,
            20,
        )
        self.assertEqual(fractional_point, (9.6, 8.4))
        edge_roi, edge_point = read_boundary_request(
            {"roi": {"left": 2, "top": 3, "right": 20, "bottom": 20}, "point": {"x": 20, "y": 20}},
            20,
            20,
        )
        self.assertEqual(edge_roi, (2, 3, 20, 20))
        self.assertEqual(edge_point, (19, 19))
        with self.assertRaises(ClientError):
            read_boundary_request(
                {"roi": {"left": 2, "top": 3, "right": 12, "bottom": 15}, "point": {"x": 12, "y": 9}},
                20,
                20,
            )

    def test_boundary_candidate_does_not_start_during_a_background_job(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            state.job.state = "running"
            with patch.object(state, "_sam_predictor_for") as predictor:
                with self.assertRaises(ClientError):
                    state.add_boundary_candidate(
                        record.image_id,
                        {"roi": {"left": 2, "top": 2, "right": 10, "bottom": 10}, "point": {"x": 5, "y": 5}},
                    )
            predictor.assert_not_called()

    def test_single_image_detection_uses_its_model_without_the_shared_inference_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]

            def detect_image(*_args):
                self.assertFalse(state.inference_lock.locked())
                return []

            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=detect_image):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE)

    def test_boundary_result_is_discarded_after_folder_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]

            class ReloadingPredictor:
                def predict(self, **_kwargs):
                    state.set_root(directory)
                    masks = np.zeros((3, 12, 12), dtype=bool)
                    masks[0, 2:10, 2:10] = True
                    return masks, np.asarray([0.9, 0.4, 0.2]), None

            with patch.object(state, "_sam_predictor_for", return_value=ReloadingPredictor()):
                with self.assertRaisesRegex(ClientError, "再読み込み"):
                    state.add_boundary_candidate(
                        record.image_id,
                        {"roi": {"left": 2, "top": 2, "right": 10, "bottom": 10}, "point": {"x": 5, "y": 5}},
                    )
            self.assertFalse(state.candidates)

    def test_sam_mask_selection_and_roi_clip_are_deterministic(self):
        masks = np.zeros((3, 8, 8), dtype=bool)
        masks[0, 1:5, 1:5] = True
        masks[1, 0:7, 0:7] = True
        masks[2, 3:8, 3:8] = True
        selected, score = select_best_sam_mask(masks, np.asarray([0.31, 0.95, 0.71]))
        clipped = clip_mask_to_roi(selected, (2, 2, 6, 6))
        self.assertEqual(score, 0.95)
        self.assertTrue(np.all(clipped[:2] == 0))
        self.assertTrue(np.all(clipped[:, :2] == 0))
        self.assertTrue(np.all(clipped[6:] == 0))
        self.assertTrue(np.all(clipped[:, 6:] == 0))

    def test_boundary_candidate_uses_the_normal_candidate_mask_path(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                self_outer.assertTrue(state.inference_lock.locked())
                masks = np.zeros((3, 12, 12), dtype=bool)
                masks[1, 1:11, 1:11] = True
                return masks, np.asarray([0.2, 0.9, 0.4]), None

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            self_outer = self
            state.root = Path(directory)
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()), \
                 patch.object(state, "_refine_detected_segments", side_effect=lambda _models, _record, _rgb, segments: segments), \
                 patch.object(state, "_ensure_models", return_value=DetectionModels(target=object())):
                created = state.add_boundary_candidate(
                    record.image_id,
                    {"roi": {"left": 3, "top": 3, "right": 9, "bottom": 9}, "point": {"x": 5, "y": 5}},
                )

            self.assertEqual(created["candidates"][0]["source"], "boundary")
            self.assertEqual(created["candidates"][0]["labelToken"], "boundary")
            self.assertEqual(created["candidateRevision"], 1)
            self.assertEqual(state.list_candidates(record.image_id), created["candidates"])
            combined = state.combined_candidate_mask(record.image_id)
            self.assertTrue(np.any(combined[3:9, 3:9]))
            self.assertFalse(np.any(combined[:3]))
            self.assertFalse(np.any(combined[:, :3]))

    def test_boundary_second_mask_failure_leaves_no_partial_candidate(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, 1:11, 1:11] = True
                return masks, np.asarray([0.9]), None

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); Image.new("RGB", (12, 12), "white").save(root / "image.png")
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            state.settings["models"].update({"hand_detection_enabled": True, "hand_segmentation_enabled": True})
            hand_mask = np.zeros((1, 12, 12), dtype=bool); hand_mask[0, 4:8, 2:10] = True
            specialist = Mock(); specialist.predict.return_value = hand_mask, np.asarray([0.9]), None
            original_fromarray = detection_module.Image.fromarray
            calls = 0

            def fail_second_mask(mask, *args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("second mask failed")
                return original_fromarray(mask, *args, **kwargs)

            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()), \
                 patch.object(state, "_boundary_hand_boxes", return_value=[(4, 4, 8, 8)]), \
                 patch.object(state, "_hand_segmentation_predictor_for", return_value=specialist), \
                 patch.object(detection_module.Image, "fromarray", side_effect=fail_second_mask):
                with self.assertRaisesRegex(OSError, "second mask"):
                    state.add_boundary_candidate(image_id, {"roi": {"left": 1, "top": 1, "right": 11, "bottom": 11}, "point": {"x": 5, "y": 5}})

            self.assertEqual(state.candidates.get(image_id, []), [])
            self.assertEqual(list((state.cache_dir / image_id).glob("*.png")), [])
            self.assertEqual(list((state.cache_dir / image_id).glob("*.tmp")), [])

    def test_boundary_candidate_keeps_hand_fluid_as_an_independent_exclusion(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, 1:11, 1:11] = True
                return masks, np.asarray([0.9]), None

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state(); state.root = Path(directory); state.images = {record.image_id: record}; state.order = [record.image_id]
            state.settings["models"].update({"hand_detection_enabled": True, "hand_segmentation_enabled": True})
            hand_mask = np.zeros((1, 12, 12), dtype=bool); hand_mask[0, 4:8, 2:10] = True
            specialist = Mock(); specialist.predict.return_value = hand_mask, np.asarray([0.9]), None
            fluid = np.zeros((12, 12), dtype=np.uint8); fluid[6:8, 4:8] = 255

            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()), \
                 patch.object(state, "_boundary_hand_boxes", return_value=[(4, 4, 8, 8)]), \
                 patch.object(state, "_hand_segmentation_predictor_for", return_value=specialist), \
                 patch.object(detection_module, "white_fluid_mask", return_value=fluid):
                state.add_boundary_candidate(record.image_id, {"roi": {"left": 1, "top": 1, "right": 11, "bottom": 11}, "point": {"x": 5, "y": 5}})

            candidates = state.list_candidates(record.image_id)
            self.assertEqual([candidate["role"] for candidate in candidates], ["apply", "exclude", "exclude"])
            self.assertEqual([candidate["source"] for candidate in candidates[1:]], ["hand_exclusion", "fluid_exclusion"])
            self.assertEqual([candidate["enabled"] for candidate in candidates], [True, True, True])
            self.assertTrue(all(candidate["origin"] == "boundary" for candidate in candidates))

    def test_hand_refinement_skips_outside_boxes_and_clips_partial_boxes(self):
        mask = np.zeros((12, 12), dtype=np.uint8); mask[4:8, 4:8] = 255
        boxes = [(0, 0, 3, 3), (2, 5, 6, 7), (9, 9, 12, 12)]
        self.assertEqual(StudioState._hand_boxes_over_apply(boxes, [mask]), [(4, 5, 6, 7)])

    def test_high_precision_refinement_keeps_detector_mask_when_sam_is_incompatible(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, 0:2, 0:2] = True
                return masks, np.asarray([0.99]), None

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"; Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            mask = np.zeros((12, 12), dtype=np.uint8); mask[3:9, 3:9] = 255
            segment = {"class_name": "penis", "mask": mask.copy(), "confidence": 0.8, "source": "target"}
            with patch.object(state, "_sam_predictor_for", return_value=FakePredictor()):
                refined = state._high_precision_segments(DetectionModels(target=object()), record, np.zeros((12, 12, 3), dtype=np.uint8), [segment])
            self.assertEqual(len(refined), 1)
            self.assertEqual(refined[0]["refinement"], "sam_fallback")
            self.assertTrue(np.array_equal(refined[0]["mask"] > 0, mask > 0))

    def test_high_precision_refinement_keeps_non_targets_and_failed_detector_masks(self):
        state = self.new_state()
        source = np.zeros((12, 12), dtype=np.uint8); source[2:10, 2:10] = 255
        good = source.astype(bool); good[2:4, 2:4] = False
        bad = np.zeros_like(good)
        predictor = Mock()
        predictor.predict.side_effect = [
            (np.asarray([good]), np.asarray([0.8]), None),
            (np.asarray([bad]), np.asarray([0.99]), None),
        ]
        non_target = {"class_name": "__hand_exclusion__", "mask": np.ones((12, 12), dtype=np.uint8), "source": "hand_exclusion"}
        segments = [
            non_target,
            {"class_name": "penis", "mask": source.copy(), "confidence": 0.8, "source": "target"},
            {"class_name": "pussy", "mask": source.copy(), "confidence": 0.8, "source": "target"},
        ]
        refined = state._high_precision_segments_with_predictor(np.zeros((12, 12, 3), dtype=np.uint8), segments, predictor)
        self.assertEqual(len(refined), 3)
        self.assertIs(refined[0], non_target)
        self.assertEqual(refined[1]["class_name"], "penis")
        self.assertEqual(refined[1]["refinement"], "sam_high_precision")
        self.assertEqual(refined[2]["refinement"], "sam_fallback")

    def test_high_precision_refinement_keeps_target_without_sam_prompt(self):
        state = self.new_state()
        source = np.zeros((12, 12), dtype=np.uint8); source[3:9, 3:9] = 255
        segment = {"class_name": "penis", "mask": source, "confidence": 0.8, "source": "target"}
        non_target = {"class_name": "__hand_exclusion__", "image_exclusions": {}}
        predictor = Mock()
        with patch.object(detection_module, "sam_refinement_prompts", return_value=(
            np.empty((0, 2), dtype=np.float32), np.empty((0,), dtype=np.int32),
        )):
            refined = state._high_precision_segments_with_predictor(
                np.zeros((12, 12, 3), dtype=np.uint8), [segment, non_target], predictor
            )
        self.assertEqual(refined, [segment, non_target])
        self.assertEqual(segment["refinement"], "sam_fallback")
        predictor.predict.assert_not_called()

    def test_high_precision_detection_keeps_candidates_when_all_targets_fail(self):
        class FakePredictor:
            def predict(self, **_kwargs):
                masks = np.zeros((1, 12, 12), dtype=bool)
                masks[0, :2, :2] = True
                return masks, np.asarray([0.99]), None

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"; Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = root; state.images = {record.image_id: record}; state.order = [record.image_id]
            target_mask = np.zeros((12, 12), dtype=np.uint8); target_mask[3:9, 3:9] = 255
            segments = [
                {"class_name": "penis", "mask": target_mask.copy(), "confidence": 0.8, "source": "target"},
                {"class_name": "pussy", "mask": target_mask.copy(), "confidence": 0.8, "source": "target"},
            ]
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), patch.object(
                state, "_sam_predictor_for", return_value=FakePredictor()
            ):
                candidates = state._detect_image(DetectionModels(target=object()), record, 0.5, mode="high_precision")
            self.assertEqual([candidate.label_token for candidate in candidates], ["penis", "pussy"])
            self.assertEqual([candidate.refinement for candidate in candidates], ["sam_fallback", "sam_fallback"])

    def test_high_precision_refinement_forwards_prompts_and_only_keeps_improved_retry(self):
        state = self.new_state()
        record = Mock(image_id="image")
        source = np.zeros((12, 12), dtype=np.uint8); source[2:10, 2:10] = 255
        hand = np.zeros_like(source); hand[3:7, 3:7] = 255
        initial = source.astype(bool); initial[3:7, 3:7] = False; initial[3, 4] = True
        improved = initial.copy(); improved[3, 4] = False
        rejected_retry = initial.copy()
        bad = np.zeros_like(initial)
        logits = np.arange(2 * 256 * 256, dtype=np.float32).reshape(2, 256, 256)
        calls: list[dict[str, Any]] = []

        def predict(**kwargs):
            calls.append(kwargs)
            if len(calls) in {1, 3}:
                return np.asarray([bad, initial]), np.asarray([0.99, 0.8]), logits
            retry = improved if len(calls) == 2 else rejected_retry
            return np.asarray([retry]), np.asarray([0.8]), None

        predictor = Mock(); predictor.predict.side_effect = predict
        segments = [
            {"class_name": "penis", "confidence": 0.8, "mask": source.copy(), "source": "target", "_detector_mask": source.copy(), "_confirmed_hand": hand.copy()},
            {"class_name": "penis", "confidence": 0.8, "mask": source.copy(), "source": "target", "_detector_mask": source.copy(), "_confirmed_hand": hand.copy()},
        ]
        points = np.asarray([[8, 8], [3, 3]], dtype=np.float32)
        labels = np.asarray([1, 0], dtype=np.int32)
        with patch.object(state, "_sam_predictor_for", return_value=predictor), patch.object(
            detection_module, "sam_refinement_prompts", return_value=(points, labels)
        ):
            refined = state._high_precision_segments(DetectionModels(target=object()), record, np.zeros((12, 12, 3), dtype=np.uint8), segments)
        self.assertTrue(np.array_equal(refined[0]["mask"] > 0, initial))
        self.assertTrue(np.array_equal(refined[1]["mask"] > 0, initial))
        self.assertTrue(np.array_equal(calls[0]["point_coords"], points))
        self.assertTrue(np.array_equal(calls[0]["point_labels"], labels))
        self.assertEqual(calls[1]["mask_input"].shape, (1, 256, 256))
        self.assertTrue(np.array_equal(calls[1]["mask_input"], logits[1:2]))

    def test_detect_image_persists_the_refined_apply_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"; Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = root; state.images = {record.image_id: record}; state.order = [record.image_id]
            state.settings["detection"]["mode"] = "high_precision"
            detector_mask = np.zeros((12, 12), dtype=np.uint8); detector_mask[2:10, 2:10] = 255
            refined_mask = detector_mask.copy(); refined_mask[2:6, 2:6] = 0
            fluid_mask = np.zeros((12, 12), dtype=np.uint8); fluid_mask[7:9, 7:9] = 255
            segments = [{"class_name": "penis", "confidence": 0.8, "mask": detector_mask, "source": "target"}]

            def refine(_rgb, detected, _predictor):
                detected[0]["mask"] = refined_mask
                detected[0]["_apply_mask"] = refined_mask
                detected[0]["exclusions"] = {"fluid": fluid_mask}
                return detected

            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), patch.object(
                state, "_hand_refinement_context", return_value=([segments[0]], np.zeros((12, 12), dtype=np.uint8), [])
            ), patch.object(state, "_sam_predictor_for", return_value=Mock()), patch.object(
                state, "_high_precision_segments_with_predictor", side_effect=refine
            ), patch.object(
                state, "_finalize_exclusions", side_effect=lambda _rgb, segments: segments):
                candidates = state._detect_image(DetectionModels(target=object()), record, 0.5, mode="high_precision")
            with Image.open(candidates[0].mask_path) as stored:
                self.assertTrue(np.array_equal(np.asarray(stored), refined_mask))
            self.assertEqual(candidates[1].role, domain_module.CandidateRole.EXCLUDE)
            self.assertTrue(candidates[1].enabled)

    def test_standard_hand_box_fallback_is_an_apply_constrained_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"; Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = root; state.images = {record.image_id: record}; state.order = [record.image_id]
            apply = np.zeros((12, 12), dtype=np.uint8); apply[4:9, 4:9] = 255
            segments = [{"class_name": "penis", "confidence": 0.8, "mask": apply, "source": "target"}]
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), patch.object(
                state, "_hand_refinement_context", return_value=([segments[0]], np.zeros((12, 12), dtype=np.uint8), [(2, 2, 7, 7)]),
            ), patch.object(state, "_sam_predictor_for") as sam:
                candidates = state._detect_image(DetectionModels(target=object()), record, 0.5, mode="standard")
            sam.assert_not_called()
            self.assertEqual([candidate.source for candidate in candidates], ["target"])
            with Image.open(candidates[0].mask_path) as mask_file:
                mask = np.asarray(mask_file)
            self.assertTrue(np.array_equal(mask > 0, apply > 0))

    def test_high_precision_rejected_hand_sam_uses_the_constrained_box(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"; Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            state = self.new_state()
            state.root = root; state.images = {record.image_id: record}; state.order = [record.image_id]
            apply = np.zeros((12, 12), dtype=np.uint8); apply[4:9, 4:9] = 255
            segments = [{"class_name": "penis", "confidence": 0.8, "mask": apply, "source": "target"}]
            rejected = np.zeros((1, 12, 12), dtype=bool); rejected[0, 2:7, 2:7] = True
            predictor = Mock(); predictor.predict.return_value = rejected, np.asarray([0.1]), None
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), patch.object(
                state, "_hand_refinement_context", return_value=([segments[0]], np.zeros((12, 12), dtype=np.uint8), [(2, 2, 7, 7)]),
            ), patch.object(state, "_sam_predictor_for", return_value=predictor), patch.object(
                state, "_high_precision_segments_with_predictor", side_effect=lambda _rgb, values, _predictor: values,
            ):
                candidates = state._detect_image(DetectionModels(target=object()), record, 0.5, mode="high_precision")
            self.assertEqual([candidate.source for candidate in candidates], ["target"])
            with Image.open(candidates[0].mask_path) as mask_file:
                mask = np.asarray(mask_file)
            self.assertTrue(np.array_equal(mask > 0, apply > 0))

    def test_gpu_diagnostic_uses_a_disposable_session_without_model_cache_changes(self):
        state = self.new_state()
        state.settings["models"].update({"provider": "gpu", "target_segmentation": "target.onnx", "gpu_device": 2})
        state.models = object(); state.hand_model = object()
        with patch.object(state, "_require_supported_gpu") as require, patch(
            "mozarie.inference.onnx.diagnose_runtime", return_value=("CUDAExecutionProvider", "CPUExecutionProvider"),
        ) as diagnose:
            self.assertEqual(state.diagnose_gpu_runtime(), ("CUDAExecutionProvider", "CPUExecutionProvider"))
        require.assert_called_once()
        diagnose.assert_called_once()
        self.assertIsNotNone(state.models)
        self.assertIsNotNone(state.hand_model)

    def test_detect_image_persists_a_real_broad_fluid_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"
            rgb = np.zeros((40, 40, 3), dtype=np.uint8)
            rgb[12:24, 12:24] = (210, 205, 200)
            rgb[16:20, 16:20] = 255
            Image.fromarray(rgb).save(image_path)
            record = self._record(image_path, 40, 40)
            state = self.new_state()
            state.root = root; state.images = {record.image_id: record}; state.order = [record.image_id]
            apply_mask = np.zeros((40, 40), dtype=np.uint8)
            apply_mask[5:35, 5:35] = 255
            segments = [{"class_name": "penis", "confidence": 0.8, "mask": apply_mask, "source": "target"}]

            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                 patch.object(state, "_hand_boxes", return_value=[]):
                candidates = state._detect_image(DetectionModels(target=object()), record, 0.5)

            self.assertEqual([candidate.source for candidate in candidates], ["target", "fluid_exclusion"])
            self.assertEqual([candidate.role for candidate in candidates], [
                domain_module.CandidateRole.APPLY, domain_module.CandidateRole.EXCLUDE,
            ])
            self.assertTrue(candidates[1].enabled)
            with Image.open(candidates[0].mask_path) as stored:
                persisted_apply = np.asarray(stored)
            with Image.open(candidates[1].mask_path) as stored:
                persisted_fluid = np.asarray(stored)
            self.assertEqual(np.count_nonzero(persisted_apply), 900)
            self.assertEqual(np.count_nonzero(persisted_fluid), 144)
            self.assertTrue(np.all(persisted_fluid[12:24, 12:24] == 255))
            self.assertEqual(np.count_nonzero(persisted_fluid[12:24, 12:24]) - np.count_nonzero(persisted_fluid[16:20, 16:20]), 128)
            self.assertFalse(np.any(persisted_fluid[persisted_apply == 0]))

            state.settings["detection"]["fluid_exclusion_enabled"] = False
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                 patch.object(state, "_hand_boxes", return_value=[]):
                disabled = state._detect_image(DetectionModels(target=object()), record, 0.5)
            self.assertEqual([candidate.source for candidate in disabled], ["target"])

    def test_redetection_preserves_boundary_candidates_and_replaces_auto_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"
            Image.new("RGB", (12, 12), "white").save(image_path)
            record = self._record(image_path, 12, 12)
            cache = root / "cache"
            cache.mkdir()
            boundary_path = cache / "boundary.png"
            boundary_hand_path = cache / "boundary-hand.png"
            old_auto_path = cache / "old-auto.png"
            new_auto_path = cache / "new-auto.png"
            Image.fromarray(self._mask(12, 12)).save(boundary_path)
            Image.fromarray(self._mask(12, 12)).save(boundary_hand_path)
            Image.fromarray(self._mask(12, 12)).save(old_auto_path)
            Image.fromarray(self._mask(12, 12)).save(new_auto_path)
            boundary = Candidate("boundary", "boundary", 0.9, boundary_path, source="boundary", origin="boundary")
            boundary_hand = Candidate("boundary-hand", "hand", None, boundary_hand_path, source="hand_exclusion", origin="boundary", role=domain_module.CandidateRole.EXCLUDE)
            old_auto = Candidate("old-auto", "penis", 0.8, old_auto_path)
            new_auto = Candidate("new-auto", "penis", 0.7, new_auto_path)
            state = self.new_state()
            state.root = root
            state.images = {record.image_id: record}
            state.order = [record.image_id]
            state.candidates = {record.image_id: [boundary, boundary_hand, old_auto]}
            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", return_value=[new_auto]):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE)

            self.assertEqual(state.candidates[record.image_id], [boundary, boundary_hand, new_auto])
            self.assertTrue(boundary_path.is_file())
            self.assertTrue(boundary_hand_path.is_file())
            self.assertFalse(old_auto_path.exists())
            self.assertTrue(new_auto_path.is_file())

    def test_boundary_api_returns_the_created_candidate(self):
        from http.server import ThreadingHTTPServer

        expected = {"candidates": [{"id": "boundary", "labelToken": "boundary", "confidence": 0.87, "enabled": True, "color": "#ffffff", "source": "boundary", "origin": "boundary", "refinement": None, "role": "apply", "forced": False}], "candidateRevision": 4}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(state_module.STATE, "add_boundary_candidate", return_value=expected) as add_candidate:
                body = json.dumps({"imageId": "image", "roi": {"left": 1, "top": 2, "right": 3, "bottom": 4}, "point": {"x": 2, "y": 3}}).encode("utf-8")
                connection.request("POST", "/api/boundary", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": state_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, expected)
            self.assertEqual(add_candidate.call_args.args[0], "image")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_settings_status_query_skips_expensive_status_probe(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(http_module.STATE, "settings_status", return_value={"models": {"target": {"valid": True}}}) as settings_status, \
                 patch.object(updater, "fetch_latest_release") as fetch_latest_release:
                connection.request("GET", "/api/settings?status=0")
                response = connection.getresponse()
                lightweight = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertIn("settings", lightweight)
                self.assertEqual(lightweight["version"], updater.display_version((Path(__file__).resolve().parents[1] / "VERSION").read_text(encoding="utf-8").strip()))
                self.assertNotIn("status", lightweight)
                settings_status.assert_not_called()
                fetch_latest_release.assert_not_called()

                connection.request("GET", "/api/settings")
                response = connection.getresponse()
                complete = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(complete["status"], {"models": {"target": {"valid": True}}})
                settings_status.assert_called_once()
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_settings_reset_status_query_skips_expensive_status_probe(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(http_module.STATE, "reset_settings", return_value=http_module.STATE.settings) as reset_settings, \
                 patch.object(http_module.STATE, "settings_status") as settings_status:
                connection.request("POST", "/api/settings/reset?status=0", b"{}", {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": http_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertIn("settings", payload)
            self.assertNotIn("status", payload)
            reset_settings.assert_called_once()
            settings_status.assert_not_called()
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_candidate_delete_api_returns_the_idempotent_result(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(state_module.STATE, "delete_candidate", side_effect=[True, False]) as delete_candidate:
                for expected in (True, False):
                    connection.request("DELETE", "/api/candidate/image/candidate", headers={
                        "X-Mozarie-Token": state_module.STATE.session_token,
                        "Origin": f"http://127.0.0.1:{httpd.server_port}",
                    })
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 200)
                self.assertEqual(payload["deleted"], expected)
                self.assertIsInstance(payload["candidateRevision"], int)
            self.assertEqual(delete_candidate.call_count, 2)
            delete_candidate.assert_called_with("image", "candidate")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_catalog_image_delete_api_removes_only_the_catalog_record(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            with patch.object(state_module.STATE, "remove_image_from_catalog", return_value=[{"id": "other"}]) as remove_image:
                connection.request("DELETE", "/api/catalog/image/current", headers={
                    "X-Mozarie-Token": state_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"images": [{"id": "other"}]})
            remove_image.assert_called_once_with("current")
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_catalog_remove_api_uses_one_batch_without_deleting_sources(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        expected = {"images": [{"id": "other"}], "removedImageIds": ["first", "second"]}
        try:
            with patch.object(state_module.STATE, "remove_images_from_catalog", return_value=expected) as remove_images:
                connection.request("POST", "/api/catalog/remove", json.dumps({"imageIds": ["first", "second"]}).encode("utf-8"), {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": state_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, expected)
            remove_images.assert_called_once_with(["first", "second"])
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_provisional_browser_catalog_detaches_without_durable_clear(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        original_catalog_id = http_module.STATE.catalog_id
        original_provisional = http_module.STATE.browser_catalog_provisional
        try:
            with patch.object(http_module.STATE, "detach_catalog") as detach_catalog, \
                    patch.object(http_module.STATE, "clear_catalog") as clear_catalog, \
                    patch.object(http_module.STATE.workspace_store, "ensure_provisional_catalog", return_value="a" * 32):
                connection.request("POST", "/api/workspace/catalog", json.dumps({"provisional": True}).encode("utf-8"), {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": http_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"catalogId": "a" * 32, "provisional": True})
            detach_catalog.assert_called_once_with()
            clear_catalog.assert_not_called()
        finally:
            http_module.STATE.catalog_id = original_catalog_id
            http_module.STATE.browser_catalog_provisional = original_provisional
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_mutation_api_rejects_invalid_request_context(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{httpd.server_port}"
        cases = [
            ({"Content-Type": "application/json", "Origin": origin}, 403),
            ({
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:1",
                "X-Mozarie-Token": state_module.STATE.session_token,
            }, 403),
            ({
                "Content-Type": "text/plain",
                "Origin": origin,
                "X-Mozarie-Token": state_module.STATE.session_token,
            }, 400),
        ]
        try:
            for headers, expected_status in cases:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("POST", "/api/catalog/clear", b"{}", headers)
                    response = connection.getresponse()
                    response.read()
                    self.assertEqual(response.status, expected_status)
                finally:
                    connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_get_rejects_hostile_host_before_state_or_file_access(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(http_module, "STATE") as guarded_state, \
                 patch.object(MosaicHandler, "_send_static") as send_static, \
                 patch.object(MosaicHandler, "_send_image") as send_image:
                for path in ("/", "/api/settings", "/api/images", "/api/image/current"):
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", path, headers={"Host": "hostile.example"})
                        response = connection.getresponse()
                        response.read()
                        self.assertEqual(response.status, 403)
                        self.assertEqual(response.getheader("Connection"), "close")
                    finally:
                        connection.close()
            self.assertEqual(guarded_state.mock_calls, [])
            send_static.assert_not_called()
            send_image.assert_not_called()
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_detection_mode_is_read_only_from_saved_settings(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "cpu"
        record = ImageRecord(image_id="test", path=Path(__file__), relative_path="test.png", width=1, height=1, mtime_ns=0)
        with patch.object(state, "_records_for_ids_with_catalog", return_value=([record], 7)), patch.object(state, "_start_job") as start:
            state.start_detection(["test"], 0.65)
        self.assertEqual(start.call_args.args[0], "detect")
        self.assertEqual(start.call_args.args[-2:], (0.65, 2))
        self.assertEqual(start.call_args.kwargs["expected_catalog_generation"], 7)
        for mode in ("standard", "high_precision"):
            state.settings["detection"]["mode"] = mode
            seen_modes: list[str] = []
            with patch.object(state, "_ensure_models", return_value=object()), \
                 patch.object(state, "_detect_image", side_effect=lambda _models, _record, _confidence, detected_mode, _targets: seen_modes.append(detected_mode) or []):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, 1)
            self.assertEqual(seen_modes, [mode])

    def test_detection_start_rejects_a_catalog_switch_after_records_are_captured(self):
        with tempfile.TemporaryDirectory() as directory:
            first_root = Path(directory) / "first"
            second_root = Path(directory) / "second"
            first_root.mkdir()
            second_root.mkdir()
            Image.new("RGB", (16, 16), "white").save(first_root / "first.png")
            Image.new("RGB", (16, 16), "black").save(second_root / "second.png")
            state = self.new_state()
            state.settings["models"]["provider"] = "cpu"
            first_id = state.set_root(str(first_root))[0]["id"]
            original_start_job = state._start_job

            def switch_then_start(*args, **kwargs):
                state.set_root(str(second_root))
                return original_start_job(*args, **kwargs)

            with patch.object(state, "_start_job", side_effect=switch_then_start):
                with self.assertRaisesRegex(ClientError, "画像一覧が更新されたため"):
                    state.start_detection([first_id])

            self.assertEqual(state.root, second_root.resolve())
            self.assertEqual(state.job.state, "idle")

    def test_apply_start_rejects_a_catalog_switch_without_touching_old_source(self):
        with tempfile.TemporaryDirectory() as directory:
            first_root = Path(directory) / "first"
            second_root = Path(directory) / "second"
            first_root.mkdir()
            second_root.mkdir()
            source = first_root / "first.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            original_source = source.read_bytes()
            Image.new("RGB", (16, 16), "black").save(second_root / "second.png")
            state = self.new_state()
            first_id = state.set_root(str(first_root))[0]["id"]
            original_start_job = state._start_job

            def switch_then_start(*args, **kwargs):
                state.set_root(str(second_root))
                return original_start_job(*args, **kwargs)

            with patch.object(state, "combined_candidate_mask", return_value=self._mask(16, 16)), \
                 patch.object(state, "_start_job", side_effect=switch_then_start):
                with self.assertRaisesRegex(ClientError, "画像一覧が更新されたため"):
                    state.start_apply([first_id], 100, {})

            self.assertEqual(source.read_bytes(), original_source)
            self.assertEqual(state.root, second_root.resolve())

    def test_same_root_reload_rejects_while_import_is_preparing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            entered = threading.Event()
            release = threading.Event()
            imported = threading.Event()
            errors: list[Exception] = []
            original_inspect = catalog_module.inspect_import_image

            def blocked_inspect(path, suffix):
                result = original_inspect(path, suffix)
                entered.set()
                self.assertTrue(release.wait(2))
                return result

            def import_worker():
                try:
                    import_image_list_for_test(state, [{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                except Exception as exc:  # asserted below
                    errors.append(exc)
                finally:
                    imported.set()

            with patch.object(catalog_module, "inspect_import_image", side_effect=blocked_inspect):
                importer = threading.Thread(target=import_worker)
                importer.start()
                self.assertTrue(entered.wait(2))
                with self.assertRaises(ClientError):
                    state.set_root(str(root))
                release.set()
                importer.join(2)

            self.assertEqual(errors, [])
            self.assertTrue(imported.is_set())
            self.assertEqual(
                [image["relativePath"] for image in state.list_images()],
                ["imported.png", "source.png"],
            )
    def test_concurrent_same_name_imports_commit_to_two_unique_intact_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            raw = raw_buffer.getvalue()
            state = self.new_state()
            state.set_root(str(root))
            barrier = threading.Barrier(3)
            errors: list[Exception] = []

            def import_worker():
                try:
                    barrier.wait()
                    import_image_list_for_test(state, [{"name": "same.png", "data": base64.b64encode(raw).decode("ascii")}])
                except Exception as exc:  # asserted below
                    errors.append(exc)

            first = threading.Thread(target=import_worker)
            second = threading.Thread(target=import_worker)
            first.start()
            second.start()
            barrier.wait()
            first.join(2)
            second.join(2)

            self.assertEqual(errors, [])
            destination_dir = state.session_imports_dir
            self.assertIsNotNone(destination_dir)
            assert destination_dir is not None
            self.assertEqual((destination_dir / "same.png").read_bytes(), raw)
            self.assertEqual((destination_dir / "same_2.png").read_bytes(), raw)
            self.assertFalse((root / ".mozarie_imports").exists())
            self.assertEqual(len(state.list_images()), 2)

    def test_concurrent_imports_decode_outside_the_commit_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            raw = raw_buffer.getvalue()
            state = self.new_state()
            state.set_root(str(root))
            active = 0
            peak = 0
            active_lock = threading.Lock()
            overlap = threading.Event()
            release = threading.Event()
            original_inspect = catalog_module.inspect_import_image

            def blocked_inspect(path, suffix):
                nonlocal active, peak
                with active_lock:
                    active += 1
                    peak = max(peak, active)
                    if active >= 2:
                        overlap.set()
                try:
                    self.assertTrue(release.wait(2))
                    return original_inspect(path, suffix)
                finally:
                    with active_lock:
                        active -= 1

            errors = []
            def worker(name):
                try:
                    import_image_list_for_test(state, [{"name": name, "data": base64.b64encode(raw).decode("ascii")}])
                except Exception as exc:  # asserted below
                    errors.append(exc)

            with patch.object(catalog_module, "inspect_import_image", side_effect=blocked_inspect):
                first = threading.Thread(target=worker, args=("first.png",))
                second = threading.Thread(target=worker, args=("second.png",))
                first.start(); second.start()
                self.assertTrue(overlap.wait(2), "image verification should overlap across import requests")
                release.set()
                first.join(2); second.join(2)

            self.assertEqual(errors, [])
            self.assertEqual(peak, 2)
            self.assertEqual(len(state.list_images()), 2)

    def test_drag_import_uses_a_session_without_writing_to_the_source_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            raw_buffer = io.BytesIO()
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("workflow", "kept exactly")
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG", pnginfo=metadata)
            raw = raw_buffer.getvalue()
            state = self.new_state()
            state.set_root(str(root))

            images = import_image_list_for_test(state, [{"name": "dropped.png", "data": base64.b64encode(raw).decode("ascii")}])

            imported = next(image for image in images if image["relativePath"] == "dropped.png")
            record = state.image_for_id(imported["id"])
            self.assertEqual(imported["sourceKind"], "session")
            self.assertEqual(record.path.read_bytes(), raw)
            self.assertEqual(Image.open(record.path).text["workflow"], "kept exactly")
            self.assertFalse((root / ".mozarie_imports").exists())
            self.assertTrue(record.path.is_relative_to(state.session_imports_dir))

    def test_clear_catalog_removes_only_session_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            import_image_list_for_test(state, [{"name": "dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
            session_dir = state.session_dir

            state.clear_catalog()

            self.assertTrue(source.is_file())
            self.assertFalse((root / ".mozarie_imports").exists())
            self.assertFalse(session_dir.exists())
            self.assertEqual(state.list_images(), [])

    def test_browser_session_save_preserves_nested_relative_path_and_temp_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            state.set_root(str(root))
            session_id = import_image_list_for_test(state, [{
                "name": "dropped.png", "relativePath": "nested/dropped.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii"),
            }])[0]["id"]
            source = state.image_for_id(session_id)
            mask_path = state.cache_dir / session_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[session_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(session_id)

            entry = state.prepare_browser_save([session_id], 100, "_censored", False)[0]
            output, _record, output_revision, _save_token = state.render_browser_save(session_id, revision, 100, None)

            self.assertEqual(entry["relativePath"], "nested/dropped.png")
            self.assertEqual(output_revision, revision)
            self.assertEqual(Image.open(io.BytesIO(output)).size, (16, 16))
            self.assertTrue(source.path.is_file())
            self.assertEqual(source.source_kind, "session")

    def test_stale_session_is_cleaned_immediately_but_an_active_session_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            session_base = Path(directory) / "sessions"
            stale = session_base / "session-stale"
            stale.mkdir(parents=True)
            (stale / ".active.lock").write_bytes(b"1")

            first = StudioState(Path(directory) / "cache-first", session_base)
            self.assertFalse(stale.exists())
            root = Path(directory) / "images"
            root.mkdir()
            first.set_root(str(root))
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            staged = Path(directory) / "active.upload"
            staged.write_bytes(raw_buffer.getvalue())
            first.import_image_file_for_api(
                staged,
                name="active.png",
                relative_path="active.png",
                client_key="active",
            )
            active = first.session_dir

            second = StudioState(Path(directory) / "cache-second", session_base)

            self.assertTrue(active.exists())
            first.shutdown()
            second._cleanup_stale_sessions()
            self.assertFalse(active.exists())

    def test_fresh_session_without_a_lock_uses_a_short_grace_period(self):
        with tempfile.TemporaryDirectory() as directory:
            session_base = Path(directory) / "sessions"
            pending = session_base / "session-pending"
            pending.mkdir(parents=True)

            StudioState(Path(directory) / "cache-fresh", session_base)
            self.assertTrue(pending.exists())

            old = time.time() - 120
            os.utime(pending, (old, old))
            StudioState(Path(directory) / "cache-expired", session_base)
            self.assertFalse(pending.exists())

    def test_fresh_process_cache_without_a_lock_uses_a_short_grace_period(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_base = Path(directory) / "cache"
            pending = cache_base / "process-pending"
            pending.mkdir(parents=True)

            with patch.object(state_module, "CACHE_BASE_DIR", cache_base):
                StudioState._cleanup_stale_process_caches()
                self.assertTrue(pending.exists())

                old = time.time() - 120
                os.utime(pending, (old, old))
                StudioState._cleanup_stale_process_caches()
                self.assertFalse(pending.exists())

    def test_import_rejects_when_a_job_has_already_started(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            entered = threading.Event()
            release = threading.Event()

            def worker(_records, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                state._finish_job(kwargs["job_generation"], kwargs["catalog_generation"])

            state._start_job("detect", [record], worker)
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ClientError, "処理中は画像を追加できません"):
                import_image_list_for_test(state, [{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
            release.set()
            assert state.worker_thread is not None
            state.worker_thread.join(2)

    def test_job_start_rejects_while_import_is_still_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            raw_buffer = io.BytesIO()
            Image.new("RGB", (16, 16), "#6688aa").save(raw_buffer, format="PNG")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            entered = threading.Event()
            release = threading.Event()
            errors: list[Exception] = []
            original_inspect = catalog_module.inspect_import_image

            def blocked_inspect(path, suffix):
                result = original_inspect(path, suffix)
                entered.set()
                self.assertTrue(release.wait(2))
                return result

            def import_worker():
                try:
                    import_image_list_for_test(state, [{"name": "imported.png", "data": base64.b64encode(raw_buffer.getvalue()).decode("ascii")}])
                except Exception as exc:  # asserted below
                    errors.append(exc)

            with patch.object(catalog_module, "inspect_import_image", side_effect=blocked_inspect):
                importer = threading.Thread(target=import_worker)
                importer.start()
                self.assertTrue(entered.wait(2))
                with self.assertRaises(ClientError):
                    state._start_job("detect", [record], lambda *_args, **_kwargs: None)
                release.set()
                importer.join(2)

            self.assertEqual(errors, [])
            self.assertFalse((root / ".mozarie_imports").exists())
            self.assertIsNotNone(state.session_imports_dir)

    def test_job_api_exposes_immutable_target_image_ids(self):
        state = self.new_state()
        records = [
            ImageRecord(image_id="first", path=Path(__file__), relative_path="first.png", width=1, height=1, mtime_ns=0),
            ImageRecord(image_id="second", path=Path(__file__), relative_path="second.png", width=1, height=1, mtime_ns=0),
        ]
        with patch("server.threading.Thread"):
            state._start_job("apply", records, lambda *_args, **_kwargs: None)
        payload = state.job.as_dict()
        self.assertEqual(payload["imageIds"], ["first", "second"])
        self.assertEqual(payload["completedImageIds"], [])
        payload["imageIds"].append("other")
        self.assertEqual(state.job.image_ids, ("first", "second"))

    def test_injected_test_cache_never_touches_the_production_cache_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            simulated_production_cache = Path(directory) / "production-cache"
            simulated_production_cache.mkdir()
            sentinel = simulated_production_cache / "keep-me.txt"
            sentinel.write_text("sentinel", encoding="utf-8")

            state = self.new_state()
            state.set_root(str(root))

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "sentinel")
            self.assertTrue(state.cache_dir.is_dir())
            self.assertNotEqual(state.cache_dir, simulated_production_cache)

    def test_candidate_mask_read_is_atomic_against_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]

            opened = threading.Event()
            release = threading.Event()
            cleared = threading.Event()
            snapshot_done = threading.Event()
            original_open = Image.open

            def delayed_open(path, *args, **kwargs):
                if isinstance(path, io.BytesIO):
                    opened.set()
                    release.wait(2)
                return original_open(path, *args, **kwargs)

            with patch.object(Image, "open", side_effect=delayed_open):
                outcome = {}
                def read_mask():
                    try:
                        outcome["value"] = state.read_candidate_mask_png(image_id, "candidate")
                    except Exception as exc:
                        outcome["error"] = exc
                reader = threading.Thread(target=read_mask)
                clearer = threading.Thread(target=lambda: (state.clear_masks([image_id]), cleared.set()))
                reader.start()
                self.assertTrue(opened.wait(2))
                clearer.start()
                self.assertTrue(cleared.wait(2))
                snapshotter = threading.Thread(target=lambda: (state.catalog_snapshot(), snapshot_done.set()))
                snapshotter.start()
                self.assertTrue(snapshot_done.wait(2))
                release.set()
                reader.join(2)
                clearer.join(2)
                snapshotter.join(2)

            self.assertTrue(cleared.is_set())
            self.assertFalse(mask_path.exists())
            self.assertEqual(state.list_candidates(image_id), [])
            self.assertIsInstance(outcome.get("error"), core_module.StaleMaskError)

    def test_candidate_mask_read_rejects_expected_revision_before_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            expected_revision = state._touch_candidates(image_id)
            state._touch_candidates(image_id)

            with patch.object(catalog_module.Image, "open") as image_open:
                with self.assertRaisesRegex(core_module.StaleMaskError, "更新"):
                    state.read_candidate_mask_png(image_id, "candidate", expected_revision=expected_revision)

            image_open.assert_not_called()

    def test_http_candidate_mask_snapshot_rejects_a_revision_changed_before_decode(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            original_read = state.read_candidate_mask_png
            snapshotted = threading.Event()
            release = threading.Event()

            def delayed_read(requested_id, candidate_id, *, expected_revision=None):
                snapshotted.set()
                self.assertTrue(release.wait(2))
                return original_read(requested_id, candidate_id, expected_revision=expected_revision)

            with patch.object(http_module, "STATE", state), \
                 patch.object(state, "read_candidate_mask_png", side_effect=delayed_read):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                result = {}

                def request_mask():
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", f"/api/mask/{image_id}/candidate")
                        response = connection.getresponse()
                        result["status"] = response.status
                        result["body"] = response.read()
                    finally:
                        connection.close()

                request = threading.Thread(target=request_mask)
                request.start()
                self.assertTrue(snapshotted.wait(2))
                state.set_candidate_state(image_id, "candidate", {"enabled": False})
                release.set()
                request.join(3)
                httpd.shutdown()
                httpd.server_close()

            self.assertEqual(result["status"], 404)
            self.assertNotEqual(result["body"], mask_path.read_bytes())

    def test_candidate_mask_gets_use_catalogue_metadata(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            with patch.object(http_module, "STATE", state):
                state.candidate_snapshot(image_id)
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    for _ in range(4):
                        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                        connection.request("GET", f"/api/mask/{image_id}/candidate?v={revision}-candidate")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()
                        connection.close()
                finally:
                    httpd.shutdown()
                    httpd.server_close()

    def test_candidate_compose_keeps_catalog_responsive_and_rejects_revision_race(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)
            opened = threading.Event()
            release = threading.Event()
            catalog_done = threading.Event()
            job_done = threading.Event()
            outcome = {}
            original_open = jobs_module.Image.open
            def delayed_open(path, *args, **kwargs):
                if Path(path) == mask_path:
                    opened.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            def compose():
                try:
                    outcome["mask"] = state.combined_candidate_mask(image_id)
                except Exception as exc:
                    outcome["error"] = exc

            with patch.object(jobs_module.Image, "open", side_effect=delayed_open):
                worker = threading.Thread(target=compose)
                worker.start()
                self.assertTrue(opened.wait(2))
                catalog_thread = threading.Thread(target=lambda: (state.catalog_snapshot(), catalog_done.set()))
                job_thread = threading.Thread(target=lambda: (state.job.as_dict(), job_done.set()))
                catalog_thread.start(); job_thread.start()
                self.assertTrue(catalog_done.wait(2))
                self.assertTrue(job_done.wait(2))
                mutation = threading.Thread(target=lambda: state.set_candidate_state(image_id, "candidate", {"enabled": False}))
                mutation.start()
                time.sleep(0.05)
                # Per-image serialization keeps a manual toggle from racing
                # an in-flight mask composition.  Other catalogue reads above
                # remain responsive while this image waits.
                self.assertTrue(mutation.is_alive())
                self.assertEqual(state._candidate_revision(image_id), 1)
                release.set()
                worker.join(2); mutation.join(2); catalog_thread.join(2); job_thread.join(2)

            self.assertFalse(mutation.is_alive())
            self.assertGreater(state._candidate_revision(image_id), 1)
            self.assertNotIn("error", outcome)
            self.assertIsNotNone(outcome.get("mask"))

    def test_list_candidates_prunes_missing_masks_and_advances_revision_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing_one = state.cache_dir / image_id / "missing-one.png"
            missing_two = state.cache_dir / image_id / "missing-two.png"
            state.candidates[image_id] = [
                Candidate("missing-one", "penis", 0.9, missing_one),
                Candidate("missing-two", "testicles", 0.8, missing_two),
            ]
            revision_before_prune = state._touch_candidates(image_id)

            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(state.candidates.get(image_id, []), [])
            revision_after_prune = state._candidate_revision(image_id)
            self.assertEqual(revision_after_prune, revision_before_prune + 1)

            self.assertEqual(state.list_candidates(image_id), [])
            self.assertEqual(state._candidate_revision(image_id), revision_after_prune)

    def test_candidate_snapshot_keeps_candidates_and_revision_in_one_epoch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            snapshot = state.candidate_snapshot(image_id)

            self.assertEqual(snapshot["candidateRevision"], revision)
            self.assertEqual([item["id"] for item in snapshot["candidates"]], ["candidate"])

    def test_catalog_snapshot_is_self_consistent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            state.set_root(str(root))

            snapshot = state.catalog_snapshot()

            self.assertEqual(
                os.path.normcase(str(Path(snapshot["root"]).resolve())),
                os.path.normcase(str(root.resolve())),
            )
            self.assertEqual(snapshot["catalogGeneration"], state.catalog_generation)
            self.assertEqual(len(snapshot["images"]), 1)

    def test_missing_candidate_mask_removes_stale_candidate_and_returns_404(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "source.png")
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing = state.cache_dir / image_id / "missing.png"
            state.candidates[image_id] = [Candidate("missing", "penis", 0.9, missing)]
            revision_before_read = state._touch_candidates(image_id)
            previous_state = state_module.STATE
            state_module.STATE = state; http_module.STATE = state
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                with patch.object(core_module.LOGGER, "exception") as logged:
                    connection.request("GET", f"/api/mask/{image_id}/missing")
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 404)
                self.assertEqual(payload, {"error_code": "mask_not_found", "params": {}})
                logged.assert_not_called()
                revision_after_read = state._candidate_revision(image_id)
                self.assertEqual(revision_after_read, revision_before_read + 1)
                self.assertEqual(state.candidates.get(image_id, []), [])
                self.assertEqual(state.list_candidates(image_id), [])
                self.assertEqual(state._candidate_revision(image_id), revision_after_read)
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()
                state_module.STATE = previous_state; http_module.STATE = previous_state

    def test_missing_enabled_mask_fails_in_the_apply_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "#6688aa").save(source)
            original = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            missing = state.cache_dir / image_id / "missing.png"
            state.candidates[image_id] = [Candidate("missing", "penis", 0.9, missing)]

            self.assertTrue(state.start_apply([image_id], 100, {}))
            assert state.worker_thread is not None
            state.worker_thread.join(2)

            self.assertEqual(state.job.state, "error")
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_apply_skips_empty_masks_and_keeps_success_output_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.png"
            second = root / "second.png"
            Image.new("RGB", (16, 16), "#6688aa").save(first)
            Image.new("RGB", (16, 16), "#aa8866").save(second)
            original_second = second.read_bytes()
            state = self.new_state()
            first_id, second_id = (item["id"] for item in state.set_root(str(root)))
            first_record = state.image_for_id(first_id)
            second_record = state.image_for_id(second_id)
            mask_path = state.cache_dir / first_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[first_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = self.commit_candidates(state, first_id)
            state.set_image_flags(first_id, {"hidden": True, "reviewed": True})
            manual_png = io.BytesIO(); Image.new("L", (16, 16), 255).save(manual_png, format="PNG")
            manual = "data:image/png;base64," + base64.b64encode(manual_png.getvalue()).decode("ascii")
            state.save_manual_workspace(first_id, {
                "add": manual, "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
                "candidateRevision": revision, "hasEffectiveMask": True, "manualEnabled": False,
            })
            state.job = core_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))

            state._apply_worker([first_record, second_record], 100, {})

            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.image_ids, (first_id,))
            self.assertEqual(
                [os.path.normcase(str(Path(output).resolve())) for output in state.job.outputs],
                [os.path.normcase(str(first.resolve()))],
            )
            self.assertEqual([candidate.candidate_id for candidate in state.candidates[first_id]], ["candidate"])
            self.assertTrue(mask_path.is_file())
            self.assertEqual(state.manual_workspace(first_id)["add"], manual)
            self.assertFalse(state.manual_workspace(first_id)["manualEnabled"])
            self.assertEqual(state.workspace_store.image_state(first_id), (True, True))
            self.assertEqual(second.read_bytes(), original_second)

    def test_apply_all_empty_masks_completes_without_changing_images(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            original = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            state.job = core_module.Job(kind="apply", state="running", total=1, image_ids=(image_id,))

            state._apply_worker([record], 100, {})

            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.total, 0)
            self.assertEqual(source.read_bytes(), original)

    def test_copy_save_empty_record_does_not_consume_a_later_output_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "empty.png")
            Image.new("RGB", (16, 16), "black").save(root / "masked.png")
            state = self.new_state()
            first_id, second_id = (item["id"] for item in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in (first_id, second_id)]
            state.job = core_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            output = root / "output.png"
            written: list[Path] = []

            def colliding_destination(_record, _suffix, reserved):
                return output if output not in reserved else root / "output_2.png"

            with patch.object(state, "_reserve_output_destination", side_effect=lambda record, suffix, _directory: colliding_destination(record, suffix, state.reserved_output_paths)), \
                 patch.object(saving_module, "write_rendered_copy", side_effect=lambda path, _data: written.append(path)):
                state._apply_worker(
                    records, 100, {first_id: np.zeros((16, 16), dtype=np.uint8), second_id: self._mask(16, 16)},
                    copy_to_default=True, saving_parallelism=2,
                )

            self.assertEqual(state.job.outputs, [str(output)])
            self.assertEqual(written, [output])

    def test_copy_save_mask_failure_releases_later_destination_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (16, 16), "white").save(root / "broken.png")
            Image.new("RGB", (16, 16), "black").save(root / "masked.png")
            state = self.new_state()
            first_id, second_id = (item["id"] for item in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in (first_id, second_id)]
            state.candidates[first_id] = [Candidate("missing", "penis", 0.9, state.cache_dir / first_id / "missing.png")]
            state.job = core_module.Job(kind="apply", state="running", total=2, image_ids=(first_id, second_id))
            worker = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, {second_id: self._mask(16, 16)}),
                kwargs={"copy_to_default": True, "saving_parallelism": 2},
            )

            with patch.object(state, "_reserve_output_destination", return_value=root / "output.png"), \
                 patch.object(saving_module, "write_rendered_copy"):
                worker.start()
                worker.join(2)

            self.assertFalse(worker.is_alive())
            self.assertEqual(state.job.state, "error")

    def test_copy_save_advances_past_an_out_of_order_empty_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first.png", "empty.png", "third.png"):
                Image.new("RGB", (16, 16), "white").save(root / name)
            state = self.new_state()
            image_ids = tuple(item["id"] for item in state.set_root(str(root)))
            records = [state.image_for_id(image_id) for image_id in image_ids]
            state.job = core_module.Job(kind="apply", state="running", total=3, image_ids=image_ids)
            first_entered = threading.Event()
            empty_done = threading.Event()
            third_ready = threading.Event()
            release_first = threading.Event()
            output_paths = {record.image_id: root / "copies" / f"{index}.png" for index, record in enumerate(records)}

            def compose(image_id, _draft, **_kwargs):
                if image_id == image_ids[0]:
                    first_entered.set()
                    self.assertTrue(release_first.wait(2))
                    return self._mask(16, 16)
                if image_id == image_ids[1]:
                    empty_done.set()
                    return None
                third_ready.set()
                return self._mask(16, 16)

            worker = threading.Thread(
                target=state._apply_worker,
                args=(records, 100, {}),
                kwargs={"copy_to_default": True, "saving_parallelism": 3},
            )
            with patch.object(state, "combined_candidate_mask", side_effect=compose), \
                patch.object(state, "_reserve_output_destination", side_effect=lambda record, _suffix, _directory: output_paths[record.image_id]), \
                 patch.object(saving_module, "render_with_mask", return_value=b"rendered"), \
                 patch.object(saving_module, "write_rendered_copy"):
                worker.start()
                self.assertTrue(first_entered.wait(2))
                self.assertTrue(empty_done.wait(2))
                self.assertTrue(third_ready.wait(2))
                release_first.set()
                worker.join(2)

            self.assertFalse(worker.is_alive())
            self.assertEqual(state.job.state, "complete")
            self.assertEqual(state.job.outputs, [str(output_paths[image_ids[0]]), str(output_paths[image_ids[2]])])

    def test_removed_image_lock_is_pruned_and_unknown_images_do_not_allocate_one(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            state.image_io_lock(image_id)
            self.assertIn(image_id, state._image_io_locks)

            state.remove_image_from_catalog(image_id)

            self.assertNotIn(image_id, state._image_io_locks)
            with self.assertRaises(ClientError):
                state.image_io_lock("missing")
            self.assertNotIn("missing", state._image_io_locks)

    def test_catalog_reload_is_rejected_while_worker_is_alive_and_stale_worker_cannot_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            entered = threading.Event()
            release = threading.Event()

            def worker(_records, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                state._finish_job(kwargs["job_generation"], kwargs["catalog_generation"])

            state._start_job("detect", [record], worker)
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ClientError, "画像一覧を変更できません"):
                state.set_root(str(root))
            release.set()
            self.assertTrue(state.worker_thread is not None)
            state.worker_thread.join(2)
            state.set_root(str(root))

            stale = Candidate("stale", "penis", 0.9, state.cache_dir / image_id / "stale.png")
            stale.mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(stale.mask_path)
            def stale_detection(*_args):
                state.catalog_generation += 1
                return [stale]
            with patch.object(state, "_ensure_models", return_value=[]), patch.object(state, "_detect_image", side_effect=stale_detection):
                state._detect_worker([record], DEFAULT_DETECTION_CONFIDENCE, job_generation=state.job_generation, catalog_generation=state.catalog_generation)
            self.assertFalse(stale.mask_path.exists())
            self.assertEqual(state.candidates.get(image_id, []), [])

    def test_cancelled_worker_blocks_a_new_job_until_it_exits(self):
        state = self.new_state()
        entered = threading.Event()
        release = threading.Event()

        def worker(_records, control, **kwargs):
            entered.set()
            while not control.cancel_requested.is_set():
                time.sleep(0.01)
            self.assertTrue(release.wait(2))
            state._cancel_job(kwargs["job_generation"], kwargs["catalog_generation"])

        record = ImageRecord(image_id="test", path=Path(__file__), relative_path="test.png", width=1, height=1, mtime_ns=0)
        state._start_job("apply", [record], worker)
        self.assertTrue(entered.wait(2))
        state.request_cancel()
        with self.assertRaises(ClientError):
            state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        release.set()
        assert state.worker_thread is not None
        state.worker_thread.join(2)
        state._start_job("detect", [record], lambda *_args, **_kwargs: None)
        assert state.worker_thread is not None
        state.worker_thread.join(2)

    def test_api_returns_utf8_japanese_client_error(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            body = json.dumps({"path": ""}).encode("utf-8")
            connection.request("POST", "/api/folder", body, {
                "Content-Type": "application/json",
                "X-Mozarie-Token": state_module.STATE.session_token,
                "Origin": f"http://127.0.0.1:{httpd.server_port}",
            })
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 400)
            self.assertEqual(payload, {"error_code": "input_invalid", "params": {}})
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_malformed_candidate_api_route_is_a_client_error(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            body = json.dumps({"enabled": True}).encode("utf-8")
            connection.request("POST", "/api/candidate/missing-part", body, {
                "Content-Type": "application/json",
                "X-Mozarie-Token": state_module.STATE.session_token,
                "Origin": f"http://127.0.0.1:{httpd.server_port}",
            })
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error_code"], "input_invalid")
            self.assertNotIn("error", payload)
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_unexpected_http_error_does_not_expose_runtime_text(self):
        handler = object.__new__(MosaicHandler)
        handler._json = Mock()
        handler._client_error(RuntimeError("sqlite disk I/O error"), http_module.HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")
        payload, status = handler._json.call_args.args
        self.assertEqual(status, http_module.HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertEqual(payload["error_code"], "internal_error")
        self.assertNotIn("error", payload)

    def test_database_http_error_has_a_stable_general_code(self):
        handler = object.__new__(MosaicHandler)
        handler._json = Mock()
        handler._client_error(sqlite3.DatabaseError("database disk image is malformed"), http_module.HTTPStatus.INTERNAL_SERVER_ERROR)
        payload, _status = handler._json.call_args.args
        self.assertEqual(payload["error_code"], "workspace_database_error")
        self.assertNotIn("error", payload)

    def test_http_error_params_are_allowlisted(self):
        handler = object.__new__(MosaicHandler)
        handler._json = Mock()
        handler._client_error(
            ClientError("private details", "gpu_out_of_memory", {"parallelism": 2, "path": "C:/private"}),
            http_module.HTTPStatus.BAD_REQUEST,
        )
        payload, _status = handler._json.call_args.args
        self.assertEqual(payload, {"error_code": "gpu_out_of_memory", "params": {"parallelism": 2}})

    def test_apply_output_error_has_a_stable_general_code(self):
        state = self.new_state()
        state.job = core_module.Job(kind="apply", state="running")
        state._fail_job(PermissionError("G:/private/output"))
        self.assertEqual(state.job.error_code, "output_unavailable")
        self.assertNotIn("private", state.job.error)

    def test_gpu_runtime_error_has_a_stable_general_code(self):
        state = self.new_state()
        state.settings["models"]["provider"] = "gpu"
        state.job = core_module.Job(kind="detect", state="running")
        state._fail_job(RuntimeError("CUDAExecutionProvider failed with private details"))
        self.assertEqual(state.job.error_code, "internal_error")
        self.assertNotIn("private", state.job.error)

    def test_save_render_returns_the_one_time_token_in_a_response_header(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            record = ImageRecord(image_id="image", path=Path("image.png"), relative_path="image.png", width=16, height=16, mtime_ns=1)
            with patch.object(state_module.STATE, "render_browser_save", return_value=(b"png", record, 3, "one-time-token")):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"imageId": "image", "candidateRevision": 3, "divisor": 100, "draft": None}).encode("utf-8")
                connection.request("POST", "/api/save/render", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": state_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("X-Mozarie-Save-Token"), "one-time-token")
                response.read()
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_save_commit_forwards_the_render_token_to_the_state(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            with patch.object(state_module.STATE, "commit_browser_save", return_value={"cleared": True}) as commit:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({
                    "imageId": "image",
                    "candidateRevision": 3,
                    "saveToken": "one-time-token",
                    "sourceAction": "keep",
                }).encode("utf-8")
                connection.request("POST", "/api/save/commit", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": state_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                self.assertEqual(commit.call_args.args, ("image", 3, "one-time-token", "keep"))
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_save_status_and_cancel_forward_the_same_pending_token(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            headers = {
                "Content-Type": "application/json", "X-Mozarie-Token": state_module.STATE.session_token,
                "Origin": f"http://127.0.0.1:{httpd.server_port}",
            }
            with patch.object(state_module.STATE, "browser_save_status", return_value={"state": "pending"}) as status, \
                    patch.object(state_module.STATE, "cancel_browser_save", return_value={"state": "pending"}) as cancel:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                status_payload = {"imageId": "image", "candidateRevision": 3, "saveToken": "one-time-token", "sourceAction": "keep"}
                connection.request("POST", "/api/save/status", json.dumps(status_payload).encode("utf-8"), headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"state": "pending"})
                status.assert_called_once_with("image", 3, "one-time-token", "keep")

                cancel_payload = {key: value for key, value in status_payload.items() if key != "sourceAction"}
                connection.request("POST", "/api/save/cancel", json.dumps(cancel_payload).encode("utf-8"), headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"state": "pending"})
                cancel.assert_called_once_with("image", 3, "one-time-token")
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_staged_file_import_can_skip_the_full_catalog_response(self):
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory) / "first.upload"
            Image.new("RGB", (8, 8), "white").save(staged, format="PNG")
            state = self.new_state()

            with patch.object(state, "list_images", wraps=state.list_images) as list_images:
                images, imported = state.import_image_file_for_api(
                    staged,
                    name="first.png",
                    relative_path="nested/first.png",
                    client_key="first",
                    include_images=False,
                )

            self.assertEqual(images, [])
            self.assertEqual(len(imported), 1)
            self.assertEqual(imported[0]["clientKey"], "first")
            list_images.assert_not_called()
            records = state.list_images()
            self.assertEqual(records[0]["id"], imported[0]["imageId"])
            self.assertEqual(records[0]["relativePath"], "nested/first.png")
    def test_detect_endpoint_forwards_validated_parallelism(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = None
        try:
            with patch.object(state_module.STATE, "start_detection") as start:
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"imageIds": ["image-a"], "confidence": 0.65, "parallelism": 3, "mode": "high_precision"}).encode("utf-8")
                connection.request("POST", "/api/detect", body, {
                    "Content-Type": "application/json",
                    "X-Mozarie-Token": state_module.STATE.session_token,
                    "Origin": f"http://127.0.0.1:{httpd.server_port}",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                start.assert_called_once_with(["image-a"], 0.65, 3)
        finally:
            if connection is not None:
                connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_http_responses_prevent_framing_and_content_type_sniffing(self):
        from http.server import ThreadingHTTPServer

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
        try:
            connection.request("GET", "/api/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Security-Policy"), "frame-ancestors 'none'")
            self.assertEqual(response.getheader("X-Frame-Options"), "DENY")
            self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
            response.read()
        finally:
            connection.close()
            httpd.shutdown()
            httpd.server_close()

    def test_thumbnail_response_is_not_persistently_cached(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            candidate_revision = state._touch_candidates(image_id)
            with patch.object(http_module, "STATE", state):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("GET", f"/api/thumbnail/{image_id}")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Cache-Control"), "no-store")
                    response.read()
                    for endpoint in (
                        f"/api/image/{image_id}",
                        f"/api/thumbnail/{image_id}",
                        f"/api/mask/{image_id}/candidate",
                    ):
                        expected_version = f"{candidate_revision}-candidate" if "/mask/" in endpoint else version
                        connection.request("GET", f"{endpoint}?v={expected_version}")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader("Cache-Control"), "private, max-age=31536000, immutable")
                        self.assertTrue(response.read())
                        connection.request("GET", f"{endpoint}?v=stale")
                        stale = connection.getresponse()
                        self.assertEqual(stale.status, 404 if "/mask/" in endpoint else 400)
                        self.assertNotEqual(stale.read(), source.read_bytes())
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_binary_import_reader_uses_bounded_chunks_and_cleans_short_body(self):
        class RecordingReader(io.BytesIO):
            def __init__(self, value):
                super().__init__(value)
                self.requests = []

            def read(self, size=-1):
                self.requests.append(size)
                return super().read(size)

        state = self.new_state()
        handler = object.__new__(MosaicHandler)
        body = b"x" * (core_module.IO_CHUNK_BYTES + 7)
        reader = RecordingReader(body)
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = reader
        with patch.object(http_module, "STATE", state):
            staged = handler._read_binary_body_to_file()
        try:
            self.assertEqual(staged.read_bytes(), body)
            self.assertTrue(all(0 < size <= core_module.IO_CHUNK_BYTES for size in reader.requests))
        finally:
            staged.unlink(missing_ok=True)

        handler.headers = {"Content-Length": "9"}
        handler.rfile = RecordingReader(b"short")
        with patch.object(http_module, "STATE", state), self.assertRaisesRegex(ClientError, "最後まで"):
            handler._read_binary_body_to_file()
        self.assertEqual(list((state.cache_dir / "import-staging").glob("*")), [])

    def test_response_disconnect_errors_are_swallowed(self):
        for error in http_module.CLIENT_DISCONNECT_ERRORS:
            with self.subTest(error=error.__name__):
                handler = object.__new__(MosaicHandler)
                handler.close_connection = False
                handler.send_response = Mock()
                handler.send_header = Mock()
                handler.end_headers = Mock()
                handler.wfile = Mock()
                handler.wfile.write.side_effect = error()
                handler._binary(b"image", "image/png")
                self.assertTrue(handler.close_connection)

                handler.close_connection = False
                handler.wfile.write.side_effect = error()
                handle = Mock()
                handle.read.side_effect = (b"image", b"")
                with patch.object(http_module.os, "fstat", return_value=types.SimpleNamespace(st_size=5)):
                    handler._stream_file(handle, None, "image/png", "no-store")
                self.assertTrue(handler.close_connection)

    def test_stream_file_propagates_file_errors(self):
        handler = object.__new__(MosaicHandler)
        handler.close_connection = False
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = Mock()
        with patch.object(http_module.os, "fstat", side_effect=RuntimeError("stat failed")), self.assertRaisesRegex(RuntimeError, "stat failed"):
            handler._stream_file(Mock(), None, "image/png", "no-store")

        handle = Mock()
        handle.read.side_effect = RuntimeError("read failed")
        with patch.object(http_module.os, "fstat", return_value=types.SimpleNamespace(st_size=5)), self.assertRaisesRegex(RuntimeError, "read failed"):
            handler._stream_file(handle, None, "image/png", "no-store")

    def test_thumbnail_requests_singleflight_the_same_image(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (32, 32), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            catalog_source = state.image_for_id(image_id).path
            version = state.list_images()[0]["assetVersion"]
            started = threading.Event()
            release = threading.Event()
            calls = 0
            calls_lock = threading.Lock()
            original_open = http_module.Image.open

            def delayed_open(path, *args, **kwargs):
                nonlocal calls
                if Path(path) == catalog_source:
                    with calls_lock:
                        calls += 1
                    started.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            with patch.object(http_module, "STATE", state), \
                 patch.object(http_module.Image, "open", side_effect=delayed_open):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                results = []

                def request_thumbnail():
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", f"/api/thumbnail/{image_id}?v={version}")
                        response = connection.getresponse()
                        results.append((response.status, response.read()))
                    finally:
                        connection.close()

                workers = [threading.Thread(target=request_thumbnail) for _ in range(8)]
                for worker in workers:
                    worker.start()
                self.assertTrue(started.wait(2))
                with calls_lock:
                    self.assertEqual(calls, 1)
                release.set()
                for worker in workers:
                    worker.join(3)
                httpd.shutdown()
                httpd.server_close()
            self.assertEqual(calls, 1)
            self.assertEqual([status for status, _body in results], [200] * 8)

    def test_exact_image_version_rejects_mutation_after_preflight_before_headers(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            original_assert = state._assert_record_stat_matches

            def mutate_after_preflight(record):
                original_assert(record)
                stat = source.stat()
                os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))

            with patch.object(http_module, "STATE", state), \
                 patch.object(state, "_assert_record_stat_matches", side_effect=mutate_after_preflight):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("GET", f"/api/image/{image_id}?v={version}")
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertEqual(response.status, 400)
                    self.assertEqual(payload["error_code"], "stale_asset")
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_missing_full_image_after_preflight_returns_error_before_ok_headers(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            validated = threading.Event()
            response_statuses = []
            original_assert = state._assert_record_stat_matches
            original_send_response = MosaicHandler.send_response

            def remove_after_preflight(record):
                original_assert(record)
                source.unlink()
                validated.set()

            def record_response(handler, status, *args, **kwargs):
                response_statuses.append(status)
                return original_send_response(handler, status, *args, **kwargs)

            with patch.object(http_module, "STATE", state), \
                 patch.object(state, "_assert_record_stat_matches", side_effect=remove_after_preflight), \
                 patch.object(MosaicHandler, "send_response", new=record_response):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                try:
                    connection.request("GET", f"/api/image/{image_id}?v={version}")
                    response = connection.getresponse()
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertTrue(validated.is_set())
                    self.assertEqual(response.status, 400)
                    self.assertEqual(payload["error_code"], "image_not_found")
                    self.assertEqual(response_statuses, [400])
                finally:
                    connection.close()
                    httpd.shutdown()
                    httpd.server_close()

    def test_exact_image_stream_holds_image_lock_until_opened_handle_finishes(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            expected_body = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            version = state.list_images()[0]["assetVersion"]
            started = threading.Event()
            release = threading.Event()
            writer_attempted = threading.Event()
            writer_done = threading.Event()
            result = {}
            original_stream = MosaicHandler._stream_file

            def delayed_stream(handler, handle, record, *args):
                if record is not None:
                    started.set()
                    self.assertTrue(release.wait(2))
                return original_stream(handler, handle, record, *args)

            def request_image(port):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    connection.request("GET", f"/api/image/{image_id}?v={version}")
                    response = connection.getresponse()
                    result["status"] = response.status
                    result["body"] = response.read()
                finally:
                    connection.close()

            def mutate_source():
                writer_attempted.set()
                with state.image_io_lock(image_id):
                    Image.new("RGB", (16, 16), "black").save(source)
                writer_done.set()

            with patch.object(http_module, "STATE", state), \
                 patch.object(MosaicHandler, "_stream_file", new=delayed_stream):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                server_thread.start()
                reader = threading.Thread(target=request_image, args=(httpd.server_port,))
                reader.start()
                self.assertTrue(started.wait(2))
                writer = threading.Thread(target=mutate_source)
                writer.start()
                self.assertTrue(writer_attempted.wait(2))
                self.assertFalse(writer_done.is_set())
                release.set()
                reader.join(3)
                writer.join(3)
                httpd.shutdown()
                httpd.server_close()

            self.assertEqual(result, {"status": 200, "body": expected_body})
            self.assertTrue(writer_done.is_set())

    def test_thumbnail_generation_limits_distinct_images_to_four(self):
        from http.server import ThreadingHTTPServer

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(5):
                Image.new("RGB", (32, 32), "white").save(root / f"{index}.png")
            state = self.new_state()
            images = state.set_root(directory)
            versions = {item["id"]: item["assetVersion"] for item in state.list_images()}
            source_paths = {record.path for record in state.images.values()}
            first_four = threading.Event()
            release = threading.Event()
            entered: set[Path] = set()
            entered_lock = threading.Lock()
            original_open = http_module.Image.open

            def delayed_open(path, *args, **kwargs):
                path = Path(path)
                if path in source_paths:
                    with entered_lock:
                        entered.add(path)
                        if len(entered) == 4:
                            first_four.set()
                    self.assertTrue(release.wait(2))
                return original_open(path, *args, **kwargs)

            with patch.object(http_module, "STATE", state), \
                 patch.object(http_module.Image, "open", side_effect=delayed_open):
                httpd = ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
                server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                server_thread.start()
                statuses = []

                def request_thumbnail(image):
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                    try:
                        connection.request("GET", f"/api/thumbnail/{image['id']}?v={versions[image['id']]}")
                        response = connection.getresponse()
                        statuses.append(response.status)
                        response.read()
                    finally:
                        connection.close()

                workers = [threading.Thread(target=request_thumbnail, args=(image,)) for image in images]
                for worker in workers:
                    worker.start()
                self.assertTrue(first_four.wait(2))
                with entered_lock:
                    self.assertEqual(len(entered), 4)
                release.set()
                for worker in workers:
                    worker.join(3)
                httpd.shutdown()
                httpd.server_close()
            self.assertEqual(sorted(statuses), [200] * 5)

    def test_browser_save_overwrite_updates_state_when_timestamp_restore_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)

            with patch.object(image_io_module.os, "utime", side_effect=OSError("denied")):
                committed = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

            self.assertTrue(committed["cleared"])
            self.assertEqual(source.read_bytes(), output)
            self.assertEqual(record.size_bytes, source.stat().st_size)

    def test_browser_overwrite_changes_asset_version_when_stat_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            before = state.asset_version(record)
            original_stat = source.stat()
            rendered = state.cache_dir / "rendered.png"
            rendered.write_bytes(source.read_bytes())
            token = state._issue_browser_save_token_unchecked(
                record,
                0,
                (record.mtime_ns, record.size_bytes),
                state.catalog_generation,
                rendered,
            )

            state.commit_browser_save(image_id, 0, token, "overwrite")

            self.assertEqual(source.stat().st_mtime_ns, original_stat.st_mtime_ns)
            self.assertEqual(source.stat().st_size, original_stat.st_size)
            self.assertNotEqual(state.asset_version(record), before)

    def test_browser_save_commit_acquires_import_lock_before_its_image_lock(self):
        class RecordingLock:
            def __init__(self, label, events):
                self.label = label
                self.events = events
                self.lock = threading.RLock()

            def __enter__(self):
                self.events.append(self.label)
                self.lock.acquire()
                return self

            def __exit__(self, *_args):
                self.lock.release()

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            events = []
            original_import_lock = state.import_lock
            state.import_lock = RecordingLock("import", events)
            try:
                with patch.object(state, "image_io_lock", return_value=RecordingLock("image", events)):
                    state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
            finally:
                state.import_lock = original_import_lock

            self.assertEqual(events[:2], ["import", "image"])

    def test_catalog_clear_waits_for_browser_commit_to_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            fingerprint_started = threading.Event()
            release = threading.Event()
            clear_done = threading.Event()
            commit_result = {}
            original_replace = saving_module._stage_record_replacement

            def delayed_replace(record, rendered_path, fingerprint):
                fingerprint_started.set()
                self.assertTrue(release.wait(2))
                return original_replace(record, rendered_path, fingerprint)

            with patch.object(saving_module, "_stage_record_replacement", side_effect=delayed_replace):
                commit = threading.Thread(
                    target=lambda: commit_result.setdefault(
                        "value", state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
                    )
                )
                commit.start()
                self.assertTrue(fingerprint_started.wait(2))
                clearer = threading.Thread(target=lambda: (state.clear_catalog(), clear_done.set()))
                clearer.start()
                self.assertFalse(clear_done.is_set())
                release.set()
                commit.join(3)
                clearer.join(3)

            self.assertFalse(commit.is_alive())
            self.assertTrue(commit_result["value"]["cleared"])
            self.assertTrue(clear_done.is_set())
            self.assertEqual(state.list_images(), [])

    def test_browser_save_session_overwrite_synchronizes_the_session_image(self):
        raw = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("prompt", '{"seed": 9}')
        Image.new("RGB", (16, 16), "white").save(raw, format="PNG", pnginfo=metadata)
        state = self.new_state()
        state.catalog_id = state.workspace_store.ensure_provisional_catalog()
        state.browser_catalog_provisional = True
        images, _imported = import_images_for_test(state, [
            {"clientKey": "session", "name": "source.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16)).save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)
        state.image_io_lock(image_id)

        _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
        rendered_path = state.browser_save_tokens[token].rendered_path
        self.assertTrue(rendered_path.is_file())
        committed = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

        self.assertTrue(committed["cleared"])
        self.assertFalse(rendered_path.exists())
        self.assertEqual(Image.open(record.path).text["prompt"], '{"seed": 9}')
        self.assertEqual(len(state.candidates.get(image_id, [])), 1)
        with state.workspace_store._connect() as db:
            stored = db.execute("SELECT size_bytes,mtime_ns FROM images WHERE image_id=?", (image_id,)).fetchone()
        self.assertEqual(int(stored["size_bytes"]), record.path.stat().st_size)

    def test_browser_save_database_failure_restores_source_and_keeps_token_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            original = source.read_bytes()
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            with patch.object(state.workspace_store, "commit_save", side_effect=OSError("database locked")):
                with self.assertRaises(OSError):
                    state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(state._candidate_revision(image_id), revision)
            self.assertEqual(len(state.candidates[image_id]), 1)
            self.assertIn(token, state.browser_save_tokens)
            self.assertNotIn(token, state.browser_save_claims)
            self.assertTrue(state.commit_browser_save(image_id, rendered_revision, token, "overwrite")["cleared"])
            self.assertEqual(state._candidate_revision(image_id), revision)
            with state.workspace_store._connect() as db:
                self.assertEqual(db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()["candidate_revision"], 0)

    def test_pending_browser_copy_token_can_be_checked_and_cancelled(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            destination = root / "copies"; destination.mkdir()
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            state.settings["saving"]["default_output_directory"] = str(destination)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)
            self.assertTrue(rendered.output_path.is_file())
            self.assertEqual(state.browser_save_status(image_id, revision, rendered.save_token, "keep"), {"state": "pending"})
            self.assertEqual(state.cancel_browser_save(image_id, revision, rendered.save_token), {"state": "pending"})
            self.assertFalse(rendered.output_path.exists())
            self.assertEqual(state.browser_save_status(image_id, revision, rendered.save_token, "keep"), {"state": "unknown"})

    def test_browser_copy_token_cleanup_handles_expiry_catalog_shutdown_and_replaced_outputs(self):
        def pending_copy() -> tuple[Any, str, int, Any]:
            directory = tempfile.TemporaryDirectory()
            self.addCleanup(directory.cleanup)
            root = Path(directory.name); source = root / "source.png"; destination = root / "copies"; destination.mkdir()
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); state.settings["saving"]["default_output_directory"] = str(destination)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            return state, image_id, revision, state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)

        state, image_id, revision, expired = pending_copy()
        details = state.browser_save_tokens[expired.save_token]
        state.browser_save_tokens[expired.save_token] = replace(details, issued_at=time.monotonic() - core_module.SAVE_TOKEN_TTL_SECONDS - 1)
        state.cleanup_expired_browser_save_tokens()
        self.assertFalse(expired.output_path.exists(), "expiry removes the token-owned copy")

        state, _image_id, _revision, catalog = pending_copy()
        state.clear_catalog()
        self.assertFalse(catalog.output_path.exists(), "catalog replacement removes a pending token-owned copy")

        state, _image_id, _revision, shutdown = pending_copy()
        state.shutdown()
        self.assertFalse(shutdown.output_path.exists(), "shutdown removes a pending token-owned copy")

        state, image_id, revision, replaced = pending_copy()
        replaced.output_path.write_bytes(b"external replacement with another size")
        self.assertEqual(state.cancel_browser_save(image_id, revision, replaced.save_token), {"state": "pending"})
        self.assertTrue(replaced.output_path.exists(), "cancel does not delete a path replaced after Mozarie created its copy")

    def test_committed_browser_copy_is_not_removed_by_a_late_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; destination = root / "copies"; destination.mkdir()
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); state.settings["saving"]["default_output_directory"] = str(destination)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)
            self.assertTrue(state.commit_browser_save(image_id, revision, rendered.save_token, "keep")["cleared"])
            self.assertEqual(state.cancel_browser_save(image_id, revision, rendered.save_token), {"state": "unknown"})
            self.assertTrue(rendered.output_path.exists(), "a committed copy remains available")

    def test_browser_save_rejects_deleting_from_a_streamed_render_token(self):
        raw = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(raw, format="PNG")
        state = self.new_state()
        images, _imported = import_images_for_test(state, [
            {"clientKey": "session", "name": "source.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16)).save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)

        _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
        rendered_path = state.browser_save_tokens[token].rendered_path
        with self.assertRaisesRegex(ClientError, "トークンと元画像の処理"):
            state.commit_browser_save(image_id, rendered_revision, token, "deleted")
        self.assertIn(image_id, state.images)
        self.assertTrue(record.path.exists())
        self.assertTrue(rendered_path.exists())

    def test_browser_save_token_render_file_is_removed_when_expired_and_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            details = state.browser_save_tokens[token]
            state.browser_save_tokens[token] = type(details)(
                details.image_id, details.candidate_revision, details.source_fingerprint,
                details.catalog_generation, time.monotonic() - core_module.SAVE_TOKEN_TTL_SECONDS - 1,
                details.rendered_path,
            )

            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
            self.assertFalse(details.rendered_path.exists())
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

    def test_browser_save_uses_1_over_100_block_size_and_keeps_png_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            width, height = 832, 1216
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            pixels[..., 0] = np.arange(width, dtype=np.uint16)[None, :] % 256
            pixels[..., 1] = np.arange(height, dtype=np.uint16)[:, None] % 256
            pixels[..., 2] = (pixels[..., 0].astype(np.uint16) + pixels[..., 1]) % 256
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("prompt", '{"seed": 13}')
            Image.fromarray(pixels).save(source, pnginfo=metadata)

            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            rgba_mask = np.full((height, width, 4), 255, dtype=np.uint8)
            rgba_mask[..., 3] = 0
            rgba_mask[600:616, 400:416, 3] = 255
            draft = {"add": self._png_data_url(Image.fromarray(rgba_mask))}
            binary_mask = np.zeros((height, width), dtype=np.uint8)
            binary_mask[600:616, 400:416] = 255

            output, _record, revision, token = state.render_browser_save(image_id, 0, 100, draft)
            expected = image_io_module.render_with_mask(record, binary_mask, 13)

            self.assertEqual(calculate_block_size(width, height, 100), 13)
            self.assertEqual(output, expected)
            self.assertTrue(token)
            with Image.open(io.BytesIO(output)) as rendered:
                rendered_pixels = np.asarray(rendered.convert("RGB"))
                self.assertEqual(rendered.text["prompt"], '{"seed": 13}')
            outside = binary_mask == 0
            self.assertTrue(np.array_equal(rendered_pixels[outside], pixels[outside]))
            self.assertFalse(np.array_equal(rendered_pixels[600:616, 400:416], pixels[600:616, 400:416]))
            state.commit_browser_save(image_id, revision, token, "overwrite")

    def test_browser_copy_render_writes_configured_unicode_destination_before_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "入力.png"
            Image.new("RGB", (16, 16), "white").save(source)
            (root / "出力先" / "nested").mkdir(parents=True)
            state = self.new_state()
            state.settings["saving"]["default_output_directory"] = str(root / "出力先" / "nested" / "..")
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            with patch.object(saving_module, "write_rendered_copy", wraps=saving_module.write_rendered_copy) as write_copy:
                rendered = state.render_browser_save(
                    image_id, revision, 100, None, copy_to_default=True, suffix="_モザイク",
                )
            _output, _record, rendered_revision, token = rendered

            destination = root / "出力先" / "入力_モザイク.png"
            expected_destination = os.path.normcase(str(destination.resolve()))
            self.assertTrue(destination.is_file())
            self.assertEqual(os.path.normcase(str(Path(rendered.output_path).resolve())), expected_destination)
            self.assertIsNone(state.browser_save_tokens[token].rendered_path)
            self.assertFalse((state.cache_dir / "browser-save").exists())
            write_copy.assert_called_once()
            written_destination, written_output = write_copy.call_args.args
            self.assertEqual(os.path.normcase(str(Path(written_destination).resolve())), expected_destination)
            self.assertEqual(written_output, _output)
            self.assertEqual(len(state.candidates[image_id]), 1, "rendering a copy must not clear candidates")
            committed = state.commit_browser_save(image_id, rendered_revision, token, "keep")
            self.assertTrue(committed["cleared"])
            self.assertTrue(destination.is_file())
            self.assertEqual(state.commit_browser_save(image_id, rendered_revision, token, "keep")["cleared"], committed["cleared"])
            write_copy.assert_called_once()

    def test_browser_file_system_copy_token_keeps_no_backend_render_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_browser=True)
            details = state.browser_save_tokens[rendered.save_token]

            self.assertTrue(rendered.output)
            self.assertIsNone(rendered.output_path)
            self.assertIsNone(details.rendered_path)
            self.assertTrue(details.allow_copy_action)
            self.assertFalse((state.cache_dir / "browser-save").exists())
            self.assertTrue(state.commit_browser_save(image_id, revision, rendered.save_token, "keep")["cleared"])

    def test_browser_file_system_400_copies_write_no_backend_temp_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            output_bytes = 0
            for _index in range(400):
                rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_browser=True)
                output_bytes += len(rendered.output)
                self.assertIsNone(rendered.output_path)
                self.assertIsNone(state.browser_save_tokens[rendered.save_token].rendered_path)
                self.assertTrue(state.commit_browser_save(image_id, revision, rendered.save_token, "keep")["cleared"])

            self.assertGreater(output_bytes, 0)
            self.assertFalse((state.cache_dir / "browser-save").exists())
            self.assertEqual(state.browser_save_tokens, {})

    def test_browser_copy_render_keeps_source_and_candidates_when_output_sync_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            source_bytes = source.read_bytes()
            output_directory = root / "output"
            output_directory.mkdir()
            state = self.new_state()
            state.settings["saving"]["default_output_directory"] = str(output_directory)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            with patch.object(image_io_module.os, "fsync", side_effect=OSError("disk full")), \
                 patch.object(image_io_module.os, "replace", wraps=image_io_module.os.replace) as replace:
                with self.assertRaisesRegex(ClientError, "保存先フォルダへ保存できませんでした"):
                    state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)

            self.assertEqual(source.read_bytes(), source_bytes)
            self.assertEqual(len(state.candidates[image_id]), 1)
            self.assertEqual(state.reserved_output_paths, set())
            self.assertEqual(state.browser_save_tokens, {})
            replace.assert_not_called()
            self.assertFalse((output_directory / "source_censored.png").exists())
            self.assertEqual(list(output_directory.glob("*.mozarie.tmp")), [])

    def test_browser_save_renders_and_keeps_the_matching_workspace_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            info = PngImagePlugin.PngInfo()
            info.add_text("prompt", '{"seed": 1}')
            Image.new("RGB", (16, 16), "white").save(source, pnginfo=info)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            entry = state.prepare_browser_save([image_id], 100, "_censored", False)[0]
            output, record, revision, save_token = state.render_browser_save(image_id, entry["candidateRevision"], 100, None)
            self.assertEqual(record.image_id, image_id)
            self.assertEqual(revision, entry["candidateRevision"])
            self.assertEqual(Image.open(io.BytesIO(output)).text["prompt"], '{"seed": 1}')
            committed = state.commit_browser_save(image_id, revision, save_token, "overwrite")
            self.assertTrue(committed["cleared"])
            self.assertEqual(len(state.candidates.get(image_id, [])), 1)
            self.assertTrue(mask_path.exists())

    def test_browser_save_does_not_clear_candidates_changed_after_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            state._touch_candidates(image_id)

            entry = state.prepare_browser_save([image_id], 100, "_censored", False)[0]
            _output, _record, revision, save_token = state.render_browser_save(
                image_id, entry["candidateRevision"], 100, None,
            )
            state._touch_candidates(image_id)

            committed = state.commit_browser_save(image_id, revision, save_token, "overwrite")
            self.assertFalse(committed["cleared"])
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_browser_save_commit_is_idempotent_for_matching_token(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
            with self.assertRaisesRegex(ClientError, "保存確認トークン"):
                state.commit_browser_save(image_id, rendered_revision, "", "overwrite")
            with self.assertRaisesRegex(ClientError, "keep、overwrite、deleted"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "invalid")
            with self.assertRaisesRegex(ClientError, "保存対象と一致"):
                state.commit_browser_save(image_id, rendered_revision + 1, save_token, "overwrite")

            committed = state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")
            self.assertTrue(committed["cleared"])
            retried = state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")
            self.assertEqual(retried["cleared"], committed["cleared"])
            self.assertEqual(retried["stale"], committed["stale"])
            self.assertEqual(retried["deleted"], committed["deleted"])
            with self.assertRaisesRegex(ClientError, "保存対象と一致"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "keep")

    def test_browser_save_token_expires_and_catalog_change_discards_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, expired_token = state.render_browser_save(image_id, revision, 100, None)
            details = state.browser_save_tokens[expired_token]
            state.browser_save_tokens[expired_token] = type(details)(
                details.image_id,
                details.candidate_revision,
                details.source_fingerprint,
                details.catalog_generation,
                time.monotonic() - core_module.SAVE_TOKEN_TTL_SECONDS - 1,
                details.rendered_path,
            )
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, expired_token, "overwrite")

            _output, _record, rendered_revision, catalog_token = state.render_browser_save(image_id, revision, 100, None)
            state.clear_catalog()
            with self.assertRaisesRegex(ClientError, "無効または期限切れ"):
                state.commit_browser_save(image_id, rendered_revision, catalog_token, "overwrite")

    def test_browser_save_claim_keeps_rendered_file_during_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            rendered_path = state.browser_save_tokens[token].rendered_path
            claimed = threading.Event(); release = threading.Event(); outcome = {}
            original_replace = saving_module._stage_record_replacement

            def block_after_claim(record, rendered_path, fingerprint):
                details = state.browser_save_tokens[token]
                state.browser_save_tokens[token] = replace(
                    details, issued_at=time.monotonic() - core_module.SAVE_TOKEN_TTL_SECONDS - 1,
                )
                claimed.set(); self.assertTrue(release.wait(2)); return original_replace(record, rendered_path, fingerprint)

            def commit():
                try:
                    outcome["value"] = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
                except Exception as exc:
                    outcome["error"] = exc

            with patch.object(saving_module, "_stage_record_replacement", side_effect=block_after_claim):
                thread = threading.Thread(target=commit); thread.start()
                self.assertTrue(claimed.wait(2))
                state.cleanup_expired_browser_save_tokens()
                self.assertTrue(rendered_path.exists())
                release.set(); thread.join(2)

            self.assertNotIn("error", outcome)
            self.assertTrue(outcome["value"]["cleared"])
            self.assertFalse(rendered_path.exists())

    def test_expired_claimed_copy_survives_delete_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; copies = root / "copies"; copies.mkdir()
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); state.settings["saving"]["default_output_directory"] = str(copies)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)
            claimed = threading.Event(); release = threading.Event(); outcome = {}
            original_assert = state._assert_record_stat_matches

            def block_assert(*args, **kwargs):
                details = state.browser_save_tokens[rendered.save_token]
                state.browser_save_tokens[rendered.save_token] = replace(
                    details, issued_at=time.monotonic() - core_module.SAVE_TOKEN_TTL_SECONDS - 1,
                )
                claimed.set(); self.assertTrue(release.wait(2)); return original_assert(*args, **kwargs)

            def commit():
                try:
                    outcome["value"] = state.commit_browser_save(image_id, revision, rendered.save_token, "deleted")
                except Exception as exc:
                    outcome["error"] = exc

            with patch.object(state, "_assert_record_stat_matches", side_effect=block_assert):
                thread = threading.Thread(target=commit); thread.start()
                self.assertTrue(claimed.wait(2))
                state.cleanup_expired_browser_save_tokens()
                self.assertTrue(rendered.output_path.exists())
                release.set(); thread.join(2)

            self.assertNotIn("error", outcome)
            self.assertTrue(outcome["value"]["deleted"])
            self.assertFalse(source.exists())
            self.assertTrue(rendered.output_path.exists())

    def test_shutdown_waits_for_a_claimed_copy_delete_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; copies = root / "copies"; copies.mkdir()
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state(); state.settings["saving"]["default_output_directory"] = str(copies)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)
            claimed = threading.Event(); release = threading.Event(); shutdown_done = threading.Event(); outcome = {}
            original_assert = state._assert_record_stat_matches

            def block_assert(*args, **kwargs):
                claimed.set(); self.assertTrue(release.wait(2)); return original_assert(*args, **kwargs)

            def commit():
                try:
                    outcome["value"] = state.commit_browser_save(image_id, revision, rendered.save_token, "deleted")
                except Exception as exc:
                    outcome["error"] = exc

            with patch.object(state, "_assert_record_stat_matches", side_effect=block_assert):
                commit_thread = threading.Thread(target=commit); commit_thread.start()
                self.assertTrue(claimed.wait(2))
                shutdown_thread = threading.Thread(target=lambda: (state.shutdown(), shutdown_done.set())); shutdown_thread.start()
                self.assertFalse(shutdown_done.wait(.1))
                self.assertTrue(rendered.output_path.exists())
                release.set(); commit_thread.join(2); shutdown_thread.join(2)

            self.assertNotIn("error", outcome)
            self.assertTrue(outcome["value"]["deleted"])
            self.assertTrue(shutdown_done.is_set())
            self.assertTrue(rendered.output_path.exists())

    def test_browser_save_catalog_mismatch_removes_rendered_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(source.parent))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            rendered_path = state.browser_save_tokens[token].rendered_path
            state.catalog_generation += 1

            with self.assertRaisesRegex(ClientError, "画像一覧が変更"):
                state.commit_browser_save(image_id, rendered_revision, token, "overwrite")

            self.assertFalse(rendered_path.exists())
            self.assertNotIn(token, state.browser_save_tokens)

    def test_shutdown_discards_pending_browser_save_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, _rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)

            state.shutdown()
            self.assertNotIn(save_token, state.browser_save_tokens)

    def test_browser_save_rejects_stale_delete_without_a_completed_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)

            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
            state._touch_candidates(image_id)

            with self.assertRaisesRegex(ClientError, "トークンと元画像の処理"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")
            self.assertTrue(source.exists())
            self.assertIn(image_id, state.images)

    def test_browser_save_stale_overwrite_updates_the_working_copy_and_keeps_candidates(self):
        raw = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(raw, format="PNG")
        state = self.new_state()
        images, _imported = import_images_for_test(state, [
            {"clientKey": "session", "name": "source.png", "data": base64.b64encode(raw.getvalue()).decode("ascii")},
        ])
        image_id = images[0]["id"]
        record = state.image_for_id(image_id)
        mask_path = state.cache_dir / image_id / "candidate.png"
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(self._mask(16, 16)).save(mask_path)
        state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
        revision = state._touch_candidates(image_id)

        output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)
        state._touch_candidates(image_id)
        committed = state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")

        self.assertFalse(committed["cleared"])
        self.assertTrue(committed["stale"])
        self.assertFalse(committed["deleted"])
        self.assertEqual(record.path.read_bytes(), output)
        self.assertEqual(len(state.candidates[image_id]), 1)
        self.assertGreater(state._candidate_revision(image_id), rendered_revision)

    def test_browser_save_rejects_a_token_after_the_source_fingerprint_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, save_token = state.render_browser_save(image_id, revision, 100, None)

            Image.new("RGB", (16, 16), "black").save(source)
            with self.assertRaisesRegex(ClientError, "元画像が.*変更"):
                state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")
            self.assertEqual(len(state.candidates[image_id]), 1)
            self.assertNotIn(save_token, state.browser_save_tokens)

    def test_browser_save_keeps_candidates_and_token_when_source_unlink_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            state.settings["saving"]["default_output_directory"] = str(root / "output")
            (root / "output").mkdir()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            rendered = state.render_browser_save(
                image_id, revision, 100, None, copy_to_default=True,
            )
            _output, record, rendered_revision, save_token = rendered
            output_path = rendered.output_path

            original_replace = Path.replace

            def fail_only_for_source(path: Path, target, *args, **kwargs):
                if path == record.path:
                    raise PermissionError("locked")
                return original_replace(path, target, *args, **kwargs)

            with patch.object(type(record.path), "replace", autospec=True, side_effect=fail_only_for_source):
                with self.assertRaisesRegex(ClientError, "候補は保持"):
                    state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")

            self.assertTrue(source.is_file())
            self.assertTrue(output_path.is_file())
            self.assertEqual(len(state.candidates[image_id]), 1)
            self.assertIn(save_token, state.browser_save_tokens)
            self.assertTrue(state.commit_browser_save(image_id, rendered_revision, save_token, "deleted")["deleted"])
            self.assertFalse(source.exists())

    def test_browser_copy_delete_removes_the_durable_workspace_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"; Image.new("RGB", (16, 16), "white").save(source)
            output = root / "output"; output.mkdir()
            state = self.new_state(); state.settings["saving"]["default_output_directory"] = str(output)
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            rendered = state.render_browser_save(image_id, revision, 100, None, copy_to_default=True)
            committed = state.commit_browser_save(image_id, rendered.candidate_revision, rendered.save_token, "deleted")
            self.assertTrue(committed["deleted"])
            self.assertFalse(state.workspace_store.has_image(image_id))
            self.assertFalse(source.exists())

    def test_browser_save_uses_one_candidate_snapshot_when_candidates_change_during_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            mask = self._mask(16, 16)
            mask[2:6, 2:6] = 255
            Image.fromarray(mask).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            render_started = threading.Event()
            allow_render_to_finish = threading.Event()
            observed: dict[str, np.ndarray] = {}
            outcome: dict[str, Any] = {}

            def capture_snapshot(_record, snapshot, _divisor):
                observed["mask"] = snapshot.copy()
                render_started.set()
                self.assertTrue(allow_render_to_finish.wait(2))
                return b"rendered"

            def run_render():
                try:
                    outcome["result"] = state.render_browser_save(image_id, revision, 100, None)
                except Exception as exc:  # asserted below
                    outcome["error"] = exc

            with patch.object(saving_module, "render_with_mask", side_effect=capture_snapshot):
                thread = threading.Thread(target=run_render)
                thread.start()
                self.assertTrue(render_started.wait(2))
                mutation = threading.Thread(target=lambda: state.set_candidate_state(image_id, "candidate", {"enabled": False}))
                mutation.start()
                allow_render_to_finish.set()
                thread.join(2)
                mutation.join(2)

            self.assertFalse(thread.is_alive())
            self.assertFalse(mutation.is_alive())
            self.assertNotIn("error", outcome)
            self.assertTrue(np.any(observed["mask"]))
            _output, _record, rendered_revision, save_token = outcome["result"]
            self.assertEqual(rendered_revision, revision)
            committed = state.commit_browser_save(image_id, rendered_revision, save_token, "overwrite")
            self.assertFalse(committed["deleted"])
            self.assertTrue(committed["stale"])
            self.assertTrue(source.exists())

    def test_browser_save_prunes_missing_candidates_and_advances_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            mask_path.unlink()

            with self.assertRaisesRegex(ClientError, "候補が変更"):
                state.render_browser_save(image_id, revision, 100, None)
            self.assertEqual(state.candidates[image_id], [])
            self.assertGreater(state._candidate_revision(image_id), revision)

    def test_browser_save_rejects_duplicate_image_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]

            with self.assertRaises(ClientError):
                state.prepare_browser_save([image_id, image_id], 100, "_censored", False)

    def test_browser_save_rejects_changed_source_and_preserves_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            Image.new("RGB", (16, 16), "black").save(source)
            with self.assertRaises(ClientError):
                state.prepare_browser_save([image_id], 100, "_censored", False)
            self.assertEqual(len(state.candidates[image_id]), 1)

    def test_exif_rotated_jpeg_uses_normalized_mask_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rotated.jpg"
            exif = Image.Exif()
            exif[274] = 6
            Image.new("RGB", (40, 20), "white").save(source, exif=exif)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            record = state.image_for_id(image_id)
            self.assertEqual((record.width, record.height), (20, 40))
            mask = np.zeros((40, 20), dtype=np.uint8)
            mask[4:12, 4:12] = 255
            output = image_io_module.render_with_mask(record, mask, 4)
            with Image.open(io.BytesIO(output)) as saved:
                self.assertEqual(saved.getexif().get(274), 1)
                self.assertEqual(ImageOps.exif_transpose(saved).size, (20, 40))

    def test_browser_save_receipt_retries_without_repeating_file_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            _output, _record, rendered_revision, token = state.render_browser_save(image_id, revision, 100, None)
            first = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
            retried = state.commit_browser_save(image_id, rendered_revision, token, "overwrite")
            self.assertTrue(mask_path.exists())
            self.assertEqual(retried["cleared"], first["cleared"])
            self.assertIn(token, state.browser_save_receipts)
            state.clear_catalog()
            self.assertIn(token, state.browser_save_receipts)
            self.assertNotIn("images", state.commit_browser_save(image_id, rendered_revision, token, "overwrite"))
            with self.assertRaises(ClientError):
                state.commit_browser_save(image_id, rendered_revision, token, "keep")

    def test_browser_save_skips_disabled_candidate_mask_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            cache = state.cache_dir / image_id; cache.mkdir(parents=True, exist_ok=True)
            enabled_path = cache / "enabled.png"
            Image.fromarray(self._mask(16, 16)).save(enabled_path)
            state.candidates[image_id] = [
                Candidate("enabled", "penis", 0.9, enabled_path),
                Candidate("disabled", "penis", 0.8, cache / "missing-disabled.png", enabled=False),
            ]
            revision = state._touch_candidates(image_id)
            output, _record, rendered_revision, _token = state.render_browser_save(image_id, revision, 100, None)
            self.assertEqual(rendered_revision, revision)
            self.assertTrue(output)

    def test_update_request_only_stops_the_http_server(self):
        events = []
        http_server = Mock(); http_server.shutdown.side_effect = lambda: events.append("server")
        with patch.object(http_module.time, "sleep"):
            http_module._start_update_after_response(http_server)
        self.assertEqual(events, ["server"])
        self.assertTrue(http_server.mozarie_update_requested)

    def test_update_start_can_only_be_reserved_once(self):
        http_module._update_start_requested = False
        self.assertTrue(http_module._reserve_update_start())
        self.assertFalse(http_module._reserve_update_start())
        http_module._update_start_requested = False

    def test_update_start_is_rejected_while_a_model_download_is_active(self):
        handler = object.__new__(MosaicHandler)
        handler.server = Mock()
        handler._json = Mock()
        state = self.new_state()
        state.model_downloads = Mock(snapshot=Mock(return_value={"state": "running"}))
        with patch.object(http_module, "STATE", state), \
                patch.object(handler, "_require_json_request"), \
                patch.object(handler, "_read_json_body", return_value={}):
            handler.path = "/api/update/start"
            handler.do_POST()
        self.assertEqual(handler._json.call_args.args[0]["error_code"], "operation_in_progress")

    def test_default_output_suffix_rejects_path_and_keeps_relative_folder(self):
        record = ImageRecord(image_id="id", path=Path("C:/source.png"), relative_path="nested/source.png", width=1, height=1, mtime_ns=0, size_bytes=0)
        destination = image_io_module._default_output_destination(record, "_mosaic")
        self.assertTrue(str(destination).endswith("output\\nested\\source_mosaic.png"))
        self.assertEqual(core_module._read_save_suffix(""), "")
        self.assertEqual(core_module._read_save_suffix("_モザイク"), "_モザイク")
        for suffix in ("../bad", "bad/name", "bad\x00name", "bad:name"):
            with self.subTest(suffix=suffix), self.assertRaises(ClientError): core_module._read_save_suffix(suffix)

    def test_folder_scan_uses_import_parallelism_and_sorts_deterministically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("c.png", "B.png", "a.png", "nested/d.png"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (8, 8), "white").save(path)
            active = peak = 0
            active_lock = threading.Lock()
            original_inspect = catalog_module.inspect_import_image

            def tracked_inspect(path, suffix):
                nonlocal active, peak
                with active_lock:
                    active += 1
                    peak = max(peak, active)
                try:
                    time.sleep(0.01)
                    return original_inspect(path, suffix)
                finally:
                    with active_lock:
                        active -= 1

            state = self.new_state()
            state.settings["importing"]["parallelism"] = 3
            with patch.object(catalog_module, "inspect_import_image", side_effect=tracked_inspect):
                records = state.set_root(directory)
            self.assertLessEqual(peak, 3)
            self.assertGreaterEqual(peak, 2)
            self.assertEqual([record["relativePath"] for record in records], ["a.png", "B.png", "c.png", "nested/d.png"])

    def test_browser_render_uses_one_source_read(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            read_bytes = Path.read_bytes
            with patch.object(Path, "read_bytes", autospec=True, side_effect=read_bytes) as read:
                state.render_browser_save(image_id, revision, 100, None)
            self.assertEqual(read.call_count, 1)

    def test_older_browser_overwrite_token_cannot_replace_a_newer_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.fromarray(np.tile(np.arange(16, dtype=np.uint8), (16, 1))).convert("RGB").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            revision = state._touch_candidates(image_id)
            output_a, _record, revision_a, token_a = state.render_browser_save(image_id, revision, 100, None)
            output_b, _record, revision_b, token_b = state.render_browser_save(image_id, revision, 1, None)
            self.assertNotEqual(output_a, output_b)
            state.commit_browser_save(image_id, revision_b, token_b, "overwrite")

            with self.assertRaisesRegex(ClientError, "外部で変更") as raised:
                state.commit_browser_save(image_id, revision_a, token_a, "overwrite")
            self.assertEqual(raised.exception.error_code, "stale_asset")
            self.assertEqual(source.read_bytes(), output_b)

    def test_candidate_state_changes_without_reading_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(directory)[0]["id"]
            mask_path = state.cache_dir / image_id / "candidate.png"
            mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            state.candidates[image_id] = [Candidate("candidate", "penis", 0.9, mask_path)]
            with patch.object(Path, "read_bytes", side_effect=AssertionError("unexpected source read")):
                state.set_candidate_state(image_id, "candidate", {"enabled": False})

    def test_filesystem_save_rechecks_after_staging_before_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            original_stat = source.stat()
            state = self.new_state()
            record = state.image_for_id(state.set_root(directory)[0]["id"])
            checks = 0
            original_check = image_io_module._assert_source_stat_matches

            def mutate_before_replace(*args):
                nonlocal checks
                checks += 1
                if checks == 2:
                    Image.new("RGB", (16, 16), "blue").save(source)
                    os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns + 4_000_000_000))
                return original_check(*args)

            with patch.object(image_io_module, "_assert_source_stat_matches", side_effect=mutate_before_replace):
                with self.assertRaisesRegex(ClientError, "外部で変更"):
                    save_with_mask(record, self._mask(16, 16), 4)
            self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 255))

    def test_staged_overwrites_reject_source_changes_during_backup_copy(self):
        for route in ("apply", "browser overwrite"):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.png"
                Image.new("RGB", (16, 16), "white").save(source)
                original_stat = source.stat()
                state = self.new_state()
                record = state.image_for_id(state.set_root(directory)[0]["id"])
                if route == "apply":
                    stage = lambda: image_io_module._stage_save_with_mask(record, self._mask(16, 16), 4)
                else:
                    rendered = Path(directory) / "rendered.png"
                    Image.new("RGB", (16, 16), "black").save(rendered)
                    stage = lambda: image_io_module._stage_record_replacement(
                        record, rendered, (record.mtime_ns, record.size_bytes),
                    )
                original_copy2 = image_io_module.shutil.copy2

                def copy_then_modify(current, backup, *args, **kwargs):
                    result = original_copy2(current, backup, *args, **kwargs)
                    Image.new("RGB", (16, 16), "blue").save(source)
                    changed_mtime = original_stat.st_mtime_ns + 4_000_000_000
                    os.utime(source, ns=(original_stat.st_atime_ns, changed_mtime))
                    return result

                with patch.object(image_io_module.shutil, "copy2", side_effect=copy_then_modify), \
                     patch.object(image_io_module.os, "replace", wraps=image_io_module.os.replace) as replace:
                    with self.assertRaisesRegex(ClientError, "外部で変更") as raised:
                        stage()

                self.assertEqual(raised.exception.error_code, "stale_asset")
                replace.assert_not_called()
                self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 255))
                self.assertEqual(list(source.parent.glob(".source.png.mozarie-backup-*")), [])

    def test_staged_overwrites_remove_partial_backup_after_copy_failure(self):
        for route in ("apply", "browser overwrite"):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.png"
                Image.new("RGB", (16, 16), "white").save(source)
                source_bytes = source.read_bytes()
                state = self.new_state()
                record = state.image_for_id(state.set_root(directory)[0]["id"])
                if route == "apply":
                    stage = lambda: image_io_module._stage_save_with_mask(record, self._mask(16, 16), 4)
                else:
                    rendered = Path(directory) / "rendered.png"
                    Image.new("RGB", (16, 16), "black").save(rendered)
                    stage = lambda: image_io_module._stage_record_replacement(
                        record, rendered, (record.mtime_ns, record.size_bytes),
                    )

                def partial_backup(_current, backup, *_args, **_kwargs):
                    Path(backup).write_bytes(b"partial backup")
                    raise OSError("disk full")

                with patch.object(image_io_module.shutil, "copy2", side_effect=partial_backup):
                    with self.assertRaisesRegex(OSError, "disk full"):
                        stage()

                self.assertEqual(source.read_bytes(), source_bytes)
                self.assertEqual(list(source.parent.glob(".source.png.mozarie-backup-*")), [])

    def test_rendered_saves_flush_and_sync_before_replace(self):
        original_temporary_file = image_io_module.tempfile.NamedTemporaryFile
        original_replace = image_io_module.os.replace
        original_assert_source_stat_matches = image_io_module._assert_source_stat_matches

        for route in ("apply", "browser overwrite", "browser copy"):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.png"
                Image.new("RGB", (16, 16), "white").save(source)
                state = self.new_state()
                record = state.image_for_id(state.set_root(directory)[0]["id"])
                events: list[str] = []

                class TrackingTemporaryFile:
                    def __init__(self, handle):
                        self.handle = handle

                    @property
                    def name(self):
                        return self.handle.name

                    def __enter__(self):
                        self.handle.__enter__()
                        return self

                    def __exit__(self, *args):
                        return self.handle.__exit__(*args)

                    def write(self, data):
                        events.append("write")
                        return self.handle.write(data)

                    def flush(self):
                        events.append("flush")
                        return self.handle.flush()

                    def fileno(self):
                        return self.handle.fileno()

                def tracked_temporary_file(*args, **kwargs):
                    return TrackingTemporaryFile(original_temporary_file(*args, **kwargs))

                def tracked_stat_check(*args, **kwargs):
                    events.append("stale check")
                    return original_assert_source_stat_matches(*args, **kwargs)

                def tracked_replace(*args, **kwargs):
                    events.append("replace")
                    return original_replace(*args, **kwargs)

                if route == "apply":
                    save = lambda: save_with_mask(record, self._mask(16, 16), 4)
                elif route == "browser overwrite":
                    rendered = Path(directory) / "rendered.png"
                    Image.new("RGB", (16, 16), "black").save(rendered)
                    save = lambda: image_io_module._replace_record_with_rendered_output(
                        record, rendered, (record.mtime_ns, record.size_bytes),
                    )
                else:
                    destination = Path(directory) / "copy.png"
                    save = lambda: image_io_module.write_rendered_copy(destination, b"rendered")

                with patch.object(image_io_module.tempfile, "NamedTemporaryFile", side_effect=tracked_temporary_file), \
                     patch.object(image_io_module.os, "fsync", side_effect=lambda _fd: events.append("fsync")), \
                     patch.object(image_io_module, "_assert_source_stat_matches", side_effect=tracked_stat_check), \
                     patch.object(image_io_module.os, "replace", side_effect=tracked_replace):
                    save()

                self.assertLess(events.index("write"), events.index("flush"))
                self.assertLess(events.index("flush"), events.index("fsync"))
                if route != "browser copy":
                    self.assertIn("stale check", events)
                    self.assertEqual(events.count("replace"), 1, "staged overwrite atomically replaces the original")
                else:
                    self.assertEqual(events.count("replace"), 1)
                if route == "browser copy":
                    self.assertEqual(destination.read_bytes(), b"rendered")

    def test_destructive_saves_preserve_source_when_fsync_fails(self):
        for route in ("apply", "browser overwrite"):
            with self.subTest(route=route), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.png"
                Image.new("RGB", (16, 16), "white").save(source)
                source_bytes = source.read_bytes()
                state = self.new_state()
                record = state.image_for_id(state.set_root(directory)[0]["id"])

                if route == "apply":
                    save = lambda: save_with_mask(record, self._mask(16, 16), 4)
                else:
                    rendered = Path(directory) / "rendered.png"
                    Image.new("RGB", (16, 16), "black").save(rendered)
                    save = lambda: image_io_module._replace_record_with_rendered_output(
                        record, rendered, (record.mtime_ns, record.size_bytes),
                    )

                with patch.object(image_io_module.os, "fsync", side_effect=OSError("disk full")), \
                     patch.object(image_io_module.os, "replace", wraps=image_io_module.os.replace) as replace:
                    with self.assertRaisesRegex(OSError, "disk full"):
                        save()

                replace.assert_not_called()
                self.assertEqual(source.read_bytes(), source_bytes)
                self.assertEqual(list(source.parent.glob("*.mozarie.tmp")), [])

    def test_overwrite_crash_never_leaves_the_source_path_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.png"; rendered = root / "rendered.png"
            Image.new("RGB", (16, 16), "white").save(source)
            Image.new("RGB", (16, 16), "black").save(rendered)
            source_stat = source.stat()
            code = """
import os, sys
from pathlib import Path
from mozarie.core import ImageRecord
from mozarie import image_io
source, rendered = map(Path, sys.argv[1:])
record = ImageRecord('image', source, 'source.png', 16, 16, source.stat().st_mtime_ns, source.stat().st_size)
original_replace = image_io.os.replace
def crash_before_replace(current, destination):
    if Path(destination) == source:
        os._exit(91)
    return original_replace(current, destination)
image_io.os.replace = crash_before_replace
image_io._stage_record_replacement(record, rendered, (source.stat().st_mtime_ns, source.stat().st_size))
"""
            environment = os.environ | {"PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            before = subprocess.run([sys.executable, "-c", code, str(source), str(rendered)], env=environment, capture_output=True, text=True)
            self.assertEqual(before.returncode, 91, before.stdout + before.stderr)
            self.assertTrue(source.is_file())
            self.assertEqual(Image.open(source).getpixel((0, 0)), (255, 255, 255))
            self.assertTrue(list(root.glob(".source.png.mozarie-backup-*")))

            code = code.replace("os._exit(91)", "return original_replace(current, destination)") + "\nos._exit(92)\n"
            after = subprocess.run([sys.executable, "-c", code, str(source), str(rendered)], env=environment, capture_output=True, text=True)
            self.assertEqual(after.returncode, 92, after.stdout + after.stderr)
            self.assertTrue(source.is_file())
            self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 0))

    def test_filesystem_save_rejects_change_during_source_read(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            record = state.image_for_id(state.set_root(directory)[0]["id"])
            target = record.path
            read_bytes = Path.read_bytes
            mutated_bytes = []

            def mutate_after_read(path):
                result = read_bytes(path)
                if path == target:
                    Image.new("RGB", (16, 16), "blue").save(target)
                    changed_timestamp = record.mtime_ns + 4_000_000_000
                    os.utime(target, ns=(changed_timestamp, changed_timestamp))
                    self.assertNotEqual(target.stat().st_mtime_ns, record.mtime_ns)
                    mutated_bytes.append(read_bytes(target))
                return result

            with patch.object(Path, "read_bytes", autospec=True, side_effect=mutate_after_read):
                with self.assertRaisesRegex(ClientError, "外部で変更") as raised:
                    save_with_mask(record, self._mask(16, 16), 4)
            self.assertEqual(raised.exception.error_code, "stale_asset")
            self.assertEqual(source.read_bytes(), mutated_bytes[0])
            self.assertEqual(source.stat().st_size, len(mutated_bytes[0]))
            self.assertEqual(Image.open(source).getpixel((0, 0)), (0, 0, 255))

    def test_copy_save_renders_once(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (16, 16), "white").save(source)
            source_bytes = source.read_bytes()
            state = self.new_state()
            record = state.image_for_id(state.set_root(directory)[0]["id"])
            mask_path = state.cache_dir / record.image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            candidate = Candidate("candidate", "penis", 0.9, mask_path)
            state.candidates[record.image_id] = [candidate]
            revision = state._touch_candidates(record.image_id)

            with patch.object(saving_module, "render_with_mask", wraps=saving_module.render_with_mask) as render, \
                 patch.object(saving_module, "write_rendered_copy") as write_copy:
                state._apply_worker([record], 100, {record.image_id: self._mask(16, 16)}, copy_to_default=True)
            write_copy.assert_called_once()
            self.assertEqual(render.call_count, 1)
            self.assertEqual(source.read_bytes(), source_bytes)
            self.assertEqual(state.candidates[record.image_id], [candidate])
            self.assertEqual(state._candidate_revision(record.image_id), revision)
            self.assertTrue(mask_path.is_file())

    def test_background_copy_database_failure_removes_output_and_keeps_masks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "copies"; output.mkdir()
            Image.new("RGB", (16, 16), "white").save(source)
            state = self.new_state()
            image_id = state.set_root(str(root))[0]["id"]
            record = state.image_for_id(image_id)
            mask_path = state.cache_dir / image_id / "candidate.png"; mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(self._mask(16, 16)).save(mask_path)
            candidate = Candidate("candidate", "penis", 0.9, mask_path)
            state.candidates[image_id] = [candidate]
            revision = state._touch_candidates(image_id)

            with patch.object(state.workspace_store, "commit_save", side_effect=OSError("database locked")):
                state._apply_worker([record], 100, {image_id: self._mask(16, 16)}, copy_to_default=True, output_directory=output)

            self.assertEqual(state.job.state, "error")
            self.assertEqual(state.candidates[image_id], [candidate])
            self.assertTrue(mask_path.is_file())
            self.assertEqual(list(output.rglob("*.png")), [])
            self.assertEqual(state._candidate_revision(image_id), revision)

    def test_detection_configuration_and_model_loading_error_paths(self):
        state = self.new_state()
        for raw, code in (("", "model_not_configured"), ("missing.onnx", "model_file_missing")):
            state.settings["models"]["target_segmentation"] = raw
            with self.subTest(raw=raw), self.assertRaises(ClientError) as raised:
                state._configured_model_path("target_segmentation", "対象")
            self.assertEqual(raised.exception.error_code, code)
        with tempfile.TemporaryDirectory() as directory:
            invalid = Path(directory) / "model.txt"; invalid.write_text("x", encoding="utf-8")
            state.settings["models"]["target_segmentation"] = str(invalid)
            with self.assertRaisesRegex(ClientError, "ONNX"):
                state._configured_model_path("target_segmentation", "対象")
            state.settings["models"]["sam_checkpoints"] = {"vit_b": str(invalid)}
            state.settings["models"]["sam_model_type"] = "vit_b"
            with self.assertRaisesRegex(ClientError, r"\.pth"):
                state._configured_sam_path()
            model = Path(directory) / "model.onnx"; model.write_bytes(b"model")
            state.settings["models"]["target_segmentation"] = str(model)
            with patch.object(detection_module, "TargetSegmenter", side_effect=ClientError("bad", "gpu_unavailable")):
                with self.assertRaisesRegex(ClientError, "bad"):
                    state._load_detection_models()
            state.settings["models"].update({"ntd11_enabled": True, "ntd11": str(model)})
            with patch.object(detection_module, "TargetSegmenter", return_value=Mock()), \
                    patch.object(detection_module, "GenericYoloSegmenter", side_effect=ClientError("bad auxiliary", "gpu_unavailable")):
                with self.assertRaisesRegex(ClientError, "bad auxiliary"):
                    state._load_detection_models()
            state.settings["models"]["hand_detection"] = str(model)
            with patch.object(detection_module, "HandDetector", side_effect=ClientError("bad hand", "gpu_unavailable")):
                with self.assertRaisesRegex(ClientError, "bad hand"):
                    state._ensure_hand_model()
        state.settings["models"]["sam_checkpoints"] = {}
        with self.assertRaisesRegex(ClientError, "SAMモデルが未設定"):
            state._configured_sam_path()
        state.settings["models"]["sam_checkpoints"] = {"vit_b": str(Path(self.app_dir) / "missing.pth")}
        with self.assertRaisesRegex(ClientError, "SAMモデルが見つかり"):
            state._configured_sam_path()

    def test_detection_segment_helpers_cover_invalid_and_empty_paths(self):
        state = self.new_state()
        rgb = np.zeros((8, 8, 3), dtype=np.uint8)
        target = Mock()
        target.detect.return_value = [
            {"class_name": "other", "mask": np.ones((8, 8), dtype=np.uint8), "confidence": .9},
            {"class_name": "penis", "mask": np.ones((2, 2), dtype=np.uint8), "confidence": .9},
        ]
        auxiliary = Mock()
        auxiliary.detect.return_value = [
            {"class_name": "other", "mask": np.ones((8, 8), dtype=np.uint8), "confidence": .9},
            {"class_name": "penis", "mask": np.ones((1, 1), dtype=np.uint8), "confidence": .9},
        ]
        models = DetectionModels(target=target, auxiliaries=[("ntd11", auxiliary)])
        self.assertEqual(state._detect_arbitrated_segments(models, rgb, .5), [])
        self.assertEqual(state._hand_boxes_over_apply([(0, 0, 2, 2)], []), [])
        state.settings["models"]["hand_detection_enabled"] = True
        hand = Mock(); hand.detect_boxes.return_value = [(1, 1, 3, 3)]
        with patch.object(state, "_ensure_hand_model", return_value=hand):
            self.assertEqual(state._hand_boxes(models, rgb), [(1, 1, 3, 3)])

    def test_detection_refinement_and_exclusion_empty_and_fallback_paths(self):
        state = self.new_state()
        rgb = np.zeros((6, 6, 3), dtype=np.uint8)
        empty = {"class_name": "penis", "mask": np.zeros((6, 6), dtype=np.uint8), "confidence": .8, "source": "target"}
        other = {"class_name": "other", "mask": np.zeros((6, 6), dtype=np.uint8), "confidence": .8, "source": "target"}
        self.assertIs(state._high_precision_segments(None, None, rgb, [other])[0], other)
        predictor = Mock()
        result = state._high_precision_segments_with_predictor(rgb, [empty], predictor)
        self.assertEqual(result[0]["refinement"], "sam_fallback")
        segments = state._attach_hand_evidence([other], [], np.ones((6, 6), dtype=np.uint8))
        self.assertEqual(segments[-1]["class_name"], "__hand_exclusion__")
        self.assertEqual(state._finalize_exclusions(rgb, segments), segments)
        mask = np.zeros((6, 6), dtype=np.uint8); mask[1:4, 1:4] = 1
        segment = {"class_name": "penis", "mask": mask, "confidence": .8, "source": "target", "image_exclusions": {"hand": np.ones((6, 6), dtype=np.uint8)}}
        state.settings["detection"]["fluid_exclusion_enabled"] = False
        finalized = state._finalize_exclusions(rgb, [segment])
        self.assertEqual(finalized[0]["exclusions"], {})
        self.assertFalse(np.any(finalized[0]["image_exclusions"].get("hand", np.zeros((6, 6), dtype=np.uint8))))

    def test_detection_start_passes_explicit_target_subset(self):
        state = self.new_state()
        state.settings["detection"]["targets"] = ["penis"]
        with patch.object(state, "_require_supported_gpu"), \
                patch.object(state, "_records_for_ids_with_catalog", return_value=([], 2)), \
                patch.object(state, "_start_job") as start:
            state.start_detection([], .6, 3)
        self.assertEqual(start.call_args.args[-1], {"penis"})

    def test_detection_worker_cancel_stale_directml_and_outer_error_paths(self):
        state = self.new_state()
        control = detection_module.JobControl(); control.cancel_requested.set()
        with patch.object(detection_module, "runtime_backend", return_value="directml"), \
                patch.object(state, "_set_job_parallelism"), patch.object(state, "_wait_while_paused"), \
                patch.object(state, "_cancel_job") as cancelled:
            state._detect_worker([], .5, 4, control=control)
        cancelled.assert_called_once()
        control = detection_module.JobControl()
        with patch.object(state, "_set_job_parallelism"), patch.object(state, "_wait_while_paused"), \
                patch.object(state, "_job_is_current", return_value=False):
            state._detect_worker([], .5, control=control)
        with patch.object(state, "_wait_while_paused", side_effect=RuntimeError("idle")), patch.object(state, "_fail_job") as failed:
            state._detect_worker([], .5)
        self.assertIsInstance(failed.call_args.args[0], RuntimeError)

    def test_detect_image_skips_empty_exclusions_and_non_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image = root / "image.png"; Image.new("RGB", (6, 6), "white").save(image)
            state = self.new_state(); record = state.image_for_id(state.set_root(directory)[0]["id"])
            target_mask = np.ones((6, 6), dtype=np.uint8)
            segments = [
                {"class_name": "other", "mask": target_mask, "confidence": .8, "source": "target", "image_exclusions": {"hand": np.zeros((6, 6), dtype=np.uint8)}},
                {"class_name": "penis", "mask": target_mask, "confidence": .8, "source": "target", "exclusions": {"fluid": np.zeros((6, 6), dtype=np.uint8)}},
            ]
            with patch.object(state, "_detect_arbitrated_segments", return_value=segments), \
                    patch.object(state, "_hand_refinement_context", return_value=([segments[1]], np.zeros((6, 6), dtype=np.uint8), [])), \
                    patch.object(state, "_fallback_hand_boxes_mask", return_value=np.zeros((6, 6), dtype=np.uint8)), \
                    patch.object(state, "_attach_hand_evidence", side_effect=lambda items, *_args: items), \
                    patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, items: items):
                candidates = state._detect_image(DetectionModels(target=Mock(), auxiliaries=[]), record, .5)
            self.assertEqual(len(candidates), 1)
            self.assertTrue(candidates[0].mask_path.is_file())

    def test_polygon_boundary_zero_mask_and_second_operation_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image = root / "image.png"; Image.new("RGB", (6, 6), "white").save(image)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]
            predictor = Mock(); predictor.predict.return_value = (np.zeros((1, 6, 6), dtype=np.uint8), [0.5], None)
            with patch.object(detection_module, "read_polygon_boundary_request", return_value=((0, 0, 6, 6), (2, 2), np.ones((6, 6), dtype=np.uint8))), \
                    patch.object(state, "_sam_predictor_for", return_value=predictor), \
                    patch.object(detection_module, "select_best_sam_mask", return_value=(np.zeros((6, 6), dtype=np.uint8), .5)):
                with self.assertRaisesRegex(ClientError, "境界を検出"):
                    state.add_boundary_candidate(image_id, {"points": [1, 2, 3, 4]})

    def test_detection_worker_discards_candidates_on_stat_replace_and_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image = root / "image.png"; Image.new("RGB", (6, 6), "white").save(image)
            state = self.new_state(); record = state.image_for_id(state.set_root(directory)[0]["id"])

            def pending_candidate() -> Candidate:
                path = state.cache_dir / record.image_id / ".mozarie-pending-test.tmp"
                path.parent.mkdir(parents=True, exist_ok=True); Image.new("L", (6, 6), 255).save(path, format="PNG")
                return Candidate("test", "penis", .8, path)

            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=Mock(), auxiliaries=[])), \
                    patch.object(state, "_detect_image", return_value=[pending_candidate()]), \
                    patch.object(state, "_job_is_current", return_value=True), \
                    patch.object(state, "_assert_record_stat_matches", side_effect=ClientError("stale", "stale_asset")), \
                    patch.object(state, "_fail_job"):
                state._detect_worker([record], .5, 1)

            candidate = pending_candidate()
            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=Mock(), auxiliaries=[])), \
                    patch.object(state, "_detect_image", return_value=[candidate]), \
                    patch.object(state, "_job_is_current", return_value=True), \
                    patch.object(detection_module.os, "replace", side_effect=OSError("replace failed")), \
                    patch.object(state, "_fail_job"):
                state._detect_worker([record], .5, 1)
            self.assertFalse(candidate.mask_path.exists())

            candidate = pending_candidate(); control = detection_module.JobControl()
            original_replace = detection_module.os.replace
            def cancel_replace(source, destination):
                original_replace(source, destination); control.cancel_requested.set()
            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=Mock(), auxiliaries=[])), \
                    patch.object(state, "_detect_image", return_value=[candidate]), \
                    patch.object(state, "_job_is_current", return_value=True), \
                    patch.object(detection_module.os, "replace", side_effect=cancel_replace), \
                    patch.object(state, "_fail_job"):
                state._detect_worker([record], .5, 1, control=control)
            self.assertFalse((state.cache_dir / record.image_id / "test.png").exists())

    def test_high_precision_retry_and_boundary_second_gate(self):
        state = self.new_state()
        source = np.ones((6, 6), dtype=np.uint8)
        hand = np.zeros((6, 6), dtype=np.uint8); hand[0, 0] = 1
        refined = np.zeros((6, 6), dtype=np.uint8); refined[:3, :] = 1
        retry = source.copy(); retry[0, 0] = 0
        segment = {"class_name": "penis", "mask": source.copy(), "confidence": .8, "source": "target", "_confirmed_hand": hand}
        predictor = Mock(); predictor.predict.side_effect = [([refined], [.9], np.ones((1, 1))), ([retry], [.9], None)]
        prompts = (np.asarray([[1, 1]], dtype=np.float32), np.asarray([1], dtype=np.int32))
        with patch.object(detection_module, "sam_refinement_prompts", return_value=prompts), \
                patch.object(detection_module, "select_semantic_sam_mask", side_effect=[(refined, 0), (retry, 0)]):
            result = state._high_precision_segments_with_predictor(np.zeros((6, 6, 3), dtype=np.uint8), [segment], predictor)
        self.assertEqual(result[0]["refinement"], "sam_high_precision")
        self.assertEqual(int(result[0]["mask"][0, 0]), 0)

        fallback = {"class_name": "penis", "mask": source.copy(), "confidence": .8, "source": "target", "_confirmed_hand": hand}
        predictor = Mock(); predictor.predict.side_effect = [([refined], [.9], np.ones((1, 1))), ([retry], [.9], None)]
        with patch.object(detection_module, "sam_refinement_prompts", return_value=prompts), \
                patch.object(detection_module, "select_semantic_sam_mask", side_effect=[(refined, 0), None]):
            result = state._high_precision_segments_with_predictor(np.zeros((6, 6, 3), dtype=np.uint8), [fallback], predictor)
        self.assertTrue(np.array_equal(result[0]["mask"], refined))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image = root / "image.png"; Image.new("RGB", (6, 6), "white").save(image)
            state = self.new_state(); image_id = state.set_root(directory)[0]["id"]
            predictor = Mock(); predictor.predict.return_value = (np.ones((1, 6, 6), dtype=np.uint8), [.5], None)
            with patch.object(state, "_sam_predictor_for", return_value=predictor), \
                    patch.object(detection_module, "select_best_sam_mask", return_value=(np.ones((6, 6), dtype=np.uint8), .5)), \
                    patch.object(state, "_has_active_worker", side_effect=[False, True]):
                with self.assertRaisesRegex(ClientError, "既存の処理"):
                    state.add_boundary_candidate(image_id, {"roi": {"left": 0, "top": 0, "right": 6, "bottom": 6}, "point": {"x": 2, "y": 2}})

    def test_boundary_hand_fallback_empty_exclusions_and_catalog_change_cleanup(self):
        def make_state():
            directory = tempfile.TemporaryDirectory()
            self.addCleanup(directory.cleanup)
            root = Path(directory.name); image = root / "image.png"; Image.new("RGB", (6, 6), "white").save(image)
            state = self.new_state(); image_id = state.set_root(str(root))[0]["id"]
            predictor = Mock(); predictor.predict.return_value = (np.ones((1, 6, 6), dtype=np.uint8), [.5], None)
            return state, image_id, predictor

        payload = {"roi": {"left": 0, "top": 0, "right": 6, "bottom": 6}, "point": {"x": 2, "y": 2}}
        state, image_id, predictor = make_state()
        state.settings["models"]["hand_segmentation_enabled"] = True
        specialist = Mock(); specialist.predict.return_value = (np.zeros((1, 6, 6), dtype=np.uint8), [.5], None)
        with patch.object(state, "_sam_predictor_for", return_value=predictor), \
                patch.object(detection_module, "select_best_sam_mask", return_value=(np.ones((6, 6), dtype=np.uint8), .5)), \
                patch.object(state, "_boundary_hand_boxes", return_value=[(1, 1, 4, 4)]), \
                patch.object(state, "_hand_boxes_over_apply", return_value=[(1, 1, 4, 4)]), \
                patch.object(state, "_hand_segmentation_predictor_for", return_value=specialist), \
                patch.object(detection_module, "accepted_specialist_hand_mask", return_value=None), \
                patch.object(state, "_fallback_hand_boxes_mask", return_value=np.ones((6, 6), dtype=np.uint8)):
            self.assertEqual(state.add_boundary_candidate(image_id, payload)["candidates"][0]["source"], "boundary")

        state, image_id, predictor = make_state()
        with patch.object(state, "_sam_predictor_for", return_value=predictor), \
                patch.object(detection_module, "select_best_sam_mask", return_value=(np.ones((6, 6), dtype=np.uint8), .5)), \
                patch.object(state, "_boundary_hand_boxes", return_value=[(1, 1, 4, 4)]), \
                patch.object(state, "_hand_boxes_over_apply", return_value=[(1, 1, 4, 4)]), \
                patch.object(state, "_fallback_hand_boxes_mask", return_value=np.zeros((6, 6), dtype=np.uint8)), \
                patch.object(state, "_finalize_exclusions", side_effect=lambda _rgb, segments: (segments[0].update({"image_exclusions": {"hand": np.zeros((6, 6), dtype=np.uint8)}}), segments)[1]):
            state.add_boundary_candidate(image_id, payload)

        state, image_id, predictor = make_state()
        record = state.image_for_id(image_id)
        def remove_before_publish(_rgb, segments):
            state.images.pop(image_id)
            return segments
        with patch.object(state, "_sam_predictor_for", return_value=predictor), \
                patch.object(detection_module, "select_best_sam_mask", return_value=(np.ones((6, 6), dtype=np.uint8), .5)), \
                patch.object(state, "_finalize_exclusions", side_effect=remove_before_publish):
            with self.assertRaisesRegex(ClientError, "再読み込み"):
                state.add_boundary_candidate(image_id, payload)
        self.assertNotIn(image_id, state.images)

        state, image_id, predictor = make_state()
        record = state.image_for_id(image_id)
        changed = threading.Event()
        class ChangesDuringPublication(dict):
            def __init__(self):
                super().__init__({image_id: record})

            def get(self, key, default=None):
                return None if changed.is_set() else record
        state.images = ChangesDuringPublication()
        original_replace = detection_module.os.replace
        def move_then_mark_changed(source, destination):
            original_replace(source, destination)
            changed.set()
        with patch.object(state, "_sam_predictor_for", return_value=predictor), \
                patch.object(detection_module, "select_best_sam_mask", return_value=(np.ones((6, 6), dtype=np.uint8), .5)), \
                patch.object(detection_module.os, "replace", side_effect=move_then_mark_changed):
            with self.assertRaisesRegex(ClientError, "再読み込み"):
                state.add_boundary_candidate(image_id, payload)


if __name__ == "__main__":
    unittest.main()
