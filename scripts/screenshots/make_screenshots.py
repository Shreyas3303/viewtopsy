"""Regenerates the README screenshots in docs/images from made-up demo data.

Everything here is fake: the chat comes from frontend/sample.js (invented
usernames), the channel is "DemoStreamer", the video is generated with ffmpeg
and just shows scene labels, the clips are invented, and the AI explanations
are scripted replies returned by an intercepted API call. No real streamer,
viewer or API is involved.

Needs: node, ffmpeg, and Playwright with a Chromium/Chrome build
(pip install playwright && playwright install chromium).

    python scripts/screenshots/make_screenshots.py [--chrome /path/to/chrome]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "images"
VOD_ID = "1234567890"
FAKE_KEY = "AIzaDemoKeyNotReal-0000000000000000000"

# Scene labels burned into the demo video, and the scripted AI replies.
EVENTS = {
    400: ("RAID INCOMING · 312 viewers", {"title": "Big raid lands mid-stream", "what_happened": "A raid alert fills the screen as another channel sends 312 viewers over.", "why_chat_reacted": "Raiders flooded chat with raid messages while regulars welcomed them.", "trigger": "alert", "confidence": "high", "evidence": ["Frame at 6:38 shows the raid alert banner", "Chat repeats 'RAID HYPE' and 'welcome raiders'"]}),
    1085: ("JUMP SCARE!", {"title": "Jump scare gets the streamer", "what_happened": "A monster lunges at the camera in a dark corridor and the streamer recoils.", "why_chat_reacted": "Chat laughed at the streamer's scream and spammed KEKW.", "trigger": "gameplay", "confidence": "high", "evidence": ["Frame at 18:03 shows the creature filling the screen", "Chat: 'HE SCREAMED', 'his face KEKW'"]}),
    1910: ("$50 DONATION + 50 GIFTED SUBS", {"title": "50 gifted subs in one go", "what_happened": "A donation alert announces 50 gifted subs with a long on-screen message.", "why_chat_reacted": "Chat thanked the gifter and celebrated the gift bomb.", "trigger": "alert", "confidence": "high", "evidence": ["Frame at 31:49 shows the gift alert", "Chat: 'W donation', 'generous king'"]}),
    2840: ("1v4 CLUTCH", {"title": "Impossible 1v4 clutch", "what_happened": "The streamer, last one alive, wins a 1-versus-4 fight with a few hit points left.", "why_chat_reacted": "Chat exploded in disbelief and asked for the moment to be clipped.", "trigger": "gameplay", "confidence": "high", "evidence": ["Frames from 47:12 to 47:26 show the 1v4 fight and the win screen", "Chat: 'NO WAY', 'CLIP THAT', '1V4 CLUTCH'"]}),
    3790: ("FELL OFF THE MAP", {"title": "Falls off the map at the worst time", "what_happened": "The character slips off a ledge and falls out of the level.", "why_chat_reacted": "Chat laughed at the fail and sent sympathy emotes.", "trigger": "gameplay", "confidence": "medium", "evidence": ["Frame at 1:03:08 shows the character falling", "Chat: 'he fell off the map', 'KEKW', 'unlucky'"]}),
    4710: ("LEGENDARY DROP", {"title": "Legendary drop after hours of farming", "what_happened": "A gold legendary item drops from a chest.", "why_chat_reacted": "Chat celebrated the rare drop the stream had been farming for.", "trigger": "gameplay", "confidence": "high", "evidence": ["Frame at 1:18:28 shows a gold 'LEGENDARY' item card", "Chat: 'no way it dropped', 'finally the drop'"]}),
    5775: ("BOSS DEFEATED", {"title": "Boss finally goes down", "what_happened": "The boss's health bar hits zero and a victory banner appears.", "why_chat_reacted": "After many attempts, chat celebrated the kill with hype and clip requests.", "trigger": "gameplay", "confidence": "high", "evidence": ["Frame at 1:36:13 shows 'BOSS DEFEATED'", "Chat: 'BOSS DOWN', 'FINALLY', 'CLIP IT'"]}),
    6760: ("HOT TAKE", {"title": "Controversial food take", "what_happened": "Back on camera, the streamer reads a chat question about food.", "why_chat_reacted": "The frames don't show a cause; chat suggests the streamer said a controversial opinion out loud.", "trigger": "streamer", "confidence": "low", "evidence": ["Frames show only the face cam", "Chat: 'that take is wild', 'chat is fighting'"]}),
    7445: ("THANKS FOR WATCHING", {"title": "End-of-stream goodbyes", "what_happened": "An end screen thanks viewers for watching.", "why_chat_reacted": "Chat said goodbye and thanked the streamer.", "trigger": "chat", "confidence": "high", "evidence": ["Frame at 2:04:08 shows the end screen", "Chat: 'gn', 'great stream', 'o7'"]}),
}
QUIET = (6000, 6390)  # a "be right back" break where chat goes quiet
WIND_DOWN_REPLY = {"title": "Stream winding down", "what_happened": "Back to Just Chatting with a calm face cam near the end of the stream.", "why_chat_reacted": "Late in the stream, many viewers had left and the conversation slowed down.", "suggestion": "Fine to keep, but wrap up sooner or end on a highlight to avoid a slow finish.", "trigger": "streamer", "confidence": "medium", "evidence": ["Frames show the Just Chatting layout", "Chat is down to occasional 'hydrate' and 'lol' messages"]}
QUIET_REPLY = {"title": "Six-minute BRB screen", "what_happened": "A static 'Be right back' screen is shown with no game or camera.", "why_chat_reacted": "With nothing happening on stream, most of chat stopped talking.", "suggestion": "Cut this from the VOD upload, or keep BRB breaks short and announce how long they'll be.", "trigger": "unclear", "confidence": "high", "evidence": ["All four frames show the same BRB screen", "Only a few 'brb?' messages in chat"]}
CHAPTERS = [(0, 900, "Just Chatting"), (900, 6700, "Hollow Quest"), (6700, 7700, "Just Chatting")]


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def demo_chat(work: Path) -> Path:
    raw = subprocess.run(
        ["node", "-e", "process.stdout.write(JSON.stringify(require('./frontend/sample.js').generateSampleChat()))"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    rows = json.loads(raw)
    rng = random.Random(7)
    authors = sorted({r["author"] for r in rows})
    subs = {a for a in authors if rng.random() < 0.14}
    comments = []
    for r in rows:
        t = r["timestamp"]
        if QUIET[0] <= t < QUIET[1]:
            continue
        text = r["message"]
        fragments = [{"text": text, "emoticon": None}]
        if text in ("PogChamp raid", "W W W") and rng.random() < 0.5:
            text = "demoPog demoPog"
            fragments = [{"text": "demoPog", "emoticon": {"emoticon_id": "1"}}, {"text": " ", "emoticon": None}, {"text": "demoPog", "emoticon": {"emoticon_id": "1"}}]
        elif text in ("lurking", "take your time") and rng.random() < 0.5:
            text = "demoChair"  # a channel emote Viewtopsy can't guess, so Profile suggests it
            fragments = [{"text": "demoChair", "emoticon": {"emoticon_id": "3"}}]
        elif text in ("KEKW", "LUL") and rng.random() < 0.4:
            text = "demoLaugh"
            fragments = [{"text": "demoLaugh", "emoticon": {"emoticon_id": "2"}}]
        bits = 0
        if 1910 <= t < 1940 and rng.random() < 0.15:
            bits = rng.choice([100, 250, 500])
            text = f"Cheer{bits} {text}"
        comments.append({
            "content_offset_seconds": round(t, 2),
            "commenter": {"display_name": r["author"]},
            "message": {"body": text, "bits_spent": bits, "fragments": fragments,
                        "user_badges": [{"_id": "subscriber", "version": "6"}] if r["author"] in subs else []},
        })
    for i, t in enumerate(range(QUIET[0] + 40, QUIET[1], 70)):
        comments.append({"content_offset_seconds": t, "commenter": {"display_name": f"lurker_{i}"}, "message": {"body": ["brb?", "is he back", "still waiting", "o7", "lol"][i % 5], "user_badges": []}})
    comments.sort(key=lambda c: c["content_offset_seconds"])
    length = 7620
    payload = {
        "FileInfo": {"Version": {"Major": 1, "Minor": 4, "Patch": 0}},
        "streamer": {"name": "DemoStreamer", "login": "demostreamer"},
        "video": {"title": "Boss rush, raids and a legendary drop (demo)", "id": VOD_ID, "start": 0, "end": length, "length": length,
                  "chapters": [{"startMilliseconds": s * 1000, "lengthMilliseconds": (e - s) * 1000, "description": n, "gameDisplayName": n} for s, e, n in CHAPTERS]},
        "comments": comments,
    }
    path = work / "DemoStreamer-chat.json"
    path.write_text(json.dumps(payload))
    return path


def demo_video(work: Path) -> Path:
    def esc(text):
        return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")

    filters = []
    for start, end, name in CHAPTERS:
        filters.append(f"drawtext=text='{esc(name)}':fontcolor=white@0.55:fontsize=22:x=24:y=h-46:enable='between(t,{start},{end})'")
    for at, (label, _) in EVENTS.items():
        filters.append(f"drawbox=x=0:y=110:w=iw:h=140:color=0xef7655@0.85:t=fill:enable='between(t,{at - 12},{at + 22})'")
        filters.append(f"drawtext=text='{esc(label)}':fontcolor=white:fontsize=40:x=(w-tw)/2:y=160:enable='between(t,{at - 12},{at + 22})'")
    filters.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=0x15231d:t=fill:enable='between(t,{QUIET[0]},{QUIET[1]})'")
    filters.append(f"drawtext=text='BE RIGHT BACK':fontcolor=0xc9eb6d:fontsize=56:x=(w-tw)/2:y=(h-th)/2:enable='between(t,{QUIET[0]},{QUIET[1]})'")
    filters.append("drawtext=text='DEMO VIDEO · %{pts\\:hms}':fontcolor=white@0.7:fontsize=18:x=w-tw-20:y=18")
    path = work / "DemoStreamer-video.mp4"
    run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0c4937:s=640x360:r=1:d=7620",
         "-vf", ",".join(filters), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path)])
    return path


def demo_clips() -> dict:
    def clip(cid, title, views, offset, creator):
        return {"id": cid, "url": f"https://clips.twitch.tv/{cid}", "title": title, "view_count": views, "vod_offset": offset, "duration": 30, "creator_name": creator, "created_at": "2026-11-20T00:00:00Z", "video_id": VOD_ID}
    return {"data": [
        clip("DemoClutch", "1v4 CLUTCH", 18400, 2830, "clipfan_01"),
        clip("DemoClutch2", "how did he win that", 2300, 2836, "clipfan_02"),
        clip("DemoBoss", "BOSS DOWN FINALLY", 9100, 5768, "clipfan_03"),
        clip("DemoChat", "chat roasts the build", 1400, 2400, "clipfan_04"),
    ], "pagination": {}}


def capture(chrome: str | None, chat: Path, video: Path) -> None:
    from playwright.sync_api import sync_playwright

    server = subprocess.Popen(["node", "scripts/serve.js"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*"}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**({"executable_path": chrome} if chrome else {}))
            page = browser.new_page(viewport={"width": 1240, "height": 900}, device_scale_factor=1.5)

            def gemini(route):
                url = route.request.url
                if "/models?" in url:
                    return route.fulfill(status=200, headers=cors, content_type="application/json",
                                         body=json.dumps({"models": [{"name": "models/gemini-3.6-flash", "supportedGenerationMethods": ["generateContent"]}]}))
                prompt = json.loads(route.request.post_data)["contents"][0]["parts"][0]["text"]
                if "lost its audience" in prompt:
                    start = re.search(r"From (\d+):(\d+)(?::(\d+))?", prompt)
                    hours = int(start.group(1)) if start.group(3) else 0
                    reply = WIND_DOWN_REPLY if hours >= 1 and int(start.group(2)) >= 55 else QUIET_REPLY
                else:
                    match = re.search(r"around (\d+):(\d+)(?::(\d+))?", prompt)
                    parts = [int(x) for x in match.groups() if x is not None]
                    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2] if len(parts) == 3 else parts[0] * 60 + parts[1]
                    at = min(EVENTS, key=lambda e: abs(e - seconds))
                    reply = dict(EVENTS[at][1])
                    h, rem = divmod(at, 3600)
                    reply["cause_time"] = f"{h}:{rem // 60:02d}:{rem % 60:02d}"
                body = {"candidates": [{"content": {"parts": [{"text": json.dumps(reply)}]}, "finishReason": "STOP"}]}
                return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(body))

            page.route("https://generativelanguage.googleapis.com/**", gemini)
            page.route("https://api.twitch.tv/helix/**", lambda r: r.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps(
                {"data": [{"id": VOD_ID, "user_id": "1", "user_name": "DemoStreamer", "title": "demo", "created_at": "2026-11-19T18:00:00Z"}]} if "/videos" in r.request.url else demo_clips())))

            page.goto("http://localhost:8000/")
            page.evaluate("""([key]) => {
                localStorage.setItem('viewtopsy.profile', JSON.stringify({
                  ai: { rememberKey: true, model: 'auto' },
                  channel: { name: 'DemoStreamer', platform: 'twitch', about: 'Variety streamer: boss rushes, co-op shooters and long Just Chatting segments. Regulars call the streamer "the goat".' },
                  twitch: { clientId: 'demo0client0id' },
                  emotes: { demoPog: 'hype' },
                  defaults: { sensitivity: 'medium', windowSeconds: 15, minMessages: 5, sort: 'score', fps: 30 },
                }));
                localStorage.setItem('viewtopsy.aiKey', key);
                localStorage.setItem('viewtopsy.twitch', JSON.stringify({ token: 'demo', login: 'demostreamer', expiresAt: Date.now() + 40 * 86400000, clientId: 'demo0client0id' }));
            }""", [FAKE_KEY])
            page.goto("http://localhost:8000/")

            page.set_input_files("#chat-file", str(chat))
            page.wait_for_timeout(500)
            page.click("#analyze-button")
            page.wait_for_function("document.querySelector('#clips-status').textContent.startsWith('✓')", timeout=20000)
            page.set_input_files("#video-file", str(video))
            page.wait_for_function("document.querySelectorAll('.moment-card .filmstrip img').length >= 72", timeout=180000)
            page.click("#explain-all")
            page.wait_for_function("document.querySelectorAll('.moment-card .explanation h4').length >= 9", timeout=60000)
            page.wait_for_timeout(500)

            # 1. The results: metrics, chart, chapters and mood strip.
            page.evaluate("window.scrollTo(0, 0)")
            top = page.locator("#results .results-head").bounding_box()["y"] - 20
            panel = page.locator(".timeline-panel").bounding_box()
            page.screenshot(path=str(OUT / "results.png"), clip={"x": 0, "y": top, "width": 1240, "height": panel["y"] + panel["height"] - top + 16}, full_page=True)
            # 2. A moment explained: frames, reaction, AI explanation, signals, clip range.
            page.locator(".moment-card").first.screenshot(path=str(OUT / "moment.png"))
            # 3. Clip these first.
            page.locator("#shortlist").screenshot(path=str(OUT / "shortlist.png"))
            # 4. Stream overview.
            page.locator("#overview").screenshot(path=str(OUT / "overview.png"))
            browser.close()
    finally:
        server.terminate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chrome", help="Path to a Chrome/Chromium binary (default: Playwright's)")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        print("Making demo chat and video…")
        chat = demo_chat(work)
        video = demo_video(work)
        print("Capturing screenshots…")
        capture(args.chrome, chat, video)
    print(f"Saved screenshots to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
