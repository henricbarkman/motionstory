#!/usr/bin/env python3
"""Render every line of a Glimt chapter via ElevenLabs v3.

One mp3 per line id, written to audio/glimt/vega/<chapter>/<line>.mp3.
Lines listed under "otherVoiceLines" use the second voice.

Idempotent: existing files are skipped. Re-render everything with --force,
or a single line with --only <id>.

Usage:
    python3 scripts/render_glimt.py stories/glimt/kapitel-1.json [--force] [--only s3-1]

Requires ELEVENLABS_API_KEY in ~/generalassistant/.env.
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
ENV_FILE = Path.home() / "generalassistant" / ".env"

MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"
VOICE_SETTINGS = {"stability": 0.5}


def render(api_key: str, voice_id: str, text: str) -> bytes:
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        params={"output_format": OUTPUT_FORMAT},
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": MODEL_ID,
            "language_code": "sv",
            "voice_settings": VOICE_SETTINGS,
        },
        timeout=300,
    )
    if not resp.ok:
        sys.exit(f"ElevenLabs error {resp.status_code} for {voice_id}: {resp.text}")
    return resp.content


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("chapter", type=Path)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--only", help="render just this line id")
    args = parser.parse_args()

    load_dotenv(ENV_FILE)
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        sys.exit(f"ELEVENLABS_API_KEY missing in {ENV_FILE}")

    chapter = json.loads(args.chapter.read_text(encoding="utf-8"))
    out_dir = REPO / "audio" / "glimt" / "vega" / chapter["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    other = set(chapter.get("otherVoiceLines", []))

    billed = 0
    for line_id, text in chapter["lines"].items():
        if args.only and line_id != args.only:
            continue
        out = out_dir / f"{line_id}.mp3"
        if out.exists() and not args.force:
            print(f"skip  {out.relative_to(REPO)}")
            continue
        voice = chapter["voices"]["other" if line_id in other else "vega"]
        audio = render(api_key, voice, text)
        out.write_bytes(audio)
        billed += len(text)
        print(f"wrote {out.relative_to(REPO)} ({len(audio) // 1024} KB)")
    print(f"done: {billed} characters billed")


if __name__ == "__main__":
    main()
