#!/usr/bin/env python3
"""Tests for scripts/rummet.py, Demi's door into the room, against a sandbox.

Builds a stand-in for ~/generalassistant in a temp folder, starts the
portal stand-in (scripts/rummet_provserver.py) over it, and then:

- runs the script's commands and reads what they wrote: the md file line by
  line, and the notes with the history;
- lets "the page" (the room's own lager.js through the portal file API, in
  node, as Henric) and several script processes write the same files at the
  same time, text and notes both, and counts that nothing went missing;
- checks that every change Demi makes is recorded as Demi's.

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


def kor(rot: Path, *args: str, stdin: str | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "--rot", str(rot), *args], input=stdin,
                          capture_output=True, text=True, check=False, env={**os.environ, **(env or {})})


# A stand-in for the portal's file module that can be told to misbehave:
# RUMMET_TEST_NEKA (a regex on the file name) refuses writes, and
# RUMMET_TEST_BYT ({"fil", "fran", "till"}) changes a file right after this
# process first read it, as someone else saving in between would.
STORIG = """
import json, os, re
from pathlib import Path
_src = Path(os.environ["RUMMET_TEST_RIKTIG"])
exec(compile(_src.read_text(encoding="utf-8"), str(_src), "exec"), globals())
_las, _skriv, _bytt = read_file, write_file, set()

def write_file(path, content, expected_mtime):
    neka = os.environ.get("RUMMET_TEST_NEKA")
    if neka and re.search(neka, Path(path).name):
        raise OSError("disken svarar inte (prov)")
    return _skriv(path, content, expected_mtime)

def read_file(path):
    d = _las(path)
    byt = json.loads(os.environ.get("RUMMET_TEST_BYT") or "null")
    if byt and Path(path).name == byt["fil"] and path not in _bytt:
        _bytt.add(path)
        t = Path(path).read_text(encoding="utf-8")
        assert byt["fran"] in t, "the line to change is not in the file"
        st = os.stat(path)
        Path(path).write_text(t.replace(byt["fran"], byt["till"]), encoding="utf-8")
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 50_000_000))
    return d
"""


def rum(rot: Path, namn: str = "episod-1") -> dict:
    return json.loads((rot / "data" / "glimt-rummet" / f"{namn}.json").read_text(encoding="utf-8"))


def innehall(t: str) -> list[str]:
    """The file's lines, the separators aside."""
    return [r for r in t.split("\n") if r.strip() not in ("", ">")]


def skillnad(fore: str, efter: str) -> tuple[list[str], list[str]]:
    """Lines that left and lines that came."""
    a, b = innehall(fore), innehall(efter)
    return [r for r in a if r not in b], [r for r in b if r not in a]


def rader_av(rot: Path, *args: str) -> list[list[str]]:
    """'rader' as [id, kind, text] per paragraph."""
    ut = kor(rot, "rader", *args).stdout
    return [ln.split(None, 2) for ln in ut.splitlines() if ln.startswith("  ") and len(ln.split(None, 2)) == 3]


# The page, without a browser: lager.js through the portal file API, as Henric.
SIDAN = """
import { skapaLager } from %(lager)s;
import { portalAdapter } from %(data)s;
import * as D from %(dok)s;
const [url, lage, antal, vilket] = process.argv.slice(1);
const f = (u, o = {}) => fetch(new URL(u, url), { ...o, headers: { ...(o.headers || {}), Origin: url.replace(/\\/$/, '') } });
const adapter = { ...portalAdapter({ fetch: f }), vem: async () => ({ id: 'henric', namn: 'Henric' }) };
const m = new Map();
const lagring = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, key: (n) => [...m.keys()][n] ?? null, get length() { return m.size; } };
const lager = skapaLager(adapter, { lagring, flik: 'sidan' });
const d = await lager.dokument('1');
const start = await d.ladda();
let lista = start.paras.map((p) => ({ ...p }));
const plats = (id) => lista.findIndex((p) => p.id === id);
const ed = {
  stycken: () => lista,
  laser: () => null,
  tillampa(ops) {
    for (const o of ops) {
      if (o.op === 'ersatt') { const k = plats(o.id); if (k >= 0) lista[k] = { ...o.p, id: o.id }; }
      if (o.op === 'infoga') { const k = o.efter == null ? -1 : plats(o.efter); lista.splice(k + 1, 0, { ...o.p }); }
      if (o.op === 'ta-bort') { const k = plats(o.id); if (k >= 0) lista.splice(k, 1); }
      if (o.op === 'attrs') { const k = plats(o.id); if (k >= 0) lista[k] = { ...lista[k], raw: o.raw, orig: o.orig, sep: o.sep }; }
      if (o.op === 'byt-id') { const k = plats(o.id); if (k >= 0) lista[k] = { ...lista[k], id: o.till }; }
      if (o.op === 'ordning') { const n = new Map(o.ids.map((id, i) => [id, i])); lista = lista.map((p, i) => [p, i]).sort((a, b) => (n.get(a[0].id) ?? a[1]) - (n.get(b[0].id) ?? b[1])).map((x) => x[0]); }
    }
  },
};
d.koppla(ed);
const ut = [];
const repliker = lista.filter((p) => p.typ === 'replik').map((p) => p.id);
for (let k = 0; k < Number(antal); k++) {
  if (lage === 'kommentera') {
    const id = D.nyttId();
    const mal = lista.find((p) => p.typ === 'scen');
    const okej = await d.anteckna('kommentar', { id, stycke: mal.id, galde: mal.text, text: `sidan ${k}`, vem: 'henric', nar: new Date().toISOString(), till: vilket === 'demi' ? 'demi' : null });
    if (okej) ut.push(id);
  } else {
    // Change one paragraph at a time, each its own save.
    const id = repliker[Number(vilket) + k];
    const i = plats(id);
    lista = lista.map((p, x) => (x === i ? { ...p, text: `${p.text} (sidan ${k})`, raw: null, orig: null } : p));
    await d.spara();
    ut.push(id);
  }
}
process.stdout.write(JSON.stringify(ut));
"""


def sidan(url: str, lage: str, antal: int, vilket: str = "") -> list[str]:
    js = SIDAN % {k: json.dumps((REPO / "rummet" / f"{k}.js").as_uri()) for k in ("lager", "data", "dok")}
    r = subprocess.run(["node", "--input-type=module", "-e", js, url, lage, str(antal), vilket],
                       capture_output=True, text=True, check=False)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-1200:])
    return json.loads(r.stdout)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="rummet-cli-"))
    rot = tmp / "ga"
    glimt = rot / "projects" / "motionstory" / "stories" / "glimt"
    glimt.mkdir(parents=True)
    (rot / "data" / "glimt-rummet").mkdir(parents=True)
    for f in ("episod-1.md", "episod-2.md", "episod-1.json", "varld.md", "mekaniker.md"):
        shutil.copyfile(GLIMT / f, glimt / f)
    M = glimt / "episod-1.md"
    manus_fore = M.read_text(encoding="utf-8")
    env = dict(os.environ, RUMMET_FILES_PY=os.environ.get("RUMMET_FILES_PY", ""))
    server = subprocess.Popen([sys.executable, str(REPO / "scripts" / "rummet_provserver.py"), "--rot", str(rot)],
                              stdout=subprocess.PIPE, text=True, env=env)
    try:
        url = server.stdout.readline().strip()

        # Reading the paragraphs, to name one.
        r = kor(rot, "rader", "--dok", "1", "--scen", "2")
        rader = rader_av(rot, "--dok", "1", "--scen", "2")
        replik = next((x for x in rader if x[1] == "replik"), None)
        mekanik = next((x for x in rader if x[1] == "mekanik"), None)
        ok(r.returncode == 0 and "## scen 2" in r.stdout and replik and mekanik, f"rader: scene 2's paragraphs with ids and kinds ({replik and replik[2][:30]})")
        ok(M.read_text(encoding="utf-8") == manus_fore, "reading writes nothing")
        ok(kor(rot, "rader", "--episod", "1", "--scen", "2").stdout == r.stdout, "--episod still works, and the ids are the same every time")
        pid, ptext = replik[0], replik[2]

        # A comment on a paragraph: by id, and by its words.
        r = kor(rot, "kommentera", "--dok", "1", "--stycke", pid, "--text", "Kortare paus?", "--galler", "paus")
        k = (rum(rot)["kommentarer"] or [{}])[-1]
        ok(r.returncode == 0 and k.get("skrev") == "demi" and k.get("stycke") == pid and k.get("galde") == ptext and k.get("galler") == "paus",
           f"kommentera: a comment at the paragraph, as Demi: {r.stderr[:200]} {k}")
        r = kor(rot, "kommentera", "--dok", "1", "--scen", "2", "--rad", ptext, "--text", "-", stdin="Från stdin.\n")
        ok(r.returncode == 0 and rum(rot)["kommentarer"][-1]["text"] == "Från stdin." and rum(rot)["kommentarer"][-1]["stycke"] == pid,
           "kommentera: the paragraph named by its words, text from stdin without the last newline")
        r = kor(rot, "kommentera", "--dok", "1", "--rad", "Finns inte i manuset.", "--text", "x")
        ok(r.returncode == 2 and "Det står inget stycke så" in r.stderr, "a paragraph that is not there is refused, with a reason")
        r = kor(rot, "kommentera", "--dok", "1", "--scen", "99", "--text", "x")
        ok(r.returncode == 2 and "ingen scen 99" in r.stderr, "a scene that is not there is refused")
        r = kor(rot, "kommentera", "--dok", "9", "--stycke", pid, "--text", "x")
        ok(r.returncode == 2 and "Okänt dokument" in r.stderr, "a document that is not there is refused")

        # Proposals: must be a paragraph the file can hold.
        r = kor(rot, "foresla", "--dok", "1", "--stycke", pid, "--text", "Ett nytt sätt att säga det.")
        f = (rum(rot)["forslag"] or [{}])[-1]
        ok(r.returncode == 0 and f.get("skrev") == "demi" and f.get("lage") == "oppet" and f.get("typ") == "replik" and f.get("text") == "Ett nytt sätt att säga det.",
           f"foresla: a proposal at the paragraph, open, Demi's: {r.stderr[:200]} {f}")
        r = kor(rot, "foresla", "--dok", "1", "--stycke", pid, "--text", "två\nrader")
        ok(r.returncode == 2 and len(rum(rot)["forslag"]) == 1, "a proposal of two lines is refused")
        r = kor(rot, "foresla", "--dok", "1", "--stycke", pid, "--text", ptext)
        ok(r.returncode == 2 and "samma som texten" in r.stderr, "a proposal that is the text itself is refused")
        ok(M.read_text(encoding="utf-8") == manus_fore, "comments and proposals do not touch the manuscript")

        # Demi changes a paragraph, when asked: one line of the file, and the history says Demi.
        r = kor(rot, "andra", "--dok", "1", "--stycke", pid, "--text", "Jag måste få veta en sak.")
        efter = M.read_text(encoding="utf-8")
        bort, kom = skillnad(manus_fore, efter)
        ok(r.returncode == 0 and bort == [f"> {ptext}"] and kom == ["> Jag måste få veta en sak."], f"andra: exactly that line changed: {r.stderr[:200]} {bort} {kom}")
        ok(len(efter.split("\n")) == len(manus_fore.split("\n")), "andra: no line was added or lost")
        h = rum(rot)["historik"].get(pid, [])
        ok(bool(h) and h[-1].get("vem") == "demi" and h[-1].get("hur") == "andrade" and h[-1].get("text") == "Jag måste få veta en sak.",
           f"andra: the history says Demi changed it: {h[-1:]}")
        ok(any(e.get("text") == ptext for e in h), "andra: the earlier words are kept in the history")
        r = kor(rot, "andra", "--dok", "1", "--stycke", pid, "--text", "Jag måste få veta en sak.")
        ok(r.returncode == 2 and "redan så" in r.stderr, "andra: the same words again is refused")
        r = kor(rot, "andra", "--dok", "1", "--stycke", pid, "--text", "två\nrader")
        ok(r.returncode == 2 and M.read_text(encoding="utf-8") == efter, f"andra: two lines in one paragraph is refused, file untouched: {r.stderr[:160]}")
        r = kor(rot, "andra", "--dok", "1", "--stycke", pid, "--typ", "regi", "--text", "väntar")
        ok(r.returncode == 0 and "> (väntar)\n" in M.read_text(encoding="utf-8"), f"andra --typ: the paragraph changes kind, in the file's own form: {r.stderr[:160]}")
        r = kor(rot, "andra", "--dok", "1", "--stycke", pid, "--md", "--text", "> [mörkt] Jag måste få veta.")
        ok(r.returncode == 0 and "> [mörkt] Jag måste få veta.\n" in M.read_text(encoding="utf-8"), f"andra --md: a whole md line, read as its kind: {r.stderr[:160]}")

        # Adding and removing.
        fore2 = M.read_text(encoding="utf-8")
        r = kor(rot, "lagg-till", "--dok", "1", "--efter", pid, "--typ", "replik", "--text", "En rad till, från Demi.")
        t = M.read_text(encoding="utf-8")
        bort, kom = skillnad(fore2, t)
        ok(r.returncode == 0 and not bort and kom == ["> En rad till, från Demi."], f"lagg-till: one new line: {r.stderr[:200]} {bort} {kom}")
        i = innehall(t)
        ok("> En rad till, från Demi." in i and i[i.index("> En rad till, från Demi.") - 1] == "> [mörkt] Jag måste få veta.", "lagg-till: it stands right after the paragraph named")
        ny = r.stdout.split("[")[1].split("]")[0] if "[" in r.stdout else ""
        hn = rum(rot)["historik"].get(ny, [])
        ok(bool(hn) and hn[-1].get("vem") == "demi" and hn[-1].get("hur") == "skrev", f"lagg-till: the history says Demi wrote it: {hn[-1:]}")
        r = kor(rot, "lagg-till", "--dok", "1", "--scen", "1", "--typ", "gren", "--text", "Om vandraren springer:")
        i = innehall(M.read_text(encoding="utf-8"))
        ok(r.returncode == 0 and "> **Om vandraren springer:**" in i and i[i.index("> **Om vandraren springer:**") + 1].startswith("## 2."),
           f"lagg-till --scen: last in that scene, as a branch: {r.stderr[:200]}")
        r = kor(rot, "stryk", "--dok", "1", "--stycke", ny)
        ok(r.returncode == 0 and "En rad till, från Demi." not in M.read_text(encoding="utf-8"), f"stryk: the paragraph is gone from the file: {r.stderr[:200]}")
        hn = rum(rot)["historik"].get(ny, [])
        ok(bool(hn) and bool(hn[-1].get("borta")) and hn[-1].get("vem") == "demi" and any(e.get("text") == "En rad till, från Demi." for e in hn),
           f"stryk: the history keeps its words and says Demi removed it: {hn[-2:]}")

        # The world book and the catalogue, the same way.
        V = glimt / "varld.md"
        vfore = V.read_text(encoding="utf-8")
        vrad = next(x for x in rader_av(rot, "--dok", "varld") if x[1] == "stycke" and len(x[2]) > 40)
        r = kor(rot, "andra", "--dok", "varld", "--stycke", vrad[0], "--text", vrad[2] + " Tillagt av Demi.")
        bort, kom = skillnad(vfore, V.read_text(encoding="utf-8"))
        ok(r.returncode == 0 and len(bort) == 1 and len(kom) == 1 and kom[0].endswith("Tillagt av Demi."), f"andra --dok varld: one line of the world book: {r.stderr[:200]}")
        ok(rum(rot, "varld")["historik"][vrad[0]][-1]["vem"] == "demi", "the world book's history says Demi")
        K = glimt / "mekaniker.md"
        kfore = K.read_text(encoding="utf-8")
        r = kor(rot, "kommentera", "--dok", "mekaniker", "--rad", "### Kontakten", "--text", "Den här bär allt.")
        ok(r.returncode == 0 and K.read_text(encoding="utf-8") == kfore and rum(rot, "mekaniker")["kommentarer"][-1]["skrev"] == "demi",
           f"kommentera --dok mekaniker: a heading named by its md line: {r.stderr[:200]}")

        # A request for a new mechanic, and a question to Demi, come first in 'nytt'.
        r = kor(rot, "andra", "--dok", "1", "--stycke", mekanik[0], "--text", "Ny mekanik: vandraren klappar händerna")
        ok(r.returncode == 0 and "*Trigger: Ny mekanik: vandraren klappar händerna*\n" in M.read_text(encoding="utf-8"), f"a Mekanik row keeps its form when changed: {r.stderr[:200]}")
        fraga = sidan(url, "kommentera", 1, "demi")[0]
        j = json.loads(kor(rot, "nytt", "--sedan", "2020-01-01T00:00", "--json").stdout)
        ok([x["slag"] for x in j["vantar"]] == ["ny-mekanik", "fraga"] and j["vantar"][1]["id"] == fraga,
           f"nytt: the new mechanic first, then the question to Demi: {[x['slag'] for x in j['vantar']]}")
        ok(any(h["slag"] == "kommentar" and h["vem"] == "henric" for h in j["handelser"]) and not any(h.get("vem") == "demi" for h in j["handelser"]),
           "nytt: others' posts are news, Demi's own are not")
        r = kor(rot, "nytt", "--sedan", "2020-01-01T00:00")
        ok(r.stdout.startswith("Väntar på Demi: 2") and "Ny mekanik, episod 1, scen 2" in r.stdout and f"--stycke {mekanik[0]}" in r.stdout,
           f"nytt: says where the request stands and how to answer it: {r.stdout[:300]}")
        kor(rot, "kommentera", "--dok", "1", "--stycke", mekanik[0], "--text", "Det finns ingen sådan mekanik än. Närmast är Knack.")
        r = kor(rot, "svara", "--pa", fraga, "--text", "För att hon lyssnar.")
        svar = rum(rot)["kommentarer"][-1]
        ok(r.returncode == 0 and svar.get("svarPa") == fraga and svar["skrev"] == "demi" and "<- ditt svar" in r.stdout, f"svara: a reply in the thread, as Demi, with the thread shown: {r.stderr[:200]}")
        ok(kor(rot, "nytt", "--sedan", "2020-01-01T00:00").stdout.startswith("Väntar på Demi: 0"), "answered: nothing waits for Demi")
        r = kor(rot, "svara", "--pa", "finns-inte", "--text", "x")
        ok(r.returncode == 2 and "Hittar ingen kommentar" in r.stderr, "svara: an id that is not there is refused")

        # 'nytt' without --sedan moves its mark: the second time there is nothing new.
        kor(rot, "nytt")
        ok(json.loads(kor(rot, "nytt", "--json").stdout)["handelser"] == [], "nytt remembers what it has shown")
        sett_fil = rot / "data" / "glimt-rummet" / "demi-sett.json"
        ok(set(json.loads(sett_fil.read_text(encoding="utf-8"))) == {"sett", "nycklar"}, "the mark file keeps its form: sett and nycklar")
        sett_fil.write_text("{trasig", encoding="utf-8")
        r = kor(rot, "nytt", "--behall")
        ok(r.returncode == 0 and "en vecka bakåt" in r.stdout and "gick inte att läsa" in r.stderr, "nytt: a broken mark file falls back to a week, and says so")
        # The first version's mark file (keys of another form) is read as it is.
        sett_fil.write_text(json.dumps({"sett": "2026-10-08T06:00:00.000Z", "nycklar": ["1|kommentar|abc|henric|2026-10-08T05:00:00.000Z"]}), encoding="utf-8")
        r = kor(rot, "nytt")
        ok(r.returncode == 0 and "förra gången (2026-10-08 06:00 UTC)" in r.stdout, f"nytt: the first version's mark file still works: {r.stdout[-200:]} {r.stderr[:200]}")

        # Lore.
        r = kor(rot, "lore", "--titel", "Slingan", "--text", "Den surrar.")
        lore = json.loads((rot / "data" / "glimt-rummet" / "lore.json").read_text(encoding="utf-8"))
        ok(r.returncode == 0 and lore["sidor"][0]["skrev"] == "demi" and lore["sidor"][0]["titel"] == "Slingan", f"lore: a page of Demi's own: {r.stderr[:200]}")
        sid = lore["sidor"][0]["id"]
        r = kor(rot, "rader", "--dok", f"lore:{sid}")
        ok(r.returncode == 0 and "Den surrar." in r.stdout, f"rader --dok lore:<id>: the page's paragraphs: {r.stderr[:200]}")

        # The page and the script at the same time, on the notes: nothing goes missing.
        fore_antal = len(rum(rot)["kommentarer"])
        resultat: dict[str, object] = {}

        def sida_kommenterar() -> None:
            resultat["sidan"] = sidan(url, "kommentera", 12)

        def skript_kommenterar(n: int) -> None:
            fel = 0
            for k in range(5):
                r = kor(rot, "kommentera", "--dok", "1", "--scen", "1", "--text", f"skript {n}.{k}")
                if r.returncode != 0:
                    fel += 1
                    print(f"  script {n}.{k}: {r.stderr.strip()[:200]}")
            resultat[f"skript{n}"] = fel

        tradar = [threading.Thread(target=sida_kommenterar)] + [threading.Thread(target=skript_kommenterar, args=(n,)) for n in range(3)]
        for t in tradar:
            t.start()
        for t in tradar:
            t.join()
        d = rum(rot)
        texter = [k["text"] for k in d["kommentarer"]]
        ok(all(resultat.get(f"skript{n}") == 0 for n in range(3)) and len(resultat.get("sidan", [])) == 12,
           f"notes: the page (12) and three script processes (5 each) all report saved ({resultat})")
        ok(len(texter) == fore_antal + 12 + 15 and all(f"sidan {k}" in texter for k in range(12))
           and all(f"skript {n}.{k}" in texter for n in range(3) for k in range(5)),
           f"notes: every one of them is in the file: {len(texter) - fore_antal} of 27")
        ok(len({k["id"] for k in d["kommentarer"]}) == len(d["kommentarer"]), "no two posts share an id")

        # The page and the script at the same time, on the text: different
        # paragraphs, every change stays, each with the right name in the history.
        repliker = [x for x in rader_av(rot, "--dok", "1") if x[1] == "replik"]
        resultat = {}

        def sida_skriver() -> None:
            resultat["sidan"] = sidan(url, "skriv", 6, "0")

        def skript_skriver(n: int) -> None:
            fel = 0
            for k in range(3):
                x = repliker[10 + n * 3 + k]
                r = kor(rot, "andra", "--dok", "1", "--stycke", x[0], "--text", f"{x[2]} (skript {n}.{k})")
                if r.returncode != 0:
                    fel += 1
                    print(f"  script {n}.{k}: {r.stderr.strip()[:300]}")
            resultat[f"skript{n}"] = fel

        tradar = [threading.Thread(target=sida_skriver)] + [threading.Thread(target=skript_skriver, args=(n,)) for n in range(2)]
        for t in tradar:
            t.start()
        for t in tradar:
            t.join()
        slut = M.read_text(encoding="utf-8")
        ok(all(resultat.get(f"skript{n}") == 0 for n in range(2)) and len(resultat.get("sidan", [])) == 6, f"text: the page (6) and two script processes (3 each) all report saved ({resultat})")
        ok(all(f"(sidan {k})" in slut for k in range(6)) and all(f"(skript {n}.{k})" in slut for n in range(2) for k in range(3)),
           f"text: every change is in the file: {sum(f'(sidan {k})' in slut for k in range(6))} of 6 and {sum(f'(skript {n}.{k})' in slut for n in range(2) for k in range(3))} of 6")
        hist = rum(rot)["historik"]
        ok(all(hist.get(repliker[10 + n * 3 + k][0], [{}])[-1].get("vem") == "demi" for n in range(2) for k in range(3)), "text: Demi's changes are Demi's in the history")
        ok(all(hist.get(i, [{}])[-1].get("vem") == "henric" for i in resultat.get("sidan", [])), "text: the page's changes are Henric's in the history")
        ok(not rum(rot).get("krockar"), f"text: different paragraphs never make a krock: {rum(rot).get('krockar')}")

        # --- When something goes wrong on the way -------------------------------
        storig = tmp / "storig_files.py"
        storig.write_text(STORIG, encoding="utf-8")
        riktig = os.environ.get("RUMMET_FILES_PY") or str(Path.home() / "generalassistant" / "scripts" / "dashboard" / "files.py")
        prov = {"RUMMET_FILES_PY": str(storig), "RUMMET_TEST_RIKTIG": riktig}
        vantande = rot / "data" / "glimt-rummet" / "demi-vantande.json"
        rader = rader_av(rot, "--dok", "1", "--scen", "3")
        x = next(r for r in rader if r[1] == "replik")

        # A comment whose notes could not be written waits, and goes out next time.
        r = kor(rot, "kommentera", "--dok", "1", "--stycke", x[0], "--text", "Den här fick vänta.", env={**prov, "RUMMET_TEST_NEKA": r"^episod-1\.json$"})
        ko = json.loads(vantande.read_text(encoding="utf-8")) if vantande.exists() else {}
        ok(r.returncode == 2 and "väntar" in r.stderr and any("Den här fick vänta." in v for v in ko.values()),
           f"a comment that could not be written is refused out loud and kept waiting: {r.stderr[:200]} {list(ko)}")
        ok(not any("Den här fick vänta." == k.get("text") for k in rum(rot)["kommentarer"]), "and is not in the notes yet")
        ok(not any("|osparat|" in k for k in ko), "what waits is notes only, never text")
        r = kor(rot, "rader", "--dok", "1", "--scen", "3")
        ko = json.loads(vantande.read_text(encoding="utf-8"))
        ok(r.returncode == 0 and sum("Den här fick vänta." == k.get("text") for k in rum(rot)["kommentarer"]) == 1 and not any(json.loads(v) for v in ko.values()),
           f"the next command sends it, once, and the waiting list is empty: {ko}")

        # Text saved, the note about who did it refused: said, kept, sent next time.
        r = kor(rot, "andra", "--dok", "1", "--stycke", x[0], "--text", f"{x[2]} (noten väntar)", env={**prov, "RUMMET_TEST_NEKA": r"^episod-1\.json$"})
        ok(r.returncode == 0 and "(noten väntar)" in M.read_text(encoding="utf-8") and "väntar och skickas nästa gång" in r.stderr,
           f"text saved while the notes could not be written: said so: {r.stderr[:200]}")
        ok((rum(rot)["historik"].get(x[0]) or [{}])[-1].get("text") != f"{x[2]} (noten väntar)", "and the history does not have it yet")
        kor(rot, "rader", "--dok", "1", "--scen", "3")
        h = (rum(rot)["historik"].get(x[0]) or [{}])[-1]
        ok(h.get("text") == f"{x[2]} (noten väntar)" and h.get("vem") == "demi", f"the next command writes the history, as Demi's: {h}")

        # Two rummet.py at once: what one put in the waiting list, the other keeps.
        sys.path.insert(0, str(REPO / "scripts"))
        import rummet as R
        ett = R.Rum(rot, False)
        vantande.write_text(json.dumps({"k": json.dumps([{"id": "a"}])}), encoding="utf-8")
        ett.spara_vantande({}, {"k": json.dumps([{"id": "b"}])})
        ok([n["id"] for n in json.loads(json.loads(vantande.read_text(encoding="utf-8"))["k"])] == ["a", "b"], "a note another process left waiting meanwhile is kept beside this one's")
        vantande.write_text(json.dumps({"k": json.dumps([{"id": "a"}, {"id": "c"}])}), encoding="utf-8")
        ett.spara_vantande({"k": json.dumps([{"id": "a"}])}, {})
        ok([n["id"] for n in json.loads(json.loads(vantande.read_text(encoding="utf-8"))["k"])] == ["c"], "a note this process sent is taken out, the other's stays")
        ett.spara_vantande({"k": json.dumps([{"id": "c"}])}, {})
        ok(json.loads(vantande.read_text(encoding="utf-8")) == {}, "and when all is sent the list is empty")

        # Someone saves the same paragraph between Demi's read and write.
        y = next(r for r in rader if r[1] == "replik" and r[0] != x[0])
        byt = json.dumps({"fil": "episod-1.md", "fran": f"> {y[2]}", "till": f"> {y[2]} (någon annan hann före)"})
        r = kor(rot, "andra", "--dok", "1", "--stycke", y[0], "--text", f"{y[2]} (Demi)", env={**prov, "RUMMET_TEST_BYT": byt})
        t = M.read_text(encoding="utf-8")
        kr = [k for k in rum(rot).get("krockar") or [] if k.get("stycke") == y[0] and k.get("lage") == "oppen"]
        ok(r.returncode == 0 and f"> {y[2]} (Demi)" in t and "(någon annan hann före)" not in t and len(kr) == 1 and kr[0]["text"] == f"{y[2]} (någon annan hann före)",
           f"andra over someone's simultaneous change: Demi's words in the text, theirs kept at the paragraph: {r.stderr[:200]} {kr}")
        ok("ändrade samma stycke samtidigt" in r.stderr and y[2][:40] in r.stderr and "krock vid stycket" in r.stderr, f"and Demi is told so: {r.stderr[:300]}")
        z = next(r for r in rader if r[1] == "replik" and r[0] not in (x[0], y[0]))
        byt = json.dumps({"fil": "episod-1.md", "fran": f"> {z[2]}", "till": f"> {z[2]} (ändrad just nu)"})
        r = kor(rot, "stryk", "--dok", "1", "--stycke", z[0], env={**prov, "RUMMET_TEST_BYT": byt})
        ok(r.returncode == 2 and "togs inte bort" in r.stderr and f"> {z[2]} (ändrad just nu)" in M.read_text(encoding="utf-8"),
           f"stryk of a paragraph someone just changed: it stands, and the command says so: {r.returncode} {r.stderr[:300]}")

        # The file still reads back as itself.
        js = "import { readFileSync } from 'node:fs'; const D = await import(process.argv[1]); const t = readFileSync(process.argv[2], 'utf8'); const x = D.tolka(t, D.SLAG_EPISOD); process.stdout.write(String(D.skriv({ paras: D.justera(x.paras, null), slut: x.slut }) === t));"
        r = subprocess.run(["node", "--input-type=module", "-e", js, (REPO / "rummet" / "dok.js").as_uri(), str(M)], capture_output=True, text=True, check=False)
        ok(r.stdout == "true", f"after all of it the manuscript reads back as itself: {r.stderr[:200]}")
    finally:
        server.terminate()
        server.wait(timeout=5)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{checks - failures}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
