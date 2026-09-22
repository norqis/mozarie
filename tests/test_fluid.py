import ast
import importlib
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mozarie.fluid import expand_white_fluid_mask, white_fluid_mask  # noqa: E402
from mozarie.masks import compose_masks  # noqa: E402


class FluidTests(unittest.TestCase):
    def test_white_fluid_mask_accepts_a_small_strong_white_penis_component(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[8:12, 8:12] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_rejects_an_under_minimum_strict_anchor(self):
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        rgb[6:18, 6:18] = (210, 205, 200)
        rgb[12, 12:14] = 255

        fluid = white_fluid_mask(rgb, penis)

        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_expands_an_accepted_white_core_into_a_translucent_deposit(self):
        rgb = np.zeros((40, 40, 3), dtype=np.uint8)
        penis = np.zeros((40, 40), dtype=np.uint8)
        penis[5:35, 5:35] = 255
        rgb[12:24, 12:24] = (210, 205, 200)
        rgb[16:20, 16:20] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 12 * 12)
        self.assertEqual(np.count_nonzero(fluid[12:24, 12:24]) - np.count_nonzero(fluid[16:20, 16:20]), 12 * 12 - 16)

    def test_white_fluid_mask_does_not_apply_a_fixed_component_count_cap(self):
        rgb = np.zeros((100, 100, 3), dtype=np.uint8)
        penis = np.zeros((100, 100), dtype=np.uint8)
        penis[10:90, 10:90] = 255
        for top, left in ((20, 15), (20, 30), (20, 45), (20, 60), (20, 75)):
            rgb[top:top + 8, left:left + 10] = (210, 205, 200)
            rgb[top + 2:top + 6, left + 3:left + 7] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 5 * 8 * 10)

    def test_white_fluid_mask_applies_its_semantic_area_budget(self):
        rgb = np.zeros((100, 100, 3), dtype=np.uint8)
        penis = np.zeros((100, 100), dtype=np.uint8)
        penis[10:90, 10:90] = 255
        for top in (15, 50):
            rgb[top:top + 20, 20:52] = 255
        rgb[40:44, 70:74] = 255

        fluid = white_fluid_mask(rgb, penis)

        self.assertEqual(np.count_nonzero(fluid), 656)
        self.assertLessEqual(np.count_nonzero(fluid), int(np.count_nonzero(penis) * 0.20))
        self.assertTrue(np.all(fluid[15:35, 20:52] == 255))
        self.assertFalse(np.any(fluid[50:70, 20:52]))
        self.assertTrue(np.all(fluid[40:44, 70:74] == 255))

    def test_white_fluid_mask_does_not_expand_when_a_separate_strict_component_uses_the_remaining_cap(self):
        rgb = np.zeros((100, 100, 3), dtype=np.uint8)
        penis = np.zeros((100, 100), dtype=np.uint8)
        penis[10:90, 10:90] = 255
        rgb[15:35, 15:55] = 255  # 800 strict pixels in a separate component.
        rgb[50:75, 55:80] = (210, 205, 200)
        rgb[60:64, 65:69] = 255  # The accepted anchor would otherwise expand by 609 pixels.

        fluid = white_fluid_mask(rgb, penis)

        self.assertEqual(np.count_nonzero(fluid), 816)
        pale_deposit = fluid[50:75, 55:80].copy()
        pale_deposit[10:14, 10:14] = 0
        self.assertFalse(np.any(pale_deposit))

    def test_white_fluid_mask_accepts_small_lines_and_drops(self):
        rgb = np.zeros((32, 32, 3), dtype=np.uint8)
        penis = np.zeros((32, 32), dtype=np.uint8)
        penis[3:29, 3:29] = 255
        rgb[8, 8:14] = 255
        rgb[18:20, 18:20] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(np.count_nonzero(fluid), 10)

    def test_white_fluid_mask_is_subset_of_final_mask_and_ignores_outside_highlights(self):
        rgb = np.zeros((48, 48, 3), dtype=np.uint8)
        penis = np.zeros((48, 48), dtype=np.uint8)
        penis[18:30, 20:32] = 255
        rgb[21:25, 23:27] = 255
        rgb[2:16, 2:16] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertTrue(np.all(fluid[penis == 0] == 0))
        self.assertEqual(np.count_nonzero(fluid), 16)
        enabled = compose_masks(penis.shape, [penis], [fluid])
        disabled = compose_masks(penis.shape, [penis], [])
        self.assertFalse(np.any(enabled[fluid > 0]))
        self.assertTrue(np.array_equal(disabled, penis))

    def test_white_fluid_mask_processes_only_the_final_mask_bounding_crop(self):
        rgb = np.zeros((64, 64, 3), dtype=np.uint8)
        penis = np.zeros((64, 64), dtype=np.uint8)
        penis[20:32, 24:40] = 255
        rgb[23:27, 28:32] = 255
        real_cvt_color = cv2.cvtColor
        real_morphology = cv2.morphologyEx
        real_blur = cv2.blur
        real_components = cv2.connectedComponentsWithStats
        real_subtract = cv2.subtract
        shapes = []

        def record_crop(image, *args, **kwargs):
            shapes.append(image.shape[:2])
            return real_cvt_color(image, *args, **kwargs)

        def record_morphology(image, operation, kernel, *args, **kwargs):
            shapes.append(image.shape[:2])
            return real_morphology(image, operation, kernel, *args, **kwargs)

        def record_blur(image, *args, **kwargs):
            shapes.append(image.shape[:2])
            return real_blur(image, *args, **kwargs)

        def record_components(image, *args, **kwargs):
            shapes.append(image.shape[:2])
            return real_components(image, *args, **kwargs)

        def record_subtract(first, second, *args, **kwargs):
            shapes.extend((first.shape[:2], second.shape[:2]))
            return real_subtract(first, second, *args, **kwargs)

        with patch.object(cv2, "cvtColor", side_effect=record_crop), \
             patch.object(cv2, "morphologyEx", side_effect=record_morphology), \
             patch.object(cv2, "blur", side_effect=record_blur), \
             patch.object(cv2, "connectedComponentsWithStats", side_effect=record_components), \
             patch.object(cv2, "subtract", side_effect=record_subtract):
            fluid = white_fluid_mask(rgb, penis)
        self.assertTrue(shapes)
        self.assertTrue(all(height <= 12 and width <= 16 for height, width in shapes))
        self.assertTrue(all(shape != penis.shape for shape in shapes))
        self.assertEqual(fluid.shape, penis.shape)
        self.assertEqual(fluid.dtype, np.uint8)
        self.assertFalse(np.any(fluid[penis == 0]))
        self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_uses_only_small_final_crops_at_large_resolutions(self):
        real_cvt_color = cv2.cvtColor
        real_morphology = cv2.morphologyEx
        real_blur = cv2.blur
        real_components = cv2.connectedComponentsWithStats
        real_subtract = cv2.subtract
        for height, width in ((832, 1216), (1440, 2560), (2160, 3840)):
            rgb = np.zeros((height, width, 3), dtype=np.uint8)
            penis = np.zeros((height, width), dtype=np.uint8)
            top, left = height // 2, width // 2
            penis[top:top + 24, left:left + 32] = 255
            rgb[top + 8:top + 12, left + 12:left + 16] = 255
            shapes = []

            def record_crop(image, *args, **kwargs):
                shapes.append(image.shape[:2])
                return real_cvt_color(image, *args, **kwargs)

            def record_morphology(image, operation, kernel, *args, **kwargs):
                shapes.append(image.shape[:2])
                return real_morphology(image, operation, kernel, *args, **kwargs)

            def record_blur(image, *args, **kwargs):
                shapes.append(image.shape[:2])
                return real_blur(image, *args, **kwargs)

            def record_components(image, *args, **kwargs):
                shapes.append(image.shape[:2])
                return real_components(image, *args, **kwargs)

            def record_subtract(first, second, *args, **kwargs):
                shapes.extend((first.shape[:2], second.shape[:2]))
                return real_subtract(first, second, *args, **kwargs)

            with patch.object(cv2, "cvtColor", side_effect=record_crop), \
                 patch.object(cv2, "morphologyEx", side_effect=record_morphology), \
                 patch.object(cv2, "blur", side_effect=record_blur), \
                 patch.object(cv2, "connectedComponentsWithStats", side_effect=record_components), \
                 patch.object(cv2, "subtract", side_effect=record_subtract):
                fluid = white_fluid_mask(rgb, penis)
            self.assertTrue(shapes)
            self.assertTrue(all(crop_height <= 24 and crop_width <= 32 for crop_height, crop_width in shapes))
            self.assertTrue(all(shape != penis.shape for shape in shapes))
            self.assertEqual(fluid.shape, penis.shape)
            self.assertEqual(fluid.dtype, np.uint8)
            self.assertFalse(np.any(fluid[penis == 0]))
            self.assertEqual(np.count_nonzero(fluid), 16)

    def test_white_fluid_mask_rejects_large_high_saturation_and_noise_components(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[3:13, 3:13] = 255
        rgb[15:19, 3:7] = (255, 40, 40)
        rgb[20, 20] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_rejects_pale_skin_connected_to_white_seeds(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[6:11, 6:14] = (245, 230, 215)
        rgb[(6, 6, 10, 10), (6, 10, 6, 10)] = 255
        fluid = white_fluid_mask(rgb, penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_rejects_an_isolated_translucent_highlight(self):
        rgb = np.zeros((24, 24, 3), dtype=np.uint8)
        penis = np.zeros((24, 24), dtype=np.uint8)
        penis[2:22, 2:22] = 255
        rgb[8:12, 8:12] = (210, 205, 200)
        fluid = white_fluid_mask(rgb, penis)
        self.assertFalse(np.any(fluid))

    def test_white_fluid_mask_keeps_all_eligible_components_without_label_scans(self):
        class TrackingLabels(np.ndarray):
            equality_scans = 0

            def __eq__(self, other):
                type(self).equality_scans += 1
                return super().__eq__(other)

        rgb = np.zeros((64, 64, 3), dtype=np.uint8)
        penis = np.full((64, 64), 255, dtype=np.uint8)
        labels = np.zeros((64, 64), dtype=np.int32)
        components = []
        for label, (top, left) in enumerate(((row, column) for row in range(2, 52, 10) for column in range(2, 52, 10)), 1):
            labels[top:top + 4, left:left + 4] = label
            rgb[top:top + 4, left:left + 4] = 255
            components.append((top, left))
        tracked_labels = labels.view(TrackingLabels)
        stats = np.zeros((len(components) + 1, 5), dtype=np.int32)
        with patch.object(
            cv2,
            "connectedComponentsWithStats",
            return_value=(len(components) + 1, tracked_labels, stats, np.zeros((len(components) + 1, 2))),
        ):
            fluid = white_fluid_mask(rgb, penis)
        self.assertEqual(TrackingLabels.equality_scans, 0)
        self.assertEqual(np.count_nonzero(fluid), len(components) * 16)
        for top, left in components:
            self.assertTrue(np.all(fluid[top:top + 4, left:left + 4] == 255))

    def test_expand_white_fluid_mask_uses_default_tolerance_and_four_connected_growth(self):
        rgb = np.zeros((9, 9, 3), dtype=np.uint8)
        allowed = np.zeros((9, 9), dtype=np.uint8)
        seed = np.zeros_like(allowed)
        allowed[4, 3:5] = 255
        allowed[5, 5] = 255  # diagonal only: must not join the seed.
        seed[4, 3] = 255
        rgb[allowed > 0] = (220, 220, 220)
        expanded = expand_white_fluid_mask(rgb, seed, allowed, 26)
        self.assertEqual(np.argwhere(expanded > 0).tolist(), [[4, 3], [4, 4]])
        self.assertFalse(np.any(expanded[allowed == 0]))

    def test_expand_white_fluid_mask_respects_alpha_and_tolerance_boundaries(self):
        rgb = np.zeros((5, 7, 3), dtype=np.uint8)
        allowed = np.ones((5, 7), dtype=np.uint8) * 255
        seed = np.zeros_like(allowed)
        alpha = np.ones_like(allowed) * 255
        seed[2, 1] = 255
        rgb[:, :] = (200, 200, 200)
        rgb[2, 1] = (226, 226, 226)
        alpha[:, 3] = 0
        grown = expand_white_fluid_mask(rgb, seed, allowed, 26, alpha=alpha)
        self.assertTrue(np.all(grown[:, :3] == 255))
        self.assertFalse(np.any(grown[:, 3:]))
        zero_tolerance = expand_white_fluid_mask(rgb, seed, allowed, 0, alpha=alpha)
        self.assertEqual(np.argwhere(zero_tolerance > 0).tolist(), [[2, 1]])

    def test_legacy_rgb_fluid_expansion_matches_fully_opaque_alpha(self):
        rgb = np.full((9, 9, 3), 210, dtype=np.uint8)
        rgb[4, 4] = (226, 226, 226)
        allowed = np.ones((9, 9), dtype=np.uint8) * 255
        seed = np.zeros_like(allowed); seed[4, 4] = 255
        legacy = expand_white_fluid_mask(rgb, seed, allowed, 26)
        opaque = expand_white_fluid_mask(rgb, seed, allowed, 26, alpha=np.ones_like(allowed) * 255)
        self.assertTrue(np.array_equal(legacy, opaque))
        self.assertEqual(np.count_nonzero(legacy), 81)

    def test_expand_white_fluid_mask_has_no_component_count_limit(self):
        rgb = np.zeros((20, 40, 3), dtype=np.uint8)
        allowed = np.zeros((20, 40), dtype=np.uint8)
        seed = np.zeros_like(allowed)
        for left in range(1, 40, 4):
            allowed[5:9, left:left + 2] = 255
            seed[6, left] = 255
            rgb[5:9, left:left + 2] = (240, 240, 240)
        expanded = expand_white_fluid_mask(rgb, seed, allowed, 26)
        self.assertEqual(np.count_nonzero(expanded), np.count_nonzero(allowed))

    def test_fluid_module_has_leaf_dependencies_and_one_public_symbol(self):
        root = Path(__file__).resolve().parents[1] / "mozarie"
        imports = ast.parse((root / "fluid.py").read_text(encoding="utf-8"))
        imported_modules = {
            alias.name.split(".")[0]
            for node in ast.walk(imports)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertEqual(imported_modules, {"cv2", "math", "numpy"})
        self.assertEqual(__import__("mozarie.fluid", fromlist=["__all__"]).__all__, ["expand_white_fluid_mask", "white_fluid_mask"])
        detection_imports = ast.parse((root / "detection.py").read_text(encoding="utf-8"))
        self.assertTrue(any(
            isinstance(node, ast.ImportFrom)
            and node.module == "fluid"
            and any(alias.name == "white_fluid_mask" for alias in node.names)
            for node in ast.walk(detection_imports)
        ))
        self.assertNotIn("white_fluid_mask", (root / "core.py").read_text(encoding="utf-8"))

    def test_fluid_runtime_import_order_isolated_from_the_test_suite(self):
        module_names = ("mozarie.fluid", "mozarie.detection", "mozarie.core")
        missing = object()
        original_modules = {name: sys.modules.get(name, missing) for name in module_names}
        package = importlib.import_module("mozarie")
        original_attributes = {
            name.rsplit(".", 1)[1]: getattr(package, name.rsplit(".", 1)[1], missing)
            for name in module_names
        }
        try:
            for order in (module_names, tuple(reversed(module_names))):
                for name in module_names:
                    sys.modules.pop(name, None)
                loaded = {name: importlib.import_module(name) for name in order}
                self.assertIs(loaded["mozarie.detection"].white_fluid_mask, loaded["mozarie.fluid"].white_fluid_mask)
                self.assertIs(loaded["mozarie.detection"].Candidate, loaded["mozarie.core"].Candidate)
                self.assertFalse(hasattr(loaded["mozarie.core"], "white_fluid_mask"))
        finally:
            for name in module_names:
                sys.modules.pop(name, None)
            for name, module in original_modules.items():
                if module is not missing:
                    sys.modules[name] = module
            for attribute, value in original_attributes.items():
                if value is missing:
                    if hasattr(package, attribute):
                        delattr(package, attribute)
                else:
                    setattr(package, attribute, value)


if __name__ == "__main__":
    unittest.main()
