#!/usr/bin/env python3
"""Put the room (rummet/) where Henric opens it: the portal's uploads folder.

    python3 scripts/rummet_deploy.py                  # -> ~/generalassistant/data/uploads/glimt-rummet/
    python3 scripts/rummet_deploy.py --ut /tmp/rum    # somewhere else, for a test

Every file except index.html gets its content's hash in its name
(app.3f9c0a1b2d.js), and every reference to it is rewritten, so a phone that
holds an old page from the portal's five-minute cache still gets the files
that page was built with, never a mix. index.html keeps its name and carries
the build in <meta name="rummet-bygge">. Glimt's shared look
(design/glimt.css, linked as ../design/glimt.css) is hashed the same way and
lands next to the page; its typefaces go to fonts/ under their own names,
which is where the stylesheet's url("fonts/...") points. The previous build's files are kept
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
# The directing desk's files. katalog.js, anteckn.js and lager.js stay in the
# repo for scripts/rummet.py (Demi's comments, the world book, lore) but the
# page no longer loads them.
FILES = ["manus.js", "data.js", "ljud.js", "dok.js", "regi.js", "app.js", "rummet.css", "ljudtider.json", "apptider.json"]
# Copied as they are, under their own names.
EXTRAS: list[str] = []
# Glimt's shared look, outside rummet/: the page links it as ../design/glimt.css.
DESIGN = REPO / "design"
GLIMT_CSS = "glimt.css"
GLIMT_HREF = "../design/glimt.css"
FONTS = sorted(p.name for p in (DESIGN / "fonts").iterdir() if p.suffix in (".woff2", ".txt"))
MANIFEST = "bygge.json"
OURS = re.compile(r"^(?:%s)\.[0-9a-f]{10}\.(?:js|css|json)$" % "|".join(re.escape(Path(f).stem) for f in [*FILES, GLIMT_CSS]))


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
    glimt = (DESIGN / GLIMT_CSS).read_bytes()
    names[GLIMT_CSS] = hashed_name(GLIMT_CSS, glimt)
    out[names[GLIMT_CSS]] = glimt
    index = (SRC / "index.html").read_text(encoding="utf-8")
    pattern = r"""(href=")%s(")""" % re.escape(GLIMT_HREF)
    if not re.search(pattern, index):
        sys.exit(f"index.html does not reference {GLIMT_HREF}")
    index = re.sub(pattern, lambda m: f"{m.group(1)}{names[GLIMT_CSS]}{m.group(2)}", index)
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
    for name in EXTRAS:
        write_atomic(ut / name, (SRC / name).read_bytes())
    (ut / "fonts").mkdir(exist_ok=True)
    for name in FONTS:
        write_atomic(ut / "fonts" / name, (DESIGN / "fonts" / name).read_bytes())
    # The HELD logo went with the 2026-10-10 look, the editor bundle's licence
    # with the word processor on 2026-10-28; only this script put them there.
    for gone in ("held-logo.svg", "pm-LICENSE.txt"):
        (ut / gone).unlink(missing_ok=True)
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
