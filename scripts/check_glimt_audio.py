#!/usr/bin/env python3
"""Check a rendered Glimt chapter without ears.

For every line in the chapter JSON:
  - the mp3 exists, and its length is measured with ffprobe
  - (with --listen) ElevenLabs Scribe transcribes it, and the words are
    compared with the script, so a line that came out as something else,
    or with a stage direction read aloud, is caught before anyone walks it

Writes the measured lengths back into the JSON under "seconds", and the word
offsets named under "cueWords" into "cues" (episode 1 needs to know when the
word "trettio" falls inside the counting line). The tests read both.

Usage:
    python3 scripts/check_glimt_audio.py stories/glimt/episod-1.json [--listen [--cached]] [--only s3-3]

--listen needs ELEVENLABS_API_KEY in ~/generalassistant/.env and is billed as
speech-to-text. Transcripts are kept in ~/.cache/demi-scratch/glimt-listen/,
and --cached reads a kept one again when it is newer than its mp3: a new cue
word costs nothing to measure.
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENV_FILE = Path.home() / "generalassistant" / ".env"
SCRATCH = Path.home() / ".cache" / "demi-scratch" / "glimt-listen"
STT_MODELS = ("scribe_v2", "scribe_v1")
MATCH_FLOOR = 0.8  # below this a line is reported as not matching its script


def seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return round(float(out), 2)


def words(text: str) -> list[str]:
    """Spoken words of a script line: tags out, punctuation out, lower case."""
    text = re.sub(r"\[[^\]]*\]", " ", text)
    return re.findall(r"[0-9a-zåäöé]+", text.lower())


def transcribe(api_key: str, path: Path) -> dict:
    import requests

    last = None
    for model in STT_MODELS:
        with path.open("rb") as fh:
            resp = requests.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": api_key},
                data={"model_id": model, "language_code": "sv",
                      "timestamps_granularity": "word", "tag_audio_events": "true"},
                files={"file": (path.name, fh, "audio/mpeg")},
                timeout=300,
            )
        if resp.ok:
            return resp.json()
        last = f"{resp.status_code} {resp.text[:200]}"
    raise RuntimeError(f"speech-to-text failed for {path.name}: {last}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("chapter", type=Path)
    parser.add_argument("--listen", action="store_true")
    parser.add_argument("--cached", action="store_true", help="with --listen: reuse kept transcripts")
    parser.add_argument("--only", help="check just this line id")
    args = parser.parse_args()

    chapter = json.loads(args.chapter.read_text(encoding="utf-8"))
    audio_dir = REPO / "audio" / "glimt" / "vega" / chapter["id"]
    ids = [i for i in chapter["lines"] if not args.only or i == args.only]
    if not ids:
        sys.exit(f"no line {args.only!r} in {args.chapter}")

    problems = []
    lengths = dict(chapter.get("seconds", {}))
    for line_id in ids:
        path = audio_dir / f"{line_id}.mp3"
        if not path.exists():
            problems.append(f"{line_id}: no file {path.relative_to(REPO)}")
            continue
        lengths[line_id] = seconds(path)

    cues = dict(chapter.get("cues", {}))
    if args.listen:
        from dotenv import load_dotenv

        load_dotenv(ENV_FILE)
        api_key = os.environ.get("ELEVENLABS_API_KEY")
        if not api_key:
            sys.exit(f"ELEVENLABS_API_KEY missing in {ENV_FILE}")
        SCRATCH.mkdir(parents=True, exist_ok=True)
        have = [i for i in ids if (audio_dir / f"{i}.mp3").exists()]

        def listen(line_id: str) -> dict:
            mp3 = audio_dir / f"{line_id}.mp3"
            kept = SCRATCH / f"{chapter['id']}-{line_id}.json"
            if args.cached and kept.exists() and kept.stat().st_mtime >= mp3.stat().st_mtime:
                return json.loads(kept.read_text(encoding="utf-8"))
            return transcribe(api_key, mp3)

        with ThreadPoolExecutor(max_workers=4) as pool:
            heard = dict(zip(have, pool.map(listen, have)))
        for line_id in have:
            result = heard[line_id]
            (SCRATCH / f"{chapter['id']}-{line_id}.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
            want = words(chapter["lines"][line_id])
            got = words(result.get("text", ""))
            ratio = difflib.SequenceMatcher(None, want, got).ratio()
            mark = "ok  " if ratio >= MATCH_FLOOR else "DIFF"
            print(f"{mark} {line_id:16} {lengths[line_id]:6.2f}s  {ratio:.2f}  {result.get('text', '').strip()}")
            if ratio < MATCH_FLOOR:
                problems.append(f"{line_id}: heard {ratio:.2f} of the script: {result.get('text', '').strip()!r}")
            for cue_word in chapter.get("cueWords", {}).get(line_id, []):
                hit = next((w for w in result.get("words", [])
                            if w.get("type") == "word" and words(w.get("text", "")) == [cue_word]), None)
                if hit is None:
                    problems.append(f"{line_id}: cue word {cue_word!r} not heard")
                else:
                    cues.setdefault(line_id, {})[cue_word] = round(float(hit["start"]), 2)
    else:
        for line_id in ids:
            if line_id in lengths:
                print(f"     {line_id:16} {lengths[line_id]:6.2f}s")

    chapter["seconds"] = {i: lengths[i] for i in chapter["lines"] if i in lengths}
    if cues:
        chapter["cues"] = cues
    args.chapter.write_text(json.dumps(chapter, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = sum(chapter["seconds"].values())
    print(f"\n{len(chapter['seconds'])} of {len(chapter['lines'])} lines measured, {total:.0f} s of audio in all")
    for problem in problems:
        print("PROBLEM", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
