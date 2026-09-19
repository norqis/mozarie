"""Direct integration contracts for data-integrity observations DI-051..070."""

from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

import mozarie.http as http_module
import mozarie.state as state_module
from mozarie.core import ClientError
from mozarie.domain import Candidate, CandidateRole
from mozarie.http import MosaicHandler
from mozarie.state import StudioState


class DataIntegrity051070Tests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.app_dir = self.root / "app"
        shutil.copytree(Path(__file__).resolve().parents[1] / "config", self.app_dir / "config")
        self._states: list[StudioState] = []

    def tearDown(self) -> None:
        for state in reversed(self._states):
            state.shutdown()
        self._temporary.cleanup()

    def new_state(self) -> StudioState:
        previous = state_module.APP_DIR
        state_module.APP_DIR = self.app_dir
        try:
            state = StudioState(self.root / "cache", self.root / "sessions")
        finally:
            state_module.APP_DIR = previous
        self._states.append(state)
        return state

    @staticmethod
    def write_image(path: Path, color: str = "white") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (24, 18), color).save(path)

    @staticmethod
    def mask(point: tuple[int, int]) -> bytes:
        image = Image.new("L", (24, 18), 0)
        image.putpixel(point, 255)
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    @staticmethod
    def data_url(raw: bytes) -> str:
        return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")

    def candidate(
        self,
        state: StudioState,
        image_id: str,
        candidate_id: str,
        point: tuple[int, int],
        *,
        role: CandidateRole = CandidateRole.APPLY,
    ) -> Candidate:
        path = state.cache_dir / image_id / f"{candidate_id}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.mask(point))
        return Candidate(
            candidate_id,
            "penis" if role == CandidateRole.APPLY else "hand",
            0.9,
            path,
            enabled=True,
            role=role,
            forced=role == CandidateRole.EXCLUDE,
            source="auto" if role == CandidateRole.APPLY else "hand_exclusion",
            origin="automatic",
        )

    def install_layers(self, state: StudioState, image_id: str, prefix: str) -> None:
        candidates = [
            self.candidate(state, image_id, f"{prefix}-apply", (1, 1)),
            self.candidate(state, image_id, f"{prefix}-exclude", (2, 2), role=CandidateRole.EXCLUDE),
        ]
        with state.image_io_lock(image_id), state.lock:
            state._commit_candidate_snapshot(image_id, candidates, replace=True)
        state.save_manual_workspace(
            image_id,
            {
                "add": self.data_url(self.mask((3, 3))),
                "exclusion": self.data_url(self.mask((4, 4))),
                "exclusionErase": self.data_url(self.mask((5, 5))),
                "removedCandidateIds": [],
                "manualEnabled": True,
                "manualExclusionEnabled": True,
                "manualExclusionEraseEnabled": True,
                "manualExclusionForced": True,
            },
        )

    @staticmethod
    def durable_state(state: StudioState, image_id: str) -> dict:
        exported = state.workspace_store.export_state(image_id)

        def mask_signature(value: str | None) -> tuple[tuple[int, int], tuple[int, ...]] | None:
            if not value:
                return None
            with Image.open(io.BytesIO(base64.b64decode(value))) as image:
                alpha = image.getchannel("A") if image.mode in {"RGBA", "LA"} else image.convert("L")
                return alpha.size, tuple(index for index, pixel in enumerate(alpha.getdata()) if pixel)

        candidates = tuple(sorted(
            (
                item["id"], item["enabled"], item["role"], item["forced"], item["expandPx"],
                mask_signature(item.get("mask")),
            )
            for item in exported["candidates"]
        ))
        manual = exported.get("manual")
        manual_signature = None if manual is None else (
            mask_signature(manual.get("add")), mask_signature(manual.get("exclusion")), mask_signature(manual.get("erase")),
            manual.get("manualEnabled"), manual.get("exclusionEnabled"), manual.get("eraseEnabled"),
            manual.get("exclusionForced"), manual.get("removed"),
        )
        return {
            "revision": exported["revision"], "flags": state.workspace_store.image_state(image_id),
            "transform": exported["transform"], "candidates": candidates, "manual": manual_signature,
        }

    def test_batch_clear_undo_redo_restores_only_the_selected_images(self) -> None:
        source = self.root / "batch-source"
        for name, color in (("A.png", "red"), ("B.png", "blue"), ("E.png", "green"), ("F.png", "yellow")):
            self.write_image(source / name, color)
        state = self.new_state()
        state.create_project("batch-history")
        images = {image["relativePath"]: image["id"] for image in state.set_root(str(source))}
        for name in images:
            self.install_layers(state, images[name], name[0])
        state.set_image_flags(images["A.png"], {"reviewed": True})
        state.set_image_flags(images["E.png"], {"hidden": True, "reviewed": True})
        state.set_image_flags(images["F.png"], {"hidden": True, "reviewed": False})

        before = {name: self.durable_state(state, image_id) for name, image_id in images.items()}
        state.clear_masks([images["A.png"], images["B.png"]])
        cleared = {name: self.durable_state(state, image_id) for name, image_id in images.items()}
        for name in ("A.png", "B.png"):
            self.assertEqual(cleared[name]["candidates"], (), f"{name} candidates are cleared")
            self.assertIsNone(cleared[name]["manual"], f"{name} all three manual layers are cleared")
            self.assertFalse(cleared[name]["flags"][1], f"{name} is unreviewed")
            self.assertFalse(state.images[images[name]].reviewed, f"{name} is immediately unreviewed in the published catalogue")
            self.assertEqual(cleared[name]["flags"][0], before[name]["flags"][0])
        self.assertEqual(cleared["E.png"], before["E.png"], "hidden E is byte-for-byte outside the batch")
        self.assertEqual(cleared["F.png"], before["F.png"], "hidden F is byte-for-byte outside the batch")

        undo = state.restore_project_history(images["A.png"], "undo")
        self.assertEqual(set(undo["changedImageIds"]), {images["A.png"], images["B.png"]})
        restored = {name: self.durable_state(state, image_id) for name, image_id in images.items()}
        for name in ("A.png", "B.png"):
            self.assertEqual(restored[name], before[name], f"undo restores every selected layer and flag for {name}")
        self.assertTrue(restored["A.png"]["flags"][1])
        self.assertFalse(restored["B.png"]["flags"][1])
        self.assertEqual(restored["E.png"], before["E.png"])
        self.assertEqual(restored["F.png"], before["F.png"])

        redo = state.restore_project_history(images["A.png"], "redo")
        self.assertEqual(set(redo["changedImageIds"]), {images["A.png"], images["B.png"]})
        redone = {name: self.durable_state(state, image_id) for name, image_id in images.items()}
        self.assertEqual(redone, cleared, "redo clears only A and B and preserves every outside state")

    def test_review_hide_show_and_history_preserve_content_and_editability(self) -> None:
        source = self.root / "flag-source"
        self.write_image(source / "A.png", "red")
        self.write_image(source / "B.png", "blue")
        state = self.new_state()
        state.create_project("flag-history")
        images = {image["relativePath"]: image["id"] for image in state.set_root(str(source))}
        a, b = images["A.png"], images["B.png"]
        self.install_layers(state, a, "A")
        self.install_layers(state, b, "B")
        stable_a = self.durable_state(state, a)
        stable_b = self.durable_state(state, b)
        content_history_before = self._history_rows(state, a)
        a_history_state_before = state.workspace_store.history_state(a)
        a_history_status_before = state.workspace_store.history_status(a)

        state.set_image_flags(a, {"reviewed": True})
        state.restore_project_history(a, "undo")
        after_review_undo = self.durable_state(state, a)
        self.assertFalse(after_review_undo["flags"][1], "undo restores only A's prior review flag")
        for key in ("candidates", "manual", "transform"):
            self.assertEqual(after_review_undo[key], stable_a[key], f"review undo leaves A {key} unchanged")
        self.assertEqual(after_review_undo["flags"][0], stable_a["flags"][0], "review undo leaves A hidden state unchanged")
        self.assertEqual(self.durable_state(state, b), stable_b, "review undo never changes B")
        self.assertEqual(state.workspace_store.history_state(a), a_history_state_before, "review undo restores A's complete candidate/manual/transform/hidden history state")
        review_history = self._history_rows(state, a)
        self.assertEqual(review_history[: len(content_history_before)], content_history_before, "review toggle preserves every existing history row byte-for-byte")
        self.assertEqual(len(review_history), len(content_history_before) + 1, "review toggle appends exactly one history operation")
        before_review = json.loads(review_history[-1][1]); after_review = json.loads(review_history[-1][2])
        self.assertEqual({**before_review, "flags": None}, {**after_review, "flags": None}, "review history changes no candidate, manual, transform, or hidden payload")
        self.assertEqual((before_review["flags"]["reviewed"], after_review["flags"]["reviewed"]), (False, True))
        self.assertEqual((before_review["flags"]["hidden"], after_review["flags"]["hidden"]), (stable_a["flags"][0], stable_a["flags"][0]))
        self.assertEqual(state.workspace_store.history_status(a), {"canUndo": a_history_status_before["canUndo"], "canRedo": True})

        state.set_image_flags(a, {"hidden": True})
        hidden = self.durable_state(state, a)
        self.assertTrue(hidden["flags"][0])
        with self.assertRaises(ClientError) as error:
            state.begin_manual_upload(a, "00000000-0000-4000-8000-000000000651", ["add"])
        self.assertEqual(error.exception.error_code, "image_hidden", "editing is blocked only while hidden")
        state.set_image_flags(a, {"hidden": False})
        session_id = "00000000-0000-4000-8000-000000000652"
        state.begin_manual_upload(a, session_id, ["add"])
        state.cancel_manual_upload(a, session_id)
        shown = self.durable_state(state, a)
        self.assertFalse(shown["flags"][0])
        self.assertEqual(shown["flags"][1], after_review_undo["flags"][1])
        self.assertEqual(shown["candidates"], after_review_undo["candidates"])
        self.assertEqual(shown["manual"], after_review_undo["manual"])
        history_rows_after = self._history_rows(state, a)
        self.assertEqual(history_rows_after[: len(content_history_before)], content_history_before, "hide/show retain every earlier mask-history entry")
        hide_show_rows = history_rows_after[len(content_history_before):]
        self.assertEqual(len(hide_show_rows), 2, "hide and show append exactly two flag-only history operations")
        for row, expected_flags in zip(hide_show_rows, ((False, True), (True, False))):
            before_flag = json.loads(row[1]); after_flag = json.loads(row[2])
            self.assertEqual({**before_flag, "flags": None}, {**after_flag, "flags": None}, "hide/show history retains complete candidate/manual/transform content")
            self.assertEqual((before_flag["flags"]["hidden"], after_flag["flags"]["hidden"]), expected_flags)
            self.assertEqual(before_flag["flags"]["reviewed"], after_flag["flags"]["reviewed"])

    @staticmethod
    def _history_rows(state: StudioState, image_id: str) -> list[tuple]:
        db = sqlite3.connect(state.workspace_store.path)
        try:
            return db.execute(
                "SELECT entry_id,before_json,after_json,delta_json FROM history_entries WHERE image_id=? ORDER BY entry_id",
                (image_id,),
            ).fetchall()
        finally:
            db.close()

    def test_project_rows_restart_missing_source_and_same_name_sources_are_durable(self) -> None:
        first = self.root / "source-one"
        second = self.root / "source-two"
        self.write_image(first / "same.png", "red")
        self.write_image(second / "same.png", "blue")
        state = self.new_state()
        empty = state.workspace_store.create_project("empty-project")
        multi = state.workspace_store.create_project("multi-source")
        for source in (first, second):
            path = source / "same.png"
            stat = path.stat()
            source_id = state.workspace_store.ensure_project_source(
                multi["id"], kind="native-folder", display_name=source.name, identity=str(source.resolve()),
            )
            state.workspace_store.reconcile_images(
                multi["id"],
                [SimpleNamespace(relative_path="same.png", size_bytes=stat.st_size, mtime_ns=stat.st_mtime_ns, width=24, height=18)],
                source_id,
            )
        opened = state.open_project(multi["id"])
        source_names = {source["id"]: Path(source["nativePath"]).name for source in opened["sources"]}
        source_to_id = {source_names[image["sourceId"]]: image["id"] for image in opened["images"]}
        first_image = source_to_id[first.name]
        self.install_layers(state, first_image, "first")
        state.set_image_flags(first_image, {"hidden": True, "reviewed": True})
        second_image = source_to_id[second.name]
        self.assertNotEqual(first_image, second_image, "same relative names from different sources retain distinct IDs")
        self.install_layers(state, second_image, "second")
        state.set_image_flags(second_image, {"hidden": False, "reviewed": False})
        expected_states = {
            first_image: self.durable_state(state, first_image),
            second_image: self.durable_state(state, second_image),
        }
        project_id = multi["id"]
        completed = state.workspace_store.set_project_status(project_id, "completed")
        completed_row = next(project for project in state.projects() if project["id"] == project_id)
        self.assertEqual(completed_row["status"], "completed")
        self.assertEqual(completed_row["imageCount"], 2)
        self.assertGreater(completed_row["createdAt"], 0)
        created_at, completed_updated = completed_row["createdAt"], completed_row["updatedAt"]
        time.sleep(0.002)
        resumed = state.resume_project(project_id)
        resumed_row = next(project for project in state.projects() if project["id"] == project_id)
        self.assertEqual(resumed["status"], "working")
        self.assertEqual(resumed_row["createdAt"], created_at)
        self.assertGreater(resumed_row["updatedAt"], completed_updated)

        finished = state.workspace_store.create_project("finished-project")
        state.workspace_store.set_project_status(finished["id"], "completed")

        before_restart = {project["id"]: project for project in state.projects() if project["id"] in {empty["id"], project_id, finished["id"]}}
        self.assertEqual({project["status"] for project in before_restart.values()}, {"working", "completed"})
        state.shutdown()
        self._states.remove(state)
        reopened = self.new_state()
        after_restart = {project["id"]: project for project in reopened.projects() if project["id"] in before_restart}
        for project_key, expected in before_restart.items():
            actual = after_restart[project_key]
            for field in ("name", "status", "imageCount", "sourceRoot", "createdAt", "updatedAt"):
                self.assertEqual(actual[field], expected[field], f"restart preserves {field} for {expected['name']}")

        previous_state = http_module.STATE
        http_module.STATE = reopened
        server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        expected_path = self.root / "restart-projects.json"
        expected_path.write_text(json.dumps(list(before_restart.values()), ensure_ascii=False), encoding="utf-8")
        try:
            helper = Path(__file__).with_name("data_integrity_project_restart_table_helper.cjs")
            result = subprocess.run(
                ["node", str(helper), f"http://127.0.0.1:{server.server_port}", str(expected_path)],
                cwd=Path(__file__).resolve().parents[1], env={**os.environ, "PYTHONUTF8": "1"},
                text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=60, check=False,
            )
            self.assertEqual(result.returncode, 0, f"restart project table helper failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        finally:
            server.shutdown(); server.server_close(); thread.join(5); http_module.STATE = previous_state

        opened = reopened.open_project(project_id)
        self.assertEqual({image["id"] for image in opened["images"]}, {first_image, second_image})
        for image_id, expected in expected_states.items():
            self.assertEqual(self.durable_state(reopened, image_id), expected, "same-name image state and history stay attached to its ID")
        second_before_first_undo = self.durable_state(reopened, second_image)
        first_undo = reopened.restore_project_history(first_image, "undo")
        self.assertEqual(first_undo["changedImageIds"], [first_image], "same-name images have independent history groups")
        self.assertEqual(self.durable_state(reopened, second_image), second_before_first_undo, "first source undo never moves the second source history")
        reopened.restore_project_history(first_image, "redo")
        self.assertEqual(self.durable_state(reopened, first_image), expected_states[first_image])

        missing = first.with_name("source-one-away")
        first.rename(missing)
        reopened.close_project()
        partial = reopened.open_project(project_id)
        missing_sources = [source for source in partial["sources"] if not source["exists"]]
        self.assertEqual([source["nativePath"] for source in missing_sources], [str(first.resolve())])
        self.assertEqual([image["id"] for image in partial["images"]], [second_image], "available source remains loaded when one source is missing")
        self.assertTrue(reopened.workspace_store.has_image(first_image), "missing source image remains durable for relink")

    def test_paused_batch_save_resumes_its_start_snapshot_without_duplicate_outputs(self) -> None:
        source = self.root / "pause-source"
        output = self.root / "pause-output"
        output.mkdir()
        for name, color in (("A.png", "red"), ("B.png", "blue"), ("C.png", "green")):
            self.write_image(source / name, color)
        state = self.new_state()
        state.create_project("pause-save")
        images = {image["relativePath"]: image["id"] for image in state.set_root(str(source))}
        state.settings["saving"]["default_output_directory"] = str(output.resolve())
        state.settings["saving"]["parallelism"] = 1
        state.settings["saving"]["preserve_directory_structure"] = True

        entered_publication = threading.Event()
        release_publication = threading.Event()
        original_publish = state._publish_staged_copy

        def controlled_publish(*args, **kwargs):
            if not entered_publication.is_set():
                entered_publication.set()
                self.assertTrue(release_publication.wait(10), "test released the first real output publication")
            return original_publish(*args, **kwargs)

        selected = [images["A.png"], images["B.png"]]
        with patch.object(state, "_publish_staged_copy", side_effect=controlled_publish):
            self.assertTrue(state.start_apply(selected, 100, {}, copy_to_default=True, suffix="_pause"))
            self.assertTrue(entered_publication.wait(10), "first selected file reached real publication")
            self.assertEqual(list(state.job.image_ids), selected, "job captures the exact start selection")
            paused = state.request_pause()
            self.assertEqual(paused["state"], "pausing")
            release_publication.set()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and state.job.state != "paused":
                time.sleep(0.02)
            self.assertEqual(state.job.state, "paused")
            self.assertEqual(state.job.completed, 1)
            self.assertEqual(list(state.job.image_ids), selected, "pause retains the immutable start target snapshot")
            self.assertEqual(len(list(output.glob("*_pause.png"))), 1, "pause leaves exactly one completed output")
            resumed = state.resume_job()
            self.assertEqual(resumed["state"], "running")
            assert state.worker_thread is not None
            state.worker_thread.join(20)
            self.assertFalse(state.worker_thread.is_alive())

        self.assertEqual(state.job.state, "complete")
        self.assertEqual(state.job.completed, 2)
        self.assertEqual(list(state.job.image_ids), selected)
        outputs = sorted(path.name for path in output.glob("*_pause.png"))
        self.assertEqual(outputs, ["A_pause.png", "B_pause.png"], "resume emits each selected file once and never saves unselected C")
        self.assertEqual(len(state.job.outputs), len(set(state.job.outputs)), "completed output receipts contain no duplicate path")

    def test_live_browser_directly_checks_selection_project_search_and_save_dialogs(self) -> None:
        source = self.root / "browser-source"
        for name, color in (
            ("A.png", "red"), ("B.png", "blue"), ("C.png", "green"), ("D.png", "yellow"),
            ("E.png", "purple"), ("F.png", "orange"), ("G.png", "gray"), ("H.png", "pink"),
        ):
            self.write_image(source / name, color)
        state = self.new_state()
        empty = state.create_project("empty-live")
        active = state.create_project("active-live")
        images = {image["relativePath"]: image["id"] for image in state.set_root(str(source))}
        self.install_layers(state, images["A.png"], "A")
        self.install_layers(state, images["B.png"], "B")
        self.install_layers(state, images["E.png"], "E")
        # Full exclusion leaves A with candidate records but no effective area;
        # disabling B leaves it with records but no enabled effective area.
        full_exclude = self.candidate(state, images["A.png"], "A-full-exclude", (0, 0), role=CandidateRole.EXCLUDE)
        full_image = Image.new("L", (24, 18), 255)
        full_image.save(full_exclude.mask_path, format="PNG")
        with state.image_io_lock(images["A.png"]), state.lock:
            state._commit_candidate_snapshot(
                images["A.png"],
                [next(candidate for candidate in state.candidates[images["A.png"]] if candidate.role == CandidateRole.APPLY), full_exclude],
                replace=True,
            )
        state.save_manual_workspace(images["A.png"], {
            "add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": [],
            "manualEnabled": True, "manualExclusionEnabled": True, "manualExclusionEraseEnabled": True,
            "manualExclusionForced": True,
        })
        state.set_candidate_state(images["B.png"], "B-apply", {"enabled": False})
        state.set_candidate_state(images["B.png"], "B-exclude", {"enabled": False})
        state.delete_manual_workspace(images["B.png"])
        active_id = active["id"]
        completed_source = self.root / "completed-source"
        self.write_image(completed_source / "done.png", "purple")
        completed = state.create_project("completed-live")
        state.set_root(str(completed_source))
        state.complete_project()
        state.open_project(active_id)
        state.settings["saving"]["default_output_directory"] = ""
        state.settings_store.save(state.settings)
        durable_before_browser = {
            image_id: (self.durable_state(state, image_id), self._history_rows(state, image_id))
            for image_id in images.values()
        }

        previous_state = http_module.STATE
        http_module.STATE = state
        server = http_module.ThreadingHTTPServer(("127.0.0.1", 0), MosaicHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            helper = Path(__file__).with_name("data_integrity_051_070_live_browser_helper.cjs")
            result = subprocess.run(
                [
                    "node", str(helper), f"http://127.0.0.1:{server.server_port}", active_id,
                    empty["id"], completed["id"], images["A.png"], images["B.png"], images["C.png"], images["D.png"],
                ],
                cwd=Path(__file__).resolve().parents[1],
                env={**os.environ, "PYTHONUTF8": "1"},
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=120,
                check=False,
            )
            self.assertEqual(result.returncode, 0, f"live browser contract failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
            for image_id, expected in durable_before_browser.items():
                self.assertEqual(
                    (self.durable_state(state, image_id), self._history_rows(state, image_id)), expected,
                    f"browser dialogs and unsaved settings preserve full durable image/history content for {image_id}",
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
            http_module.STATE = previous_state


if __name__ == "__main__":
    unittest.main()
