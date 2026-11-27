import json
import shutil
import subprocess
from pathlib import Path

import pytest

from stream_moments.analyzer import find_moments
from stream_moments.chat import load_chat
from stream_moments.cli import main

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "data" / "chat" / "example.json"


def test_loads_generic_csv(tmp_path):
    path = tmp_path / "chat.csv"
    path.write_text('Timestamp,Author,Message\n0:05,amy,hello\n"0:01",bob,"hi, ""chat"""\n0:09,cat,\n', encoding="utf-8")
    messages = load_chat(path)
    assert [m.text for m in messages] == ['hi, "chat"', "hello"]  # sorted, empty row skipped
    assert messages[0].author == "bob"


def test_loads_twitchdownloader_json(tmp_path):
    path = tmp_path / "chat.json"
    path.write_text(json.dumps({"comments": [
        {"content_offset_seconds": 12.5, "commenter": {"display_name": "Amy"}, "message": {"body": "POG"}},
        {"content_offset_seconds": 3, "commenter": {"display_name": "Bob"}, "message": {"body": "hi"}},
    ]}), encoding="utf-8")
    messages = load_chat(path)
    assert [(m.timestamp, m.author, m.text) for m in messages] == [(3, "Bob", "hi"), (12.5, "Amy", "POG")]


def test_loads_chat_downloader_jsonl(tmp_path):
    path = tmp_path / "chat.json"
    rows = [
        {"time_in_seconds": 4.2, "message": "first", "author": {"name": "Amy"}},
        {"time_in_seconds": -10, "message": "pre-stream", "author": {"name": "Bob"}},
        {"time_in_seconds": 9, "message": "second", "author": {"name": "Cat"}},
    ]
    path.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    messages = load_chat(path)
    assert [m.text for m in messages] == ["first", "second"]
    assert messages[0].author == "Amy"


def test_rejects_file_without_messages(tmp_path):
    path = tmp_path / "empty.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(ValueError):
        load_chat(path)


def test_example_chat_finds_the_planted_events():
    moments = find_moments(load_chat(EXAMPLE))
    assert len(moments) == 9
    assert "boss" in moments[0].keywords


def test_cli_writes_reports(tmp_path, capsys):
    code = main(["analyze", "--chat", str(EXAMPLE), "--id", "demo", "--sensitivity", "low", "--reports-dir", str(tmp_path)])
    assert code == 0
    report = json.loads((tmp_path / "twitch-demo-moments.json").read_text())
    assert len(report["moments"]) == 7
    assert "1:36:00" in (tmp_path / "twitch-demo-moments.md").read_text()
    assert "found 7 candidate moments" in capsys.readouterr().out


def test_cli_reports_missing_file(capsys):
    assert main(["analyze", "--chat", "does-not-exist.json"]) == 2
    assert "not found" in capsys.readouterr().err


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_web_app_and_cli_agree():
    """The browser analyzer and the Python analyzer must find the same moments."""
    script = (
        "const A=require('./frontend/analysis.js');"
        "const raw=require('fs').readFileSync('data/chat/example.json','utf8');"
        "const r=A.findMoments(A.parseChatExport(raw,'x.json'));"
        "console.log(JSON.stringify(r.moments.map(m=>[m.timestamp,m.messageCount,m.zScore,m.keywords])));"
    )
    output = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    from_js = json.loads(output)
    from_py = [[m.timestamp, m.message_count, m.z_score, m.keywords] for m in find_moments(load_chat(EXAMPLE))]
    assert from_js == from_py


def test_loads_yt_dlp_live_chat():
    messages = load_chat(ROOT / "tests" / "fixtures" / "yt-dlp.live_chat.json")
    # Membership item (no text) and the pre-stream message are dropped.
    assert [(m.timestamp, m.author, m.text) for m in messages] == [(4.2, "Amy", "hello :wave:"), (9.0, "Bob", "great stream")]


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


class _FakeTwitch:
    """Stands in for `requests`: one VOD, clips over two pages, one from another VOD."""

    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        return _FakeResponse({"access_token": "tok"})

    def get(self, url, params=None, headers=None, **kwargs):
        self.calls.append((url, dict(params or {})))
        if url.endswith("/videos"):
            return _FakeResponse({"data": [{"id": "2939504732", "user_id": "641972806", "user_name": "KaiCenat", "title": "KAI VS SPEED", "created_at": "2026-11-24T17:36:25Z"}]})
        if (params or {}).get("after") is None:
            return _FakeResponse({"data": [
                {"id": "A", "url": "u", "title": "late", "view_count": 5, "vod_offset": 5000, "duration": 30, "creator_name": "x", "created_at": "c", "video_id": "2939504732"},
                {"id": "B", "url": "u", "title": "other vod", "view_count": 9, "vod_offset": 10, "duration": 30, "creator_name": "x", "created_at": "c", "video_id": "1"},
            ], "pagination": {"cursor": "next"}})
        return _FakeResponse({"data": [
            {"id": "C", "url": "u", "title": "early", "view_count": 50, "vod_offset": 3700, "duration": 20, "creator_name": "y", "created_at": "c", "video_id": "2939504732"},
            {"id": "D", "url": "u", "title": "no offset", "view_count": 1, "vod_offset": None, "duration": 20, "creator_name": "y", "created_at": "c", "video_id": "2939504732"},
        ], "pagination": {}})


def test_fetch_clips_keeps_this_vods_clips_in_order(tmp_path, monkeypatch, capsys):
    from stream_moments import platforms

    fake = _FakeTwitch()
    monkeypatch.setattr(platforms, "_requests", lambda: fake)
    monkeypatch.setenv("TWITCH_CLIENT_ID", "id")
    monkeypatch.setenv("TWITCH_CLIENT_SECRET", "secret")
    output = tmp_path / "clips.json"
    assert main(["fetch-clips", "--id", "2939504732", "--output", str(output)]) == 0
    saved = json.loads(output.read_text())
    assert [c["id"] for c in saved["clips"]] == ["C", "A", "D"]
    assert saved["channel"] == "KaiCenat"
    clip_calls = [params for url, params in fake.calls if url.endswith("/clips")]
    assert clip_calls[0]["broadcaster_id"] == "641972806" and clip_calls[0]["started_at"] == "2026-11-24T17:36:25Z"
    assert clip_calls[1]["after"] == "next"
    assert "3 clips" in capsys.readouterr().out


def test_fetch_clips_needs_credentials(monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)  # no .env here
    monkeypatch.delenv("TWITCH_CLIENT_ID", raising=False)
    monkeypatch.delenv("TWITCH_CLIENT_SECRET", raising=False)
    assert main(["fetch-clips", "--id", "1"]) == 2
    assert "TWITCH_CLIENT_ID" in capsys.readouterr().err
