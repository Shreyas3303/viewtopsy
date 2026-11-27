from __future__ import annotations

import csv
import json
import math
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
    if isinstance(author, dict):
        author = author.get("name", "")
    if timestamp is None or not str(text).strip():
        raise ValueError("Every chat row needs timestamp/time and message/text/content.")
    return ChatMessage(parse_timestamp(timestamp), str(text), str(author))


def _runs_to_text(message: dict | None) -> str:
    """Turn YouTube's message "runs" (text pieces and emoji) into plain text."""
    if not message:
        return ""
    if isinstance(message.get("simpleText"), str):
        return message["simpleText"]
    parts = []
    for run in message.get("runs", []):
        if "text" in run:
            parts.append(run["text"])
        elif "emoji" in run:
            emoji = run["emoji"]
            parts.append((emoji.get("shortcuts") or [emoji.get("emojiId", "")])[0])
    return "".join(parts)


def _expand(row: dict) -> list[dict]:
    """yt-dlp's YouTube `*.live_chat.json` stores one replayChatItemAction per line."""
    replay = row.get("replayChatItemAction")
    if not isinstance(replay, dict):
        return [row]
    offset = float(replay.get("videoOffsetTimeMsec", "nan")) / 1000
    rows = []
    for action in replay.get("actions", []):
        item = (action.get("addChatItemAction") or {}).get("item") or {}
        renderer = item.get("liveChatTextMessageRenderer") or item.get("liveChatPaidMessageRenderer") or {}
        rows.append({
            "timestamp": offset,
            "message": _runs_to_text(renderer.get("message")),
            "author": (renderer.get("authorName") or {}).get("simpleText", ""),
        })
    return rows


def _normalize(row: dict) -> dict:
    """Map known tool-specific shapes onto timestamp/message/author."""
    if "content_offset_seconds" in row:  # TwitchDownloader JSON
        return {
            "timestamp": row["content_offset_seconds"],
            "message": (row.get("message") or {}).get("body", ""),
            "author": (row.get("commenter") or {}).get("display_name", ""),
        }
    if "time_in_seconds" in row:  # chat-downloader (YouTube and others)
        return {"timestamp": row["time_in_seconds"], "message": row.get("message", ""), "author": row.get("author", "")}
    return row


def _json_rows(raw: str) -> list[dict]:
    text = raw.strip()
    if text.startswith("{") and "\n{" in text:  # newline-delimited JSON
        try:
            return [json.loads(line) for line in text.splitlines() if line.strip()]
        except json.JSONDecodeError:
            pass
    payload = json.loads(text)
    if isinstance(payload, list):
        return payload
    return payload.get("comments") or payload.get("messages") or []


def load_chat(path: Path) -> list[ChatMessage]:
    """Load generic JSON/CSV exports, TwitchDownloader JSON, chat-downloader JSON and yt-dlp live_chat.json.

    Rows without a timestamp or text are skipped, like in the web app.
    """
    if not path.is_file():
        raise FileNotFoundError(f"Chat file not found: {path}")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            rows: Iterable[dict] = [{key.strip().lower(): value for key, value in row.items() if key} for row in csv.DictReader(handle)]
    elif suffix in (".json", ".jsonl"):
        rows = _json_rows(path.read_text(encoding="utf-8-sig"))
    else:
        raise ValueError("Chat input must be .json, .jsonl or .csv")

    messages = []
    for row in (expanded for raw in rows for expanded in _expand(raw)):
        try:
            message = _message_from_row(_normalize(row))
        except (ValueError, TypeError):
            continue
        if math.isfinite(message.timestamp) and message.timestamp >= 0:
            messages.append(message)
    if not messages:
        raise ValueError(f"No messages with a timestamp and text were found in {path}.")
    return sorted(messages, key=lambda message: message.timestamp)
