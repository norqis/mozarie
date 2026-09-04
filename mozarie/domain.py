"""Small, serialisable domain types for Mozarie."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


CANDIDATE_LABEL_TOKENS = frozenset({"penis", "pussy", "testicles", "boundary", "boundary_polygon", "hand", "fluid"})
CANDIDATE_SOURCE_TOKENS = frozenset({"auto", "target", "ntd11", "sensitive", "boundary", "hand_exclusion", "fluid_exclusion"})
CANDIDATE_REFINEMENT_TOKENS = frozenset({"sam_high_precision"})


class CandidateRole(StrEnum):
    """How a candidate contributes to the final mosaic mask."""

    APPLY = "apply"
    EXCLUDE = "exclude"


@dataclass
class Candidate:
    """A cached mask proposed by automatic, boundary or manual editing."""

    candidate_id: str
    label_token: str
    confidence: float | None
    mask_path: Path
    enabled: bool = True
    color: str = "#5bb6d5"
    source: str = "auto"
    origin: str = "auto"
    refinement: str | None = None
    role: CandidateRole = CandidateRole.APPLY
    forced: bool = True
    expand_px: int = 0

    def __post_init__(self) -> None:
        if self.label_token not in CANDIDATE_LABEL_TOKENS:
            raise ValueError("candidate label token is invalid")
        if self.source not in CANDIDATE_SOURCE_TOKENS:
            raise ValueError("candidate source token is invalid")
        if self.refinement is not None and self.refinement not in CANDIDATE_REFINEMENT_TOKENS:
            raise ValueError("candidate refinement token is invalid")
        if isinstance(self.expand_px, bool) or not isinstance(self.expand_px, int) or self.expand_px < 0:
            raise ValueError("candidate expand pixels are invalid")

    def as_api_dict(self) -> dict[str, object]:
        return {
            "id": self.candidate_id,
            "labelToken": self.label_token,
            "confidence": self.confidence,
            "enabled": self.enabled,
            "color": self.color,
            "source": self.source,
            "origin": self.origin,
            "refinement": self.refinement,
            "role": self.role.value,
            "forced": self.forced if self.role == CandidateRole.EXCLUDE else False,
            "expandPx": self.expand_px,
        }
