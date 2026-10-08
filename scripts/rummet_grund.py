#!/usr/bin/env python3
"""Write the room's baseline: which manuscript lines are Demi's drafts.

The room (rummet/) marks every line with who wrote it. A line nobody has
touched in the room is Demi's if its text stood in the manuscript at one of
the commits named here; any other text was changed outside the room and is
shown that way until someone says whose it is. Only name a commit whose
manuscript text is Demi's own draft (1e54ffc is the start: episodes 1 and 2
as Demi wrote them). After Demi writes a new draft, run this again with that
commit added; the earlier ones stay in the file.

    python3 scripts/rummet_grund.py                       # 1e54ffc, episodes 1 and 2
    python3 scripts/rummet_grund.py --commit abc1234      # add a later draft of Demi's
    python3 scripts/rummet_grund.py --prov                # the sandbox the room's tests use

Writes ~/generalassistant/data/glimt-rummet/grund/episod-N.json, outside this
public repo. --prov also lays fresh copies of the manuscript, its recordings
list, the world book and HELD's lore in data/glimt-rummet/prov/, so the room
can be tried against the real portal (rummet/?rot=prov) without touching the
manuscript. The sandbox ignores itself in git.

The lines are read with rummet/manus.js through node, the same reading the
room does.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import UTC, datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GA = Path.home() / "generalassistant"
UT = GA / "data" / "glimt-rummet"
LIVE = GA / "projects" / "motionstory"
START = "1e54ffc"
EPISODER = ("1", "2")

READ_LINES = """
import { tolka } from %s;
let text = '';
process.stdin.setEncoding('utf8');
for await (const bit of process.stdin) text += bit;
const m = tolka(text);
const ut = m.rader.filter((r) => r.typ === 'replik' && r.scen != null).map((r) => r.innehall);
process.stdout.write(JSON.stringify(ut));
"""


def lines_of(text: str) -> list[str]:
    js = READ_LINES % json.dumps((REPO / "rummet" / "manus.js").as_uri())
    out = subprocess.run(["node", "--input-type=module", "-e", js], input=text,
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def at_commit(commit: str, episode: str) -> str | None:
    r = subprocess.run(["git", "-C", str(REPO), "show", f"{commit}:stories/glimt/episod-{episode}.md"],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def write_baseline(folder: Path, commits: list[str]) -> None:
    (folder / "grund").mkdir(parents=True, exist_ok=True)
    for ep in EPISODER:
        path = folder / "grund" / f"episod-{ep}.json"
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"fran": [], "rader": []}
        lines = list(old.get("rader", []))
        sources = list(old.get("fran", []))
        for c in commits:
            text = at_commit(c, ep)
            if text is None:
                print(f"episod {ep}: not in {c}, skipped")
                continue
            for line in lines_of(text):
                if line not in lines:
                    lines.append(line)
            if c not in sources:
                sources.append(c)
        data = {
            "om": "Rader som är Demis utkast. Skrivs av scripts/rummet_grund.py i motionstory, aldrig av rummet.",
            "fran": sources,
            "skriven": datetime.now(UTC).isoformat(timespec="seconds"),
            "rader": lines,
        }
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"episod {ep}: {len(lines)} lines from {', '.join(sources)} -> {path}")


def make_sandbox() -> Path:
    prov = UT / "prov"
    (prov / "manus").mkdir(parents=True, exist_ok=True)
    (prov / ".gitignore").write_text("# The room's test sandbox: copies, never committed.\n*\n", encoding="utf-8")
    glimt = LIVE / "stories" / "glimt"
    for ep in EPISODER:
        shutil.copyfile(glimt / f"episod-{ep}.md", prov / "manus" / f"episod-{ep}.md")
        if (glimt / f"episod-{ep}.json").exists():
            shutil.copyfile(glimt / f"episod-{ep}.json", prov / "manus" / f"episod-{ep}.json")
    shutil.copyfile(glimt / "varld.md", prov / "manus" / "varld.md")
    held = GA / "projects" / "held" / "universe" / "LORE.md"
    if held.exists():
        shutil.copyfile(held, prov / "manus" / "held-lore.md")
    return prov


def main() -> int:
    ap = argparse.ArgumentParser(description="Write the room's baseline of Demi's draft lines.")
    ap.add_argument("--commit", action="append", default=[], help="a later commit of Demi's draft (repeatable)")
    ap.add_argument("--prov", action="store_true", help="set up the test sandbox instead")
    ap.add_argument("--nollstall", action="store_true", help="with --prov: also remove the sandbox's notes and lore")
    args = ap.parse_args()
    commits = [START, *args.commit]
    if args.prov:
        prov = make_sandbox()
        if args.nollstall:
            for name in ("episod-1.json", "episod-2.json", "lore.json"):
                (prov / name).unlink(missing_ok=True)
            shutil.rmtree(prov / "grund", ignore_errors=True)
        write_baseline(prov, commits)
        print(f"sandbox ready: {prov}")
        return 0
    write_baseline(UT, commits)
    return 0


if __name__ == "__main__":
    sys.exit(main())
