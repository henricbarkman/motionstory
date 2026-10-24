#!/usr/bin/env python3
"""Check a rendered Glimt chapter without ears.

For every line in the chapter JSON:
  - the mp3 exists, and its length is measured with ffprobe
  - (with --listen) ElevenLabs Scribe transcribes it, and the words are
    compared with the script, so a line that came out as something else,
    or with a stage direction read aloud, is caught before anyone walks it

Writes the measured lengths back into the JSON under "seconds", and the word
offsets named under "cueWords" into "cues" (episode 1 needs to know when the
word "trettio" falls inside the counting line). A cue word written "last:nu"
is the last "nu" of the line, not the first. The tests read both.

With --listen it also measures where a line may stop early: for each line
named under "breakFrom", the pauses between two of its sentences from the
named word on, as "breaks" (seconds into the file). A break is a sentence end
in the script (. ! ? …) where the file is silent, the Scribe words on both
sides of it, and a margin kept clear of the sound at each edge. Episode 1 ends
a line that asks the walker to go at the next of them once the walker goes.
A sentence end after the named word with no silence measured is reported.
Each line's pauses are stamped with the length of the take they were measured
on ("breaksMeasuredOn"): a line rendered again and measured without --listen
is reported, for its pauses are where the old take had them.

Usage:
    python3 scripts/check_glimt_audio.py stories/glimt/episod-1.json [--listen [--cached]] [--only s3-3[,s3-4]]

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
SILENCE_DB = -40   # dBFS: quieter than this is a pause between her words
SILENCE_MIN = 0.15  # s: a shorter silence is the space inside a phrase, not a pause
BREAK_MARGIN = 0.06  # s kept clear of the sound at each edge of a pause
BREAK_MIN = 0.12   # s: what is left of a pause must hold the fade and a tick's lead
SENTENCE_END = re.compile(r"[.!?…]")


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


def silences(path: Path) -> list[tuple[float, float]]:
    """The silent stretches of a file, (start, end) in seconds, as ffmpeg hears them."""
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", f"silencedetect=noise={SILENCE_DB}dB:d={SILENCE_MIN}", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    starts = [float(x) for x in re.findall(r"silence_start: (-?[0-9.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", err)]
    if len(ends) < len(starts):
        ends.append(seconds(path))  # silent to the end of the file
    return [(max(0.0, a), b) for a, b in zip(starts, ends)]


def script_tokens(text: str) -> list[tuple[str, str, bool]]:
    """(token as written, spoken word, ends a sentence) for each word of a script line."""
    text = re.sub(r"\[[^\]]*\]", " ", text)
    out = []
    for tok in re.findall(r"[0-9a-zåäöéA-ZÅÄÖÉ]+[^\s0-9a-zåäöéA-ZÅÄÖÉ]*", text):
        word = words(tok)[0]
        out.append((tok, word, bool(SENTENCE_END.search(tok[len(word):]))))
    return out


def breaks(text: str, heard: dict, quiet: list[tuple[float, float]], from_word: str) -> tuple[list[dict], list[str]]:
    """Where a line may stop early, from `from_word` on: see the module docstring."""
    script = script_tokens(text)
    spoken = [t[1] for t in script]
    if from_word not in spoken:
        return [], [f"break word {from_word!r} not in the script"]
    first = spoken.index(from_word)
    timed = []
    for w in heard.get("words", []):
        if w.get("type") == "word":
            timed += [(x, float(w["start"]), float(w["end"])) for x in words(w.get("text", ""))]
    at = {}
    matcher = difflib.SequenceMatcher(None, spoken, [x for x, _, _ in timed], autojunk=False)
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            at[block.a + k] = timed[block.b + k][1:]
    found, problems = [], []
    for i in range(max(0, first - 1), len(script) - 1):
        if not script[i][2]:
            continue
        said = " ".join(t[0] for t in script[:i + 1])
        if i not in at or i + 1 not in at:
            problems.append(f"after {said!r}: Scribe did not hear the words on both sides")
            continue
        end, start = at[i][1], at[i + 1][0]
        mid = (end + start) / 2
        pause = next(((a, b) for a, b in quiet if a <= max(mid, end) and b >= min(mid, start)), None)
        if pause is None:
            problems.append(f"after {said!r}: no silence between {end:.2f} and {start:.2f} s")
            continue
        lo, hi = pause[0] + BREAK_MARGIN, pause[1] - BREAK_MARGIN
        if hi - lo < BREAK_MIN:
            problems.append(f"after {said!r}: the pause {pause[0]:.2f}-{pause[1]:.2f} s is too short")
            continue
        found.append({"from": round(lo, 2), "to": round(hi, 2), "said": said})
    return found, problems


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
    only = set(args.only.split(",")) if args.only else None
    ids = [i for i in chapter["lines"] if not only or i in only]
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
    found_breaks = dict(chapter.get("breaks", {}))
    measured_on = dict(chapter.get("breaksMeasuredOn", {}))
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
                # "last:nu" is the last "nu" in the line: "när jag säger nu. Nu."
                last = cue_word.startswith("last:")
                bare = cue_word.removeprefix("last:")
                hits = [w for w in result.get("words", [])
                        if w.get("type") == "word" and words(w.get("text", "")) == [bare]]
                hit = (hits[-1] if last else hits[0]) if hits else None
                if hit is None:
                    problems.append(f"{line_id}: cue word {cue_word!r} not heard")
                else:
                    cues.setdefault(line_id, {})[cue_word] = round(float(hit["start"]), 2)
            from_word = chapter.get("breakFrom", {}).get(line_id)
            if from_word:
                found, trouble = breaks(chapter["lines"][line_id], result, silences(audio_dir / f"{line_id}.mp3"), from_word)
                found_breaks[line_id] = found
                measured_on[line_id] = lengths[line_id]
                problems += [f"{line_id}: {t}" for t in trouble]
                for b in found:
                    print(f"     {'':16} break {b['from']:.2f}-{b['to']:.2f} s after {b['said']!r}")
                if not found:
                    print(f"     {'':16} no break: the line is said to its end")
    else:
        for line_id in ids:
            if line_id in lengths:
                print(f"     {line_id:16} {lengths[line_id]:6.2f}s")

    for line_id in found_breaks:
        if line_id in lengths and measured_on.get(line_id) != lengths[line_id]:
            problems.append(f"{line_id}: its pauses were measured on a take of {measured_on.get(line_id)} s, "
                            f"the file is {lengths[line_id]} s: measure them again with --listen")

    chapter["seconds"] = {i: lengths[i] for i in chapter["lines"] if i in lengths}
    if cues:
        chapter["cues"] = cues
    if found_breaks:
        chapter["breaks"] = {i: found_breaks[i] for i in chapter["lines"] if i in found_breaks}
        chapter["breaksMeasuredOn"] = {i: measured_on[i] for i in chapter["breaks"] if i in measured_on}
    args.chapter.write_text(json.dumps(chapter, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = sum(chapter["seconds"].values())
    print(f"\n{len(chapter['seconds'])} of {len(chapter['lines'])} lines measured, {total:.0f} s of audio in all")
    for problem in problems:
        print("PROBLEM", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
