# Viewtopsy

**Find the moments your chat loved.** Viewtopsy reads a Twitch or YouTube chat replay, spots the bursts where chat went wild, works out why, shows where chat went quiet, and tells you which moments nobody has clipped yet.

**Who it's for:** clippers and editors working through someone's VOD, and streamers who want to know what actually lands with their chat. Twitch and YouTube now cut automatic highlight clips for the streamer; Viewtopsy is for understanding a stream and getting its moments into your editor, on any public VOD.

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
5. Optionally **add the video file** for frames. Add an **API key** once in the **Profile** tab for explanations.

**Trimmed downloads:** if you downloaded part of a stream (say 1:00:00–1:30:00) with TwitchDownloader, timestamps still match the full stream on Twitch, and *Video starts at* is filled in from the chat file so frames line up with your trimmed video. For other tools, set *Video starts at* to where your video file begins in the stream.

### Profile

The **Profile** tab keeps everything that doesn't change between streams, saved in your browser, so the Analyze page only shows the stream:

- **AI settings:** API key (remembered only if you tick the box), model.
- **Your channel:** name, main platform, and an "about" note the AI gets as background (regulars, running jokes, usual content).
- **Channel emotes:** what your own emotes mean (`kaicFireMGM = hype`), so they count toward the right reaction. After loading a TwitchDownloader chat, Profile suggests the channel emotes it found that it can't read yet; pick a reaction to add one.
- **Defaults** for each new analysis: sensitivity, window length, minimum messages, order, editor frame rate.
- **Backup:** save or load the profile as a file to move it to another browser. The API key is never included.

### Connect with Twitch (beta)

Optional, and nothing else depends on it: loading a clips file keeps working without it. Connecting lets the app fetch a VOD's existing clips itself (the **Fetch clips from Twitch** button), instead of you running `fetch-clips` and loading the file.

Twitch can only send you back to an `http://` address, so open Viewtopsy through the local server:

```bash
npm run serve        # then open http://localhost:8000
# no Node? this works too:
python -m http.server 8000 --directory frontend
```

One-time setup, also shown in the Profile tab:

1. Create a free app at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) (category: Analytics Tool, client type: Public).
2. Set its **OAuth Redirect URL** to `http://localhost:8000/` (Profile shows the exact URL with a Copy button).
3. Paste the app's **Client ID** into Profile and click **Connect with Twitch**.

This uses Twitch's browser sign-in (implicit grant), so no client secret is needed or stored. The token asks for no extra permissions, is kept in this browser only (never in profile backup files), and expires after a while; just click Connect again. Disconnect forgets it; to fully revoke access, remove the app under Twitch Settings › Connections.

### What you get

- **Chat activity chart** across the whole stream with numbered markers on each spike. Click a marker to jump to that moment.
- **Moment cards** ranked by how far chat jumped above its normal pace, with the top words chat was using and a few sample messages.
- **Sensitivity** (Fewer / Balanced / More) to trade fewer, bigger moments for more candidates. Advanced settings let you change the window length and thresholds.
- **Reaction reading** for every moment: laughter, hype, shock, tension, sad, wholesome, disapproval, confusion, chat voting, support/alerts. It understands emotes (KEKW, monkaS, Pog, W/L…), channel emotes by their ending (`cohhLUL`, `kaicenatW`) and stretched words (LMAOOOO).
- **Frames from your video** (optional): add the video file and each moment gets a strip of 6 frames from the 20 seconds before chat spiked, since chat reacts a few seconds after the cause. The video is read in your browser and never uploaded.
- **AI explanations** (optional): paste an API key and each moment's frames, chat and reaction profile go to a vision model, which returns what happened, why chat reacted, the likely trigger (gameplay, streamer, guest, alert, chat itself…), and a confidence level. Only moments you explain are sent. The model can't hear audio yet, so moments caused by something said get low confidence.
  - **Free option:** a Google Gemini key from [Google AI Studio](https://aistudio.google.com/apikey) (free tier, no card needed). Viewtopsy asks Google which models your key can use, picks the newest stable Flash model, and moves to the next one if a model has no free quota on your key. Note that Google may use free-tier requests to improve its products.
  - An Anthropic key (`sk-ant-…`) works too and uses Claude.
  - The key type is detected automatically. You can still pick a specific model in the menu.
  - Explanations work when you open `frontend/index.html` yourself. Hosted previews that block outside connections can't reach the AI.
- **Stream story strip** under the chart: the VOD's chapters (game/category) and chat's main mood over time (laughter, hype, shock, voting…), lined up with moments and quiet stretches.
- **Click to read chat:** click any point on the chart, a stretch of the mood strip, or a chapter to see the messages from it, with their reaction mix.
- **Stream overview:** messages a minute (average and peak), time spent in hype and the longest hype, the mood mix, when waves of new chatters arrived (including waves with no chat spike, e.g. a raid), every time chat asked for a clip (and the times it did without a spike), subs/members, bits and Super Chats.
- **Search chat:** type a word or username to mark every mention on the chart and list the messages, each linking to the VOD 10 seconds earlier.
- **Clip these first:** a shortlist ranked by a 0–100 clip score combining spike size, how many people reacted, first-time chatters, clip requests, spike type, AI confidence and whether it's already clipped, with the reasons shown. Also available as the **Best to clip** sort order.
- **Suggested clip range** for each moment: starts a few seconds before the cause (the AI's cause time when it's confident, otherwise just before chat started rising) and ends when chat calms down. Marker exports use these ranges.
- **More per-moment detail:** how long the hype lasted, first-time chatters (people whose first message in the chat is in this moment; skipped in the first 10 minutes of a file), chat asking for a clip ("CLIP IT", "!clip"), share of messages from subscribers or members versus usual, bits and Super Chats.
- **Spike type** for every moment: *organic reaction*, *prompted* (chat answering a question or voting), *alert-driven* (subs, gifts, raids), *copypasta / spam wave*, or *hellos / goodbyes*. Prompted and alert spikes look big but tell you less about the content.
- **Where chat went quiet:** stretches of 3+ minutes where chat ran well below its normal pace, shaded on the chart and listed with frames. With an API key, the AI says what was happening and suggests what to do about it (cut it, speed it up…).
- **How each part of the stream did:** engagement per game or category, from the VOD's chapters (TwitchDownloader exports include them), or per time block.
- **Already clipped or not:** once you connect Twitch (beta, see below), clips are fetched automatically for each Twitch VOD. Without it you can still load a clips file (see `fetch-clips` below) and each moment shows whether it's already clipped and how popular the top clip is. Moments nobody clipped are marked ✦. Clips where chat stayed calm are listed separately.
- **Stars and notes** so you can shortlist moments and name your clips.
- **Exports**: copy as YouTube chapters, or download CSV / JSON. If you starred anything, only starred moments are exported.
- **Markers for editing software**: a DaVinci Resolve marker file (Timeline › Import › Timeline Markers from EDL) and a Final Cut Pro 7 XML for Premiere Pro (File › Import; locate the video when asked). Markers line up with your video file, are colour-coded by spike type in Resolve, and carry the AI title and summary.

## How detection works

1. Chat is split into short windows (15 seconds by default) and each window's messages are counted, from the first message to the last.
2. Each window is compared with the stream's average using a z-score (how many standard deviations above normal it is).
3. Windows above the threshold, with at least the minimum number of messages, become moments. Back-to-back windows merge into one moment.
4. Each moment's timestamp is set one window *before* its peak, so playback catches the build-up instead of starting mid-reaction.
5. Viewtopsy also finds where chat **starts rising** (up to 30 seconds before the peak). Frames for the AI are taken from 25 seconds before that point to the end of that first rising window, spaced more tightly near the rise, since chat reacts a few seconds after the cause. Once you've explained some moments, the app shows the measured gap between cause and reaction for that stream.

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
| `stream-moments fetch-clips --id VOD` | Twitch API keys in `.env`; saves `data/clips/VOD.json` for the clip comparison |
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
  insights.js        Spike types, quiet stretches, segments, clips, editor markers
  profile.js         Saved profile: settings, channel, emotes, defaults
  twitch.js          (beta) Connect with Twitch and fetch a VOD's clips
  frames.js          Grabs frames from a local video file
  explain.js         Gemini/Claude requests, model choice and reading answers
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
npm run serve        # Serve the app at http://localhost:8000 (needed for Connect with Twitch)
```

`frontend/analysis.js` and `src/stream_moments/analyzer.py` implement the same algorithm. If you change one, change the other; `tests/test_chat_and_cli.py::test_web_app_and_cli_agree` will fail if they drift apart.
