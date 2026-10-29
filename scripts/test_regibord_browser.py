#!/usr/bin/env python3
"""The directing desk (regibordet) in a real browser, on copies of the manuscript.

Builds a sandbox with today's episodes and recordings lists, deploys the desk
into it with rummet_deploy.py and runs the local portal stand-in
(rummet_provserver.py: the portal's own files.py for the mtime check, and the
portal's own glimt_regi.py for takes and write-back, rendering nothing). Then
Chromium does what Henric would: open episode 1 in English, play a line, open
its drawer, lengthen the pause, choose Rowan, write a direction, press Gör om
and hear the take, rewrite the words and send them to Manus, see the answer
come back; at phone size in the sandbox (?rot=prov) and wide. Two windows
change the same line at once and both changes stay. Opening a page writes
nothing.

    ~/generalassistant/.venv/bin/python scripts/test_regibord_browser.py [--skarmar DIR]

RUMMET_GLIMT_PY points the stand-in at another copy of glimt_regi.py (a
worktree of generalassistant, before it is merged). Nothing outside the
temporary sandbox is written.
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
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[1]
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


def vanta(fn, timeout: float = 8.0, steg: float = 0.1):
    slut = time.monotonic() + timeout
    while time.monotonic() < slut:
        v = fn()
        if v:
            return v
        time.sleep(steg)
    return fn()


# --- The sandbox and the server -------------------------------------------------------------

FILER = ("episode-1.md", "episode-1.json", "episod-1.md", "episod-1.json", "episod-2.md", "episod-3.md")


def sandbox() -> tuple[Path, Path]:
    rot = Path(tempfile.mkdtemp(prefix="regibord-browser-"))
    glimt = rot / "projects/motionstory/stories/glimt"
    prov = rot / "data/glimt-rummet/prov/manus"
    for d in (glimt, prov):
        d.mkdir(parents=True)
        for f in FILER:
            shutil.copyfile(GLIMT / f, d / f)
    ut = rot / "uploads"
    load("rummet_deploy").deploy(ut)
    return rot, ut


def provserver(rot: Path, ut: Path) -> tuple[subprocess.Popen, str]:
    p = subprocess.Popen([sys.executable, str(REPO / "scripts/rummet_provserver.py"), "--rot", str(rot), "--uploads", str(ut)],
                         stdout=subprocess.PIPE, text=True)
    return p, p.stdout.readline().strip().rstrip("/")


def route_audio(route) -> None:
    rel = route.request.url.split("#")[0].split("/motionstory/audio/", 1)[-1]
    f = REPO / "audio" / rel
    if not f.is_file():
        route.fulfill(status=404, body=b"")
        return
    route.fulfill(status=200, body=f.read_bytes(), headers={"Content-Type": "audio/mpeg"})


INIT = """
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () { window.__spelat = (window.__spelat || []).concat([this.src]); return play.call(this).catch(() => {}); };
"""


def anrop(url: str) -> list:
    with urlopen(f"{url}/prov/anrop") as r:
        return json.loads(r.read())["anrop"]


def regi(rot: Path, prov: bool, dok: str = "1en") -> dict:
    p = rot / "data/glimt-rummet" / ("prov" if prov else "") / f"regi-{dok}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def rad_med(page, text: str):
    return page.locator(".rad", has=page.locator(".ord", has_text=text)).first


def rad_not(r: dict, text: str) -> dict | None:
    """The notes of the row whose shadow line contains `text`."""
    ids = [i for i, line in r.get("stycken", []) if text in line]
    return (r.get("rader") or {}).get(ids[0]) if ids else None


# --- Scenarios ------------------------------------------------------------------------------------

def telefon(pw, url: str, rot: Path, skarmar: Path | None) -> None:
    prov = True
    md_fore = {f: (rot / "data/glimt-rummet/prov/manus" / f).read_bytes() for f in FILER}
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.add_init_script(INIT)
    page = ctx.new_page()
    page.route("**/motionstory/audio/**", route_audio)
    fel: list[str] = []
    page.on("pageerror", lambda e: fel.append(str(e)))
    page.goto(f"{url}/uploads/glimt-rummet/?rot=prov#episod-1en")
    page.wait_for_selector(".rad")
    ok(page.locator(".band.prov").count() == 1, "telefon: the sandbox band shows")
    ok(page.locator(".flikar a[aria-current]").inner_text().startswith("Episode 1"), "telefon: Episode 1 EN is the open tab")
    ok(page.locator(".flikar a").count() == 1, "telefon: only the English episode has a tab, the Swedish ones are hidden")
    ok(page.locator(".marke .namn").inner_text() == "Weavers" and page.title().endswith("regibordet"), "telefon: the name is Weavers")
    n = page.locator(".rad").count()
    ok(n > 50, f"telefon: the episode's lines are rows ({n})")
    tyst = page.locator(".tystnad", has_text="manuset")
    ok(tyst.count() >= 1 and "2 s" in tyst.first.inner_text(), "telefon: the manuscript's pause is drawn as a silence before its line")
    ok(page.locator("textarea, [contenteditable]").count() == 0, "telefon: nothing to write in until a drawer opens")
    time.sleep(0.5)
    ok(not (rot / "data/glimt-rummet/prov/regi-1en.json").exists(), "telefon: opening writes nothing")

    # Play a line the app has recorded.
    inspelad = page.locator(".rad", has=page.locator(".om", has_text="appens inspelning")).first
    if ok(inspelad.count() == 1, "telefon: some line plays the app's recording"):
        inspelad.locator(":scope > .spela").click()
        ok(vanta(lambda: any("/audio/glimt/vega/glimt-e1en/" in s for s in page.evaluate("window.__spelat || []"))),
           "telefon: its play button plays the app's clip")
        inspelad.locator(":scope > .spela").click()  # stop

    # The drawer for "Hello? Hello! Wait!"
    rad = rad_med(page, "Hello? Hello! Wait!")
    rad.locator(":scope > .ord").click()
    lada = rad.locator(".lada")
    ok(lada.is_visible() and rad.locator(":scope > .ord").get_attribute("aria-expanded") == "true", "telefon: a tap opens the line's drawer")
    ok("Manuset 2 s" in lada.locator(".stegare").first.inner_text(), "telefon: the pause before says where it comes from")
    lada.get_by_role("button", name="Paus före, längre").click()
    ok(vanta(lambda: (rad_not(regi(rot, prov), "Hello? Hello! Wait!") or {}).get("pausFore") == 2.25),
       "telefon: one step longer is 2,25 s in the desk's file")
    rad = rad_med(page, "Hello? Hello! Wait!")
    ok("2,25 s" in rad.locator(".lada .sek").first.inner_text(), "telefon: and on the page")

    rad.locator(".lada").get_by_role("button", name="Rowan").click()
    ok(vanta(lambda: (rad_not(regi(rot, prov), "Hello? Hello! Wait!") or {}).get("rost") == "snackan"), "telefon: Rowan is chosen for the line")
    rad = rad_med(page, "Hello? Hello! Wait!")
    ok(rad.locator(".lada").get_by_role("button", name="Rowan").get_attribute("aria-pressed") == "true", "telefon: and shown pressed")
    falt = rad.locator(".regitext")
    ok(falt.input_value().startswith("[calling out]"), f"telefon: the voice's text is the line with its direction as a tag: {falt.input_value()[:50]}")
    falt.fill("[calling out, unsure] Hello? [louder] Hello! Wait!")
    falt.blur()
    ok(vanta(lambda: (rad_not(regi(rot, prov), "Hello? Hello! Wait!") or {}).get("regi") == "[calling out, unsure] Hello? [louder] Hello! Wait!"),
       "telefon: the direction is saved when the field is left")

    rad = rad_med(page, "Hello? Hello! Wait!")
    fore = len(anrop(url))
    rad.get_by_role("button", name="Gör om").click()
    ok(vanta(lambda: len(anrop(url)) > fore), "telefon: Gör om asks for a take")
    a = anrop(url)[-1]
    kap = json.loads((GLIMT / "episode-1.json").read_text(encoding="utf-8"))
    ok(a.get("voice") == kap["voices"]["snackan"] and a.get("text") == "[calling out, unsure] Hello? [louder] Hello! Wait!" and a.get("sprak") == "en",
       f"telefon: with Rowan's voice id from the episode, the desk's text, in English: {a}")
    not_ = vanta(lambda: (lambda x: x if x and x.get("vald") else None)(rad_not(regi(rot, prov), "Hello? Hello! Wait!")))
    ok(bool(not_) and len(not_["tagningar"]) == 1 and not_["vald"] == not_["tagningar"][0]["id"] and not_["tagningar"][0]["modell"] == "eleven_v4",
       "telefon: the take is noted and chosen")
    ok(vanta(lambda: any("/api/glimt/tagning" in s for s in page.evaluate("window.__spelat || []"))), "telefon: and played at once")
    rad = rad_med(page, "Hello? Hello! Wait!")
    ok("tagning 1 av 1" in rad.locator(":scope > .om").inner_text(), "telefon: the line says which take plays")
    # Stop it: the page does not redraw under a playing take.
    rad.locator(":scope > .spela").click()
    ok(vanta(lambda: page.evaluate("document.querySelectorAll('.spelar').length") == 0), "telefon: the play button stops the take")
    ok(rad.locator(".tagningar input[type=radio]").count() >= 1, "telefon: the takes are a choice")
    if skarmar:
        rad.scroll_into_view_if_needed()
        page.screenshot(path=str(skarmar / "telefon-lada.png"))

    # Rewrite the words, and send them to Manus.
    rad.get_by_role("button", name="Skriv om repliken").click()
    ny = rad_med(page, "Hello? Hello! Wait!").locator(".nyord")
    ny.fill("(calling out) Hello? Hello! Hey, wait!")
    fore = len(anrop(url))
    rad_med(page, "Hello? Hello! Wait!").get_by_role("button", name="Spara och för in i Manus").click()
    ok(vanta(lambda: any(x.get("slag") == "tillbaka" and x.get("dok") == "1en" and x.get("prov") for x in anrop(url)[fore:])),
       "telefon: the rewrite starts the write-back, for the sandbox")
    oms = (rad_not(regi(rot, prov), "Hello? Hello! Wait!") or {}).get("omskrivningar") or []
    ok(len(oms) == 1 and oms[0]["till"] == "> (calling out) Hello? Hello! Hey, wait!", f"telefon: the rewrite is in the desk's file as an md line: {oms}")
    ok(vanta(lambda: page.locator(".omskr", has_text="inne i Manus").count() == 1, timeout=10),
       "telefon: the answer comes back to the page by itself")
    ok(page.locator(".replik", has_text="Hey, wait!").count() == 1, "telefon: the line shows the new words")
    ok(all((rot / "data/glimt-rummet/prov/manus" / f).read_bytes() == d for f, d in md_fore.items()), "telefon: no md file was written")

    # The Swedish episode 1 is not in Manus.
    page.goto(f"{url}/uploads/glimt-rummet/?rot=prov#episod-1")
    page.wait_for_selector(".rad")
    page.locator(".rad .ord").first.click()
    ok(page.locator(".skrivom", has_text="finns inte i Manus").count() == 1, "telefon: episod 1 (svenska) says its lines are not rewritten here")
    ok(not fel, f"telefon: no errors on the page: {fel[:2]}")
    b.close()


def bred(pw, url: str, rot: Path, skarmar: Path | None) -> None:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script(INIT)
    a, c = ctx.new_page(), ctx.new_page()
    for p in (a, c):
        p.route("**/motionstory/audio/**", route_audio)
        p.goto(f"{url}/uploads/glimt-rummet/#episod-1en")
        p.wait_for_selector(".rad")
    ok(a.locator(".band.prov").count() == 0, "bred: the real root has no sandbox band")
    if skarmar:
        a.screenshot(path=str(skarmar / "bred.png"))
    scen = a.locator(".scen").first
    scen.get_by_role("button", name="Spela scenen").click()
    ok(vanta(lambda: bool(a.evaluate("window.__spelat || []"))), "bred: Spela scenen plays")
    ok(scen.get_by_role("button", name="Stoppa").count() == 1, "bred: and the button turns into Stoppa")
    scen.get_by_role("button", name="Stoppa").click()

    # Two windows, the same line, at once.
    text = "But I have thought about this."
    rad_med(a, text).locator(":scope > .ord").click()
    rad_med(c, text).locator(":scope > .ord").click()
    rad_med(a, text).locator(".lada").get_by_role("button", name="Paus efter, längre").click()
    rad_med(c, text).locator(".lada .ljudtext").fill("the hum drops away")
    rad_med(c, text).locator(".lada .ljudtext").blur()
    n = vanta(lambda: (lambda x: x if x and x.get("pausEfter") == 0.25 and x.get("ljud") == "the hum drops away" else None)(rad_not(regi(rot, False), text)))
    ok(bool(n), f"bred: two windows change one line at once, both changes stay: {rad_not(regi(rot, False), text)}")
    time.sleep(4.5)  # the poll
    ok("0,25 s" in rad_med(c, text).locator(".lada .sek").nth(1).inner_text() or rad_med(c, text).locator(".lada").count() == 1,
       "bred: the other window keeps its drawer while someone types in it")
    b.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--skarmar", type=Path, default=None)
    args = ap.parse_args()
    if args.skarmar:
        args.skarmar.mkdir(parents=True, exist_ok=True)
    rot, ut = sandbox()
    server, url = provserver(rot, ut)
    try:
        with sync_playwright() as pw:
            telefon(pw, url, rot, args.skarmar)
            bred(pw, url, rot, args.skarmar)
    finally:
        server.terminate()
        shutil.rmtree(rot, ignore_errors=True)
    print(f"\n{checks - failures}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
