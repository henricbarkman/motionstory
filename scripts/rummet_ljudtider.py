#!/usr/bin/env python3
"""Where each paragraph starts inside a recorded Glimt clip, for the room.

A clip in episod-N.json often holds several manuscript paragraphs, and the
room (rummet/) plays one manuscript line at a time. This lines up each
clip's script with the word times ElevenLabs Scribe gave when the audio was
checked (scripts/check_glimt_audio.py --listen keeps them in
~/.cache/demi-scratch/glimt-listen/), and writes the start of every paragraph
to rummet/ljudtider.json. Only clips with more than one paragraph are listed;
the room guesses from text length for a clip that is missing.

    python3 scripts/rummet_ljudtider.py stories/glimt/episod-1.json [more.json ...]

Costs nothing: it only reads kept transcripts.
"""
from __future__ import annotations

import difflib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRATCH = Path.home() / ".cache" / "demi-scratch" / "glimt-listen"
OUT = REPO / "rummet" / "ljudtider.json"
LEAD = 0.12  # start a little before the first word


def words(text: str) -> list[str]:
    text = re.sub(r"\[[^\]]*\]", " ", text)
    return [w for w in re.sub(r"[^\wåäöÅÄÖéÉ]+", " ", text.lower()).split() if w]


def paragraph_starts(script: str, transcript: dict) -> list[float] | None:
    paras = [p for p in re.split(r"\n\s*\n", script)]
    if len(paras) < 2:
        return None
    heard = [w for w in transcript.get("words", []) if w.get("type") == "word"]
    heard_words = [words(w["text"])[0] if words(w["text"]) else "" for w in heard]
    said: list[str] = []
    first_of: list[int] = []
    for p in paras:
        first_of.append(len(said))
        said.extend(words(p))
    match = difflib.SequenceMatcher(a=said, b=heard_words, autojunk=False)
    where = {}
    for block in match.get_matching_blocks():
        for k in range(block.size):
            where[block.a + k] = block.b + k
    starts = [0.0]
    for n, first in enumerate(first_of[1:], start=1):
        # The first said word of the paragraph that was also heard; give up
        # if none of its first three words were.
        hit = next((where[first + k] for k in range(3) if first + k in where and first + k < len(said)), None)
        if hit is None:
            return None
        t = max(0.0, float(heard[hit]["start"]) - LEAD)
        if t <= starts[-1]:
            return None
        starts.append(round(t, 2))
    return starts


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    out = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    for name in argv[1:]:
        chapter = json.loads(Path(name).read_text(encoding="utf-8"))
        cid = chapter["id"]
        found, missing = {}, []
        for line_id, script in chapter["lines"].items():
            if len(re.split(r"\n\s*\n", script)) < 2:
                continue
            kept = SCRATCH / f"{cid}-{line_id}.json"
            if not kept.exists():
                missing.append(line_id)
                continue
            starts = paragraph_starts(script, json.loads(kept.read_text(encoding="utf-8")))
            if starts is None:
                missing.append(line_id)
            else:
                found[line_id] = starts
        out[cid] = found
        print(f"{cid}: {len(found)} clips timed" + (f", guessed from text: {', '.join(missing)}" if missing else ""))
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
