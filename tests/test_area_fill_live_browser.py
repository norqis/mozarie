"""Real pointer-to-SQLite coverage for enclosed mosaic and exclusion fills."""

from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

import numpy as np
from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.domain import Candidate, CandidateRole
from mozarie.http import MosaicHandler
from mozarie.state import StudioState
from tests import prepare_test_app_config


class LiveAreaFillBrowserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.output = self.root / "output"
        self.source.mkdir()
        self.output.mkdir()
        app = self.root / "app"
        prepare_test_app_config(app)
        previous_app, previous_http, previous_state = state_module.APP_DIR, http_module.STATE, state_module.STATE
        self.addCleanup(setattr, state_module, "APP_DIR", previous_app)
        self.addCleanup(setattr, http_module, "STATE", previous_http)
        self.addCleanup(setattr, state_module, "STATE", previous_state)
        state_module.APP_DIR = app
        self.state = StudioState(self.root / "cache", self.root / "sessions")
        self.addCleanup(self.state.shutdown)
        http_module.STATE = state_module.STATE = self.state
        self.originals: dict[str, bytes] = {}

    @staticmethod
    def mask_uri(mask: np.ndarray) -> str:
        with Image.fromarray(mask) as image, io.BytesIO() as stream:
            image.save(stream, format="PNG")
            return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")

    def prepare_images(self, specs: list[dict]) -> list[dict]:
        y, x = np.indices((128, 128))
        pixels = np.stack(((x * 13 + y * 7) % 256, (x * 3 + y * 17) % 256, (x * 19 + y * 5) % 256), axis=-1).astype(np.uint8)
        for index, spec in enumerate(specs):
            name = f"area-{index}.png"
            with Image.fromarray(pixels) as image:
                image.save(self.source / name)
            self.originals[name] = (self.source / name).read_bytes()
            spec["name"] = name
        self.state.create_project("Area fill integration")
        images = self.state.set_root(str(self.source))
        ids = {item["relativePath"]: item["id"] for item in images}
        for spec in specs:
            image_id = spec["id"] = ids[spec["name"]]
            candidates = []
            for candidate_id, role, mask in spec.pop("candidates", []):
                path = self.state.cache_dir / image_id / f"{candidate_id}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                with Image.fromarray(mask) as image:
                    image.save(path)
                candidates.append(Candidate(candidate_id, "penis" if role == "apply" else "hand", .9, path, role=CandidateRole(role)))
            if candidates:
                with self.state.image_io_lock(image_id), self.state.lock:
                    self.state._commit_candidate_snapshot(image_id, candidates, replace=True)
            manual = spec.pop("manual", {})
            if manual:
                self.state.save_manual_workspace(image_id, {
                    **{layer: self.mask_uri(mask) for layer, mask in manual.items()},
                    "candidateRevision": self.state._candidate_revision(image_id),
                    "hasEffectiveMask": True, "manualExclusionForced": True,
                })
            self.state.set_image_flags(image_id, {"reviewed": True})
        self.state.update_settings({"saving": {"default_output_directory": str(self.output)}})
        return specs

    def run_browser(self, mode: str, specs: list[dict]) -> None:
        server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            helper = Path(__file__).with_name("editor") / "area_fill_live_browser_helper.cjs"
            result = subprocess.run(
                ["node", str(helper), f"http://127.0.0.1:{server.server_port}", mode, json.dumps(specs)],
                cwd=Path(__file__).resolve().parents[1], env={**os.environ, "PYTHONUTF8": "1"},
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, check=False,
            )
            self.assertEqual(result.returncode, 0, f"area fill browser {mode}\n{result.stdout}\n{result.stderr}")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
        for name, original in self.originals.items():
            self.assertEqual((self.source / name).read_bytes(), original, "editing and copy saving preserve source bytes")

    def manual_mask(self, image_id: str, layer: str) -> np.ndarray:
        draft = self.state.manual_workspace(image_id) or {}
        uri = draft.get(layer)
        if not uri:
            return np.zeros((128, 128), dtype=np.uint8)
        with io.BytesIO(base64.b64decode(uri.split(",", 1)[1])) as stream, Image.open(stream) as image:
            with image.getchannel("A") if image.mode == "RGBA" else image.convert("L") as channel:
                return np.asarray(channel).copy()

    @staticmethod
    def ring() -> np.ndarray:
        mask = np.zeros((128, 128), dtype=np.uint8)
        mask[20:108, 20:108] = 255
        mask[24:104, 24:104] = 0
        return mask

    def test_bucket_fills_only_closed_holes_in_candidate_and_manual_masks_for_both_roles(self) -> None:
        specs = []
        for role in ("apply", "exclude"):
            for origin in ("candidate", "manual"):
                specs.append({"role": role, "origin": origin,
                              "candidates": [("ring", role, self.ring())] if origin == "candidate" else [],
                              "manual": {"add" if role == "apply" else "exclusion": self.ring()} if origin == "manual" else {}})
        specs = self.prepare_images(specs)
        self.run_browser("rings", specs)
        for spec in specs:
            mask = self.manual_mask(spec["id"], "add" if spec["role"] == "apply" else "exclusion")
            self.assertTrue(np.all(mask[24:104, 24:104] == 255), "the whole enclosed hole is persisted")
            self.assertFalse(mask[:20].any() or mask[108:].any() or mask[:, :20].any() or mask[:, 108:].any())

    def test_freehand_auto_closes_and_cancel_leaves_both_role_masks_and_history_unchanged(self) -> None:
        specs = self.prepare_images([{"role": "apply"}, {"role": "exclude"}])
        self.run_browser("enclose", specs)
        for spec in specs:
            mask = self.manual_mask(spec["id"], "add" if spec["role"] == "apply" else "exclusion")
            self.assertEqual(mask[60, 60], 255)
            self.assertEqual(mask[110, 110], 0)
            self.assertEqual(mask[60, 10], 0, "automatic closing never fills the outer region")

    def test_replace_cuts_candidate_and_all_manual_masks_inside_only_and_undo_is_exact(self) -> None:
        mark = np.zeros((128, 128), dtype=np.uint8)
        mark[40:64, 40:64] = 255
        mark[112:124, 112:124] = 255
        specs = self.prepare_images([
            {"role": role, "replace": replace,
             "candidates": [("apply-original", "apply", mark), ("exclude-original", "exclude", mark)],
             "manual": {layer: mark for layer in ("add", "exclusion", "exclusionErase")}}
            for role in ("apply", "exclude") for replace in (False, True)
        ])
        self.run_browser("replace", specs)
        for spec in specs:
            opposite = "exclude" if spec["role"] == "apply" else "apply"
            opposite_candidates = [candidate for candidate in self.state.candidates[spec["id"]] if candidate.role.value == opposite]
            self.assertTrue(opposite_candidates, "partial replacement retains candidate content outside the region")
            for candidate in opposite_candidates:
                raw = self.state.workspace_store.candidate_png(spec["id"], candidate.candidate_id)
                with io.BytesIO(raw) as stream, Image.open(stream) as image:
                    with image.getchannel("A") if image.mode == "RGBA" else image.convert("L") as channel:
                        mask = np.asarray(channel)
                        self.assertEqual(int(mask[50, 50]), 0 if spec["replace"] else 255)
                        self.assertEqual(int(mask[116, 116]), 255)
                if spec["replace"]:
                    self.assertNotEqual(candidate.candidate_id, opposite + "-original", "edited automatic masks have immutable new identity")
            for layer in ("add", "exclusion", "exclusionErase"):
                mask = self.manual_mask(spec["id"], layer)
                self.assertEqual(mask[116, 116], 255, "all three original outside layers survive")
                selected = "add" if spec["role"] == "apply" else "exclusion"
                preserved = not spec["replace"] and not (spec["role"] == "exclude" and layer == "exclusionErase")
                self.assertEqual(mask[50, 50], 255 if preserved or layer == selected else 0,
                                 "replacement removes underlying data, rather than covering it with an overlay")

    def test_fill_failure_retry_busy_restore_pending_brush_reopen_and_saved_output(self) -> None:
        specs = self.prepare_images([{"role": "apply"}, {"role": "exclude"}])
        self.run_browser("lifecycle", specs)
        image_id = specs[0]["id"]
        mask = self.manual_mask(image_id, "add")
        self.assertEqual(mask[60, 60], 255)
        self.assertGreater(mask[116, 12], 0, "the earlier pending brush is not lost by area-fill reload")
        exported = self.state.export_mask_png(image_id, "mosaic")
        with io.BytesIO(exported) as stream, Image.open(stream) as image:
            with image.getchannel("A") if image.mode == "RGBA" else image.convert("L") as channel:
                effective = np.asarray(channel).copy()
        from mozarie.image_io import render_with_mask
        expected = render_with_mask(self.state.image_for_id(image_id), effective, 16)
        saved = self.output / "area-0_area.png"
        with io.BytesIO(expected) as stream, Image.open(stream) as image, Image.open(saved) as output:
            with output.convert("RGB") as actual_rgb, image.convert("RGB") as expected_rgb:
                self.assertEqual(actual_rgb.tobytes(), expected_rgb.tobytes(), "saved pixels match the authoritative exported mask")
