from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from .models import Moment


def _clock(seconds: float) -> str:
    minutes, second = divmod(int(seconds), 60)
    hour, minute = divmod(minutes, 60)
    return f"{hour:02d}:{minute:02d}:{second:02d}"


def write_reports(platform: str, video_id: str, moments: list[Moment], output_directory: Path) -> tuple[Path, Path]:
    output_directory.mkdir(parents=True, exist_ok=True)
    stem = f"{platform}-{video_id}-moments"
    json_path = output_directory / f"{stem}.json"
    markdown_path = output_directory / f"{stem}.md"
    json_path.write_text(json.dumps({"platform": platform, "video_id": video_id, "moments": [asdict(moment) for moment in moments]}, indent=2), encoding="utf-8")
    lines = [f"# Stream moments: {platform} / {video_id}", "", f"Found {len(moments)} candidate moment(s).", ""]
    for number, moment in enumerate(moments, 1):
        lines.extend([f"## {number}. {_clock(moment.timestamp)}", "", f"- Chat: {moment.message_count} messages (z-score {moment.z_score})", f"- Keywords: {', '.join(moment.keywords) or '—'}", f"- Samples: {' | '.join(moment.sample_messages)}"])
        if moment.frame_path:
            lines.append(f"- Frame: `{moment.frame_path}`")
        if moment.visual_labels:
            labels = ", ".join(f"{item['label']} ({item['confidence']})" for item in moment.visual_labels)
            lines.append(f"- Visual labels: {labels}")
        if moment.reaction_type:
            lines.append(f"- Reaction attribution: {moment.reaction_type} (alignment {moment.alignment_score})")
        if moment.causal_explanation:
            lines.append(f"- Evidence-grounded explanation: {moment.causal_explanation}")
        lines.append("")
    markdown_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, markdown_path
