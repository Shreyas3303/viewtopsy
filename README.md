# Viewtopsy

**Find the moments your chat loved.** Viewtopsy reads a Twitch or YouTube chat replay, spots the bursts where chat went wild, and gives you a ranked list of timestamps that are worth clipping.

It runs entirely in your browser. Chat files are never uploaded anywhere, and no account or API key is needed.

## Try it in 30 seconds

1. Open `frontend/index.html` in a browser (double-click it, or run `npm run serve` and visit <http://localhost:8000>).
2. Click **Try it with a sample stream**.

The sample is a made-up 2-hour stream with nine planted events (a raid, a jump scare, a clutch play, a boss kill…). Viewtopsy finds all nine.

## Using your own stream

1. **Get the chat replay** as a file. Supported formats:

   | Source | Format |
   | --- | --- |
   | [TwitchDownloader](https://github.com/lay295/TwitchDownloader) | JSON (`chatdownload`) |
   | [yt-dlp](https://github.com/yt-dlp/yt-dlp) (YouTube) | `*.live_chat.json` from `yt-dlp --write-subs --sub-langs live_chat` |
   | [chat-downloader](https://github.com/xenova/chat-downloader) (YouTube, Twitch and more) | JSON or one-message-per-line JSON |
   | Anything else | CSV or JSON with a `timestamp` (seconds, `MM:SS` or `H:MM:SS`), a `message` and an optional `author` column |

2. **Drop the file** into Viewtopsy.
3. Optionally **paste the VOD link**. Every moment then gets a *Watch* button that opens the video at that time. TwitchDownloader exports fill this in for you.
4. Click **Find moments**.
5. Optionally **add the video file** for frames, and an **API key** for explanations.

**Trimmed downloads:** if you downloaded part of a stream (say 1:00:00–1:30:00) with TwitchDownloader, timestamps still match the full stream on Twitch, and *Video starts at* is filled in from the chat file so frames line up with your trimmed video. For other tools, set *Video starts at* to where your video file begins in the stream.

### What you get

- **Chat activity chart** across the whole stream with numbered markers on each spike. Click a marker to jump to that moment.
- **Moment cards** ranked by how far chat jumped above its normal pace, with the top words chat was using and a few sample messages.
- **Sensitivity** (Fewer / Balanced / More) to trade fewer, bigger moments for more candidates. Advanced settings let you change the window length and thresholds.
- **Reaction reading** for every moment: laughter, hype, shock, tension, sad, wholesome, disapproval, confusion, chat voting, support/alerts. It understands emotes (KEKW, monkaS, Pog, W/L…), channel emotes by their ending (`cohhLUL`, `kaicenatW`) and stretched words (LMAOOOO).
- **Frames from your video** (optional): add the video file and each moment gets a strip of 6 frames from the 20 seconds before chat spiked, since chat reacts a few seconds after the cause. The video is read in your browser and never uploaded.
- **AI explanations** (optional): with your own Anthropic API key, each moment's frames, chat and reaction profile go to Claude, which returns what happened, why chat reacted, the likely trigger (gameplay, streamer, guest, alert, chat itself…), and a confidence level. Only moments you explain are sent. The model can't hear audio yet, so moments caused by something said get low confidence.
- **Stars and notes** so you can shortlist moments and name your clips.
- **Exports**: copy as YouTube chapters, or download CSV / JSON. If you starred anything, only starred moments are exported.

## How detection works

1. Chat is split into short windows (15 seconds by default) and each window's messages are counted, from the first message to the last.
2. Each window is compared with the stream's average using a z-score (how many standard deviations above normal it is).
3. Windows above the threshold, with at least the minimum number of messages, become moments. Back-to-back windows merge into one moment.
4. Each moment's timestamp is set one window *before* its peak, so playback catches the build-up instead of starting mid-reaction.

A spike usually means something happened, but not always (a giveaway or a chat argument also spikes), so give each moment a quick look before clipping.

## Python command-line tool (optional)

The same analysis is available from the command line, plus helpers for downloading chat and video and for adding video frames to reports.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Analyze a chat file and write JSON + Markdown reports to ./reports
stream-moments analyze --chat data/chat/example.json --sensitivity medium

# With a VOD ID and platform (used in report names)
stream-moments analyze --platform twitch --id 123456789 --chat chat.json
```

Other commands (these need extra tools or API keys, see `.env.example`):

| Command | Needs |
| --- | --- |
| `stream-moments fetch-twitch-chat --id VOD --output chat.json` | `TwitchDownloaderCLI` on your PATH |
| `stream-moments download --url URL` | `yt-dlp` |
| `stream-moments metadata --platform twitch --id VOD` | Twitch or YouTube API keys in `.env` |
| `stream-moments analyze … --video vod.mp4` | `ffmpeg` (adds a frame for each moment) |
| `stream-moments analyze … --video vod.mp4 --visual-analysis` | `pip install -e ".[vision]"` |

## Project layout

```
frontend/            Browser app (no build step)
  index.html
  styles.css
  app.js             Interface
  analysis.js        Detection, parsing and export (shared with tests)
  reactions.js       Emote-aware reaction reading
  frames.js          Grabs frames from a local video file
  explain.js         Builds the Claude request and reads its answer
  sample.js          Generates the demo stream
src/stream_moments/  Python package and CLI
tests/               Python (pytest) and JavaScript (node --test) tests
data/chat/           example.json, the demo stream as a file
scripts/             build-sample-chat.js regenerates example.json
```

## Development

```bash
npm test             # JavaScript tests (Node 18+)
python -m pytest     # Python tests, including a check that the web app and CLI agree
npm run sample       # Regenerate data/chat/example.json after editing frontend/sample.js
```

`frontend/analysis.js` and `src/stream_moments/analyzer.py` implement the same algorithm. If you change one, change the other; `tests/test_chat_and_cli.py::test_web_app_and_cli_agree` will fail if they drift apart.
