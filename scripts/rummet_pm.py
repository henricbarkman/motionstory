#!/usr/bin/env python3
"""Build rummet/pm.js: the ProseMirror editor the room writes in, as one file.

The room has no build step: rummet/pm.js is checked in, and the page imports it
like any of its own files. This script only rebuilds that file, for a new
ProseMirror version. It installs the pinned packages in a temporary folder,
bundles them with esbuild into one ES module, and writes the licence texts of
everything inside it to rummet/pm-LICENSE.txt (all MIT).

    python3 scripts/rummet_pm.py
    python3 scripts/rummet_pm.py --ut /tmp/pm.js     # somewhere else, to compare

Needs node and npm, and the network.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PAKET = {
    "prosemirror-model": "1.25.12",
    "prosemirror-state": "1.4.4",
    "prosemirror-view": "1.42.6",
    "prosemirror-transform": "1.12.2",
    "prosemirror-history": "1.5.1",
    "prosemirror-keymap": "1.2.3",
    "prosemirror-commands": "1.7.2",
}
ESBUILD = "0.28.2"
# What the room uses; tree shaking leaves the rest out.
INGANG = """
export { Schema, Fragment, Slice, Node, DOMParser, DOMSerializer } from 'prosemirror-model';
export { EditorState, Selection, TextSelection, NodeSelection, AllSelection, Plugin, PluginKey } from 'prosemirror-state';
export { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
export { history, undo, redo, undoDepth, redoDepth, closeHistory } from 'prosemirror-history';
export { keymap } from 'prosemirror-keymap';
export { baseKeymap, chainCommands, deleteSelection, joinBackward, joinForward, selectAll, splitBlock } from 'prosemirror-commands';
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Bundle ProseMirror into rummet/pm.js.")
    ap.add_argument("--ut", type=Path, default=REPO / "rummet" / "pm.js")
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="rummet-pm-"))
    try:
        (tmp / "package.json").write_text(json.dumps({"name": "rummet-pm", "private": True}), encoding="utf-8")
        spec = [f"{p}@{v}" for p, v in PAKET.items()] + [f"esbuild@{ESBUILD}"]
        subprocess.run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", *spec], cwd=tmp, check=True)
        (tmp / "ingang.js").write_text(INGANG, encoding="utf-8")
        ut = tmp / "pm.js"
        subprocess.run([str(tmp / "node_modules" / ".bin" / "esbuild"), "ingang.js", "--bundle", "--format=esm",
                        "--minify", "--legal-comments=none", f"--outfile={ut}"], cwd=tmp, check=True)
        delar = sorted({p.parent.name if not p.parent.parent.name.startswith("@") else p.parent.parent.name + "/" + p.parent.name
                        for p in (tmp / "node_modules").glob("**/package.json")
                        if "esbuild" not in str(p) and p.parent.parent == tmp / "node_modules"})
        versioner = []
        licenser = []
        for namn in delar:
            d = tmp / "node_modules" / namn
            pj = json.loads((d / "package.json").read_text(encoding="utf-8"))
            versioner.append(f"{namn} {pj.get('version')} ({pj.get('license')})")
            lic = next((f for f in d.iterdir() if f.name.upper().startswith(("LICENSE", "LICENCE"))), None)
            text = lic.read_text(encoding="utf-8") if lic else f"{pj.get('license')} (no licence file in the package)\n"
            licenser.append(f"{'=' * 72}\n{namn} {pj.get('version')}\n{'=' * 72}\n\n{text.strip()}\n")
        huvud = ("// ProseMirror, bundled for the manuscript room by scripts/rummet_pm.py. Do not edit.\n"
                 f"// {'; '.join(versioner)}\n// Licences: pm-LICENSE.txt (MIT).\n")
        args.ut.write_text(huvud + ut.read_text(encoding="utf-8"), encoding="utf-8")
        (args.ut.parent / "pm-LICENSE.txt").write_text(
            "The file pm.js bundles the packages below. All are MIT licensed.\n\n" + "\n".join(licenser), encoding="utf-8")
        print(f"{args.ut}: {args.ut.stat().st_size} bytes, {len(delar)} packages")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
