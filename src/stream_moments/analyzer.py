from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

from .models import ChatMessage, Moment

STOP_WORDS = {"the", "and", "that", "this", "with", "what", "for", "you", "are", "was", "but", "have", "just", "lol", "lmao"}


def _keywords(messages: list[ChatMessage], limit: int = 5) -> list[str]:
    words = []
    for message in messages:
        words.extend(word.lower() for word in re.findall(r"[A-Za-z][A-Za-z0-9_']{2,}", message.text) if word.lower() not in STOP_WORDS)
    return [word for word, _ in Counter(words).most_common(limit)]


def find_moments(messages: list[ChatMessage], window_seconds: int = 15, z_threshold: float = 2.0, min_messages: int = 5, max_moments: int = 25) -> list[Moment]:
    if window_seconds <= 0:
        raise ValueError("window_seconds must be positive")
    if not messages:
        return []
    buckets: dict[int, list[ChatMessage]] = defaultdict(list)
    for message in messages:
        buckets[int(message.timestamp // window_seconds)].append(message)
    last_bucket = max(buckets)
    counts = [len(buckets[index]) for index in range(last_bucket + 1)]
    mean = sum(counts) / len(counts)
    variance = sum((count - mean) ** 2 for count in counts) / len(counts)
    deviation = math.sqrt(variance)
    candidates: list[Moment] = []
    for index, count in enumerate(counts):
        z_score = (count - mean) / deviation if deviation else (float("inf") if count > mean else 0.0)
        if count < min_messages or z_score < z_threshold:
            continue
        bucket_messages = buckets[index]
        candidates.append(Moment(
            timestamp=index * window_seconds + window_seconds / 2,
            window_start=index * window_seconds,
            window_end=(index + 1) * window_seconds,
            message_count=count,
            baseline_count=round(mean, 2),
            z_score=round(z_score, 2),
            sample_messages=[message.text for message in bucket_messages[:5]],
            keywords=_keywords(bucket_messages),
        ))
    return sorted(candidates, key=lambda moment: (moment.z_score, moment.message_count), reverse=True)[:max_moments]

