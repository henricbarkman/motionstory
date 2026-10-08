#!/usr/bin/env python3
"""The room in a real browser, end to end, on copies of the manuscript.

Builds a sandbox (copies of the episodes, the recordings list, the world book,
the mechanics catalogue, HELD's lore, and Demi's baseline written fresh by
rummet_grund.py), deploys the room into it with rummet_deploy.py and runs the
local portal stand-in (rummet_provserver.py, which uses the portal's own
files.py for the mtime check and the atomic write). Then Chromium does what a
writer would, typing for real: write in a paragraph, Enter for a new one,
change its style, join two, undo, paste several lines, insert a mechanic from
the catalogue, choose a variant label, ask Demi for a new mechanic, comment,
propose, take back an earlier version, reload. Two windows change different
paragraphs and then the same one. Between the clicks the test changes the
files on disk the way the portal's file panel or Demi would, and checks that
nobody's text is lost and every other line stays byte for byte.

    ~/generalassistant/.venv/bin/python scripts/test_rummet_browser.py [--skarmar DIR] [--bara telefon|bred|tva]

The sound is served from this repo's audio/ instead of the public site.
Nothing outside the temporary sandbox is written.
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


def ok(cond: bool, what: str) -> bool:
    global failures, checks
    checks += 1
    if not cond:
        failures += 1
    if not cond or os.environ.get("VERBOSE"):
        print(f"{'ok  ' if cond else 'FAIL'}  {what}", flush=True)
    return cond


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# --- The sandbox and the server ------------------------------------------------------------

def sandbox() -> tuple[Path, Path]:
    rot = Path(tempfile.mkdtemp(prefix="rummet-browser-"))
    glimt = rot / "projects/motionstory/stories/glimt"
    glimt.mkdir(parents=True)
    for f in ("episod-1.md", "episod-2.md", "episod-1.json", "varld.md", "mekaniker.md"):
        shutil.copyfile(GLIMT / f, glimt / f)
    held = rot / "projects/held/universe"
    held.mkdir(parents=True)
    lore = GA / "projects/held/universe/LORE.md"
    if lore.exists():
        shutil.copyfile(lore, held / "LORE.md")
    else:
        (held / "LORE.md").write_text("# HELD\n\nEn stand-in för HELD:s lore.\n", encoding="utf-8")
    load("rummet_grund").write_baseline(rot / "data/glimt-rummet", ["f0fd543"])
    ut = rot / "uploads"
    load("rummet_deploy").deploy(ut)
    return rot, ut


def provserver(rot: Path, ut: Path) -> tuple[subprocess.Popen, str]:
    p = subprocess.Popen([sys.executable, str(REPO / "scripts/rummet_provserver.py"), "--rot", str(rot), "--uploads", str(ut)],
                         stdout=subprocess.PIPE, text=True)
    url = p.stdout.readline().strip().rstrip("/")
    return p, url


def route_audio(route) -> None:
    """The public site's recordings, from this repo, with byte ranges."""
    url = route.request.url.split("#")[0]
    f = REPO / "audio" / url.split("/motionstory/audio/", 1)[-1]
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


INIT = """
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () { window.__ljud = this; return play.call(this); };
"""


# --- Reading the files --------------------------------------------------------------------------

ROUNDTRIP_JS = """
import { readFileSync } from 'node:fs';
const D = await import(process.env.DOK_JS);
const text = readFileSync(process.env.FIL, 'utf8');
const slag = process.env.SLAG === 'episod' ? D.SLAG_EPISOD : D.SLAG_FRI;
const t = D.tolka(text, slag);
const paras = D.justera(t.paras, null);
const fel = [];
const omr = D.scenomrade(paras.map((p) => p.typ), slag);
paras.forEach((p, k) => { const f = D.fel(p, omr[k]); if (f && f !== 'tom') fel.push([k, f, p.text]); });
process.stdout.write(JSON.stringify({ samma: D.skriv({ paras, slut: t.slut }) === text, fel }));
"""


def formen(fil: Path, episod: bool = True) -> dict:
    env = {**os.environ, "DOK_JS": (REPO / "rummet" / "dok.js").as_uri(), "FIL": str(fil), "SLAG": "episod" if episod else "fri"}
    out = subprocess.run(["node", "--input-type=module", "-e", ROUNDTRIP_JS], capture_output=True, text=True, check=True, env=env)
    return json.loads(out.stdout)


def innehall(t: str) -> list[str]:
    """The file's lines without the separators (empty lines and the bare ">"
    that keeps a quote block together)."""
    return [r for r in t.split("\n") if r.strip() not in ("", ">")]


def foljd(t: str, *rader: str) -> bool:
    """The lines stand right after each other, separators aside."""
    i = innehall(t)
    n = len(rader)
    return any(i[k:k + n] == list(rader) for k in range(len(i) - n + 1))


def vanta_fil(page, fil: Path, villkor, sek: float = 20) -> bool:
    slut = time.time() + sek
    while time.time() < slut:
        try:
            if villkor(fil.read_text(encoding="utf-8")):
                return True
        except FileNotFoundError:
            pass
        page.wait_for_timeout(200)
    return False


def notes(fil: Path) -> dict:
    try:
        return json.loads(fil.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def demi(rot: Path, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(REPO / "scripts/rummet.py"), "--rot", str(rot), *args],
                          capture_output=True, text=True, input=stdin)


# --- In the page --------------------------------------------------------------------------------

def stycke_id(page, borjar: str) -> str | None:
    return page.evaluate("""(b) => {
      for (const s of document.querySelectorAll('.ProseMirror .st')) {
        const t = s.querySelector('.text');
        if (t && t.textContent.startsWith(b)) return s.dataset.id;
      }
      return null;
    }""", borjar)


def markor(page, sid: str, var: str = "slut") -> None:
    """Tap the paragraph, then put the caret at its start or end, as a
    finger or an arrow key would."""
    sel = f'.ProseMirror .st[data-id="{sid}"] .text'
    page.locator(sel).first.scroll_into_view_if_needed()
    page.locator(sel).first.click()
    page.evaluate("""([sel, slut]) => {
      const t = document.querySelector(sel);
      const r = document.createRange();
      r.selectNodeContents(t);
      r.collapse(!slut);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }""", [sel, var == "slut"])
    page.wait_for_timeout(80)


def markera_allt_i(page, sid: str) -> None:
    sel = f'.ProseMirror .st[data-id="{sid}"] .text'
    page.locator(sel).first.click()
    page.evaluate("""(sel) => {
      const t = document.querySelector(sel);
      const r = document.createRange(); r.selectNodeContents(t);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }""", sel)
    page.wait_for_timeout(80)


def klistra(page, text: str) -> None:
    page.evaluate("""(text) => {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }""", text)


def lage(page) -> str:
    return page.get_attribute("#lage", "class") or ""


def vanta_sparat(page, sek: float = 20) -> bool:
    page.wait_for_timeout(400)
    slut = time.time() + sek
    while time.time() < slut:
        if "sparat" in lage(page).split():
            return True
        page.wait_for_timeout(150)
    return False


def stil(page, namn: str) -> None:
    page.locator("#verktyg .typval").click()
    page.locator("#meny button", has_text=namn).first.click()
    page.wait_for_timeout(120)


def verktyg(page, gor: str) -> None:
    # On a phone the toolbar is one row that scrolls sideways, as in the
    # sketch: swipe it to the button first.
    page.evaluate("(g) => document.querySelector(`#verktyg button[data-gor=\"${g}\"]`).scrollIntoView({ inline: 'center', block: 'nearest' })", gor)
    page.wait_for_timeout(100)
    page.locator(f'#verktyg button[data-gor="{gor}"]').click()
    page.wait_for_timeout(150)


def oppna(page, url: str, fel: list[str]) -> None:
    page.goto(url)
    page.wait_for_selector(".ProseMirror .st", timeout=15000)
    page.wait_for_timeout(500)


# --- The scenarios -----------------------------------------------------------------------------------

def skrivaren(b, url: str, rot: Path, storlek: str, skarmar: Path | None) -> None:
    """One person writing in episode 1: everything a word processor does."""
    mobil = storlek == "telefon"
    ctx = b.new_context(viewport={"width": 390, "height": 844} if mobil else {"width": 1440, "height": 1000},
                        is_mobile=mobil, has_touch=mobil, device_scale_factor=2 if mobil else 1)
    ctx.add_init_script(INIT)
    page = ctx.new_page()
    page.route(re.compile(r".*/motionstory/audio/.*"), route_audio)
    fel: list[str] = []
    page.on("pageerror", lambda e: fel.append(f"pageerror: {e}"))
    page.on("console", lambda m: fel.append(m.text) if m.type == "error" and "404" not in m.text else None)
    F = rot / "projects/motionstory/stories/glimt/episod-1.md"
    N = rot / "data/glimt-rummet/episod-1.json"
    original = F.read_text(encoding="utf-8")
    pre = f"[{storlek}]"

    def skarm(namn: str) -> None:
        if skarmar:
            page.screenshot(path=str(skarmar / f"{storlek}-{namn}.png"))

    oppna(page, f"{url}/index.html#episod-1", fel)
    ok(page.locator(".ProseMirror .st").count() > 100, f"{pre} episode 1 is drawn as paragraphs")
    ok(page.locator(".ProseMirror .bricka").count() == 7, f"{pre} episode 1 has 7 mechanic chips (hand count), not {page.locator('.ProseMirror .bricka').count()}")
    brickor = page.evaluate("[...document.querySelectorAll('.ProseMirror .bricka')].map((b) => b.textContent.toLowerCase())")
    ok(sorted(brickor) == sorted(["kontakten"] * 5 + ["lampan"] * 2), f"{pre} the chips are Kontakten x5 and lampan x2: {brickor}")
    ok(page.locator(".ProseMirror button.ring").count() > 10, f"{pre} recorded lines have a listen ring")
    ok("sparat" in lage(page), f"{pre} the state says Sparat before anything is typed")
    ok(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"{pre} the page never pans sideways")
    skarm("01-start")

    # Listen: the ring plays the recording.
    ring = page.locator(".ProseMirror button.ring").first
    ring.click()
    page.wait_for_timeout(700)
    ok(page.evaluate("!!window.__ljud && !window.__ljud.paused && window.__ljud.src.includes('/audio/glimt/vega/')"), f"{pre} the listen ring plays the recording")
    ring.click()

    # 1. Type at the end of a paragraph.
    p1 = stycke_id(page, "Jag måste få veta en sak")
    markor(page, p1)
    page.keyboard.type(" Hallå?")
    rad1 = "> Jag måste få veta en sak, annars blir jag tokig. Jag har pratat för mig själv här länge. Jag vet hur det känns när ingen lyssnar. Det här känns inte så. Hallå?"
    ok(vanta_fil(page, F, lambda t: rad1 + "\n" in t), f"{pre} typing at the end of a line is saved")
    ok(vanta_sparat(page), f"{pre} the state says Sparat after the save")
    ok(page.locator(f'.st[data-id="{p1}"] .ring.ny').count() == 1, f"{pre} a changed line shows the dotted ring (not recorded yet)")

    # 2. Enter makes a new paragraph; in a scene after a line it is a line.
    page.keyboard.press("Enter")
    page.keyboard.type("En ny replik från Henric.")
    ok(vanta_fil(page, F, lambda t: foljd(t, rad1, "> En ny replik från Henric.")), f"{pre} Enter and typing makes a new line right after it")
    ny = stycke_id(page, "En ny replik från Henric.")

    # 3. Change its style from the toolbar, and back with the keyboard.
    stil(page, "Regi och ljud")
    ok(vanta_fil(page, F, lambda t: "> (En ny replik från Henric.)\n" in t), f"{pre} the style menu makes it direction: > (…)")
    page.keyboard.press("Control+Shift+3")
    ok(vanta_fil(page, F, lambda t: "> En ny replik från Henric.\n" in t and "> (En ny replik" not in t), f"{pre} Ctrl+Shift+3 makes it a line again")

    # 4. Backspace at the start joins it with the one before; Ctrl+Z undoes.
    markor(page, ny, "start")
    page.keyboard.press("Backspace")
    ok(vanta_fil(page, F, lambda t: "Hallå?En ny replik från Henric.\n" in t and "\n> En ny replik" not in t), f"{pre} Backspace at the start joins two paragraphs")
    page.keyboard.press("Control+z")
    ok(vanta_fil(page, F, lambda t: foljd(t, rad1, "> En ny replik från Henric.")), f"{pre} Ctrl+Z splits them again")
    # A style is its own step for Ctrl+Z, however fast the next key comes.
    stil(page, "Regi och ljud")
    markor(page, stycke_id(page, "En ny replik från Henric."), "start")
    page.keyboard.press("Backspace")
    page.keyboard.press("Control+z")
    ok(vanta_fil(page, F, lambda t: foljd(t, rad1, "> (En ny replik från Henric.)")), f"{pre} a style and a join right after it: Ctrl+Z undoes the join only")
    page.keyboard.press("Control+z")
    ok(vanta_fil(page, F, lambda t: foljd(t, rad1, "> En ny replik från Henric.")), f"{pre} and once more undoes the style")
    skarm("02-skrivet")

    # 5. Paste several lines: each becomes a paragraph, (…) becomes direction.
    ny = stycke_id(page, "En ny replik från Henric.")
    markor(page, ny)
    page.keyboard.press("Enter")
    klistra(page, "Rad ett.\nRad två.\n(paus)")
    ok(vanta_fil(page, F, lambda t: foljd(t, "> En ny replik från Henric.", "> Rad ett.", "> Rad två.", "> (paus)")), f"{pre} pasting three lines makes three paragraphs, the last one direction")

    # 6. Insert a mechanic from the catalogue into scene 1, which has no branches.
    s1 = stycke_id(page, "Så. Nu är du tydlig.")
    markor(page, s1)
    verktyg(page, "infoga")
    ok(page.locator("#panel:not([hidden]) .mek-val").count() == 33, f"{pre} the mechanic picker lists the catalogue's 33")
    page.locator("#panel input[type=search]").fill("stanna")
    page.wait_for_timeout(150)
    ok(page.locator("#panel .mek-val").count() >= 1, f"{pre} searching narrows the list")
    page.locator("#panel .mek-val", has_text="Stanna för ja").first.click()
    ok(vanta_fil(page, F, lambda t: "*Trigger: kontakten stark första gången, efter ungefär en minut i rörelse. Stanna för ja.*\n" in t), f"{pre} the name is added last in the scene's Mekanik row")
    mek1 = stycke_id(page, "kontakten stark första gången")
    ok(page.locator(f'.st[data-id="{mek1}"] .bricka').count() == 2, f"{pre} the row now has two chips")
    varsel = page.locator(f'.st[data-id="{mek1}"] .varsel').all_inner_texts()
    ok(any(v.startswith("Osäker: Stanna för ja.") for v in varsel), f"{pre} an Osäker mechanic gives a quiet warning: {varsel}")
    # Two empty branches came last in the scene, with the caret in the first.
    page.keyboard.type("Om vandraren stannar:")
    ok(vanta_fil(page, F, lambda t: foljd(t, "> **Om vandraren stannar:**", "## 2. Frågan") or foljd(t, "> **Om vandraren stannar:**", "---", "## 2. Frågan")), f"{pre} typing in the new branch saves it last in scene 1")
    tom = page.locator(".ProseMirror .st.gren.tom").count()
    ok(tom == 1, f"{pre} the second new branch waits, empty, and is not written ({tom})")
    skarm("03-mekanik")

    # 7. A variant: the style, then a label from the catalogue's list.
    p2 = stycke_id(page, "Så. Om det finns någon där.")
    markor(page, p2)
    stil(page, "Variant")
    ok(page.locator("#panel:not([hidden]) .etikett-val").count() > 5, f"{pre} the label picker offers the catalogue's labels")
    page.locator("#panel .etikett-val", has_text=re.compile(r"^mörkt$")).first.click()
    ok(vanta_fil(page, F, lambda t: "> [mörkt] Så. Om det finns någon där." in t), f"{pre} choosing a label writes the variant: > [mörkt] …")

    # 8. Ask Demi for a new mechanic: a Mekanik row starting "Ny mekanik:".
    mek2 = stycke_id(page, "kontakten stark, runt minut två och en halv")
    markera_allt_i(page, mek2)
    page.keyboard.type("Ny mekanik: vandraren klappar händerna")
    ok(vanta_fil(page, F, lambda t: "*Trigger: Ny mekanik: vandraren klappar händerna*\n" in t), f"{pre} the request is saved in the Mekanik row")
    page.wait_for_timeout(300)
    ok(page.locator(f'.st[data-id="{mek2}"] .vantar').inner_text() == "Ny mekanik: väntar på Demi", f"{pre} the row says it waits for Demi")
    r = demi(rot, "nytt", "--behall", "--json")
    ut = json.loads(r.stdout or "{}")
    forsta = (ut.get("vantar") or [{}])[0]
    ok(forsta.get("slag") == "ny-mekanik" and (forsta.get("text") or "").startswith("Ny mekanik: vandraren"), f"{pre} rummet.py nytt lists the request first: {r.stdout[:200]} {r.stderr[:200]}")
    r = demi(rot, "kommentera", "--dok", "1", "--stycke", mek2, "--text", "Det låter som Kroppsmorse. Vill du att den heter så?")
    ok(r.returncode == 0, f"{pre} Demi answers in a comment at the row: {r.stderr}")
    ok(json.loads(demi(rot, "nytt", "--behall", "--json").stdout)["vantar"] == [], f"{pre} once Demi has answered, the request no longer waits")
    page.wait_for_timeout(5200)
    ok(page.locator(f'.st[data-id="{mek2}"] .vantar.svarat').count() == 1, f"{pre} the row says Demi has answered")
    ok(page.locator(f'.st[data-id="{mek2}"] .kort.ai').count() == 1, f"{pre} Demi's comment shows at the row, marked AI")
    skarm("04-ny-mekanik")

    # 9. Comment, mark done; propose and lay it in.
    markor(page, p1)
    verktyg(page, "kommentera")
    page.locator("#panel textarea").fill("Kortare, kanske?")
    page.locator("#panel button[type=submit]").click()
    ok(vanta_fil(page, N, lambda t: "Kortare, kanske?" in t), f"{pre} the comment is written to the notes")
    kort = page.locator(f'.st[data-id="{p1}"] .kom .kort', has_text="Kortare, kanske?")
    ok(kort.count() == 1, f"{pre} the comment shows at its paragraph")
    if not mobil:
        box_t = page.locator(f'.st[data-id="{p1}"] .text').bounding_box()
        box_k = kort.bounding_box()
        ok(box_k and box_t and box_k["x"] > box_t["x"] + box_t["width"], f"{pre} on a wide screen the comment sits in the right margin")
    kort.locator("button", has_text="Klar").click()
    page.wait_for_timeout(400)
    ok(kort.count() == 0, f"{pre} a comment marked done leaves the margin")
    markor(page, p1)
    verktyg(page, "foresla")
    page.locator("#panel textarea").fill("Jag måste få veta en sak. Hallå?")
    page.locator("#panel button[type=submit]").click()
    page.wait_for_timeout(400)
    page.locator(f'.st[data-id="{p1}"] .kom .kort button', has_text="Lägg in").click()
    ok(vanta_fil(page, F, lambda t: "> Jag måste få veta en sak. Hallå?\n" in t), f"{pre} a proposal laid in replaces the paragraph's text")

    # 10. History: take an earlier version back.
    page.locator(f'.st[data-id="{p1}"] .marg button.av').click()
    page.wait_for_timeout(200)
    versioner = page.locator("#panel .version")
    ok(versioner.count() >= 3, f"{pre} the history lists the paragraph's versions ({versioner.count()})")
    page.locator("#panel .version", has_text="Det här känns inte så.").filter(has_not_text="Hallå").locator("button", has_text="Ta tillbaka").first.click()
    ok(vanta_fil(page, F, lambda t: "> Jag måste få veta en sak, annars blir jag tokig. Jag har pratat för mig själv här länge. Jag vet hur det känns när ingen lyssnar. Det här känns inte så.\n" in t),
       f"{pre} taking back the first version writes it back")
    # The notes are written right after the text: wait for them.
    hur = lambda t: {e.get("hur") for e in json.loads(t).get("historik", {}).get(p1, [])}  # noqa: E731
    ok(vanta_fil(page, N, lambda t: {"tillbaka", "forslag"} <= hur(t)), f"{pre} the history records the proposal and the taking back")

    # 11. Someone else writes in the file meanwhile (the file panel, a new draft from Demi).
    t = F.read_text(encoding="utf-8")
    F.write_text(t.replace("> Så. Nu är du tydlig.", "> Så. Nu är du tydlig, du där."), encoding="utf-8")
    p3 = stycke_id(page, "Jag går också. Det gör alla här")
    markor(page, p3)
    page.keyboard.type(" Och du?")
    ok(vanta_fil(page, F, lambda t: "Vi är väldigt friska. Och du?" in t and "> Så. Nu är du tydlig, du där." in t), f"{pre} an outside change and a typed one both stay")
    page.wait_for_timeout(4500)
    ok(page.locator(".ProseMirror .text", has_text="Så. Nu är du tydlig, du där.").count() == 1, f"{pre} the outside change appears in the page")
    r = demi(rot, "andra", "--dok", "1", "--rad", "Men det gör det. Något går här inne, och jag ser det. Fast du inte är här.", "--text", "Men det gör det. Något går här inne.")
    ok(r.returncode == 0, f"{pre} Demi changes a line when asked: {r.stderr}")
    page.wait_for_timeout(4500)
    pd = stycke_id(page, "Men det gör det. Något går här inne.")
    ok(pd is not None and page.locator(f'.st[data-id="{pd}"] .marg .av.d').count() == 1, f"{pre} Demi's change shows with Demi's hollow dot")

    # 12. Reload: everything is kept, the empty branch included.
    page.reload()
    page.wait_for_selector(".ProseMirror .st")
    page.wait_for_timeout(800)
    for bit in ("Rad två.", "Om vandraren stannar:", "Ny mekanik: vandraren klappar händerna", "Vi är väldigt friska. Och du?"):
        ok(page.locator(".ProseMirror .text", has_text=bit).count() >= 1, f"{pre} after reload the page has «{bit}»")
    ok(page.locator(".ProseMirror .st.gren.tom").count() == 1, f"{pre} after reload the empty branch is still there")
    form = formen(F)
    ok(form["samma"] and not form["fel"], f"{pre} the file reads back as itself, with no paragraph out of form: {form['fel'][:3]}")
    andrade = [r for r in F.read_text(encoding="utf-8").split("\n") if r not in original.split("\n")]
    vantat = ("Hallå", "En ny replik", "Rad ett", "Rad två", "(paus)", "Stanna för ja", "Om vandraren stannar", "[mörkt]",
              "Ny mekanik", "Och du?", "du där.", "Något går här inne.")
    ok(all(any(v in r for v in vantat) for r in andrade if r.strip()), f"{pre} only the lines the writer touched differ: {[r for r in andrade if r.strip() and not any(v in r for v in vantat)][:3]}")
    skarm("05-efter-omladdning")

    ok(not fel, f"{pre} no errors in the page: {fel[:3]}")
    ctx.close()


def tva_fonster(b, url: str, rot: Path, skarmar: Path | None) -> None:
    """Two windows: different paragraphs, then the same one."""
    F = rot / "projects/motionstory/stories/glimt/episod-2.md"
    N = rot / "data/glimt-rummet/episod-2.json"
    sidor = []
    fel: list[str] = []
    for _ in range(2):
        ctx = b.new_context(viewport={"width": 1280, "height": 900})
        p = ctx.new_page()
        p.on("pageerror", lambda e: fel.append(str(e)))
        oppna(p, f"{url}/index.html#episod-2", fel)
        sidor.append(p)
    a, bb = sidor
    ok(a.locator(".ProseMirror .bricka").count() == 8, f"[två] episode 2 has 8 mechanic chips (hand count), not {a.locator('.ProseMirror .bricka').count()}")

    # Different paragraphs at once.
    rader = [r[2:] for r in F.read_text(encoding="utf-8").split("\n") if r.startswith("> ") and not r.startswith("> (") and not r.startswith("> [") and not r.startswith("> **")]
    x, y, z = rader[3], rader[8], rader[12]
    ix, iy, iz = stycke_id(a, x[:30]), stycke_id(a, y[:30]), stycke_id(a, z[:30])
    markor(a, ix)
    a.keyboard.type(" (A)")
    markor(bb, iy)
    bb.keyboard.type(" (B)")
    ok(vanta_fil(a, F, lambda t: f"> {x} (A)\n" in t and f"> {y} (B)\n" in t), "[två] two windows changing different paragraphs: both are saved")
    a.evaluate("document.activeElement && document.activeElement.blur()")
    bb.evaluate("document.activeElement && document.activeElement.blur()")
    a.wait_for_timeout(5000)
    ok(a.locator(".ProseMirror .text", has_text=f"{y} (B)").count() == 1, "[två] window A shows B's change")
    ok(bb.locator(".ProseMirror .text", has_text=f"{x} (A)").count() == 1, "[två] window B shows A's change")

    # The same paragraph: A saves first, then B. Nothing is lost.
    markor(a, iz)
    a.keyboard.type(" A-ändring")
    markor(bb, iz)
    bb.keyboard.type(" B-ändring")
    ok(vanta_fil(a, F, lambda t: f"> {z} B-ändring\n" in t or f"> {z} A-ändring\n" in t, 25), "[två] the same paragraph from two windows: one version is in the text")
    a.evaluate("document.activeElement && document.activeElement.blur()")
    bb.evaluate("document.activeElement && document.activeElement.blur()")
    ok(vanta_fil(a, N, lambda t: any(k.get("lage") == "oppen" for k in json.loads(t).get("krockar", [])), 25), "[två] the other version is recorded as a krock")
    text = F.read_text(encoding="utf-8")
    vinnare, andra = ("B-ändring", "A-ändring") if f"> {z} B-ändring\n" in text else ("A-ändring", "B-ändring")
    kr = [k for k in notes(N)["krockar"] if k.get("lage") == "oppen"]
    ok(len(kr) == 1 and kr[0]["text"].endswith(andra), f"[två] the krock holds the other version ({andra})")
    a.wait_for_timeout(5500)
    for namn, s in (("A", a), ("B", bb)):
        ok(s.locator(f'.st[data-id="{iz}"] .text').inner_text().endswith(vinnare), f"[två] window {namn} shows the version in the text")
        ok(s.locator(f'.st[data-id="{iz}"] .kort.krock').count() == 1, f"[två] window {namn} shows the krock at the paragraph")
    if skarmar:
        a.locator(f'.st[data-id="{iz}"]').scroll_into_view_if_needed()
        a.screenshot(path=str(skarmar / "tva-krock.png"))
    a.locator(f'.st[data-id="{iz}"] .kort.krock button', has_text="Använd den här").click()
    ok(vanta_fil(a, F, lambda t: f"> {z} {andra}\n" in t), "[två] choosing the other version writes it")
    ok(vanta_fil(a, N, lambda t: all(k.get("lage") != "oppen" for k in json.loads(t).get("krockar", []))), "[två] the krock is settled")

    # Two paragraphs change places in the file (Demi's new draft, or the file
    # panel): both windows follow, the cursor stays in its paragraph, and the
    # next save from a window keeps the new order.
    text = F.read_text(encoding="utf-8")
    par = next((m for m in re.finditer(r"^> ([^(\[*>\n][^\n]*)\n>\n> ([^(\[*>\n][^\n]*)\n", text, re.M)
                if not any(v[:30] in m.group(0) for v in (x, y, z))), None)
    ok(par is not None, "[två] found two lines next to each other to swap")
    if par:
        p1, p2 = par.group(1), par.group(2)
        i1, i2 = stycke_id(a, p1[:40]), stycke_id(a, p2[:40])
        markor(bb, i2)
        ordning = "[...document.querySelectorAll('.ProseMirror .st[data-id]')].map((e) => e.dataset.id)"
        fore = a.evaluate(ordning)
        ok(fore.index(i1) < fore.index(i2), "[två] before the swap the first stands first")
        F.write_text(text.replace(par.group(0), f"> {p2}\n>\n> {p1}\n"), encoding="utf-8")
        a.wait_for_timeout(6500)
        for namn, s in (("A", a), ("B", bb)):
            o = s.evaluate(ordning)
            ok(o.index(i2) < o.index(i1) and sorted(o) == sorted(fore), f"[två] window {namn} shows the paragraphs in the file's new order, none lost or doubled")
        inne = bb.evaluate("(id) => { const n = getSelection().anchorNode; const e = n && (n.nodeType === 1 ? n : n.parentElement).closest('.st[data-id]'); return !!e && e.dataset.id === id; }", i2)
        ok(inne, "[två] the cursor stays in its paragraph when it moves")
        bb.keyboard.type(" (kvar)")
        ok(vanta_fil(bb, F, lambda t: f"> {p2} (kvar)\n>\n> {p1}\n" in t), "[två] typing there afterwards saves in the new order")
        a.wait_for_timeout(1500)
        ok(F.read_text(encoding="utf-8").count(f"> {p1}\n") == 1, "[två] and the other window does not put the old order back")
    ok(not fel, f"[två] no errors in the pages: {fel[:3]}")
    for s in sidor:
        s.context.close()


def ovriga(b, url: str, rot: Path, skarmar: Path | None) -> None:
    """The world book, the catalogue as a list and as text, the round trips."""
    ctx = b.new_context(viewport={"width": 1440, "height": 1000})
    page = ctx.new_page()
    fel: list[str] = []
    page.on("pageerror", lambda e: fel.append(str(e)))
    G = rot / "projects/motionstory/stories/glimt"
    tider = {f: (G / f).stat().st_mtime for f in ("episod-1.md", "episod-2.md", "varld.md", "mekaniker.md")}
    for vag in ("#episod-2", "#varlden", "#mekaniker/text"):
        oppna(page, f"{url}/index.html{vag}", fel)
        page.wait_for_timeout(1500)
    page.goto(f"{url}/index.html#episod-1")
    page.wait_for_timeout(1500)
    ok(all((G / f).stat().st_mtime == t for f, t in tider.items() if f != "episod-1.md"), "[övrigt] opening a document and changing nothing writes nothing")

    # The catalogue as a list.
    page.goto(f"{url}/index.html#mekaniker")
    page.wait_for_selector(".mekanik-post")
    ok(page.locator(".mekanik-post").count() == 33, f"[övrigt] the Mekaniker tab lists 33 mechanics ({page.locator('.mekanik-post').count()})")
    page.locator("#inne > input[type=search]").fill("knack")
    page.wait_for_timeout(200)
    namn = page.locator(".mekanik-post .mek-namn").all_inner_texts()
    ok({"Knack", "Hon knackar"} <= set(namn) and len(namn) < 6, f"[övrigt] searching filters the list: {namn}")
    page.locator("#inne > input[type=search]").fill("")
    page.wait_for_timeout(1500)
    minnet = page.locator(".mekanik-post").filter(has=page.locator("summary .mek-namn", has_text="Minnet mellan episoderna"))
    ok(minnet.count() == 1 and minnet.locator("summary .omdome.inget").count() == 1 and page.locator(".mekanik-post summary .omdome.inget").count() == 1, "[övrigt] a mechanic without a verdict word shows as without a verdict")
    page.goto(f"{url}/index.html#mekaniker/kontakten")
    page.wait_for_timeout(1800)
    k = page.locator("#mek-kontakten")
    ok(k.get_attribute("open") is not None, "[övrigt] #mekaniker/<id> opens that mechanic")
    lankar = k.locator(".anvands a")
    ok(lankar.count() >= 4, f"[övrigt] Kontakten lists the scenes that use it ({lankar.count()})")
    if skarmar:
        page.screenshot(path=str(skarmar / "bred-katalog.png"))
    lankar.first.click()
    page.wait_for_selector(".ProseMirror .st")
    page.wait_for_timeout(800)
    ok("/s/" in page.url and page.url.split("#")[1].startswith("episod-"), f"[övrigt] a scene link opens the episode at the paragraph: {page.url}")

    # The world book is edited the same way.
    V = G / "varld.md"
    fore = V.read_text(encoding="utf-8")
    page.goto(f"{url}/index.html#varlden")
    page.wait_for_selector(".ProseMirror .st")
    page.wait_for_timeout(500)
    forsta = page.evaluate("""() => { for (const s of document.querySelectorAll('.ProseMirror .st.stycke')) { const t = s.querySelector('.text'); if (t && t.textContent.length > 40) return [s.dataset.id, t.textContent]; } return null; }""")
    markor(page, forsta[0])
    page.keyboard.type(" Tillagt i rummet.")
    ok(vanta_fil(page, V, lambda t: t != fore), "[övrigt] typing in the world book saves it")
    efter = V.read_text(encoding="utf-8")
    skillnad = [(x, y) for x, y in zip(fore.split("\n"), efter.split("\n")) if x != y]
    ok(len(skillnad) == 1 and skillnad[0][1].endswith("Tillagt i rummet.") and len(fore.split("\n")) == len(efter.split("\n")),
       f"[övrigt] exactly one line of the world book changed: {skillnad[:2]}")
    ok(formen(V, episod=False)["samma"], "[övrigt] the world book reads back as itself")
    if skarmar:
        page.screenshot(path=str(skarmar / "bred-varlden.png"))
    ok(not fel, f"[övrigt] no errors: {fel[:3]}")
    ctx.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--skarmar", type=Path, default=None)
    ap.add_argument("--bara", choices=("telefon", "bred", "tva", "ovriga"))
    a = ap.parse_args()
    if a.skarmar:
        a.skarmar.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        for namn, kor in (("telefon", lambda u, r: skrivaren(b, u, r, "telefon", a.skarmar)),
                          ("bred", lambda u, r: skrivaren(b, u, r, "bred", a.skarmar)),
                          ("tva", lambda u, r: tva_fonster(b, u, r, a.skarmar)),
                          ("ovriga", lambda u, r: ovriga(b, u, r, a.skarmar))):
            if a.bara and a.bara != namn:
                continue
            rot, ut = sandbox()
            server, url = provserver(rot, ut)
            try:
                kor(f"{url}/uploads/glimt-rummet", rot)
            finally:
                server.terminate()
                server.wait()
                shutil.rmtree(rot, ignore_errors=True)
        b.close()
    print(f"{checks - failures}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
