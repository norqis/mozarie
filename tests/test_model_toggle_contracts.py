import copy
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mozarie.config as config_module
import mozarie.detection as detection_module
import mozarie.state as state_module
from mozarie.core import Candidate, CandidateRole
from mozarie.runtime_types import DetectionModels
from mozarie.state import StudioState


class ModelToggleContracts(unittest.TestCase):
    """Small end-to-end contracts for every optional detection-model gate."""

    def setUp(self):
        self.cache = tempfile.TemporaryDirectory()
        self.app = tempfile.TemporaryDirectory()
        self.app_dir = Path(self.app.name) / "app"
        (self.app_dir / "config").mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[1] / "config" / "defaults.json", self.app_dir / "config" / "defaults.json")
        self.states = []

    def tearDown(self):
        for state in self.states:
            state.shutdown()
        self.app.cleanup()
        self.cache.cleanup()

    def new_state(self) -> StudioState:
        with patch.object(state_module, "APP_DIR", self.app_dir):
            state = StudioState(Path(self.cache.name) / "cache", Path(self.cache.name) / "sessions")
        self.states.append(state)
        return state

    def state_with_image(self, root: Path) -> tuple[StudioState, str]:
        source = root / "source.png"
        Image.new("RGB", (16, 16), "black").save(source)
        state = self.new_state()
        state.create_project(f"Toggle contract {len(self.states)}")
        return state, state.set_root(str(root))[0]["id"]

    @staticmethod
    def write_mask(path: Path, size: int = 16) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.full((size, size), 255, dtype=np.uint8)).save(path, format="PNG")

    def test_auxiliary_toggles_gate_loading_inference_and_candidate_source(self):
        with tempfile.TemporaryDirectory() as directory:
            state, image_id = self.state_with_image(Path(directory))
            record = state.image_for_id(image_id)
            for source, switch in (("ntd11", "ntd11_enabled"), ("sensitive", "sensitive_enabled")):
                for enabled in (False, True):
                    with self.subTest(source=source, enabled=enabled):
                        state.settings["models"].update({"ntd11_enabled": False, "sensitive_enabled": False, switch: enabled})
                        target_constructor = Mock(return_value=Mock())
                        generic_constructor = Mock(return_value=Mock())
                        with patch.object(state, "_configured_model_path", side_effect=lambda key, _label: Path(f"{key}.onnx")), \
                             patch.object(detection_module, "TargetSegmenter", target_constructor), \
                             patch.object(detection_module, "GenericYoloSegmenter", generic_constructor):
                            loaded = state._load_detection_models()
                        self.assertEqual([name for name, _model in loaded.auxiliaries], [source] if enabled else [])
                        self.assertEqual(generic_constructor.call_count, int(enabled))

                        target = Mock(); target.detect.return_value = []
                        auxiliary = Mock()
                        auxiliary.detect.side_effect = lambda tile, _confidence, actual_source, _targets: [{
                            "class_name": "penis", "confidence": .9, "mask": np.full(tile.shape[:2], 255, dtype=np.uint8), "source": actual_source,
                        }]
                        models = DetectionModels(target=target, auxiliaries=[(source, auxiliary)] if enabled else [])
                        candidates = state._detect_image(models, record, .5)
                        self.assertEqual([candidate.source for candidate in candidates], [source] if enabled else [])
                        self.assertEqual(auxiliary.detect.call_count, len(detection_module.detection_tiles(16, 16)) if enabled else 0)
                        state._discard_candidates(candidates)

    def test_hand_toggle_truth_table_gates_auto_and_boundary_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            state, image_id = self.state_with_image(Path(directory))
            record = state.image_for_id(image_id)
            state.settings["models"]["provider"] = "cpu"
            target = Mock(); target.detect.return_value = []
            models = DetectionModels(target=target)
            hand = Mock(); hand.detect_boxes.return_value = [(4, 4, 8, 8)]
            specialist_mask = np.zeros((1, 16, 16), dtype=bool); specialist_mask[0, 4:7, 4:7] = True
            specialist = Mock(); specialist.predict.return_value = specialist_mask, np.asarray([.9]), None
            for detection_enabled, segmentation_enabled, expected_source in ((False, False, None), (True, False, None), (True, True, "hand_exclusion")):
                with self.subTest(auto=(detection_enabled, segmentation_enabled)):
                    state.settings["models"].update({
                        "hand_detection_enabled": detection_enabled,
                        "hand_segmentation_enabled": segmentation_enabled,
                    })
                    with patch.object(state, "_ensure_hand_model", return_value=hand) as ensure, \
                         patch.object(state, "_hand_segmentation_predictor_for", return_value=specialist) as specialist_loader:
                        candidates = state._detect_image(models, record, .5)
                    self.assertEqual([candidate.source for candidate in candidates], [] if expected_source is None else [expected_source])
                    self.assertEqual(ensure.call_count, int(detection_enabled))
                    self.assertEqual(specialist_loader.call_count, int(segmentation_enabled))
                    state._discard_candidates(candidates)

            invalid = copy.deepcopy(state.settings)
            invalid["models"].update({"hand_detection_enabled": False, "hand_segmentation_enabled": True})
            with self.assertRaises(config_module.SettingsError):
                state.settings_store.validate_update(invalid)

            class BoundaryPredictor:
                def predict(self, **_kwargs):
                    mask = np.zeros((1, 16, 16), dtype=bool); mask[0, 2:14, 2:14] = True
                    return mask, np.asarray([.9]), None

            state.settings["models"].update({"hand_detection_enabled": False, "hand_segmentation_enabled": False})
            with patch.object(state, "_sam_predictor_for", return_value=BoundaryPredictor()), \
                 patch.object(state, "_ensure_hand_model") as ensure:
                result = state.add_boundary_candidate(image_id, {"roi": {"left": 2, "top": 2, "right": 14, "bottom": 14}, "point": {"x": 8, "y": 8}})
            self.assertEqual([candidate["source"] for candidate in result["candidates"]], ["boundary"])
            ensure.assert_not_called()

        with tempfile.TemporaryDirectory() as directory:
            state, image_id = self.state_with_image(Path(directory))
            state.settings["models"].update({"hand_detection_enabled": True, "hand_segmentation_enabled": True, "provider": "cpu"})
            specialist_mask = np.zeros((1, 16, 16), dtype=bool); specialist_mask[0, 4:8, 2:10] = True
            specialist = Mock(); specialist.predict.return_value = specialist_mask, np.asarray([.9]), None
            with patch.object(state, "_sam_predictor_for", return_value=BoundaryPredictor()), \
                 patch.object(state, "_boundary_hand_boxes", return_value=[(4, 4, 8, 8)]), \
                 patch.object(state, "_hand_segmentation_predictor_for", return_value=specialist):
                result = state.add_boundary_candidate(image_id, {"roi": {"left": 2, "top": 2, "right": 14, "bottom": 14}, "point": {"x": 8, "y": 8}})
            self.assertEqual([candidate["source"] for candidate in result["candidates"]], ["boundary", "hand_exclusion"])
            specialist.predict.assert_called_once()

    def test_target_selection_and_precision_keep_only_valid_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            state, image_id = self.state_with_image(Path(directory))
            record = state.image_for_id(image_id)
            state.settings["detection"]["fluid_exclusion_enabled"] = False
            masks = {}
            for index, name in enumerate(("penis", "pussy", "testicles", "female_face")):
                mask = np.zeros((16, 16), dtype=np.uint8); mask[index:index + 4, index:index + 4] = 255
                masks[name] = mask
            target = Mock()
            target.detect.return_value = [
                {"class_name": name, "confidence": .8, "mask": mask, "source": "target"}
                for name, mask in masks.items()
            ]
            models = DetectionModels(target=target)
            for selected, expected in (({"penis"}, {"penis", "testicles"}), ({"pussy"}, {"pussy"}), ({"penis", "pussy"}, {"penis", "pussy", "testicles"})):
                with self.subTest(selected=selected):
                    candidates = state._detect_image(models, record, .5, target_classes=selected)
                    self.assertEqual({candidate.label_token for candidate in candidates}, expected)
                    self.assertNotIn("female_face", {candidate.label_token for candidate in candidates})
                    state._discard_candidates(candidates)

            apply = masks["penis"]
            target.detect.return_value = [{"class_name": "penis", "confidence": .8, "mask": apply, "source": "target"}]
            with patch.object(state, "_sam_predictor_for") as predictor:
                standard = state._detect_image(models, record, .5, mode="standard")
            predictor.assert_not_called()
            self.assertEqual([(candidate.source, candidate.refinement) for candidate in standard], [("target", None)])
            state._discard_candidates(standard)

            def mark_refined(_rgb, segments, _predictor):
                segments[0]["refinement"] = "sam_high_precision"
                return segments

            with patch.object(state, "_sam_predictor_for", return_value=Mock()) as predictor, \
                 patch.object(state, "_high_precision_segments_with_predictor", side_effect=mark_refined):
                high_precision = state._detect_image(models, record, .5, mode="high_precision")
            predictor.assert_called_once()
            self.assertEqual([(candidate.source, candidate.refinement) for candidate in high_precision], [("target", "sam_high_precision")])
            state._discard_candidates(high_precision)

    def test_model_toggle_changes_discard_only_the_affected_cache(self):
        for switch in ("ntd11_enabled", "sensitive_enabled", "hand_detection_enabled", "hand_segmentation_enabled"):
            with self.subTest(switch=switch):
                state = self.new_state()
                state.settings["models"]["provider"] = "cpu"
                state.models = object(); state.hand_model = object(); state.sam_predictor = object(); state.hand_segmentation_predictor = object()
                if switch == "hand_segmentation_enabled":
                    state.settings["models"]["hand_detection_enabled"] = True
                previous = copy.deepcopy(state.settings)
                update = copy.deepcopy(previous)
                update["models"][switch] = not update["models"][switch]
                with patch.object(state, "_require_supported_gpu"), patch.object(state.settings_store, "save", return_value=update):
                    state.update_settings(update)
                if switch == "hand_segmentation_enabled":
                    self.assertIsNotNone(state.models)
                    self.assertIsNotNone(state.hand_model)
                    self.assertIsNone(state.hand_segmentation_predictor)
                else:
                    self.assertIsNone(state.models)
                    self.assertIsNone(state.hand_model)
                self.assertIsNotNone(state.sam_predictor)

    def test_fluid_toggle_preserves_existing_candidates_until_successful_redetection_then_replaces_them_durably(self):
        with tempfile.TemporaryDirectory() as directory:
            state, image_id = self.state_with_image(Path(directory))
            record = state.image_for_id(image_id)
            old_fluid_path = state.cache_dir / image_id / "old-fluid.png"
            old_hand_path = state.cache_dir / image_id / "old-hand.png"
            self.write_mask(old_fluid_path); self.write_mask(old_hand_path)
            old_fluid = Candidate("old-fluid", "fluid", None, old_fluid_path, source="fluid_exclusion", role=CandidateRole.EXCLUDE)
            old_hand = Candidate("old-hand", "hand", None, old_hand_path, source="hand_exclusion", role=CandidateRole.EXCLUDE)
            state.candidates[image_id] = [old_fluid, old_hand]
            with state.image_io_lock(image_id), state.lock:
                state._commit_candidate_snapshot(image_id, state.candidates[image_id], replace=True)

            update = copy.deepcopy(state.settings)
            update["detection"]["fluid_exclusion_enabled"] = False
            with patch.object(state, "_require_supported_gpu"), patch.object(state.settings_store, "save", return_value=update):
                state.update_settings(update)
            self.assertEqual([candidate.candidate_id for candidate in state.candidates[image_id]], ["old-fluid", "old-hand"])

            new_path = state.cache_dir / image_id / ".mozarie-pending-new-apply.tmp"
            self.write_mask(new_path)
            replacement = Candidate("new-apply", "penis", .8, new_path, source="target")
            with patch.object(state, "_ensure_models", return_value=DetectionModels(target=Mock())), \
                 patch.object(state, "_detect_image", return_value=[replacement]):
                state._detect_worker([record], .5, 1)

            self.assertEqual([candidate.candidate_id for candidate in state.candidates[image_id]], ["new-apply"])
            self.assertFalse(old_fluid_path.exists())
            self.assertFalse(old_hand_path.exists())
            self.assertEqual(state.workspace_store.valid_candidate_ids(image_id), {"new-apply"})
            self.assertIsNone(state.workspace_store.candidate_png(image_id, "old-fluid"))
            self.assertIsNone(state.workspace_store.candidate_png(image_id, "old-hand"))
            self.assertTrue((state.cache_dir / image_id / "new-apply.png").is_file())


if __name__ == "__main__":
    unittest.main()
