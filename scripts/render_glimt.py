#!/usr/bin/env python3
"""Render every line of a Glimt chapter via ElevenLabs v4.

One mp3 per line id, written to audio/glimt/vega/<chapter>/<line>.mp3.
Lines listed under "otherVoiceLines" use the second voice. An episode with
more voices names them under "voices" and maps lines to them in "lineVoices";
"voiceSettings" overrides the render settings per voice.

The chapter's "language" (default "sv") is the language code sent with each
line: "en" for the English episode.

Idempotent: existing files are skipped. Re-render everything with --force,
or a single line with --only <id>.

Usage:
    python3 scripts/render_glimt.py stories/glimt/kapitel-1.json [--force] [--only s3-1]

Model: eleven_v4 since 2026-10-28 (Henric). v4 reads the direction as free
tags in the text ([whispers], [dry, quietly pleased], [pause]) and has no
style or speed setting, so only "stability" is sent from a voice's settings.
The manuscript room's directing desk (rummet/) renders single takes through
render() as well, from the portal (scripts/dashboard/glimt_regi.py in
generalassistant), so a change of model here changes both.

A voice whose settings say "denoise": true gets a local noise filter after
ElevenLabs (DENOISE, ffmpeg's afftdn): Jessica, Vega's voice since 29/10,
carries a hiss from the recording she was cloned from, -76 dBFS in her pauses,
that no voice setting moves (measured 29/10). The filter takes about 11 dB of
it and about 1.5 dB of her breaths. afftdn delays its output by DENOISE_DELAY,
so that much is cut from the start and padded at the end: the line keeps its
length and its words stay where they were. The desk's takes go through the
same render(), so they come out clean too.

Requires ELEVENLABS_API_KEY in ~/generalassistant/.env.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import requests
    from dotenv import load_dotenv
except ImportError:
    sys.exit("Install deps: pip install -r scripts/requirements.txt")

REPO = Path(__file__).resolve().parents[1]
ENV_FILE = Path.home() / "generalassistant" / ".env"

MODEL_ID = "eleven_v4"
OUTPUT_FORMAT = "mp3_44100_128"
VOICE_SETTINGS = {"stability": 0.5}
# What v4 takes of a voice's settings; style, speed and the rest are not v4's.
V4_SETTINGS = ("stability",)
# The local filter for a voice with "denoise": true (Henric 29/10: nr=12).
DENOISE = "afftdn=nr=12:nf=-72:tn=1"
DENOISE_DELAY = 1102  # samples at 44.1 kHz (25.0 ms), measured by cross-correlation 29/10


class RenderFel(RuntimeError):
    """ElevenLabs said no. The message is safe to show: it never holds the key."""


def voice_for(chapter: dict, line_id: str) -> str:
    """Name of the voice (a key in chapter["voices"]) that speaks a line."""
    named = chapter.get("lineVoices", {}).get(line_id)
    if named:
        return named
    return "other" if line_id in chapter.get("otherVoiceLines", []) else "vega"


def denoise(audio: bytes) -> bytes:
    """The mp3 through DENOISE, the filter's delay taken back, as mp3 again
    (44.1 kHz mono, 128 kbit/s constant, like ElevenLabs' own)."""
    with tempfile.TemporaryDirectory(prefix="glimt-denoise-") as td:
        src, dst = Path(td) / "in.mp3", Path(td) / "out.mp3"
        src.write_bytes(audio)
        try:
            res = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                 "-af", f"aresample=44100,apad=pad_len={DENOISE_DELAY},{DENOISE},atrim=start_sample={DENOISE_DELAY},asetpts=N/SR/TB",
                 "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", str(dst)],
                capture_output=True, text=True, timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            raise RenderFel(f"the noise filter failed: {e}") from e
        if res.returncode != 0 or not dst.exists() or dst.stat().st_size < 1000:
            raise RenderFel(f"the noise filter failed: {res.stderr.strip()[:300]}")
        return dst.read_bytes()


def render(api_key: str, voice_id: str, text: str, settings: dict | None = None, language: str = "sv") -> bytes:
    clean = (settings or {}).get("denoise") is True
    settings = {k: v for k, v in {**VOICE_SETTINGS, **(settings or {})}.items() if k in V4_SETTINGS}
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        params={"output_format": OUTPUT_FORMAT},
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": MODEL_ID,
            "language_code": language,
            "voice_settings": settings,
        },
        timeout=300,
    )
    if not resp.ok:
        raise RenderFel(f"ElevenLabs error {resp.status_code} for {voice_id}: {resp.text[:500]}")
    return denoise(resp.content) if clean else resp.content


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

    if args.only and args.only not in chapter["lines"]:
        sys.exit(f"no line {args.only!r} in {args.chapter}")

    billed = 0
    for line_id, text in chapter["lines"].items():
        if args.only and line_id != args.only:
            continue
        out = out_dir / f"{line_id}.mp3"
        if out.exists() and not args.force:
            print(f"skip  {out.relative_to(REPO)}")
            continue
        name = voice_for(chapter, line_id)
        if name not in chapter["voices"]:
            sys.exit(f"line {line_id} wants voice {name!r}, missing under voices")
        settings = chapter.get("voiceSettings", {}).get(name)
        try:
            audio = render(api_key, chapter["voices"][name], text, settings, chapter.get("language", "sv"))
        except RenderFel as e:
            sys.exit(str(e))
        out.write_bytes(audio)
        billed += len(text)
        print(f"wrote {out.relative_to(REPO)} ({len(audio) // 1024} KB)")
    print(f"done: {billed} characters billed")


if __name__ == "__main__":
    main()
