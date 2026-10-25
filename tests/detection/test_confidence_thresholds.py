"""Selected confidence reaches actual ONNX decoders without relaxation."""

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from mozarie.core import confidence_for_source
from mozarie.detection import DetectionMixin
from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter
from mozarie.inference.yolo_segment import TargetSegmenter


class ConfidenceThresholdTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.rgb = np.zeros((64, 64, 3), dtype=np.uint8)

    def model(self, target=False, scores=(.94, .95, 1.0)):
        classes = 7 if target else 2
        rows = np.zeros((1, 4 + classes + 32, 3), dtype=np.float32)
        for index, score in enumerate(scores):
            rows[0, :4, index] = (10 + index * 22, 32, 12, 20)
            rows[0, 4 + (2 if target else 0), index] = score
            rows[0, 4 + classes, index] = 10
        proto = np.ones((1, 32, 4, 4), dtype=np.float32)
        graph = helper.make_graph([
            helper.make_node("Constant", [], ["prediction"], value=numpy_helper.from_array(rows)),
            helper.make_node("Constant", [], ["prototype"], value=numpy_helper.from_array(proto)),
        ], "confidence", [helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, 64, 64])], [
            helper.make_tensor_value_info("prediction", TensorProto.FLOAT, list(rows.shape)),
            helper.make_tensor_value_info("prototype", TensorProto.FLOAT, list(proto.shape)),
        ])
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
        model.ir_version = 8
        metadata = model.metadata_props.add(); metadata.key = "names"; metadata.value = "{0: 'penis', 1: 'vagina'}"
        path = self.root / ("target.onnx" if target else "auxiliary.onnx")
        onnx.save(model, path)
        cls = TargetSegmenter if target else GenericYoloSegmenter
        return cls(path, device="cpu", input_size=64)

    def test_sources_never_lower_the_selected_confidence(self):
        for source in ("target", "ntd11", "sensitive"):
            for threshold in (.10, .50, .95, 1.0):
                with self.subTest(source=source, threshold=threshold):
                    expected = max(.5, threshold) if source == "sensitive" else threshold
                    self.assertEqual(confidence_for_source(source, threshold), expected)

    def test_target_and_auxiliary_decoders_keep_boundary_and_reject_lower_scores(self):
        for target in (True, False):
            model = self.model(target)
            for threshold, expected in ((.95, [.95, 1.0]), (1.0, [1.0])):
                with self.subTest(target=target, threshold=threshold):
                    arguments = () if target else ("ntd11",)
                    segments = model.detect(self.rgb, threshold, *arguments)
                    np.testing.assert_allclose(sorted(segment["confidence"] for segment in segments), expected)
                    self.assertTrue(all(np.any(segment["mask"]) for segment in segments))

    def test_tiled_auxiliary_detection_honors_the_maximum_selected_threshold(self):
        target = self.model(True, (0, 0, 0))
        auxiliary = self.model(False, (.84, .95, .99))
        models = SimpleNamespace(target=target, auxiliaries=[("ntd11", auxiliary)])
        segments = DetectionMixin._detect_arbitrated_segments(None, models, self.rgb, 1.0, {"penis"})
        self.assertEqual(segments, [], "no tile may publish a candidate below the selected maximum")
