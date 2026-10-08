#!/usr/bin/env python3
"""The room in a real browser, end to end, on copies of the manuscript.

Builds a sandbox (copies of episodes 1 and 2, the recordings list, the world
book, HELD's lore, and Demi's baseline written fresh by rummet_grund.py),
deploys the room into it with rummet_deploy.py, and runs the local portal
stand-in (rummet_provserver.py, which uses the portal's own files.py for the
mtime check and the atomic write). Then a phone-sized Chromium does what
Henric would: listen, change a line, propose, say yes, lay it in, take it
back, comment, strike and put back, add a line, write a lore page. Between the
clicks the test changes the files on disk the way the portal's file panel or
Demi would, and checks that nobody's text is lost and that every other line
of the manuscript stays byte for byte.

    ~/generalassistant/.venv/bin/python scripts/test_rummet_browser.py [--skarmar DIR]

The sound is served from this repo's audio/ instead of the public site.
Nothing outside the temporary sandbox is read for writing or written.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[1]
GA = Path("/home/henric/generalassistant")
GLIMT = REPO / "stories" / "glimt"
failures = 0
checks = 0


def ok(cond: bool, what: str) -> None:
    global failures, checks
    checks += 1
    if not cond:
        failures += 1
    if not cond or os.environ.get("VERBOSE"):
        print(f"{'ok  ' if cond else 'FAIL'}  {what}", flush=True)


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LINES_JS = """
import { readFileSync } from 'node:fs';
const M = await import(process.env.MANUS_JS);
const text = readFileSync(process.env.FIL, 'utf8');
const m = M.tolka(text);
const ut = m.rader.filter((r) => r.typ === 'replik' && r.scen != null).map((r) => {
  let strykbar = true;
  try { M.stryk(text, M.ankareFor(m, r.i)); } catch { strykbar = false; }
  return { i: r.i, scen: r.scen, kropp: r.kropp, variant: r.variant, etikett: r.etikett, strykbar, slag: M.kroppDelar(r.kropp).slag };
});
process.stdout.write(JSON.stringify(ut));
"""


def repliker(fil: Path) -> list[dict]:
    env = {**os.environ, "MANUS_JS": (REPO / "rummet" / "manus.js").as_uri(), "FIL": str(fil)}
    out = subprocess.run(["node", "--input-type=module", "-e", LINES_JS], capture_output=True, text=True, check=True, env=env)
    return json.loads(out.stdout)


def sandbox() -> tuple[Path, Path]:
    rot = Path(tempfile.mkdtemp(prefix="rummet-browser-"))
    glimt = rot / "projects/motionstory/stories/glimt"
    glimt.mkdir(parents=True)
    for f in ("episod-1.md", "episod-2.md", "episod-1.json", "varld.md"):
        shutil.copyfile(GLIMT / f, glimt / f)
    held = rot / "projects/held/universe"
    held.mkdir(parents=True)
    lore = GA / "projects/held/universe/LORE.md"
    if lore.exists():
        shutil.copyfile(lore, held / "LORE.md")
    else:
        (held / "LORE.md").write_text("# HELD\n\nEn stand-in för HELD:s lore.\n", encoding="utf-8")
    load("rummet_grund").write_baseline(rot / "data/glimt-rummet", ["1e54ffc"])
    ut = rot / "uploads"
    load("rummet_deploy").deploy(ut)
    return rot, ut


def provserver(rot: Path, ut: Path, api: bool = True) -> tuple[subprocess.Popen, str]:
    args = [sys.executable, str(REPO / "scripts/rummet_provserver.py"), "--rot", str(rot), "--uploads", str(ut)]
    if not api:
        args.append("--utan-api")
    p = subprocess.Popen(args, stdout=subprocess.PIPE, text=True)
    url = p.stdout.readline().strip().rstrip("/")
    return p, url


INIT = """
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () { window.__ljud = this; return play.call(this); };
"""


def route_audio(route) -> None:
    """The public site's recordings, from this repo, with byte ranges as
    GitHub Pages serves them."""
    url = route.request.url.split("#")[0]
    rel = url.split("/motionstory/audio/", 1)[-1]
    f = REPO / "audio" / rel
    if not f.is_file():
        route.fulfill(status=404, body=b"")
        return
    data = f.read_bytes()
    m = re.match(r"bytes=(\d+)-(\d*)", route.request.headers.get("range", ""))
    if not m:
        route.fulfill(status=200, body=data, headers={"Content-Type": "audio/mpeg", "Accept-Ranges": "bytes"})
        return
    start = int(m.group(1))
    end = min(int(m.group(2)) if m.group(2) else len(data) - 1, len(data) - 1)
    route.fulfill(status=206, body=data[start:end + 1], headers={
        "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Content-Range": f"bytes {start}-{end}/{len(data)}"})


def ritad(page) -> str:
    return page.get_attribute("#rum", "data-ritad") or ""


def spara(page, klick) -> list[str] | None:
    """Click, then wait for the page to be drawn again (a save went through)
    or for an error. -> None on success, else the error texts."""
    fore = ritad(page)
    # An error already on the page is not this save's answer.
    page.evaluate("for (const p of document.querySelectorAll('.fel p')) p.dataset.gammal = '1'")
    klick()
    page.wait_for_function(
        """n => document.getElementById('rum').dataset.ritad !== n
           || document.querySelector('.fel p:not([data-gammal])')
           || document.querySelector('.status.fel:not([hidden])')""",
        arg=fore, timeout=20000)
    if ritad(page) != fore:
        return None
    return page.locator(".fel p:not([data-gammal]), .status.fel:not([hidden]) span").all_inner_texts() or ["(no redraw)"]


def rad(page, i: int):
    return page.locator(f"#rad-{i}")


def oppna(page, i: int) -> None:
    if not rad(page, i).locator(".verktyg").count():
        rad(page, i).locator(".radtext").click()
    rad(page, i).locator(".verktyg").wait_for()


def bump(fil: Path) -> None:
    s = fil.stat()
    os.utime(fil, (s.st_atime, s.st_mtime + 2))


def andra_pa_disk(fil: Path, i: int, ny: str) -> None:
    raa = fil.read_text(encoding="utf-8").split("\n")
    raa[i] = ny
    fil.write_text("\n".join(raa), encoding="utf-8")
    bump(fil)


def skillnad(a: str, b: str) -> list[int]:
    x, y = a.split("\n"), b.split("\n")
    if len(x) != len(y):
        return [-1]
    return [k for k in range(len(x)) if x[k] != y[k]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skarmar", type=Path, default=None, help="save screenshots here")
    args = ap.parse_args()
    if args.skarmar:
        args.skarmar.mkdir(parents=True, exist_ok=True)

    def skarm(page, namn: str) -> None:
        if args.skarmar:
            page.screenshot(path=str(args.skarmar / f"{namn}.png"))

    rot, ut = sandbox()
    manus1 = rot / "projects/motionstory/stories/glimt/episod-1.md"
    rumfil = rot / "data/glimt-rummet/episod-1.json"
    lorefil = rot / "data/glimt-rummet/lore.json"
    original = manus1.read_text(encoding="utf-8")
    alla = repliker(manus1)
    vega = [r for r in alla if r["slag"] == "vega" and not r["variant"] and not r["etikett"]]

    def valj(scen: str, n: int, strykbar: bool | None = None) -> dict:
        kand = [r for r in vega if r["scen"] == scen and (strykbar is None or r["strykbar"] == strykbar)]
        return kand[min(n, len(kand) - 1)]

    L1, L2, L3 = valj("1", 0), valj("1", 2), valj("2", 0)
    L4, L5, L6 = valj("3", 0), valj("3", 3), valj("4", 0)
    L7, L8, L9, L10 = valj("5", 1, strykbar=True), valj("6", 0), valj("2", 2), valj("0", 2)
    valda = [L1, L2, L3, L4, L5, L6, L7, L8, L9, L10]
    ok(len({r["i"] for r in valda}) == len(valda), "test setup: ten different lines picked")

    server, url = provserver(rot, ut)
    server_b, url_b = provserver(rot, ut, api=False)
    fel_i_sidan: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
            ctx.add_init_script(INIT)
            page = ctx.new_page()
            page.on("pageerror", lambda e: fel_i_sidan.append(str(e)))
            page.route("https://henricbarkman.github.io/**", route_audio)
            rum_url = f"{url}/uploads/glimt-rummet/index.html"

            # --- Reading --------------------------------------------------------------
            page.goto(f"{rum_url}#episod-1")
            page.wait_for_selector(".rad")
            ok(page.locator(".rad").count() == len(alla), f"episode 1: every line is shown ({page.locator('.rad').count()}/{len(alla)})")
            ok(page.locator(".vem .marke.demi").count() == len(alla), "episode 1: every line is marked as Demi's draft")
            ok(page.locator(".spela").count() > len(alla) * 0.8, f"episode 1: most lines can be played ({page.locator('.spela').count()})")
            ok(page.locator(".radinfo .ej").count() == 0, "episode 1: nothing reads as not recorded before anyone has changed anything")
            ok(bool(re.match(r"^[0-9a-f]{10} ", page.get_attribute('meta[name="rummet-bygge"]', "content") or "")), "the deployed page names its build")
            skarm(page, "01-episod-1")

            # --- Listening ------------------------------------------------------------
            knapp = rad(page, L10["i"]).locator(".spela")
            knapp.click()
            page.wait_for_function("window.__ljud && !window.__ljud.paused && window.__ljud.currentTime > 0.2", timeout=15000)
            src = page.evaluate("window.__ljud.src")
            m = re.search(r"#t=([\d.]+)(?:,([\d.]+))?$", src)
            t = page.evaluate("window.__ljud.currentTime")
            ok("/audio/glimt/vega/glimt-e1/" in src and m is not None, f"play: the line's clip is fetched from the recordings ({src.rsplit('/', 1)[-1]})")
            ok(m is not None and t >= float(m.group(1)) - 0.3 and (m.group(2) is None or t < float(m.group(2))),
               f"play: it starts where the line starts in the clip ({t:.2f}s in {m.group(0) if m else '?'})")
            ok("spelar" in (knapp.get_attribute("class") or ""), "play: the button shows that it plays")
            knapp.click()
            ok(page.evaluate("window.__ljud.paused"), "play: pressing again stops it")

            # --- Changing a line --------------------------------------------------------
            ny1 = 'Så. Nu hör jag dig <b>tydligt</b> & "klart". '
            oppna(page, L1["i"])
            rad(page, L1["i"]).get_by_role("button", name="Ändra", exact=True).click()
            rad(page, L1["i"]).locator("textarea").fill(ny1)
            fel = spara(page, lambda: rad(page, L1["i"]).get_by_role("button", name="Spara i manus").click())
            ok(fel is None, f"edit: saved ({fel})")
            efter = manus1.read_text(encoding="utf-8")
            ok(skillnad(original, efter) == [L1["i"]] and efter.split("\n")[L1["i"]] == f"> {ny1}",
               "edit: exactly that one line changed in the file, and it is exactly what was typed")
            ok(rad(page, L1["i"]).locator(".marke.henric").count() == 1, "edit: the line is now marked as Henric's")
            ok(rad(page, L1["i"]).locator(".radinfo .ej").count() == 1, "edit: the changed line reads as not recorded yet")
            ok(rad(page, L1["i"]).locator(".radtext b").count() == 0 and "<b>tydligt</b>" in rad(page, L1["i"]).locator(".radtext").inner_text(),
               "edit: text that looks like HTML is shown as text")
            skarm(page, "02-andrad")

            # --- A proposal, a yes, laid in, taken back ---------------------------------------
            fore = manus1.read_text(encoding="utf-8")
            forslag = "Gå som du vill. Din väg går före min, alltid."
            oppna(page, L2["i"])
            rad(page, L2["i"]).get_by_role("button", name="Föreslå", exact=True).click()
            rad(page, L2["i"]).locator("textarea").fill(forslag)
            fel = spara(page, lambda: rad(page, L2["i"]).get_by_role("button", name="Lägg förslaget").click())
            ok(fel is None, f"proposal: saved ({fel})")
            ok(manus1.read_text(encoding="utf-8") == fore, "proposal: the manuscript is not touched by a proposal")
            kort = rad(page, L2["i"]).locator(".kort.forslag")
            ok(kort.count() == 1 and forslag in kort.inner_text() and "Henric" in kort.inner_text(), "proposal: it lies beside the line, with who wrote it")
            fel = spara(page, lambda: rad(page, L2["i"]).get_by_role("button", name="Säg ja").click())
            ok(fel is None and "Ja från Henric." in rad(page, L2["i"]).locator(".kort.forslag").inner_text(), "proposal: saying yes shows who said it")
            rad(page, L2["i"]).get_by_role("button", name="Lägg in i manus").click()
            bekr = rad(page, L2["i"]).locator(".bekrafta")
            ok(bekr.count() == 1, "proposal: laying it in asks first")
            skarm(page, "03-lagg-in")
            fel = spara(page, lambda: bekr.get_by_role("button", name="Lägg in i manus").click())
            efter = manus1.read_text(encoding="utf-8")
            ok(fel is None and skillnad(fore, efter) == [L2["i"]] and efter.split("\n")[L2["i"]] == f"> {forslag}",
               "proposal: laid in, exactly that line now has the proposed words")
            oppna(page, L2["i"])
            vemrad = rad(page, L2["i"]).locator(".vemrad").inner_text()
            ok("förslag, inlagt i manus av Henric" in vemrad, f"proposal: the line says whose proposal it was and who laid it in ({vemrad})")
            logg = json.loads(rumfil.read_text(encoding="utf-8"))["logg"]
            ok(any(x.get("vad") == "lade-in-forslag" and x.get("vem") == "henric" and x.get("nar") for x in logg), "proposal: the log has who laid it in and when")
            rad(page, L2["i"]).locator("details.tidigare summary").click()
            fel = spara(page, lambda: rad(page, L2["i"]).get_by_role("button", name="Ta tillbaka den här").click())
            ok(fel is None and manus1.read_text(encoding="utf-8") == fore, "proposal: the old text can be taken back, and the file is as before")
            ok(rad(page, L2["i"]).locator(".marke.demi").count() == 1, "proposal: taken back, the line is Demi's again")
            ok(rad(page, L2["i"]).locator(".kort.forslag").count() == 1, "proposal: taken back, the proposal lies open beside the line again")

            # --- Comments ------------------------------------------------------------------------
            kommentar = '<img src=x onerror="window.__xss=1"> för snabbt här'
            oppna(page, L3["i"])
            rad(page, L3["i"]).get_by_role("button", name="Kommentera", exact=True).click()
            rad(page, L3["i"]).get_by_role("button", name="Tempot").click()
            rad(page, L3["i"]).locator("textarea").fill(kommentar)
            fel = spara(page, lambda: rad(page, L3["i"]).get_by_role("button", name="Spara kommentaren").click())
            k = rad(page, L3["i"]).locator(".kort.kommentar")
            ok(fel is None and k.count() == 1 and "tempot" in k.inner_text(), "comment: saved on the line, about the tempo")
            ok(k.locator("img").count() == 0 and kommentar in k.inner_text() and page.evaluate("window.__xss") is None,
               "comment: HTML in a comment is shown as text and never runs")
            fot = page.locator("#fot-2")
            fot.get_by_role("button", name="Kommentera scenen").click()
            fot.get_by_role("button", name="Pausen").click()
            fot.locator("textarea").fill("Pausen före frågan kan vara längre.")
            fel = spara(page, lambda: page.locator("#fot-2").get_by_role("button", name="Spara kommentaren").click())
            ok(fel is None and "Pausen före frågan" in page.locator("#fot-2").inner_text(), "comment: a comment on a whole scene")

            # --- Someone else saves while Henric types ---------------------------------------------
            fore = manus1.read_text(encoding="utf-8")
            oppna(page, L4["i"])
            rad(page, L4["i"]).get_by_role("button", name="Ändra", exact=True).click()
            rad(page, L4["i"]).locator("textarea").fill("Henrics rad, skriven i rummet.")
            andra_pa_disk(manus1, L5["i"], "> Demis rad, skriven i filen samtidigt.")
            fel = spara(page, lambda: rad(page, L4["i"]).get_by_role("button", name="Spara i manus").click())
            efter = manus1.read_text(encoding="utf-8").split("\n")
            ok(fel is None and skillnad(fore, "\n".join(efter)) == sorted([L4["i"], L5["i"]])
               and efter[L4["i"]] == "> Henrics rad, skriven i rummet." and efter[L5["i"]] == "> Demis rad, skriven i filen samtidigt.",
               "conflict: the file changed in between, both texts are kept and nothing else moved")
            ok(rad(page, L5["i"]).locator(".marke.utanfor").count() == 1 and "ändrad utanför rummet" in rad(page, L5["i"]).inner_text(),
               "conflict: the line changed in the file shows as changed outside the room")
            oppna(page, L5["i"])
            fel = spara(page, lambda: rad(page, L5["i"]).get_by_role("button", name="Demi", exact=True).click())
            ok(fel is None and rad(page, L5["i"]).locator(".marke.demi").count() == 1, "conflict: saying whose words they are takes one press")

            # The same line changed while Henric typed: his words are kept, the file's are not overwritten.
            oppna(page, L6["i"])
            rad(page, L6["i"]).get_by_role("button", name="Ändra", exact=True).click()
            rad(page, L6["i"]).locator("textarea").fill("Min version av repliken.")
            andra_pa_disk(manus1, L6["i"], "> Någon annans version av repliken.")
            fore = manus1.read_text(encoding="utf-8")
            fel = spara(page, lambda: rad(page, L6["i"]).get_by_role("button", name="Spara i manus").click())
            ok(fel is not None and any("står inte längre så" in f for f in fel), f"same line: the save stops and says why ({fel})")
            ok(manus1.read_text(encoding="utf-8") == fore, "same line: the other person's text is not overwritten")
            ok(rad(page, L6["i"]).locator("textarea").input_value() == "Min version av repliken.", "same line: Henric's words are still in the field")
            fel = spara(page, lambda: rad(page, L6["i"]).get_by_role("button", name="Lägg det som förslag i stället").click())
            fot = page.locator(f"#fot-{L6['scen']}")
            ok(fel is None and "Min version av repliken." in fot.inner_text() and "inte står så längre" in fot.inner_text().lower(),
               f"same line: his words become a proposal at the end of the scene ({fel}; {fot.inner_text()[-300:]!r})")

            # --- Strike and put back ---------------------------------------------------------------------
            fore = manus1.read_text(encoding="utf-8")
            oppna(page, L7["i"])
            rad(page, L7["i"]).get_by_role("button", name="Stryk", exact=True).click()
            fel = spara(page, lambda: rad(page, L7["i"]).locator(".bekrafta").get_by_role("button", name="Stryk").click())
            efter = manus1.read_text(encoding="utf-8")
            ok(fel is None and len(efter.split("\n")) in (len(fore.split("\n")) - 1, len(fore.split("\n")) - 2) and f"> {L7['kropp']}" not in efter.split("\n"),
               "strike: the line leaves the file")
            fot = page.locator(f"#fot-{L7['scen']}")
            ok(L7["kropp"][:20] in fot.inner_text(), "strike: it is listed under Struket")
            fel = spara(page, lambda: page.locator(f"#fot-{L7['scen']}").get_by_role("button", name="Lägg tillbaka").click())
            ok(fel is None and manus1.read_text(encoding="utf-8") == fore, "strike: put back, the file is byte for byte as before")

            # --- Enter saves, a draft survives a reload ------------------------------------------------------
            oppna(page, L9["i"])
            rad(page, L9["i"]).get_by_role("button", name="Ändra", exact=True).click()
            rad(page, L9["i"]).locator("textarea").fill("Sparad med Enter.")
            fel = spara(page, lambda: rad(page, L9["i"]).locator("textarea").press("Enter"))
            ok(fel is None and manus1.read_text(encoding="utf-8").split("\n")[L9["i"]] == "> Sparad med Enter.", "enter: Enter saves a line instead of breaking it")
            oppna(page, L10["i"])
            rad(page, L10["i"]).get_by_role("button", name="Ändra", exact=True).click()
            rad(page, L10["i"]).locator("textarea").fill("Ett utkast som inte sparades.")
            page.reload()
            page.wait_for_selector(".rad")
            ok("osparad text" in rad(page, L10["i"]).inner_text(), "draft: after a reload the line says there is unsaved text")
            oppna(page, L10["i"])
            rad(page, L10["i"]).get_by_role("button", name="Ändra · osparat").click()
            ok(rad(page, L10["i"]).locator("textarea").input_value() == "Ett utkast som inte sparades.", "draft: the words are back in the field")
            rad(page, L10["i"]).get_by_role("button", name="Avbryt").click()
            page.reload()
            page.wait_for_selector(".rad")
            ok("osparad text" not in rad(page, L10["i"]).inner_text(), "draft: Avbryt throws it away")

            # --- A new line ------------------------------------------------------------------------------------
            fore = manus1.read_text(encoding="utf-8")
            oppna(page, L8["i"])
            rad(page, L8["i"]).get_by_role("button", name="Ny replik efter").click()
            rad(page, L8["i"]).locator("textarea").fill("En helt ny replik.")
            fel = spara(page, lambda: rad(page, L8["i"]).get_by_role("button", name="Lägg till i manus").click())
            x, y = fore.split("\n"), manus1.read_text(encoding="utf-8").split("\n")
            j = y.index("> En helt ny replik.") if "> En helt ny replik." in y else -1
            ok(fel is None and j > 0 and y[j - 1] == ">" and y[:j - 1] + y[j + 1:] == x,
               "new line: exactly '>' and the new line are added, nothing else moves")
            ok(page.locator(".rad .marke.henric").count() >= 2, "new line: it is marked as Henric's")

            # --- After a reload everything is still there ----------------------------------------------------------
            page.reload()
            page.wait_for_selector(".rad")
            ok(rad(page, L1["i"]).locator(".marke.henric").count() == 1 and "tydligt" in rad(page, L1["i"]).inner_text(), "reload: the changed line is still Henric's")
            ok(rad(page, L3["i"]).locator(".kort.kommentar").count() == 1, "reload: the comment is still there")
            ok(rad(page, L2["i"]).locator(".kort.forslag").count() == 1, "reload: the proposal is still there")
            skarm(page, "04-efter-omladdning")

            # --- Episode 2 ------------------------------------------------------------------------------------------
            page.goto(f"{rum_url}#episod-2")
            page.wait_for_function("document.querySelector('.ep-titel') && document.querySelector('h2').textContent.includes('2')")
            page.wait_for_selector(".rad")
            ok(page.locator(".spela").count() == 0 and "inte inspelad än" in page.locator("main").inner_text(), "episode 2: says it is not recorded yet, no play buttons")
            ok(page.locator(".vem .marke.demi").count() == page.locator(".rad").count(), "episode 2: every line is Demi's draft")

            # --- The world book and a lore page ----------------------------------------------------------------------
            page.goto(f"{rum_url}#varlden")
            page.wait_for_selector("article.md")
            forsta = next((ln[2:] for ln in (GLIMT / "varld.md").read_text(encoding="utf-8").split("\n") if ln.startswith("## ")), "")
            ok(bool(forsta) and forsta.strip()[:15] in page.locator("article.md").inner_text(), "world: the world book is shown")
            page.get_by_role("link", name="HELD").click()
            page.wait_for_function("document.querySelector('article.md') && location.hash.includes('held')")
            ok(len(page.locator("article.md").inner_text()) > 50, "world: HELD's lore is shown")
            page.get_by_role("link", name="Våra sidor").click()
            page.get_by_role("link", name="Skriv en ny sida").click()
            page.locator("input.titelfalt").wait_for()
            text = "Den läser stegen.\n\n<script>window.__xss2=1</script> ska synas som text."
            page.locator("input.titelfalt").fill("Snäckan")
            page.locator("textarea.lorefalt").fill(text)
            fel = spara(page, lambda: page.get_by_role("button", name="Spara sidan").click())
            page.wait_for_selector(".sida-titel")
            ok(fel is None and page.locator(".sida-titel").inner_text() == "Snäckan", "lore: a new page is saved and opened")
            ok(page.locator(".sida-text script").count() == 0 and "<script>" in page.locator(".sida-text").inner_text() and page.evaluate("window.__xss2") is None,
               "lore: markup in a page is shown as text and never runs")
            sidor = json.loads(lorefil.read_text(encoding="utf-8"))["sidor"]
            ok(len(sidor) == 1 and "\n".join(sidor[0]["text"]) == text and sidor[0]["skrev"] == "henric", "lore: the file has exactly what was typed, and who")
            page.get_by_role("button", name="Ändra").click()
            page.locator("textarea.lorefalt").fill("Den läser stegen. Andra versionen.")
            fel = spara(page, lambda: page.get_by_role("button", name="Spara sidan").click())
            ok(fel is None and "Tidigare versioner (1)" in page.locator("main").inner_text(), "lore: an edit keeps the earlier version")
            page.reload()
            page.wait_for_selector(".sida-titel")
            ok("Andra versionen" in page.locator(".sida-text").inner_text(), "lore: the page is there after a reload")
            skarm(page, "05-lore")

            ok(not fel_i_sidan, f"no script errors on the page ({fel_i_sidan})")
            ctx.close()

            # --- Wide screen, for the eye --------------------------------------------------------------------------
            if args.skarmar:
                dator = browser.new_context(viewport={"width": 1440, "height": 900})
                d = dator.new_page()
                d.route("https://henricbarkman.github.io/**", route_audio)
                d.goto(f"{rum_url}#episod-1")
                d.wait_for_selector(".rad")
                d.locator(f"#rad-{L3['i']}").scroll_into_view_if_needed()
                d.locator(f"#rad-{L3['i']} .radtext").click()
                d.screenshot(path=str(args.skarmar / "06-dator.png"))
                dator.close()

            # --- Without the portal: read-only, or asked to log in --------------------------------------------------
            ctx = browser.new_context(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)
            page = ctx.new_page()
            page.route("https://henricbarkman.github.io/**", route_audio)
            page.goto(f"{url_b}/uploads/glimt-rummet/index.html#episod-1")
            page.wait_for_selector("main h2")
            ok("logga in först" in page.locator("main").inner_text().lower(), "no login: the portal copy asks to log in instead of showing nothing")
            page.goto(f"{url_b}/rummet/index.html#episod-1")
            page.wait_for_selector(".rad")
            page.locator(".rad .radtext").first.click()
            ok(page.locator(".verktyg").count() == 0 and page.locator(".spela").count() > 0 and "Här går det att läsa och lyssna" in page.inner_text("body"),
               "read-only: lines and sound, no tools")
            skarm(page, "07-las")
            ctx.close()
            browser.close()
    finally:
        server.kill()
        server_b.kill()
        shutil.rmtree(rot, ignore_errors=True)

    print(f"\n{checks - failures}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
