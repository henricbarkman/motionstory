#!/usr/bin/env python3
"""Render scene audio via ElevenLabs text-to-speech.

Idempotent: skips scenes whose audio file already exists.
Re-render everything with --force, or delete a single file first.

Usage:
    python3 scripts/render_audio.py [--force] [--voice VOICE_ID] [--model MODEL_ID]

Voice default: Louise (calm Swedish narrator, Stockholm accent). Other Swedish
narrators in the account library: "Adam Composer Stockholm" (male), "Hans O.
Karlsson" (male). List voices: GET https://api.elevenlabs.io/v1/voices.

Model default: eleven_multilingual_v2. Audio is rendered once and shipped as
files, so latency does not matter and the highest-quality model is the right
pick. Flash/turbo are for live speech.

Requires ELEVENLABS_API_KEY in ~/generalassistant/.env.

History: toy v0 (2026-05-30) was rendered with OpenAI tts-1 because the
ElevenLabs credit pool was empty at the time. Switched back 2026-09-10.
"""
import argparse
import json
import os
import sys
from pathlib import Path

try:
    import requests
    from dotenv import load_dotenv
except ImportError:
    sys.exit("Install deps: pip install -r scripts/requirements.txt")

REPO = Path(__file__).resolve().parents[1]
SCENES_FILE = REPO / "stories" / "pilgrimsvagen" / "scenes.json"
ENV_FILE = Path.home() / "generalassistant" / ".env"

DEFAULT_VOICE_ID = "kpTdKfohzvarfFPnwuHW"  # Louise - Calm & Clear Narration
DEFAULT_MODEL_ID = "eleven_multilingual_v2"
OUTPUT_FORMAT = "mp3_44100_128"

# Calm narration: fairly stable delivery, little exaggeration.
VOICE_SETTINGS = {
    "stability": 0.55,
    "similarity_boost": 0.75,
    "style": 0.15,
    "use_speaker_boost": True,
}


def render_scene(api_key: str, voice_id: str, model_id: str, text: str) -> bytes:
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        params={"output_format": OUTPUT_FORMAT},
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "text": text,
            "model_id": model_id,
            "language_code": "sv",
            "voice_settings": VOICE_SETTINGS,
        },
        timeout=180,
    )
    if not resp.ok:
        sys.exit(f"ElevenLabs error {resp.status_code}: {resp.text}")
    return resp.content


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true", help="re-render existing files")
    parser.add_argument("--voice", default=DEFAULT_VOICE_ID, help="ElevenLabs voice id")
    parser.add_argument("--model", default=DEFAULT_MODEL_ID, help="ElevenLabs model id")
    args = parser.parse_args()

    load_dotenv(ENV_FILE)
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        sys.exit(f"ELEVENLABS_API_KEY missing in {ENV_FILE}")

    with open(SCENES_FILE, encoding="utf-8") as f:
        data = json.load(f)

    total_chars = 0
    for scene in data["scenes"]:
        out_path = REPO / scene["audioFile"]
        if out_path.exists() and not args.force:
            print(f"skip  {out_path.relative_to(REPO)} (exists)")
            continue
        out_path.parent.mkdir(parents=True, exist_ok=True)
        audio = render_scene(api_key, args.voice, args.model, scene["text"])
        out_path.write_bytes(audio)
        total_chars += len(scene["text"])
        print(f"wrote {out_path.relative_to(REPO)} ({len(audio) // 1024} KB)")

    print(f"done: {total_chars} characters billed (voice {args.voice}, model {args.model})")


if __name__ == "__main__":
    main()
