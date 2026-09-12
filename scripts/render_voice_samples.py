#!/usr/bin/env python3
"""Render Vega's opening lines with several candidate voices, to pick one by ear.

Everything except the voice is held constant: same text, same model, same
voice settings. Output goes to rostprov/<slug>.mp3 next to a listening page.

Usage:
    python3 scripts/render_voice_samples.py [--force]

Requires ELEVENLABS_API_KEY in ~/generalassistant/.env.
"""
import argparse
import os
import sys
from pathlib import Path

try:
    import requests
    from dotenv import load_dotenv
except ImportError:
    sys.exit("Install deps: pip install -r scripts/requirements.txt")

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "rostprov"
ENV_FILE = Path.home() / "generalassistant" / ".env"

MODEL_ID = "eleven_v3"
OUTPUT_FORMAT = "mp3_44100_128"
# v3 takes discrete stability steps: 0.0 creative, 0.5 natural, 1.0 robust.
# Set explicitly so each voice's own stored defaults cannot differ between
# candidates.
VOICE_SETTINGS = {"stability": 0.5}

# Scene 0 and the start of scene 1 from stories/glimt/kapitel-1.md, with v3
# audio tags. Tags are English because that is the vocabulary v3 is
# documented with; they are performance directions and are not spoken
# (verified 2026-09-11 by transcribing a tagged render back).
SAMPLE_TEXT = (
    "[nervously] ...där. Där är du. Nej, gå inte. Vänta. Gå. Gå! "
    "Det är när du går jag hör dig.\n\n"
    "[quietly] Jag vet inte vem du är. Jag hör bara steg. Dina steg. "
    "De är det enda som låter som något härifrån. Fortsätt gå. Snälla.\n\n"
    "[calmly] Så. Nu är du tydlig. Jag var ute och gick. Samma som du. "
    "En helt vanlig kväll. Och så tystnade allt. Inte mörkt. "
    "[whispers] Tyst. Som om någon dragit ur en sladd."
)

# Swedish female voices from the shared library, none with a Stockholm
# accent. Vega is "hon" in the script.
CANDIDATES = [
    ("elin", "4Ct5uMEndw4cJ7q0Jx0l", "Elin", "Varm, känslomässigt nyanserad"),
    ("elin-assured", "qR801wfGbt4yozOoeFIY", "Elin, självsäker", "Distinkt, stadig rytm"),
    ("karin", "2z4pujvcLHrr5ilDhLnD", "Karin", "Lugn, jämn, mjuk"),
    ("maria", "cO6h9P4dtHr7hXjE8ofa", "Maria", "Varm och trygg"),
]


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
    parser.add_argument("--force", action="store_true", help="re-render existing files")
    args = parser.parse_args()

    load_dotenv(ENV_FILE)
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        sys.exit(f"ELEVENLABS_API_KEY missing in {ENV_FILE}")

    OUT_DIR.mkdir(exist_ok=True)
    billed = 0
    for slug, voice_id, name, _ in CANDIDATES:
        out = OUT_DIR / f"{slug}.mp3"
        if out.exists() and not args.force:
            print(f"skip  {out.relative_to(REPO)} (exists)")
            continue
        audio = render(api_key, voice_id, SAMPLE_TEXT)
        out.write_bytes(audio)
        billed += len(SAMPLE_TEXT)
        print(f"wrote {out.relative_to(REPO)} ({len(audio) // 1024} KB) {name}")
    print(f"done: {billed} characters billed (model {MODEL_ID})")


if __name__ == "__main__":
    main()
