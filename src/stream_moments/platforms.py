from __future__ import annotations

from dataclasses import dataclass

from .config import Settings


@dataclass(frozen=True)
class VideoMetadata:
    platform: str
    video_id: str
    title: str
    channel: str
    published_at: str
    url: str


def twitch_metadata(video_id: str, settings: Settings) -> VideoMetadata:
    if not settings.twitch_client_id or not settings.twitch_client_secret:
        raise RuntimeError("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env to fetch Twitch metadata.")
    requests = _requests()
    token_response = requests.post("https://id.twitch.tv/oauth2/token", params={"client_id": settings.twitch_client_id, "client_secret": settings.twitch_client_secret, "grant_type": "client_credentials"}, timeout=20)
    token_response.raise_for_status()
    response = requests.get("https://api.twitch.tv/helix/videos", params={"id": video_id}, headers={"Client-ID": settings.twitch_client_id, "Authorization": f"Bearer {token_response.json()['access_token']}"}, timeout=20)
    response.raise_for_status()
    data = response.json().get("data", [])
    if not data:
        raise RuntimeError(f"No Twitch VOD found for ID {video_id}.")
    video = data[0]
    return VideoMetadata("twitch", video_id, video["title"], video["user_name"], video["created_at"], video["url"])


def youtube_metadata(video_id: str, settings: Settings) -> VideoMetadata:
    if not settings.youtube_api_key:
        raise RuntimeError("Set YOUTUBE_API_KEY in .env to fetch YouTube metadata.")
    response = _requests().get("https://www.googleapis.com/youtube/v3/videos", params={"part": "snippet", "id": video_id, "key": settings.youtube_api_key}, timeout=20)
    response.raise_for_status()
    items = response.json().get("items", [])
    if not items:
        raise RuntimeError(f"No YouTube video found for ID {video_id}.")
    snippet = items[0]["snippet"]
    return VideoMetadata("youtube", video_id, snippet["title"], snippet["channelTitle"], snippet["publishedAt"], f"https://www.youtube.com/watch?v={video_id}")


def get_metadata(platform: str, video_id: str, settings: Settings) -> VideoMetadata:
    if platform == "twitch":
        return twitch_metadata(video_id, settings)
    if platform == "youtube":
        return youtube_metadata(video_id, settings)
    raise ValueError("platform must be twitch or youtube")


def _requests():
    """Import the optional API client only when a network-backed command needs it."""
    try:
        import requests
    except ImportError as exc:
        raise RuntimeError("Install project dependencies with 'pip install -e .' before using metadata commands.") from exc
    return requests
