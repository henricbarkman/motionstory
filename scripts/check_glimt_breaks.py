#!/usr/bin/env python3
"""Listen to where a go line may end early, the way episode 1 ends it.

For every pause measured under "breaks" (check_glimt_audio.py --listen), two
clips are rendered from the line's mp3: ended at the earliest point the app
can end it (the pause's start) and at the latest (its end less the fade),
each faded out over BREAK_FADE as audio.js's endVoiceAtBreak does. For each:

  - the file's peak level from 50 ms before the cut to the fade's end must be
    below SILENCE_DB, so the fade lies in silence and nothing clicks
  - ElevenLabs Scribe transcribes the clip, and its words must be the words
    the pause is said to come after: no word cut in half, none missing. The
    late clip is the early one and silence after it, so it passes on the early
    one's words when the stretch between them is below SILENCE_DB too (Scribe
    heard a whispered "Gå" with a second of quiet after it as "God", 23/10)

Usage:
    python3 scripts/check_glimt_breaks.py stories/glimt/episod-1.json [--out DIR] [--only s0-go2[,s1-go]]

--out keeps the clips and writes an index.html to listen to them by ear
(default: ~/.cache/demi-scratch/glimt-breaks/). Needs ELEVENLABS_API_KEY in
~/generalassistant/.env; billed as speech-to-text, a second or three a clip.
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_glimt_audio import ENV_FILE, REPO, SILENCE_DB, transcribe, words  # noqa: E402

AUDIO_JS = REPO / "glimt" / "audio.js"
BREAK_FADE = float(re.search(r"export const BREAK_FADE = ([0-9.]+);", AUDIO_JS.read_text(encoding="utf-8")).group(1))
BEFORE = 0.05  # s before the cut that must be silent too


def peak_db(path: Path, start: float, end: float) -> float:
    """The loudest sample between start and end, in dBFS."""
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", f"atrim=start={start:.4f}:end={end:.4f},astats=measure_overall=Peak_level:measure_perchannel=none",
         "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    m = re.findall(r"Peak level dB: (-?inf|-?[0-9.]+)", err)
    return float("-inf") if not m or m[-1] == "-inf" else float(m[-1])


def render(src: Path, cut: float, out: Path) -> None:
    """The line up to `cut`, faded to nothing over BREAK_FADE after it."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
         "-af", f"atrim=end={cut + BREAK_FADE:.4f},afade=t=out:st={cut:.4f}:d={BREAK_FADE}",
         "-c:a", "libmp3lame", "-q:a", "2", str(out)],
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("chapter", type=Path)
    parser.add_argument("--out", type=Path, default=Path.home() / ".cache" / "demi-scratch" / "glimt-breaks")
    parser.add_argument("--only", help="just these line ids, comma separated")
    args = parser.parse_args()

    chapter = json.loads(args.chapter.read_text(encoding="utf-8"))
    audio_dir = REPO / "audio" / "glimt" / "vega" / chapter["id"]
    only = set(args.only.split(",")) if args.only else None
    found = {i: b for i, b in chapter.get("breaks", {}).items() if not only or i in only}
    if not found:
        sys.exit(f"no breaks to check in {args.chapter}")

    from dotenv import load_dotenv

    load_dotenv(ENV_FILE)
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        sys.exit(f"ELEVENLABS_API_KEY missing in {ENV_FILE}")
    args.out.mkdir(parents=True, exist_ok=True)

    clips = []
    for line_id, bs in found.items():
        src = audio_dir / f"{line_id}.mp3"
        for n, b in enumerate(bs):
            for edge, cut in (("early", b["from"]), ("late", round(b["to"] - BREAK_FADE, 3))):
                out = args.out / f"{line_id}-{n + 1}-{edge}.mp3"
                render(src, cut, out)
                clips.append({"line": line_id, "said": b["said"], "edge": edge, "cut": cut, "file": out,
                              "peak": peak_db(src, max(0.0, cut - BEFORE), cut + BREAK_FADE),
                              "between": peak_db(src, b["from"], cut + BREAK_FADE)})

    with ThreadPoolExecutor(max_workers=4) as pool:
        heard = list(pool.map(lambda c: transcribe(api_key, c["file"]), clips))

    problems = []
    early = {}
    for c, h in zip(clips, heard):
        want, got = words(c["said"]), words(h.get("text", ""))
        c["heard"] = h.get("text", "").strip()
        ok_words = got == want
        if c["edge"] == "early":
            early[(c["line"], c["said"])] = ok_words
        note = ""
        if not ok_words and c["edge"] == "late" and early.get((c["line"], c["said"])) and c["between"] < SILENCE_DB:
            ok_words, note = True, f" (only silence after the early cut, {c['between']:.1f} dB: the same words)"
        ok_quiet = c["peak"] < SILENCE_DB
        mark = "ok  " if ok_words and ok_quiet else "FAIL"
        print(f"{mark}  {c['line']} {c['edge']:5} cut {c['cut']:.2f} s, peak {c['peak']:.1f} dB around it: heard {c['heard']!r}{note}")
        if not ok_quiet:
            problems.append(f"{c['line']} at {c['cut']:.2f} s: {c['peak']:.1f} dB under the fade, not silent")
        if not ok_words:
            problems.append(f"{c['line']} at {c['cut']:.2f} s: heard {got}, wanted {want}")

    rows = "\n".join(
        f"<tr><td>{html.escape(c['line'])}</td><td>{html.escape(c['said'])}</td><td>{c['edge']} ({c['cut']:.2f} s)</td>"
        f"<td><audio controls preload=\"none\" src=\"{c['file'].name}\"></audio></td><td>{html.escape(c['heard'])}</td></tr>"
        for c in clips)
    (args.out / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">"
        "<meta name=robots content=noindex><title>Glimt: där gå-repliken slutar</title>"
        "<style>body{font:15px system-ui;margin:1.5em;max-width:60em}td{padding:.3em .6em;border-bottom:1px solid #ddd}"
        "audio{height:2em}</style><h1>Där gå-repliken slutar</h1>"
        "<p>Varje rad är repliken avbruten i en paus, så som appen gör när du går iväg mitt i den: "
        "tidigast möjliga ställe och senast möjliga. Sista kolumnen är vad Scribe hörde.</p>"
        f"<table><tr><th>Replik</th><th>Slutar efter</th><th>Var</th><th>Lyssna</th><th>Scribe</th></tr>{rows}</table>",
        encoding="utf-8")

    print(f"\n{len(clips)} clips in {args.out}")
    if problems:
        print("\n".join(["", "Problems:"] + problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
