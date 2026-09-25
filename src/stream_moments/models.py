from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class ChatMessage:
    timestamp: float
    text: str
    author: str = ""


@dataclass(frozen=True)
class Moment:
    timestamp: float
    window_start: float
    window_end: float
    message_count: int
    baseline_count: float
    z_score: float
    sample_messages: list[str]
    keywords: list[str]
    frame_path: str | None = None
    visual_description: str | None = None
    visual_labels: list[dict[str, float | str]] | None = None
    reaction_type: str | None = None
    alignment_score: float | None = None
    causal_explanation: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)
