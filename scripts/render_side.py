#!/usr/bin/env python3
"""Make the sounds of Vega's side for a Glimt episode: her steps, the other
woman's steps, a hand against the plastic tree.

Each entry under "sfx" in the episode JSON is generated once with ElevenLabs
sound effects and written to audio/glimt/side/<file>. A clip marked
"steps": true is then cut into single steps: the script finds each footfall
in the clip and writes its [start, length] in seconds under "slices". The app
plays those slices one at a time, so it decides the pace and can stop her
mid-walk; the clip itself is never looped.

The hum, the lamp tone and the bell are not here. They are synthesised in the
browser (glimt/herside.js).

Idempotent: existing files are kept and only re-measured. --force renders
again, --only <name> limits it to one sound.

Usage:
    python3 scripts/render_side.py stories/glimt/episod-1.json [--force] [--only grus]

Requires ELEVENLABS_API_KEY in ~/generalassistant/.env, ffmpeg and numpy.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
ENV_FILE = Path.home() / "generalassistant" / ".env"
OUT_DIR = REPO / "audio" / "glimt" / "side"
RATE = 22050
FRAME = 0.01          # envelope resolution, seconds
MIN_GAP = 0.28        # two footfalls are never closer than this
MAX_SLICE = 0.7       # a step is cut off here even if the next one is late
LEAD = 0.03           # keep this much before the onset, so the attack survives


def generate(api_key: str, prompt: str, seconds: float) -> bytes:
    import requests

    resp = requests.post(
        "https://api.elevenlabs.io/v1/sound-generation",
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json={"text": prompt, "duration_seconds": seconds, "prompt_influence": 0.6},
        timeout=300,
    )
    if not resp.ok:
        sys.exit(f"ElevenLabs error {resp.status_code}: {resp.text[:300]}")
    return resp.content


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(RATE),
         "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def envelope(samples: np.ndarray) -> np.ndarray:
    hop = int(RATE * FRAME)
    frames = samples[: len(samples) // hop * hop].reshape(-1, hop)
    return np.sqrt((frames ** 2).mean(axis=1))


def find_steps(samples: np.ndarray) -> list[list[float]]:
    """[start, length] of every footfall, from the loudness envelope."""
    env = envelope(samples)
    smooth = np.convolve(env, np.ones(5) / 5, mode="same")
    floor = float(np.percentile(smooth, 30))
    top = float(np.percentile(smooth, 99))
    gate = floor + 0.35 * (top - floor)
    gap = int(MIN_GAP / FRAME)

    peaks = []
    for i in range(1, len(smooth) - 1):
        if smooth[i] < gate or smooth[i] < smooth[i - 1] or smooth[i] < smooth[i + 1]:
            continue
        if peaks and i - peaks[-1] < gap:
            if smooth[i] > smooth[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)

    onsets = []
    for p in peaks:
        low = floor + 0.15 * (smooth[p] - floor)
        i = p
        while i > 0 and p - i < int(0.2 / FRAME) and smooth[i] > low:
            i -= 1
        onsets.append(max(0.0, i * FRAME - LEAD))

    total = len(samples) / RATE
    slices = []
    for n, start in enumerate(onsets):
        end = onsets[n + 1] - 0.01 if n + 1 < len(onsets) else total
        length = min(MAX_SLICE, end - start)
        if length >= 0.15:
            slices.append([round(start, 3), round(length, 3)])
    return slices


def describe(samples: np.ndarray) -> dict:
    peak = float(np.abs(samples).max()) if len(samples) else 0.0
    rms = float(np.sqrt((samples ** 2).mean())) if len(samples) else 0.0
    return {"seconds": round(len(samples) / RATE, 2), "peak": round(peak, 3), "rms": round(rms, 4)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("episode", type=Path)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--only", help="just this sound")
    args = parser.parse_args()

    episode = json.loads(args.episode.read_text(encoding="utf-8"))
    sounds = episode.get("sfx", {})
    if args.only and args.only not in sounds:
        sys.exit(f"no sound {args.only!r} in {args.episode}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    api_key = None
    problems = []
    for name, spec in sounds.items():
        if args.only and name != args.only:
            continue
        out = OUT_DIR / spec["file"]
        if args.force or not out.exists():
            if api_key is None:
                from dotenv import load_dotenv

                load_dotenv(ENV_FILE)
                api_key = os.environ.get("ELEVENLABS_API_KEY")
                if not api_key:
                    sys.exit(f"ELEVENLABS_API_KEY missing in {ENV_FILE}")
            out.write_bytes(generate(api_key, spec["prompt"], spec["seconds"]))
            print(f"wrote {out.relative_to(REPO)} ({out.stat().st_size // 1024} KB)")
        samples = decode(out)
        spec["measured"] = describe(samples)
        line = f"{name:8} {spec['measured']}"
        if spec.get("steps"):
            spec["slices"] = find_steps(samples)
            gaps = np.diff([s[0] for s in spec["slices"]])
            pace = f", median gap {np.median(gaps):.2f} s" if len(gaps) else ""
            line += f"  {len(spec['slices'])} steps{pace}"
            if len(spec["slices"]) < 4:
                problems.append(f"{name}: only {len(spec['slices'])} steps found, the walk would sound like a loop")
        print(line)

    args.episode.write_text(json.dumps(episode, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for problem in problems:
        print("PROBLEM", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
