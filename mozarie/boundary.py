"""Validation and clipping primitives for four-point boundary selection."""

from __future__ import annotations

import math
from collections.abc import Sequence

import cv2
import numpy as np

from .masks import mask_bounds


Point = tuple[float, float]


def _orientation(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    ab_c = _orientation(a, b, c)
    ab_d = _orientation(a, b, d)
    cd_a = _orientation(c, d, a)
    cd_b = _orientation(c, d, b)
    return (ab_c > 0) != (ab_d > 0) and (cd_a > 0) != (cd_b > 0)


def validate_polygon(points: Sequence[Point], width: int, height: int, minimum_area: float = 16.0) -> tuple[Point, Point, Point, Point]:
    """Validate a non-self-intersecting, in-bounds four-point polygon."""

    if len(points) != 4:
        raise ValueError("four points are required")
    normalised = tuple((float(x), float(y)) for x, y in points)
    if not all(math.isfinite(x) and math.isfinite(y) and 0 <= x <= width and 0 <= y <= height for x, y in normalised):
        raise ValueError("polygon points must be inside the image")
    if len({(round(x, 4), round(y, 4)) for x, y in normalised}) != 4:
        raise ValueError("polygon points must be distinct")
    if _segments_intersect(normalised[0], normalised[1], normalised[2], normalised[3]) or _segments_intersect(normalised[1], normalised[2], normalised[3], normalised[0]):
        raise ValueError("polygon edges must not intersect")
    contour = np.asarray(normalised, dtype=np.float32)
    if abs(float(cv2.contourArea(contour))) < minimum_area:
        raise ValueError("polygon is too small")
    return normalised  # type: ignore[return-value]


def polygon_mask(points: Sequence[Point], width: int, height: int) -> np.ndarray:
    valid = validate_polygon(points, width, height)
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(mask, [np.rint(np.asarray(valid)).astype(np.int32)], 255)
    return mask


def polygon_roi_and_point(points: Sequence[Point], width: int, height: int) -> tuple[tuple[int, int, int, int], Point, np.ndarray]:
    mask = polygon_mask(points, width, height)
    bounds = mask_bounds(mask != 0)
    assert bounds is not None
    distance = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    y, x = np.unravel_index(int(np.argmax(distance)), distance.shape)
    return bounds, (float(x), float(y)), mask
