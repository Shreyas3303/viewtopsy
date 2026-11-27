"""Chat spike detection.

Mirrors frontend/analysis.js so the CLI and the web app find the same moments.
"""
from __future__ import annotations

import math
import re
from collections import Counter

from .models import ChatMessage, Moment

STOP_WORDS = {
    "the", "and", "that", "this", "with", "what", "for", "you", "are", "was",
    "but", "have", "just", "not", "its", "it's", "can", "his", "her", "how",
    "all", "they", "she", "him", "get", "got", "one", "now", "who", "why",
    "from", "did", "see", "way", "here", "out", "too", "our", "has",
}
WORD_PATTERN = re.compile(r"[a-z][a-z0-9_']{2,}")

SENSITIVITY = {"low": 3.0, "medium": 2.0, "high": 1.2}


def _words(text: str) -> list[str]:
    return WORD_PATTERN.findall(text.lower())


def _keywords(messages: list[ChatMessage], limit: int = 5) -> list[str]:
    counts: Counter[str] = Counter()
    for message in messages:
        # Count each word once per message so one spammer can't dominate.
        counts.update({word for word in _words(message.text) if word not in STOP_WORDS})
    # A keyword has to come from at least two messages to say anything about the crowd.
    ranked = sorted(((w, c) for w, c in counts.items() if c >= 2), key=lambda item: (-item[1], item[0]))
    return [word for word, _ in ranked[:limit]]


def _samples(messages: list[ChatMessage], keywords: list[str], limit: int = 6) -> list[str]:
    """Varied samples, preferring messages that use the moment's keywords."""
    wanted = set(keywords)
    seen: set[str] = set()
    unique: list[tuple[int, int, str]] = []
    for order, message in enumerate(messages):
        key = message.text.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        on_topic = any(word in wanted for word in _words(message.text))
        unique.append((0 if on_topic else 1, order, message.text))
    return [text for _, _, text in sorted(unique)[:limit]]


def build_timeline(messages: list[ChatMessage], window_seconds: float) -> list[int]:
    """Message count per window, from 0 up to the window holding the last message."""
    if not messages:
        return []
    last = int(max(message.timestamp for message in messages) // window_seconds)
    counts = [0] * (last + 1)
    for message in messages:
        counts[int(message.timestamp // window_seconds)] += 1
    return counts


def find_moments(
    messages: list[ChatMessage],
    window_seconds: float = 15,
    z_threshold: float = SENSITIVITY["medium"],
    min_messages: int = 5,
    max_moments: int = 25,
) -> list[Moment]:
    """Return the strongest chat spikes, biggest first.

    Each window is scored against the whole stream's average. Neighbouring
    windows that all pass the threshold are merged into one moment.
    """
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")
    if min_messages < 1:
        raise ValueError("min_messages must be at least 1")
    if z_threshold < 0:
        raise ValueError("z_threshold can't be negative")
    if not messages:
        return []

    messages = sorted(messages, key=lambda message: message.timestamp)
    counts = build_timeline(messages, window_seconds)
    mean = sum(counts) / len(counts)
    deviation = math.sqrt(sum((count - mean) ** 2 for count in counts) / len(counts))
    z_scores = [(count - mean) / deviation if deviation else 0.0 for count in counts]
    hot = [count >= min_messages and z >= z_threshold for count, z in zip(counts, z_scores)]

    groups: list[list[int]] = []
    for index, is_hot in enumerate(hot):
        if not is_hot:
            continue
        if groups and groups[-1][1] == index - 1:
            groups[-1][1] = index
        else:
            groups.append([index, index])

    moments: list[Moment] = []
    for start, end in groups:
        window_start = start * window_seconds
        window_end = (end + 1) * window_seconds
        inside = [message for message in messages if window_start <= message.timestamp < window_end]
        peak = max(range(start, end + 1), key=lambda i: (counts[i], -i))
        keywords = _keywords(inside)
        moments.append(Moment(
            # Start a window before the peak so playback catches the build-up.
            timestamp=max(0.0, peak * window_seconds - window_seconds),
            window_start=window_start,
            window_end=window_end,
            message_count=len(inside),
            baseline_count=round(mean, 2),
            z_score=round(z_scores[peak], 2),
            sample_messages=_samples(inside, keywords),
            keywords=keywords,
            peak_time=peak * window_seconds,
            peak_count=counts[peak],
            intensity=round(counts[peak] / mean, 1) if mean else 0.0,
            unique_chatters=len({message.author for message in inside if message.author}),
        ))

    return sorted(moments, key=lambda moment: (moment.z_score, moment.message_count), reverse=True)[:max_moments]
