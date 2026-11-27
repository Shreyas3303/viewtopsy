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
