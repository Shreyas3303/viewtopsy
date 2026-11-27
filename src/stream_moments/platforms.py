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
    requests = _requests()
    token = _twitch_token(settings, requests)
    response = requests.get("https://api.twitch.tv/helix/videos", params={"id": video_id}, headers={"Client-ID": settings.twitch_client_id, "Authorization": f"Bearer {token}"}, timeout=20)
    response.raise_for_status()
    data = response.json().get("data", [])
    if not data:
        raise RuntimeError(f"No Twitch VOD found for ID {video_id}.")
    video = data[0]
    return VideoMetadata("twitch", video_id, video["title"], video["user_name"], video["created_at"], video["url"])


def _twitch_token(settings: Settings, requests) -> str:
    if not settings.twitch_client_id or not settings.twitch_client_secret:
        raise RuntimeError("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env (create an app at dev.twitch.tv/console/apps).")
    response = requests.post("https://id.twitch.tv/oauth2/token", params={"client_id": settings.twitch_client_id, "client_secret": settings.twitch_client_secret, "grant_type": "client_credentials"}, timeout=20)
    response.raise_for_status()
    return response.json()["access_token"]


def twitch_vod_clips(video_id: str, settings: Settings, max_pages: int = 20) -> dict:
    """Clips made from one Twitch VOD, with where each starts in the VOD.

    Uses the official Helix API: looks up the VOD's channel and date, lists that
    channel's clips created since the VOD started, and keeps the ones cut from
    this VOD. Clips without a VOD position (vod_offset) are kept but marked.
    """
    requests = _requests()
    token = _twitch_token(settings, requests)
    headers = {"Client-ID": settings.twitch_client_id, "Authorization": f"Bearer {token}"}

    video_response = requests.get("https://api.twitch.tv/helix/videos", params={"id": video_id}, headers=headers, timeout=20)
    video_response.raise_for_status()
    videos = video_response.json().get("data", [])
    if not videos:
        raise RuntimeError(f"No Twitch VOD found for ID {video_id}.")
    video = videos[0]

    clips: list[dict] = []
    cursor = None
    for _ in range(max_pages):
        params = {"broadcaster_id": video["user_id"], "started_at": video["created_at"], "first": 100}
        if cursor:
            params["after"] = cursor
        response = requests.get("https://api.twitch.tv/helix/clips", params=params, headers=headers, timeout=20)
        response.raise_for_status()
        body = response.json()
        for clip in body.get("data", []):
            if str(clip.get("video_id")) == str(video_id):
                clips.append({key: clip.get(key) for key in ("id", "url", "title", "view_count", "vod_offset", "duration", "creator_name", "created_at", "video_id")})
        cursor = (body.get("pagination") or {}).get("cursor")
        if not cursor:
            break

    clips.sort(key=lambda c: (c["vod_offset"] is None, c["vod_offset"] or 0))
    return {"video_id": str(video_id), "title": video.get("title", ""), "channel": video.get("user_name", ""), "clips": clips}


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
