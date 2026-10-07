"""Lightweight white-fluid exclusion detection."""

from __future__ import annotations

import math

import cv2
import numpy as np

from .masks import mask_bounds


__all__ = ["expand_white_fluid_mask", "white_fluid_mask"]


_MAX_COMPONENT_RATIO = 0.15
_MAX_TOTAL_RATIO = 0.20


def expand_white_fluid_mask(
    rgb: np.ndarray,
    seed_mask: np.ndarray,
    allowed_mask: np.ndarray,
    tolerance: int,
    *,
    alpha: np.ndarray | None = None,
) -> np.ndarray:
    """Grow accepted fluid seeds through their permitted colour-connected area.

    The white-fluid detector remains the authority for seed selection.  This
    optional post-process only expands each accepted seed through a 4-connected
    fixed-range RGB region, bounded by the target or metadata search region.
    """

    if isinstance(tolerance, bool) or not isinstance(tolerance, int) or not 0 <= tolerance <= 255:
        raise ValueError("tolerance must be an integer between 0 and 255")
    pixels = np.asarray(rgb)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("rgb must have shape (height, width, 3)")
    seeds = np.asarray(seed_mask) > 0
    allowed = np.asarray(allowed_mask) > 0
    if seeds.shape != pixels.shape[:2] or allowed.shape != pixels.shape[:2]:
        raise ValueError("fluid masks must match rgb dimensions")
    if alpha is not None:
        alpha_values = np.asarray(alpha)
        if alpha_values.shape != seeds.shape:
            raise ValueError("alpha must match rgb dimensions")
        allowed &= alpha_values > 0
    seeds &= allowed
    if not np.any(seeds) or tolerance == 0:
        return np.asarray(seeds, dtype=np.uint8) * 255

    # ``floodFill`` uses a mask two pixels larger than the source image.  A
    # non-zero entry blocks traversal, so pre-fill every pixel outside the
    # permitted region.  Clear only the marked result rectangle after each
    # component so one work mask can be reused without blocking later fills.
    source = np.ascontiguousarray(pixels)
    expanded = np.zeros_like(seeds, dtype=bool)
    flood_mask = np.pad(np.asarray(~allowed, dtype=np.uint8), 1, constant_values=1)
    component_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        np.asarray(seeds, dtype=np.uint8), connectivity=4,
    )
    flags = 4 | cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY | (2 << 8)
    difference = (tolerance, tolerance, tolerance)
    for label in range(1, component_count):
        left, top, width, height, _area = stats[label]
        local_labels = labels[top:top + height, left:left + width]
        coordinates = np.argwhere(local_labels == label)
        colors = source[top + coordinates[:, 0], left + coordinates[:, 1]].astype(np.int32)
        median = np.median(colors, axis=0)
        row, column = coordinates[np.argmin(np.sum((colors - median) ** 2, axis=1))]
        filled, _image, flood_mask, (fill_left, fill_top, fill_width, fill_height) = cv2.floodFill(
            source, flood_mask, (int(left + column), int(top + row)), 0, difference, difference, flags,
        )
        if not filled:
            continue
        mask_region = flood_mask[fill_top + 1:fill_top + fill_height + 1, fill_left + 1:fill_left + fill_width + 1]
        expanded_region = expanded[fill_top:fill_top + fill_height, fill_left:fill_left + fill_width]
        marked = mask_region == 2
        expanded_region |= marked
        mask_region[marked] = 0
    # Preserve every accepted seed even if its representative colour is an
    # outlier for the remainder of that component.
    return np.asarray(expanded | seeds, dtype=np.uint8) * 255


def white_fluid_mask(rgb: np.ndarray, penis_mask: np.ndarray) -> np.ndarray:
    """Find neutral-white fluid regions inside one final target segment."""
    penis = np.asarray(penis_mask > 0, dtype=np.uint8)
    penis_area = int(np.count_nonzero(penis))
    empty = np.zeros_like(penis, dtype=np.uint8)
    if penis_area == 0:
        return empty

    bounds = mask_bounds(penis != 0)
    assert bounds is not None
    left, top, right, bottom = bounds
    crop_penis = penis[top:bottom, left:right]
    pixels = np.asarray(rgb)[top:bottom, left:right]
    hsv = cv2.cvtColor(pixels, cv2.COLOR_RGB2HSV)
    saturation, value = hsv[:, :, 1], hsv[:, :, 2]
    channel_min = pixels.min(axis=2)
    channel_spread = pixels.max(axis=2) - channel_min
    candidate = (crop_penis > 0) & (saturation <= 80) & (value >= 180) & (channel_spread <= 24) & (channel_min >= 215)
    seed = candidate & (saturation <= 45) & (value >= 225) & (channel_spread <= 18) & (channel_min >= 230)
    closed = cv2.morphologyEx(candidate.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8)) > 0
    count, labels, _stats, _centroids = cv2.connectedComponentsWithStats(closed.astype(np.uint8), connectivity=8)
    minimum = max(4, math.ceil(penis_area * 0.001))
    maximum = math.floor(penis_area * _MAX_COMPONENT_RATIO)
    total_cap = math.floor(penis_area * _MAX_TOTAL_RATIO)
    flat_labels = np.asarray(labels).ravel()
    areas = np.bincount(flat_labels[candidate.ravel()], minlength=count)
    seed_counts = np.bincount(flat_labels[seed.ravel()], minlength=count)
    eligible = [
        label
        for label in range(1, count)
        if minimum <= areas[label] <= maximum and seed_counts[label] >= 2 and seed_counts[label] / areas[label] >= 0.10
    ]
    candidates = eligible
    selected_labels: list[int] = []
    selected_area = 0
    for label in candidates:
        area = int(areas[label])
        if selected_area + area > total_cap:
            continue
        selected_labels.append(label)
        selected_area += area

    strict_selected = np.isin(labels, selected_labels) & candidate & (crop_penis > 0)

    # Expand only from an already accepted strict-white deposit.  The looser
    # neutral gate admits translucent material, while the local brightness
    # checks keep an isolated pale highlight out.
    loose_candidate = (
        (crop_penis > 0)
        & (saturation <= 70)
        & (value >= 190)
        & (channel_spread <= 24)
        & (channel_min >= 185)
    )
    top_hat = np.maximum(
        cv2.morphologyEx(value, cv2.MORPH_TOPHAT, np.ones((7, 7), dtype=np.uint8)),
        cv2.morphologyEx(value, cv2.MORPH_TOPHAT, np.ones((15, 15), dtype=np.uint8)),
    )
    local_residual = cv2.subtract(value, cv2.blur(value, (9, 9)))
    bright_residual = np.maximum(top_hat, local_residual)
    loose_closed = cv2.morphologyEx(loose_candidate.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8)) > 0
    broad_count, broad_labels, _stats, _centroids = cv2.connectedComponentsWithStats(loose_closed.astype(np.uint8), connectivity=8)
    broad_flat_labels = np.asarray(broad_labels).ravel()
    loose_areas = np.bincount(broad_flat_labels[loose_candidate.ravel()], minlength=broad_count)
    anchor_counts = np.bincount(broad_flat_labels[(loose_candidate & strict_selected).ravel()], minlength=broad_count)
    new_pixels = loose_candidate & ~strict_selected
    new_areas = np.bincount(broad_flat_labels[new_pixels.ravel()], minlength=broad_count)
    contrast_counts = np.bincount(
        broad_flat_labels[(loose_candidate & (bright_residual >= 20)).ravel()], minlength=broad_count
    )
    residual_sums = np.bincount(
        broad_flat_labels[loose_candidate.ravel()], weights=bright_residual[loose_candidate].ravel(), minlength=broad_count
    )
    broad_eligible = [
        label
        for label in range(1, broad_count)
        if minimum <= loose_areas[label] <= total_cap
        and anchor_counts[label] >= 2
        and new_areas[label] > 0
        and contrast_counts[label] >= max(2, math.ceil(loose_areas[label] * 0.05))
        and residual_sums[label] / loose_areas[label] >= 10
    ]
    broad_candidates = broad_eligible
    broad_selected_labels: list[int] = []
    for label in broad_candidates:
        area = int(new_areas[label])
        if selected_area + area > total_cap:
            continue
        broad_selected_labels.append(label)
        selected_area += area

    selected = strict_selected | (np.isin(broad_labels, broad_selected_labels) & loose_candidate)
    empty[top:bottom, left:right] = np.asarray(selected, dtype=np.uint8) * 255
    return empty
