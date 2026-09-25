from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def require_tool(tool: str) -> str:
    resolved = shutil.which(tool)
    if not resolved:
        raise RuntimeError(f"{tool} is not installed or not on PATH. See README.md for setup.")
    return resolved


def extract_frame(video_path: Path, timestamp: float, output_path: Path) -> Path:
    require_tool("ffmpeg")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-ss", str(timestamp), "-i", str(video_path), "-frames:v", "1", "-q:v", "2", str(output_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    return output_path


def download_video(url: str, output_directory: Path) -> None:
    require_tool("yt-dlp")
    output_directory.mkdir(parents=True, exist_ok=True)
    subprocess.run(["yt-dlp", "--no-playlist", "-o", str(output_directory / "%(extractor)s-%(id)s.%(ext)s"), url], check=True)


def fetch_twitch_chat(vod_id: str, output_path: Path) -> None:
    require_tool("TwitchDownloaderCLI")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["TwitchDownloaderCLI", "chatdownload", "--id", vod_id, "--output", str(output_path)], check=True)

