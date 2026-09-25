from __future__ import annotations

import csv
import json
import re
from collections.abc import Iterable
from pathlib import Path

from .models import ChatMessage


def parse_timestamp(value: object) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text.startswith("PT"):
        hours = re.search(r"(\d+)H", text)
        minutes = re.search(r"(\d+)M", text)
        seconds = re.search(r"([\d.]+)S", text)
        return (int(hours.group(1)) * 3600 if hours else 0) + (int(minutes.group(1)) * 60 if minutes else 0) + (float(seconds.group(1)) if seconds else 0)
    parts = text.split(":")
    if len(parts) in (2, 3):
        values = [float(part) for part in parts]
        return values[-1] + values[-2] * 60 + (values[-3] * 3600 if len(values) == 3 else 0)
    return float(text)


def _message_from_row(row: dict) -> ChatMessage:
    timestamp = row.get("timestamp", row.get("time", row.get("offset")))
    text = row.get("message", row.get("text", row.get("content", "")))
    author = row.get("author", row.get("user", row.get("username", "")))
    if timestamp is None or not str(text).strip():
        raise ValueError("Every chat row needs timestamp/time and message/text/content.")
    return ChatMessage(parse_timestamp(timestamp), str(text), str(author))


def load_chat(path: Path) -> list[ChatMessage]:
    """Load generic JSON/CSV exports plus the common TwitchDownloader JSON shape."""
    if not path.is_file():
        raise FileNotFoundError(f"Chat file not found: {path}")
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            messages = [_message_from_row(row) for row in csv.DictReader(handle)]
    elif path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows: Iterable[dict] = payload.get("comments", []) if isinstance(payload, dict) else payload
        messages = []
        for row in rows:
            if "content_offset_seconds" in row:  # TwitchDownloader JSON
                rows_data = {"timestamp": row["content_offset_seconds"], "message": row.get("message", {}).get("body", ""), "author": row.get("commenter", {}).get("display_name", "")}
                messages.append(_message_from_row(rows_data))
            else:
                messages.append(_message_from_row(row))
    else:
        raise ValueError("Chat input must be .json or .csv")
    return sorted(messages, key=lambda message: message.timestamp)

