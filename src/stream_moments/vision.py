"""Optional multimodal enrichment for chat-derived stream moments.

CLIP gives open-vocabulary visual labels for an extracted frame.  The
attribution layer combines those labels with nearby chat, then can ask Gemini
to turn this grounded evidence into a concise reviewer-facing explanation.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .models import ChatMessage

VISUAL_PROMPTS = (
    "a streamer laughing or visibly excited", "a streamer shocked or surprised",
    "a streamer frustrated or angry", "a streamer sad or disappointed",
    "a streamer celebrating or cheering", "a competitive gameplay victory",
    "a game over or player elimination", "a difficult gameplay skill or combo",
    "a close call or near miss in gameplay", "a boss fight or intense game moment",
    "a game scoreboard or results screen", "a rare item or reward appearing",
    "a jump scare or sudden surprise", "a sudden scene transition",
    "a donation or subscriber alert", "an announcement or title card",
    "a countdown timer", "a chat overlay", "a technical error or crash",
    "a blank or black screen", "a browser or desktop on screen",
    "a person reacting to a video", "a news or social media post",
    "multiple people talking together", "a person reading chat",
    "a musical performance", "a drawing or artwork being created",
    "a cooking or food scene", "an outdoor or travel scene",
    "a crowded event or convention", "a stream intro sequence",
    "a facecam with gameplay", "a cinematic cutscene", "a calm conversation",
)
EMOTES = {"kekw", "omegalul", "lulw", "pog", "pogchamp", "monkas", "sadge", "copium", "pepe", "widepeepo"}
STOP_WORDS = {"the", "and", "that", "this", "with", "what", "for", "you", "are", "was", "but", "have", "just"}


@dataclass(frozen=True)
class Attribution:
    reaction_type: str
    alignment_score: float


class ClipClassifier:
    """Lazy OpenCLIP classifier; dependencies are required only for --visual-analysis."""

    def __init__(self, prompts: tuple[str, ...] = VISUAL_PROMPTS) -> None:
        try:
            import open_clip
            import torch
            from PIL import Image  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("Install visual dependencies with 'pip install -e .[vision]'.") from exc
        self._torch = torch
        self._open_clip = open_clip
        self._prompts = prompts
        self._model, _, self._preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
        self._tokenizer = open_clip.get_tokenizer("ViT-B-32")
        self._model.eval()

    def classify(self, image_path: Path, limit: int = 3) -> list[dict[str, float | str]]:
        from PIL import Image
        with self._torch.no_grad():
            image = self._preprocess(Image.open(image_path).convert("RGB")).unsqueeze(0)
            text = self._tokenizer(list(self._prompts))
            image_features = self._model.encode_image(image)
            text_features = self._model.encode_text(text)
            image_features /= image_features.norm(dim=-1, keepdim=True)
            text_features /= text_features.norm(dim=-1, keepdim=True)
            probabilities = (100 * image_features @ text_features.T).softmax(dim=-1)[0]
            values, indices = probabilities.topk(min(limit, len(self._prompts)))
        return [{"label": self._prompts[index], "confidence": round(float(value), 3)} for value, index in zip(values.tolist(), indices.tolist())]


def attribute_reaction(chat_messages: list[ChatMessage], visual_labels: list[dict[str, float | str]]) -> Attribution:
    """Classify why chat reacted using only transparent chat/visual evidence."""
    chat_words = Counter(word.lower() for message in chat_messages for word in re.findall(r"[A-Za-z][A-Za-z0-9_']+", message.text) if word.lower() not in STOP_WORDS)
    visual_words = {word.lower() for item in visual_labels for word in re.findall(r"[A-Za-z]+", str(item["label"])) if word.lower() not in STOP_WORDS}
    overlap = sum(count for word, count in chat_words.items() if word in visual_words)
    total = sum(chat_words.values()) or 1
    alignment = round(min(1.0, overlap / total * 3), 2)
    emote_ratio = sum(1 for message in chat_messages if any(token in message.text.lower().split() for token in EMOTES)) / max(1, len(chat_messages))
    reaction_type = "content" if alignment >= 0.35 else "emotional" if emote_ratio >= 0.4 else "auditory" if alignment < 0.12 else "ambiguous"
    return Attribution(reaction_type, alignment)


def gemini_explanation(settings: Settings, visual_labels: list[dict[str, float | str]], chat_messages: list[ChatMessage], attribution: Attribution) -> str:
    """Request an explanation grounded in CLIP results and chat; never sends credentials to the frontend."""
    if not settings.gemini_api_key or not settings.gemini_model or settings.gemini_model.startswith("your_"):
        raise RuntimeError("Set GEMINI_API_KEY and GEMINI_MODEL in .env to enable Gemini explanations.")
    try:
        import requests
    except ImportError as exc:
        raise RuntimeError("Install project dependencies with 'pip install -e .' before using Gemini explanations.") from exc
    evidence = {"visual_labels": visual_labels, "chat_sample": [message.text for message in chat_messages[:8]], "heuristic_reaction_type": attribution.reaction_type, "alignment_score": attribution.alignment_score}
    prompt = ("You are explaining a livestream audience reaction for an editor. Use only the supplied evidence; do not claim causes not supported by it. "
              "Return one concise sentence describing what was likely visible and why viewers reacted. Evidence: " + json.dumps(evidence))
    response = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent", headers={"Content-Type": "application/json", "x-goog-api-key": settings.gemini_api_key}, json={"contents": [{"parts": [{"text": prompt}]}]}, timeout=45)
    response.raise_for_status()
    try:
        return response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("Gemini returned no usable explanation.") from exc
