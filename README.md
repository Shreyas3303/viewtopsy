# Viewtopsy

Viewtopsy is a local-first tool for finding the most interesting moments in a stream or VOD from chat activity.

It helps you:
- analyze chat exports from Twitch or YouTube
- detect spikes in conversation intensity
- rank likely high-engagement moments
- generate a report you can review or export
- optionally attach frame-based visual context when a video file is available

## What it does

The project combines a browser-based frontend with an optional Python CLI. The frontend lets you drop a chat export and inspect moments without needing a server or account. The Python companion can also pull metadata, download public media, and enrich moments with thumbnails and AI-assisted explanations when configured.

## Quick start

### Browser workflow

Open the local frontend:

```bash
cd /home/shreshri/viewtopsy
python -m http.server 8080 --directory frontend
```

Then visit:

```text
http://localhost:8080
```

Upload a JSON or CSV chat export and run the analysis.

### Python CLI workflow

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
stream-moments analyze --platform youtube --id VIDEO_ID --chat data/chat/my-stream.json --video data/downloads/video.mp4
```

## Project structure

```text
frontend/          Browser UI
src/stream_moments Python analysis tools
reports/           Generated outputs
data/              Chat, downloaded media, and extracted frames
```

## Notes

- This project keeps credentials in environment variables instead of hard-coded config.
- The frontend is designed to work without API keys.
- Optional tools like ffmpeg, yt-dlp, and TwitchDownloaderCLI can be enabled for extra functionality.

## License

This project is currently shared as-is for local use and experimentation.
