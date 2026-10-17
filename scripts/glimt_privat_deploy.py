#!/usr/bin/env python3
"""Put a private, walkable copy of Glimt behind the portal login, with real credits.

    python3 scripts/glimt_privat_deploy.py <song>                 # -> ~/generalassistant/data/uploads/glimt-episod1/
    python3 scripts/glimt_privat_deploy.py <song> --ut /tmp/g     # somewhere else, for a test

The public app (GitHub Pages) plays a stand-in for episode 1's opening
credits. This copies the app as it stands in this checkout to the portal's
uploads folder (portal login only) and puts <song> in the stand-in's place:
transcoded to Ogg Opus at the stand-in's path (audio/glimt/music/<credits
file in episod-1.json>), so nothing else in the app changes.

<song> is an unreleased track. It is only ever read from the path given on
the command line and written into the copy: it never comes into this repo,
and neither does its name or where it lives. The copy's folder is outside
the repo (and ignored by generalassistant's git).

The copy's service worker gets its own cache name, 'motionstory-vNN-privat-'
plus a hash of the song, so a phone that walked an earlier copy fetches the
new song, and the start screen's build line says which copy it is. The
folder's own index.html sends the walker straight to episode 1.

Address afterwards: https://demi.henricbarkman.se/uploads/glimt-episod1/glimt/index.html?kapitel=episod1
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
UT = Path.home() / "generalassistant" / "data" / "uploads" / "glimt-episod1"
# What the public site serves: the app, its look, its sounds and the chapter
# files. Not the manuscripts, the room, the scripts or the voice tryouts.
TREE = ["index.html", "main.js", "styles.css", "manifest.json", "service-worker.js", "design", "glimt", "audio"]
STORIES = "stories/glimt"
LOUDNESS = "loudnorm=I=-17:TP=-1.5:LRA=11"  # level with the stand-in and her voice
INDEX = """<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Glimt, episod 1</title>
  <meta http-equiv="refresh" content="0; url=glimt/index.html?kapitel=episod1">
</head>
<body><p><a href="glimt/index.html?kapitel=episod1">Glimt, episod 1</a></p></body>
</html>
"""


def credits_path() -> Path:
    chapter = json.loads((REPO / STORIES / "episod-1.json").read_text(encoding="utf-8"))
    return Path("audio/glimt/music") / chapter["credits"]["file"]


def transcode(song: Path, out: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(song), "-vn", "-af", LOUDNESS,
         "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", str(out)],
        check=True,
    )


def seconds(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def deploy(song: Path, ut: Path) -> str:
    credits = credits_path()
    stand_in = (REPO / credits).read_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        build = Path(tmp) / "glimt-episod1"
        build.mkdir()
        for name in TREE:
            src = REPO / name
            if src.is_dir():
                shutil.copytree(src, build / name)
            else:
                shutil.copy2(src, build / name)
        (build / STORIES).mkdir(parents=True)
        for f in sorted((REPO / STORIES).glob("*.json")):
            shutil.copy2(f, build / STORIES / f.name)
        transcode(song, build / credits)
        song_bytes = (build / credits).read_bytes()
        if song_bytes == stand_in:
            sys.exit("the song came out identical to the stand-in")
        tag = hashlib.sha256(song_bytes).hexdigest()[:8]
        sw = build / "service-worker.js"
        text = sw.read_text(encoding="utf-8")
        text, n = re.subn(r"const CACHE = '(motionstory-v\d+)';", lambda m: f"const CACHE = '{m.group(1)}-privat-{tag}';", text)
        if n != 1:
            sys.exit("service-worker.js has no CACHE line to rename")
        sw.write_text(text, encoding="utf-8")
        (build / "index.html").write_text(INDEX, encoding="utf-8")
        # Swap in whole: the old copy goes only once the new one is complete.
        ut.parent.mkdir(parents=True, exist_ok=True)
        old = ut.with_name(ut.name + ".gammal")
        if old.exists():
            shutil.rmtree(old)
        if ut.exists():
            ut.rename(old)
        shutil.move(str(build), str(ut))
        if old.exists():
            shutil.rmtree(old)
    return re.search(r"const CACHE = '([^']+)'", (ut / "service-worker.js").read_text(encoding="utf-8")).group(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("song", type=Path, help="the credits song, read from here only")
    parser.add_argument("--ut", type=Path, default=UT)
    args = parser.parse_args()
    if not args.song.is_file():
        sys.exit(f"no file {args.song}")
    cache = deploy(args.song, args.ut)
    credits = args.ut / credits_path()
    print(f"wrote {args.ut} ({cache}), credits {seconds(credits):.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
