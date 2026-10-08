#!/usr/bin/env python3
"""Write the room's baseline: which paragraphs are Demi's drafts.

The room (rummet/) marks every paragraph with who last wrote it. A paragraph
nobody has touched in the room is Demi's if it stood, word for word, in the
file at one of the commits named here; any other text was changed outside the
room and is shown that way. Only name a commit whose text is Demi's own draft.
After Demi writes a new draft, run this again with that commit added; the
earlier ones stay in the file.

    python3 scripts/rummet_grund.py                       # the start commits below
    python3 scripts/rummet_grund.py --commit abc1234      # add a later draft of Demi's
    python3 scripts/rummet_grund.py --prov --nollstall    # the sandbox the room's tests use

Writes ~/generalassistant/data/glimt-rummet/grund/<dok>.json for the episodes,
the world book and the mechanics catalogue, outside this public repo. Each
holds "stycken": the paragraphs as whole md lines, read with rummet/dok.js
through node, the same reading the room does. Lines from the first version's
baseline ("rader", the inside of the quote lines) are kept as "> " lines.

--prov lays fresh copies of the episodes, their recordings lists, the world
book, the catalogue and HELD's lore in data/glimt-rummet/prov/manus/, so the
room can be tried against the real portal (rummet/?rot=prov) without touching
the real files. --nollstall also removes the sandbox's notes, lore pages and
settings. The sandbox ignores itself in git.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GA = Path.home() / "generalassistant"
UT = GA / "data" / "glimt-rummet"
LIVE = GA / "projects" / "motionstory"
EPISODER = ("1", "2")
# The first commit where each document is Demi's own draft.
START = {"1": "1e54ffc", "2": "1e54ffc", "varld": "f0fd543", "mekaniker": "0ca4994"}
FIL = {"1": "episod-1.md", "2": "episod-2.md", "varld": "varld.md", "mekaniker": "mekaniker.md"}
OM = "Stycken som är Demis utkast. Skrivs av scripts/rummet_grund.py i motionstory, aldrig av rummet."

READ_PARAS = """
import * as D from %s;
let text = '';
process.stdin.setEncoding('utf8');
for await (const bit of process.stdin) text += bit;
const slag = process.env.SLAG === 'episod' ? D.SLAG_EPISOD : D.SLAG_FRI;
const ut = D.tolka(text, slag).paras.filter((p) => p.typ !== 'linje' && p.text.trim()).map((p) => D.skrivRad(p));
process.stdout.write(JSON.stringify(ut));
"""


def paras_of(text: str, dok: str) -> list[str]:
    js = READ_PARAS % json.dumps((REPO / "rummet" / "dok.js").as_uri())
    env = {**os.environ, "SLAG": "episod" if dok in EPISODER else "fri"}
    out = subprocess.run(["node", "--input-type=module", "-e", js], input=text, env=env,
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def at_commit(commit: str, dok: str) -> str | None:
    r = subprocess.run(["git", "-C", str(REPO), "show", f"{commit}:stories/glimt/{FIL[dok]}"],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def namn(dok: str) -> str:
    return f"episod-{dok}" if dok in EPISODER else dok


def write_baseline(folder: Path, extra: list[str]) -> None:
    (folder / "grund").mkdir(parents=True, exist_ok=True)
    for dok in FIL:
        path = folder / "grund" / f"{namn(dok)}.json"
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        stycken = list(old.get("stycken", [])) + [f"> {r}" for r in old.get("rader", [])]
        sources = list(old.get("fran", []))
        # The commits named before stay: their paragraphs are read again.
        for c in dict.fromkeys([START[dok], *sources, *extra]):
            text = at_commit(c, dok)
            if text is None:
                continue
            for line in paras_of(text, dok):
                if line not in stycken:
                    stycken.append(line)
            if c not in sources:
                sources.append(c)
        seen: set[str] = set()
        stycken = [s for s in stycken if not (s in seen or seen.add(s))]
        data = {"om": OM, "fran": sources, "skriven": datetime.now(UTC).isoformat(timespec="seconds"), "stycken": stycken}
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{dok}: {len(stycken)} paragraphs from {', '.join(sources)} -> {path}")


def make_sandbox() -> Path:
    prov = UT / "prov"
    (prov / "manus").mkdir(parents=True, exist_ok=True)
    (prov / ".gitignore").write_text("# The room's test sandbox: copies, never committed.\n*\n", encoding="utf-8")
    glimt = LIVE / "stories" / "glimt"
    for ep in EPISODER:
        shutil.copyfile(glimt / f"episod-{ep}.md", prov / "manus" / f"episod-{ep}.md")
        if (glimt / f"episod-{ep}.json").exists():
            shutil.copyfile(glimt / f"episod-{ep}.json", prov / "manus" / f"episod-{ep}.json")
    for f in ("varld.md", "mekaniker.md"):
        shutil.copyfile(glimt / f, prov / "manus" / f)
    held = GA / "projects" / "held" / "universe" / "LORE.md"
    if held.exists():
        shutil.copyfile(held, prov / "manus" / "held-lore.md")
    return prov


def main() -> int:
    ap = argparse.ArgumentParser(description="Write the room's baseline of Demi's draft paragraphs.")
    ap.add_argument("--commit", action="append", default=[], help="a later commit of Demi's draft (repeatable)")
    ap.add_argument("--prov", action="store_true", help="set up the test sandbox instead")
    ap.add_argument("--nollstall", action="store_true", help="with --prov: also remove the sandbox's notes, lore and settings")
    args = ap.parse_args()
    if args.prov:
        prov = make_sandbox()
        if args.nollstall:
            for name in ("episod-1.json", "episod-2.json", "varld.json", "mekaniker.json", "lore.json",
                         "installningar.json", "demi-sett.json", "demi-vantande.json"):
                (prov / name).unlink(missing_ok=True)
            shutil.rmtree(prov / "grund", ignore_errors=True)
        write_baseline(prov, args.commit)
        print(f"sandbox ready: {prov}")
        return 0
    write_baseline(UT, args.commit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
