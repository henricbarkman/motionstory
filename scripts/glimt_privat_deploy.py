#!/usr/bin/env python3
"""Put a private, walkable copy of a Glimt episode behind the portal login, with a real song.

    python3 scripts/glimt_privat_deploy.py <song>                  # episode 1 -> ~/generalassistant/data/uploads/glimt-episod1/
    python3 scripts/glimt_privat_deploy.py --episod 2 <song>       # episode 2 -> .../glimt-episod2/
    python3 scripts/glimt_privat_deploy.py --episod 1en <song>     # episode 1 in English -> .../glimt-episode1-en/
    python3 scripts/glimt_privat_deploy.py <song> --ut /tmp/g      # somewhere else, for a test
    python3 scripts/glimt_privat_deploy.py <song> --ljud <dir>     # the licensed sounds from elsewhere
    python3 scripts/glimt_privat_deploy.py --episod 1en            # new code, the song the copy already has
    python3 scripts/glimt_privat_deploy.py --repo <checkout>       # the app as another checkout has it

The public app (GitHub Pages) has no songs that are not released, and none of
the licensed sounds (the bed and the riser, Splice samples whose terms do not
allow them in a public repo). This copies the app as it stands in this
checkout to the portal's uploads folder (portal login only) and adds them:

- <song>, transcoded to Ogg Opus, under audio/glimt/music/ by the name the
  episode's file gives it (stories/glimt/episod-N.json): `privat.ersatter` if
  it has one, else `credits.file`;
- the bed and the riser from the --ljud folder (default
  ~/generalassistant/data/glimt-ljud, outside every repo), whose ljud.json
  names them: {"bed": "<file>", "riser": "<file>"};
- glimt/ljud.json, which tells the app where all of it is.

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
plus a hash of every file in the copy (the service worker aside), so a phone
that walked an earlier copy fetches whatever changed, and the start screen's build line says which copy it is. The
folder's own index.html sends the walker straight to the episode.

Without <song> the copy keeps the song it already has, byte for byte: new
code goes out without the song at hand and without a second transcode. With
--repo the app, its look and the episode files come from another checkout of
this repo, so a language can stay on an older version of the story and still
get a change on top of it (the Swedish copy on version 40, 27/10).

Address afterwards: https://demi.henricbarkman.se/uploads/glimt-episodN/glimt/index.html?kapitel=episodN
(in English, "Nen": .../uploads/glimt-episodeN-en/glimt/index.html?kapitel=episodeNen, file episode-N.json).
Each language has its own folder, so a copy of one never replaces the other's.
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
# The licensed sounds, kept out of every repo (its own .gitignore says *).
LJUD = Path.home() / "generalassistant" / "data" / "glimt-ljud"
# Where the copy is put together before it goes live: never served.
SCRATCH = Path.home() / ".cache" / "demi-scratch"
# What the public site serves: the app, its look, its sounds and the chapter
# files. Not the manuscripts, the room, the scripts or the voice tryouts.
TREE = ["index.html", "main.js", "styles.css", "manifest.json", "service-worker.js", "design", "glimt", "audio"]
STORIES = "stories/glimt"
MARK = ".glimt-privat"  # written into every copy: only a folder with it is ever replaced
LOUDNESS = "loudnorm=I=-17:TP=-1.5:LRA=11"  # level with the stand-in and her voice
INDEX = """<!doctype html>
<html lang="{lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Glimt, {title}</title>
  <meta http-equiv="refresh" content="0; url=glimt/index.html?kapitel={kapitel}">
</head>
<body><p><a href="glimt/index.html?kapitel={kapitel}">Glimt, {title}</a></p></body>
</html>
"""


def english(episode: int | str) -> tuple[int, bool]:
    """The episode's number, and whether it is the English one ("1en")."""
    m = re.fullmatch(r"(\d+)(en)?", str(episode))
    if not m:
        sys.exit(f"no episode {episode!r}: a number, or a number and en (1en)")
    return int(m.group(1)), bool(m.group(2))


def default_ut(episode: int | str) -> Path:
    n, en = english(episode)
    return UPLOADS / (f"glimt-episode{n}-en" if en else f"glimt-episod{n}")


def kapitel(episode: int | str) -> str:
    """The app's ?kapitel= for the episode."""
    n, en = english(episode)
    return f"episode{n}en" if en else f"episod{n}"


def episode_name(episode: int | str) -> str:
    n, en = english(episode)
    return f"episode-{n}.json" if en else f"episod-{n}.json"


def episode_file(episode: int | str, repo: Path = REPO) -> dict:
    f = repo / STORIES / episode_name(episode)
    if not f.is_file():
        sys.exit(f"no {f.relative_to(repo)}: episode {episode} has no file to say where its song goes")
    return json.loads(f.read_text(encoding="utf-8"))


def song_path(episode: int | str, repo: Path = REPO) -> Path:
    """Where the song goes in the copy, relative to its root."""
    chapter = episode_file(episode, repo)
    name = (chapter.get("privat") or {}).get("ersatter") or (chapter.get("credits") or {}).get("file")
    if not name or Path(name).name != name:
        sys.exit(f"stories/glimt/{episode_name(episode)} names no song file (privat.ersatter or credits.file)")
    return Path("audio/glimt/music") / name


def licensed(ljud: Path) -> dict[str, Path]:
    """The bed and the riser in the --ljud folder, as its ljud.json names them."""
    manifest = ljud / "ljud.json"
    if not manifest.is_file():
        sys.exit(f"no {manifest}: the private copy needs the bed and the riser (--ljud)")
    names = json.loads(manifest.read_text(encoding="utf-8"))
    found = {}
    for kind in ("bed", "riser"):
        name = names.get(kind)
        if not name or Path(name).name != name or not (ljud / name).is_file():
            sys.exit(f"{manifest} names no {kind} file next to it")
        found[kind] = ljud / name
    return found


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


def check_target(ut: Path, repo: Path = REPO) -> None:
    """The copy holds the song: never inside the repo (nor the checkout it is
    built from), never over a folder this script did not make."""
    ut = ut.resolve()
    for r in {REPO.resolve(), repo.resolve()}:
        if ut == r or r in ut.parents or ut in r.parents:
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


def tree_tag(build: Path, skip: Path) -> str:
    """Eight hex characters that change whenever any file in the build does.

    A phone keeps the service worker's cache until its name changes, so the
    name hashes everything in the copy: the code and the voices as well as the
    song and the licensed sounds (code review 18/10, Medel 3). `skip` is the
    service worker itself, which gets the name written into it."""
    digest = hashlib.sha256()
    for f in sorted(p for p in build.rglob("*") if p.is_file() and p != skip):
        digest.update(f.relative_to(build).as_posix().encode("utf-8") + b"\0")
        digest.update(f.read_bytes())
    return digest.hexdigest()[:8]


def deploy(song: Path | None, ut: Path, episode: int | str = 1, scratch: Path = SCRATCH, ljud: Path = LJUD,
           repo: Path = REPO) -> str:
    """`song` None: the song the copy at `ut` has now, copied as it is."""
    check_target(ut, repo)
    credits = song_path(episode, repo)
    chapter_id = episode_file(episode, repo)["id"]
    kept = None
    if song is None:
        kept = ut / credits
        if not kept.is_file():
            sys.exit(f"no song given, and {kept} is not there to keep")
    sounds = licensed(ljud)
    ut.parent.mkdir(parents=True, exist_ok=True)
    scratch.mkdir(parents=True, exist_ok=True)
    # Built where nothing serves it.
    work = Path(tempfile.mkdtemp(dir=scratch, prefix=f"glimt-privat-{ut.name}-"))
    ok = False
    try:
        build = work / ut.name
        build.mkdir()
        for name in TREE:
            src = repo / name
            if src.is_dir():
                shutil.copytree(src, build / name)
            else:
                shutil.copy2(src, build / name)
        (build / STORIES).mkdir(parents=True)
        for f in sorted((repo / STORIES).glob("*.json")):
            shutil.copy2(f, build / STORIES / f.name)
        (build / credits).parent.mkdir(parents=True, exist_ok=True)
        if kept is not None:
            shutil.copy2(kept, build / credits)
        else:
            transcode(song, build / credits)
        where = {"bed": Path("audio/glimt/bed"), "riser": Path("audio/glimt/fx")}
        extra = {}
        for kind, src in sounds.items():
            rel = where[kind] / src.name
            (build / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, build / rel)
            extra[kind] = rel.as_posix()
        extra["credits"] = {chapter_id: credits.as_posix()}
        (build / "glimt" / "ljud.json").write_text(json.dumps(extra, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        n, en = english(episode)
        (build / "index.html").write_text(INDEX.format(
            lang="en" if en else "sv", title=f"episode {n}" if en else f"episod {n}", kapitel=kapitel(episode)), encoding="utf-8")
        (build / MARK).write_text("Made by motionstory scripts/glimt_privat_deploy.py. Holds an unreleased song: never publish.\n",
                                  encoding="utf-8")
        sw = build / "service-worker.js"
        text = sw.read_text(encoding="utf-8")
        text, n = re.subn(r"const CACHE = '(motionstory-v\d+)';", lambda m: f"const CACHE = '{m.group(1)}-privat-{tree_tag(build, sw)}';", text)
        if n != 1:
            sys.exit("service-worker.js has no CACHE line to rename")
        sw.write_text(text, encoding="utf-8")
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
    parser.add_argument("song", type=Path, nargs="?", help="the song, read from here only (left out: keep the copy's own)")
    parser.add_argument("--episod", default="1", help="which episode (default 1; 1en for episode 1 in English)")
    parser.add_argument("--ut", type=Path, help="where the copy goes (default the uploads folder glimt-episodN)")
    parser.add_argument("--ljud", type=Path, default=LJUD, help=f"the folder with the bed and the riser (default {LJUD})")
    parser.add_argument("--repo", type=Path, default=REPO, help="the checkout the app comes from (default this one)")
    args = parser.parse_args()
    if args.song is not None and not args.song.is_file():
        sys.exit(f"no file {args.song}")
    if not (args.repo / "glimt" / "app.js").is_file():
        sys.exit(f"{args.repo} is not a checkout of this repo (no glimt/app.js)")
    ut = args.ut or default_ut(args.episod)
    cache = deploy(args.song, ut, args.episod, ljud=args.ljud, repo=args.repo)
    song = ut / song_path(args.episod, args.repo)
    print(f"wrote {ut} ({cache}), song {seconds(song):.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
