#!/usr/bin/env python3
"""Put a private, walkable copy of a Glimt episode behind the portal login, with a real song.

    python3 scripts/glimt_privat_deploy.py <song>                  # episode 1 -> ~/generalassistant/data/uploads/glimt-episod1/
    python3 scripts/glimt_privat_deploy.py --episod 2 <song>       # episode 2 -> .../glimt-episod2/
    python3 scripts/glimt_privat_deploy.py <song> --ut /tmp/g      # somewhere else, for a test

The public app (GitHub Pages) plays stand-ins for songs that are not released.
This copies the app as it stands in this checkout to the portal's uploads
folder (portal login only) and puts <song> in the episode's stand-in's place:
transcoded to Ogg Opus at the stand-in's path, so nothing else in the app
changes. Which file is the stand-in, the episode's file says
(stories/glimt/episod-N.json): `privat.ersatter` if it has one, else its
credits (episode 1: audio/glimt/music/fortexter.opus). Both are names under
audio/glimt/music/.

<song> is an unreleased track. It is only ever read from the path given on
the command line and written into the copy: it never comes into this repo,
and neither does its name or where it lives. The copy is built in
~/.cache/demi-scratch (not served by anything), and only moved into the
uploads folder once it is whole. The uploads folder is outside the repo (and
ignored by generalassistant's git).

The swap is two renames on one disk: the old copy aside, the new one in. If
the second fails the old copy goes back, so the address never ends up empty;
the old copy is deleted only once the new one is in place.

The copy's service worker gets its own cache name, 'motionstory-vNN-privat-'
plus a hash of the song, so a phone that walked an earlier copy fetches the
new song, and the start screen's build line says which copy it is. The
folder's own index.html sends the walker straight to the episode.

Address afterwards: https://demi.henricbarkman.se/uploads/glimt-episodN/glimt/index.html?kapitel=episodN
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
UPLOADS = Path.home() / "generalassistant" / "data" / "uploads"
# Where the copy is put together before it goes live: never served.
SCRATCH = Path.home() / ".cache" / "demi-scratch"
# What the public site serves: the app, its look, its sounds and the chapter
# files. Not the manuscripts, the room, the scripts or the voice tryouts.
TREE = ["index.html", "main.js", "styles.css", "manifest.json", "service-worker.js", "design", "glimt", "audio"]
STORIES = "stories/glimt"
MARK = ".glimt-privat"  # written into every copy: only a folder with it is ever replaced
LOUDNESS = "loudnorm=I=-17:TP=-1.5:LRA=11"  # level with the stand-in and her voice
INDEX = """<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Glimt, episod {n}</title>
  <meta http-equiv="refresh" content="0; url=glimt/index.html?kapitel=episod{n}">
</head>
<body><p><a href="glimt/index.html?kapitel=episod{n}">Glimt, episod {n}</a></p></body>
</html>
"""


def default_ut(episode: int) -> Path:
    return UPLOADS / f"glimt-episod{episode}"


def stand_in_path(episode: int) -> Path:
    """The file in the app the song takes the place of, relative to the repo."""
    f = REPO / STORIES / f"episod-{episode}.json"
    if not f.is_file():
        sys.exit(f"no {f.relative_to(REPO)}: episode {episode} has no file to say which stand-in the song replaces")
    chapter = json.loads(f.read_text(encoding="utf-8"))
    name = (chapter.get("privat") or {}).get("ersatter") or (chapter.get("credits") or {}).get("file")
    if not name:
        sys.exit(f"{f.relative_to(REPO)} names no stand-in (privat.ersatter or credits.file)")
    path = Path("audio/glimt/music") / name
    if not (REPO / path).is_file():
        sys.exit(f"the stand-in {path} is not in the repo")
    return path


def transcode(song: Path, out: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(song), "-vn", "-map_metadata", "-1", "-af", LOUDNESS,
         "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", str(out)],
        check=True,
    )


def seconds(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def check_target(ut: Path) -> None:
    """The copy holds the song: never inside the repo, never over a folder
    this script did not make."""
    ut = ut.resolve()
    repo = REPO.resolve()
    if ut == repo or repo in ut.parents or ut in repo.parents:
        sys.exit(f"{ut} is inside the repo or holds it: the song must never come near it")
    if ut.exists() and not (ut / MARK).is_file():
        sys.exit(f"{ut} exists and was not made by this script; refusing to replace it")


def swap(build: Path, ut: Path, aside: Path) -> None:
    """Moves `build` to `ut`. A copy already at `ut` goes to `aside` first,
    and back again if the move fails, so `ut` is never left empty."""
    old = None
    if ut.exists():
        ut.rename(aside)
        old = aside
    try:
        build.rename(ut)
    except OSError:
        if old is not None:
            old.rename(ut)
        raise


def deploy(song: Path, ut: Path, episode: int = 1, scratch: Path = SCRATCH) -> str:
    check_target(ut)
    credits = stand_in_path(episode)
    stand_in = (REPO / credits).read_bytes()
    ut.parent.mkdir(parents=True, exist_ok=True)
    scratch.mkdir(parents=True, exist_ok=True)
    # Built where nothing serves it.
    work = Path(tempfile.mkdtemp(dir=scratch, prefix=f"glimt-privat-{ut.name}-"))
    ok = False
    try:
        build = work / ut.name
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
        (build / "index.html").write_text(INDEX.format(n=episode), encoding="utf-8")
        (build / MARK).write_text("Made by motionstory scripts/glimt_privat_deploy.py. Holds an unreleased song: never publish.\n",
                                  encoding="utf-8")
        # The old copy is set aside in the scratch folder, out of the
        # portal's reach, when that is the same disk. Elsewhere (a --ut on
        # another disk) the build and the old copy wait next to the target.
        aside = work / "gammal"
        if build.stat().st_dev != ut.parent.stat().st_dev:
            near, aside = ut.parent / f".{ut.name}-ny", ut.parent / f".{ut.name}-gammal"
            for left in (near, aside):
                if left.exists():
                    sys.exit(f"{left} is left from a run that broke off; look at it and remove it first")
            shutil.move(str(build), near)
            build = near
        swap(build, ut, aside)
        ok = True
        if aside.exists():
            shutil.rmtree(aside)
    finally:
        # Only a run that went through cleans up after itself: after a failure
        # whatever is left (a half build, an old copy that could not go back)
        # stays where the message says.
        if ok:
            shutil.rmtree(work, ignore_errors=True)
        else:
            print(f"left in place after a failure: {work}", file=sys.stderr)
    return re.search(r"const CACHE = '([^']+)'", (ut / "service-worker.js").read_text(encoding="utf-8")).group(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("song", type=Path, help="the song, read from here only")
    parser.add_argument("--episod", type=int, default=1, help="which episode (default 1)")
    parser.add_argument("--ut", type=Path, help="where the copy goes (default the uploads folder glimt-episodN)")
    args = parser.parse_args()
    if not args.song.is_file():
        sys.exit(f"no file {args.song}")
    ut = args.ut or default_ut(args.episod)
    cache = deploy(args.song, ut, args.episod)
    song = ut / stand_in_path(args.episod)
    print(f"wrote {ut} ({cache}), song {seconds(song):.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
