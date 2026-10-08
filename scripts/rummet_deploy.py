#!/usr/bin/env python3
"""Put the room (rummet/) where Henric opens it: the portal's uploads folder.

    python3 scripts/rummet_deploy.py                  # -> ~/generalassistant/data/uploads/glimt-rummet/
    python3 scripts/rummet_deploy.py --ut /tmp/rum    # somewhere else, for a test

Every file except index.html gets its content's hash in its name
(app.3f9c0a1b2d.js), and every reference to it is rewritten, so a phone that
holds an old page from the portal's five-minute cache still gets the files
that page was built with, never a mix. index.html keeps its name and carries
the build in <meta name="rummet-bygge">. The previous build's files are kept
next to the new ones for the same reason; older ones are removed. Only files
this script made are ever removed.

The page finds the portal's file API on its own (same origin), so nothing in
the copy names a server.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "rummet"
UT = Path.home() / "generalassistant" / "data" / "uploads" / "glimt-rummet"
FILES = ["manus.js", "data.js", "ljud.js", "rum.js", "lager.js", "md.js", "app.js", "rummet.css", "ljudtider.json"]
MANIFEST = "bygge.json"
OURS = re.compile(r"^(?:%s)\.[0-9a-f]{10}\.(?:js|css|json)$" % "|".join(re.escape(Path(f).stem) for f in FILES))


def refs(text: str) -> list[str]:
    """The room's own files a file points at, as './name'."""
    return [f for f in FILES if re.search(r"""['"]\./%s['"]""" % re.escape(f), text)]


def hashed_name(name: str, data: bytes) -> str:
    stem, ext = name.rsplit(".", 1)
    return f"{stem}.{hashlib.sha256(data).hexdigest()[:10]}.{ext}"


def build() -> tuple[dict[str, bytes], str]:
    """-> {output name: bytes} and the build id. Dependencies first, so each
    file's hash covers the hashed names of what it imports."""
    texts = {f: (SRC / f).read_text(encoding="utf-8") for f in FILES}
    names: dict[str, str] = {}
    out: dict[str, bytes] = {}
    left = list(FILES)
    while left:
        ready = [f for f in left if all(d in names for d in refs(texts[f]) if d != f)]
        if not ready:
            sys.exit(f"Import cycle among: {', '.join(left)}")
        for f in ready:
            text = texts[f]
            for d in refs(text):
                text = re.sub(r"""(['"])\./%s\1""" % re.escape(d), lambda m, d=d: f"{m.group(1)}./{names[d]}{m.group(1)}", text)
            data = text.encode("utf-8")
            names[f] = hashed_name(f, data)
            out[names[f]] = data
            left.remove(f)
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or "okänd"
    bygge = f"{names['app.js'].split('.')[1]} {commit}"
    index = (SRC / "index.html").read_text(encoding="utf-8")
    for f in ("rummet.css", "app.js"):
        pattern = r"""((?:href|src)=")%s(")""" % re.escape(f)
        if not re.search(pattern, index):
            sys.exit(f"index.html does not reference {f}")
        index = re.sub(pattern, lambda m, f=f: f"{m.group(1)}{names[f]}{m.group(2)}", index)
    index, n = re.subn(r'<meta name="rummet-bygge" content="[^"]*">', f'<meta name="rummet-bygge" content="{bygge}">', index)
    if n != 1:
        sys.exit("index.html has no rummet-bygge meta")
    out["index.html"] = index.encode("utf-8")
    return out, bygge


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def deploy(ut: Path) -> str:
    out, bygge = build()
    ut.mkdir(parents=True, exist_ok=True)
    previous: list[str] = []
    mf = ut / MANIFEST
    if mf.exists():
        try:
            previous = json.loads(mf.read_text(encoding="utf-8")).get("filer", [])
        except (json.JSONDecodeError, OSError):
            previous = []
    # Hashed files first, the page that points at them last.
    for name, data in out.items():
        if name != "index.html" and not (ut / name).exists():
            write_atomic(ut / name, data)
    write_atomic(ut / "index.html", out["index.html"])
    current = sorted(n for n in out if n != "index.html")
    write_atomic(mf, (json.dumps({
        "bygge": bygge,
        "skriven": datetime.now(UTC).isoformat(timespec="seconds"),
        "filer": current,
        "forra": previous,
    }, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))
    keep = set(current) | set(previous)
    removed = [p.name for p in ut.iterdir() if p.is_file() and OURS.match(p.name) and p.name not in keep]
    for name in removed:
        (ut / name).unlink()
    print(f"build {bygge}: {len(current)} files + index.html -> {ut}" + (f" (removed {len(removed)} old)" if removed else ""))
    return bygge


def main() -> int:
    ap = argparse.ArgumentParser(description="Copy the room to the portal's uploads, with hashed file names.")
    ap.add_argument("--ut", type=Path, default=UT, help=f"target folder (default {UT})")
    args = ap.parse_args()
    deploy(args.ut)
    return 0


if __name__ == "__main__":
    sys.exit(main())
