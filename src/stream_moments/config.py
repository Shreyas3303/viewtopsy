from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path = Path(".env")) -> None:
    """Load simple KEY=VALUE pairs without making .env a runtime dependency."""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Settings:
    twitch_client_id: str | None
    twitch_client_secret: str | None
    youtube_api_key: str | None
    gemini_api_key: str | None
    gemini_model: str | None

    @classmethod
    def from_environment(cls) -> "Settings":
        load_dotenv()
        return cls(
            twitch_client_id=os.getenv("TWITCH_CLIENT_ID"),
            twitch_client_secret=os.getenv("TWITCH_CLIENT_SECRET"),
            youtube_api_key=os.getenv("YOUTUBE_API_KEY"),
            gemini_api_key=os.getenv("GEMINI_API_KEY"),
            gemini_model=os.getenv("GEMINI_MODEL"),
        )
