#!/usr/bin/env python3
"""Tests for scripts/rummet.py, Demi's door into the room, against a sandbox.

Builds a stand-in for ~/generalassistant in a temp folder, starts the
portal stand-in (scripts/rummet_provserver.py) over it, and then:

- runs the script's commands and reads what they wrote;
- lets "the page" (the room's own lager.js through the portal file API, in
  node) and several script processes write the same notes file at the same
  time, and counts that nothing went missing;
- checks that Demi cannot change someone else's post or the manuscript.

    python3 scripts/test_rummet_cli.py
    RUMMET_FILES_PY=/path/to/files.py python3 scripts/test_rummet_cli.py   # another copy of the portal module

Never touches the real room or the manuscript.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "rummet.py"
GLIMT = REPO / "stories" / "glimt"

checks = 0
failures = 0


def ok(cond: bool, what: str) -> None:
    global checks, failures
    checks += 1
    if not cond:
        failures += 1
    if not cond or os.environ.get("VERBOSE"):
        print(f"{'ok  ' if cond else 'FAIL'}  {what}")


def kor(rot: Path, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "--rot", str(rot), *args], input=stdin,
                          capture_output=True, text=True, check=False)


def rum(rot: Path, n: str = "1") -> dict:
    return json.loads((rot / "data" / "glimt-rummet" / f"episod-{n}.json").read_text(encoding="utf-8"))


SIDAN = """
import { skapaLager } from %(lager)s;
import { portalAdapter } from %(data)s;
const [url, vem, antal, till] = process.argv.slice(1);
const f = (u, o = {}) => fetch(new URL(u, url), { ...o, headers: { ...(o.headers || {}), Origin: url.replace(/\\/$/, '') } });
const adapter = { ...portalAdapter({ fetch: f }), vem: async () => ({ id: vem, namn: vem }) };
// The portal's file paths name the real home; the stand-in moves them into the sandbox.
const lager = skapaLager(adapter);
const ut = [];
for (let k = 0; k < Number(antal); k++) {
  ut.push(await lager.kommentera('1', { scen: '1', text: null }, `sidan ${k}`, null, { till: till || null }));
}
process.stdout.write(JSON.stringify(ut));
"""


def sidan(url: str, vem: str, antal: int, till: str = "") -> list[str]:
    js = SIDAN % {
        "lager": json.dumps((REPO / "rummet" / "lager.js").as_uri()),
        "data": json.dumps((REPO / "rummet" / "data.js").as_uri()),
    }
    r = subprocess.run(["node", "--input-type=module", "-e", js, url, vem, str(antal), till],
                       capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:])
    return json.loads(r.stdout)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="rummet-cli-"))
    rot = tmp / "ga"
    glimt = rot / "projects" / "motionstory" / "stories" / "glimt"
    glimt.mkdir(parents=True)
    (rot / "data" / "glimt-rummet").mkdir(parents=True)
    for f in ("episod-1.md", "episod-2.md", "episod-1.json", "varld.md"):
        shutil.copyfile(GLIMT / f, glimt / f)
    manus_fore = (glimt / "episod-1.md").read_text(encoding="utf-8")
    env = dict(os.environ, RUMMET_FILES_PY=os.environ.get("RUMMET_FILES_PY", ""))
    server = subprocess.Popen([sys.executable, str(REPO / "scripts" / "rummet_provserver.py"), "--rot", str(rot)],
                              stdout=subprocess.PIPE, text=True, env=env)
    try:
        url = server.stdout.readline().strip()

        # Reading the lines to name one.
        r = kor(rot, "rader", "--episod", "1", "--scen", "1")
        forsta = next((ln.strip() for ln in r.stdout.splitlines() if ln.startswith("  ") and not ln.strip().startswith("[n=")), None)
        ok(r.returncode == 0 and forsta, f"rader: lists scene 1's lines ({forsta and forsta[:40]})")

        # A comment on a line, and one on the whole scene.
        r = kor(rot, "kommentera", "--episod", "1", "--scen", "1", "--rad", forsta, "--text", "Kortare paus?", "--galler", "paus")
        d = rum(rot)
        k = d["kommentarer"][-1] if d["kommentarer"] else {}
        ok(r.returncode == 0 and k.get("skrev") == "demi" and k.get("mal", {}).get("text") == forsta and k.get("galler") == "paus",
           "kommentera: a comment on a line, as Demi, anchored to that line")
        ok("fore" in k.get("mal", {}) and "efter" in k.get("mal", {}), "the anchor carries the neighbours, as the page's does")
        r = kor(rot, "kommentera", "--episod", "1", "--scen", "1", "--text", "-", stdin="Om hela scenen.\nTvå rader.")
        ok(r.returncode == 0 and rum(rot)["kommentarer"][-1]["text"] == "Om hela scenen.\nTvå rader." and rum(rot)["kommentarer"][-1]["mal"]["text"] is None,
           "kommentera: a comment on the whole scene, text from stdin kept exactly")
        r = kor(rot, "kommentera", "--episod", "1", "--scen", "1", "--rad", "Finns inte i manuset.", "--text", "x")
        ok(r.returncode == 2 and "står inte så" in r.stderr, "a line that is not there is refused, with a reason")
        r = kor(rot, "kommentera", "--episod", "1", "--scen", "99", "--text", "x")
        ok(r.returncode == 2 and "ingen scen 99" in r.stderr, "a scene that is not there is refused")

        # Proposals: must be a line the manuscript can hold.
        r = kor(rot, "foresla", "--episod", "1", "--scen", "1", "--rad", forsta, "--text", "Ett nytt sätt att säga det.")
        ok(r.returncode == 0 and rum(rot)["forslag"][-1]["skrev"] == "demi" and rum(rot)["forslag"][-1]["lage"] == "oppet",
           "foresla: a proposal beside the line, open, Demi's")
        r = kor(rot, "foresla", "--episod", "1", "--scen", "1", "--rad", forsta, "--text", "två\nrader")
        ok(r.returncode == 2 and len(rum(rot)["forslag"]) == 1, "a proposal the manuscript cannot hold as a line is refused")
        ok((glimt / "episod-1.md").read_text(encoding="utf-8") == manus_fore, "none of it touched the manuscript")

        # Henric asks Demi something from the page; Demi sees it first, and answers.
        fraga = sidan(url, "henric", 1, "demi")[0]
        r = kor(rot, "nytt", "--sedan", "2020-01-01T00:00")
        ok(r.returncode == 0 and r.stdout.startswith("Väntar på svar från Demi: 1") and fraga in r.stdout.split("Nytt sedan")[0],
           "nytt: a question to Demi is listed first")
        j = json.loads(kor(rot, "nytt", "--sedan", "2020-01-01T00:00", "--json").stdout)
        ok(j["vantar"][0]["id"] == fraga and any(h["typ"] == "kommentar" and h["vem"] == "henric" for h in j["handelser"])
           and not any(h["vem"] == "demi" for h in j["handelser"]), "nytt --json: the same, and Demi's own posts are not news")
        r = kor(rot, "svara", "--pa", fraga, "--text", "För att hon lyssnar.")
        svar = rum(rot)["kommentarer"][-1]
        ok(r.returncode == 0 and svar["svarPa"] == fraga and svar["skrev"] == "demi", "svara: a reply in the thread, as Demi")
        ok("Tråden nu:" in r.stdout and "<- ditt svar" in r.stdout, "svara: shows the thread as it stands, so a late question is seen")
        ok(kor(rot, "nytt", "--sedan", "2020-01-01T00:00").stdout.startswith("Väntar på svar från Demi: 0"), "answered: no longer waiting")

        # 'nytt' without --sedan moves its mark: the second time there is nothing new.
        kor(rot, "nytt")
        ok("Nytt sedan" in kor(rot, "nytt").stdout and kor(rot, "nytt", "--json").stdout.count('"typ"') == 0,
           "nytt remembers where it was")

        # A post stamped by a clock that is behind still shows as new: what was
        # shown is known by key, not by time.
        efter_klocka = rum(rot)
        sett = json.loads((rot / "data" / "glimt-rummet" / "demi-sett.json").read_text(encoding="utf-8"))["sett"]
        # Written after the mark, stamped earlier the same day.
        efter_klocka["kommentarer"].append({"id": "sen1", "mal": {"scen": "1", "text": None}, "text": "Telefonen går efter.",
                                            "galler": None, "skrev": "liv", "nar": sett[:11] + "00:00:00.000Z"})
        (rot / "data" / "glimt-rummet" / "episod-1.json").write_text(json.dumps(efter_klocka), encoding="utf-8")
        r = kor(rot, "nytt")
        ok(r.returncode == 0 and "Telefonen går efter." in r.stdout, "nytt: a post stamped before the mark (a clock behind) still shows once")
        ok("Telefonen går efter." not in kor(rot, "nytt").stdout, "and not again")
        (rot / "data" / "glimt-rummet" / "demi-sett.json").write_text("{trasig", encoding="utf-8")
        r = kor(rot, "nytt", "--behall")
        ok(r.returncode == 0 and "en vecka bakåt" in r.stdout and "gick inte att läsa" in r.stderr, "nytt: a broken mark file falls back to a week, and says so")
        kor(rot, "nytt")

        # A proposal from stdin: the trailing newline of echo is not part of the line.
        r = kor(rot, "foresla", "--episod", "1", "--scen", "1", "--rad", forsta, "--text", "-", stdin="Från en heredoc.\n")
        ok(r.returncode == 0 and rum(rot)["forslag"][-1]["kropp"] == "Från en heredoc.", "foresla --text -: the trailing newline is dropped, nothing else")

        # Lore: Demi's own page, and someone else's.
        r = kor(rot, "lore", "--titel", "Slingan", "--text", "Den surrar.")
        lore_path = rot / "data" / "glimt-rummet" / "lore.json"
        lore = json.loads(lore_path.read_text(encoding="utf-8"))
        sida = lore["sidor"][0]["id"]
        ok(r.returncode == 0 and lore["sidor"][0]["skrev"] == "demi", "lore: a page of Demi's own")
        r = kor(rot, "lore", "--sida", sida, "--titel", "Slingan", "--text", "Den surrar lågt.")
        ok(r.returncode == 0 and json.loads(lore_path.read_text(encoding="utf-8"))["sidor"][0]["text"] == ["Den surrar lågt."], "Demi changes its own page")
        lore = json.loads(lore_path.read_text(encoding="utf-8"))
        lore["sidor"].append({"id": "h1", "titel": "Huset", "text": ["Henrics."], "skrev": "henric", "skapad": "2026-10-08T08:00:00.000Z", "versioner": []})
        lore_path.write_text(json.dumps(lore), encoding="utf-8")
        fore = lore_path.read_text(encoding="utf-8")
        r = kor(rot, "lore", "--sida", "h1", "--titel", "Huset", "--text", "Demis.")
        ok(r.returncode == 2 and "Bara den som skrev" in r.stderr and lore_path.read_text(encoding="utf-8") == fore,
           "Demi cannot change Henric's page: refused, file untouched")

        # Demi has no way to change the manuscript: there is no such command.
        r = kor(rot, "andra", "--episod", "1")
        ok(r.returncode != 0 and (glimt / "episod-1.md").read_text(encoding="utf-8") == manus_fore, "there is no command that writes the manuscript")

        # The page and the script at the same time: nothing goes missing.
        fore_antal = len(rum(rot)["kommentarer"])
        resultat: dict[str, object] = {}

        def sida_skriver() -> None:
            resultat["sidan"] = sidan(url, "henric", 15)

        def skript_skriver(n: int) -> None:
            fel = 0
            for k in range(6):
                r = kor(rot, "kommentera", "--episod", "1", "--scen", "1", "--text", f"skript {n}.{k}")
                if r.returncode != 0:
                    fel += 1
                    print(f"  script {n}.{k}: {r.stderr.strip()[:200]}")
            resultat[f"skript{n}"] = fel

        tradar = [threading.Thread(target=sida_skriver)] + [threading.Thread(target=skript_skriver, args=(n,)) for n in range(3)]
        for t in tradar:
            t.start()
        for t in tradar:
            t.join()
        d = rum(rot)
        texter = [k["text"] for k in d["kommentarer"]]
        ok(all(resultat.get(f"skript{n}") == 0 for n in range(3)) and len(resultat.get("sidan", [])) == 15,
           f"the page (15) and three script processes (6 each) all report saved ({resultat})")
        ok(len(texter) == fore_antal + 15 + 18 and all(f"sidan {k}" in texter for k in range(15))
           and all(f"skript {n}.{k}" in texter for n in range(3) for k in range(6)),
           f"and every one of them is in the file: {len(texter) - fore_antal} of 33")
        ok(len({k["id"] for k in d["kommentarer"]}) == len(d["kommentarer"]), "no two posts share an id")
        ok((glimt / "episod-1.md").read_text(encoding="utf-8") == manus_fore, "the manuscript is still untouched")
    finally:
        server.terminate()
        server.wait(timeout=5)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{checks - failures}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
