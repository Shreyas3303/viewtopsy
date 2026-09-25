from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

from .analyzer import find_moments
from .chat import load_chat
from .config import Settings
from .media import download_video, extract_frame, fetch_twitch_chat
from .platforms import get_metadata
from .reports import write_reports
from .vision import ClipClassifier, attribute_reaction, gemini_explanation


def _analyze(args: argparse.Namespace) -> int:
    messages = load_chat(Path(args.chat))
    moments = find_moments(messages, args.window_seconds, args.z_threshold, args.min_messages, args.max_moments)
    visual_requested = args.visual_analysis or args.gemini_explanations
    classifier = ClipClassifier() if visual_requested else None
    settings = Settings.from_environment() if args.gemini_explanations else None
    if visual_requested and not args.video:
        raise ValueError("--video is required for visual analysis and Gemini explanations.")
    if args.video:
        video = Path(args.video)
        if not video.is_file():
            raise FileNotFoundError(f"Video not found: {video}")
        frame_dir = Path(args.frames_dir) / f"{args.platform}-{args.id}"
        enriched = []
        for index, moment in enumerate(moments, 1):
            frame = extract_frame(video, moment.timestamp, frame_dir / f"moment-{index:02d}-{int(moment.timestamp)}s.jpg")
            if classifier:
                visual_labels = classifier.classify(frame)
                local_chat = [message for message in messages if moment.window_start <= message.timestamp < moment.window_end]
                attribution = attribute_reaction(local_chat, visual_labels)
                explanation = gemini_explanation(settings, visual_labels, local_chat, attribution) if args.gemini_explanations else None
                enriched.append(replace(moment, frame_path=str(frame), visual_description=str(visual_labels[0]["label"]), visual_labels=visual_labels, reaction_type=attribution.reaction_type, alignment_score=attribution.alignment_score, causal_explanation=explanation))
            else:
                enriched.append(replace(moment, frame_path=str(frame)))
        moments = enriched
    json_path, markdown_path = write_reports(args.platform, args.id, moments, Path(args.reports_dir))
    print(f"Analyzed {len(messages)} messages; found {len(moments)} candidate moments.")
    print(f"JSON report: {json_path}")
    print(f"Markdown report: {markdown_path}")
    return 0


def _metadata(args: argparse.Namespace) -> int:
    metadata = get_metadata(args.platform, args.id, Settings.from_environment())
    print(f"{metadata.platform}: {metadata.title}\nChannel: {metadata.channel}\nPublished: {metadata.published_at}\nURL: {metadata.url}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="stream-moments", description="Find high-engagement Twitch/YouTube stream moments.")
    commands = parser.add_subparsers(dest="command", required=True)
    analyze = commands.add_parser("analyze", help="Analyze an imported chat JSON/CSV file.")
    analyze.add_argument("--platform", choices=("twitch", "youtube"), required=True)
    analyze.add_argument("--id", required=True, help="Twitch VOD ID or YouTube video ID")
    analyze.add_argument("--chat", required=True, help="JSON/CSV chat export")
    analyze.add_argument("--video", help="Optional local VOD file for FFmpeg thumbnails")
    analyze.add_argument("--window-seconds", type=int, default=15)
    analyze.add_argument("--z-threshold", type=float, default=2.0)
    analyze.add_argument("--min-messages", type=int, default=5)
    analyze.add_argument("--max-moments", type=int, default=25)
    analyze.add_argument("--reports-dir", default="reports")
    analyze.add_argument("--frames-dir", default="data/frames")
    analyze.add_argument("--visual-analysis", action="store_true", help="Classify extracted frames with local OpenCLIP.")
    analyze.add_argument("--gemini-explanations", action="store_true", help="Generate evidence-grounded causal explanations with Gemini; implies visual analysis.")
    analyze.set_defaults(handler=_analyze)
    metadata = commands.add_parser("metadata", help="Fetch public video metadata using configured API credentials.")
    metadata.add_argument("--platform", choices=("twitch", "youtube"), required=True)
    metadata.add_argument("--id", required=True)
    metadata.set_defaults(handler=_metadata)
    twitch_chat = commands.add_parser("fetch-twitch-chat", help="Download Twitch VOD chat with TwitchDownloaderCLI.")
    twitch_chat.add_argument("--id", required=True)
    twitch_chat.add_argument("--output", required=True)
    twitch_chat.set_defaults(handler=lambda args: (fetch_twitch_chat(args.id, Path(args.output)) or 0))
    download = commands.add_parser("download", help="Download a public Twitch/YouTube URL using yt-dlp.")
    download.add_argument("--url", required=True)
    download.add_argument("--output-dir", default="data/downloads")
    download.set_defaults(handler=lambda args: (download_video(args.url, Path(args.output_dir)) or 0))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
