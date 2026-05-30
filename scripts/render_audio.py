#!/usr/bin/env python3
"""Render scene audio via OpenAI TTS API.

Idempotent: skips scenes whose audio file already exists.
Re-render: delete the audio file first.

Why OpenAI over ElevenLabs: cheaper per character, decent Swedish on tts-1.
Switch back to ElevenLabs when its credit pool refills (see git history).

Voice: shimmer (soft female narrator). Other options: alloy, echo, fable, onyx, nova.
"""
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

MODEL = "tts-1"  # or "tts-1-hd" for higher quality at 2x cost
VOICE = "shimmer"
FORMAT = "mp3"


def main():
    load_dotenv(ENV_FILE)
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        sys.exit(f"OPENAI_API_KEY missing in {ENV_FILE}")

    with open(SCENES_FILE) as f:
        data = json.load(f)

    for scene in data["scenes"]:
        out_path = REPO / scene["audioFile"]
        if out_path.exists():
            print(f"skip  {out_path.relative_to(REPO)} (exists)")
            continue
        out_path.parent.mkdir(parents=True, exist_ok=True)

        resp = requests.post(
            "https://api.openai.com/v1/audio/speech",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "input": scene["text"],
                "voice": VOICE,
                "response_format": FORMAT,
            },
            timeout=120,
        )
        if not resp.ok:
            sys.exit(f"OpenAI error {resp.status_code}: {resp.text}")
        out_path.write_bytes(resp.content)
        print(f"wrote {out_path.relative_to(REPO)} ({len(resp.content)//1024} KB)")


if __name__ == "__main__":
    main()
