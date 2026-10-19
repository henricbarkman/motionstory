#!/usr/bin/env python3
"""Glimt in a real browser: the start screen's vibration try-out, Hon
knackar walked from start to end, and every test walk (?prov=) walked with
?sim from its link to the file it saves.

The node tests run the engine and the stations. This runs what app.js wires
together, which nothing else does: Chromium with Chrome-on-Android's user
agent, navigator.vibrate replaced by a stand-in that records what it was
asked, and a made-up accelerometer (devicemotion at 60 Hz): flat, restless
while the stand-in motor "runs", and in the station a sharp sample for every
knock back. The motor there starts late and rings on, as a real one may.

    pip install playwright && playwright install chromium
    python3 scripts/test_browser.py                # all of it, about four minutes
    python3 scripts/test_browser.py first,resume   # some scenarios
    python3 scripts/test_browser.py prov            # the test walks, about five minutes
    python3 scripts/test_browser.py episod          # episode 1 walked twice side by side, about twelve minutes
    GLIMT_SHOTS=/tmp/shots python3 scripts/test_browser.py first   # with screenshots

It serves this repo on a free local port and lets no request leave the
machine: the map and the weather fail at once, as they do offline.
GLIMT_FAIL_FAST=1 stops at the first failed check.
"""
import functools
import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Install deps: pip install playwright && playwright install chromium")

REPO = Path(__file__).resolve().parents[1]
# The app's version, read from the app, so a version bump is not a red test.
APP_VERSION = int(re.search(r"const APP_VERSION = (\d+);", (Path(__file__).resolve().parent.parent / "glimt" / "app.js").read_text()).group(1))
ONLY = [x for x in (sys.argv[1].split(",") if len(sys.argv) > 1 else []) if x]
SHOTS = os.environ.get("GLIMT_SHOTS")
FAIL_FAST = bool(os.environ.get("GLIMT_FAIL_FAST"))
CHROME_UA = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Mobile Safari/537.36"
)
FIREFOX_UA = "Mozilla/5.0 (Android 14; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0"
FIREFOX_DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0"
PATTERN = [400, 400] * 3   # glimt/lab.js knockPattern(3): KNOCK_ON, KNOCK_OFF

# The phone, as the page meets it. `answer` is what navigator.vibrate says,
# `shake` how hard the motor moves the sensor (0: the phone lies still, as on
# 2026-10-06), `lag` and `ring` how late it starts and how long it rings on,
# in ms. Once window.__walking is set the walker knocks back, as many times as
# she buzzed, the first 0.7 s after her last buzz as it was asked for.
PHONE = """
(() => {
  const cfg = %s;
  window.__vib = [];
  window.__knocks = [];
  window.__walking = false;
  window.__hidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__hidden; } });
  Object.defineProperty(Navigator.prototype, 'vibrate', {
    configurable: true,
    value: function (p) {
      const at = performance.now();
      window.__vib.push({ at, p: Array.isArray(p) ? p.slice() : p, walking: window.__walking });
      if (window.__walking && Array.isArray(p)) {
        const end = at + p.reduce((a, b) => a + b, 0) - (p.length %% 2 ? 0 : p[p.length - 1]);
        for (let i = 0; i < Math.ceil(p.length / 2); i++) window.__knocks.push({ t: end + 700 + i * 450, done: false });
      }
      return cfg.answer;
    },
  });
  let up = false;
  setInterval(() => {
    const now = performance.now();
    let extra = 0;
    const last = window.__vib[window.__vib.length - 1];
    if (last && Array.isArray(last.p) && cfg.shake) {
      let t = last.at + cfg.lag;
      for (let i = 0; i < last.p.length; i += 2) {
        const off = t + last.p[i];
        if (now >= t && now < off) { up = !up; extra = up ? cfg.shake : -cfg.shake; }
        else if (cfg.ring && now >= off && now < off + cfg.ring) { up = !up; extra = (up ? cfg.shake : -cfg.shake) * (1 - (now - off) / cfg.ring); }
        t += last.p[i] + (last.p[i + 1] || 0);
      }
    }
    for (const k of window.__knocks) if (!k.done && now >= k.t) { k.done = true; extra += 8; }
    if (cfg.motion === false) return;
    const e = new Event('devicemotion');
    e.accelerationIncludingGravity = { x: 0, y: 0, z: 9.81 + extra + (Math.random() - 0.5) * 0.04 };
    // A gyro at rest: a degree a second of noise, as Chrome hands it over.
    e.rotationRate = cfg.rotation === false ? null
      : { alpha: (Math.random() - 0.5) * 2, beta: (Math.random() - 0.5) * 2, gamma: (Math.random() - 0.5) * 2 };
    window.dispatchEvent(e);
    // And its orientation, lying flat.
    if (cfg.rotation !== false) {
      const o = new Event('deviceorientation');
      Object.assign(o, { alpha: 30 + (Math.random() - 0.5) * 0.1, beta: (Math.random() - 0.5) * 0.1, gamma: (Math.random() - 0.5) * 0.1 });
      window.dispatchEvent(o);
    }
  }, 16);
})();
"""

# A round of labb 2 under way in this browser, walked up to and with Hon knackar.
ROUND = """
localStorage.setItem('glimt-lab-ratings', JSON.stringify(
  ['normalt', 'vandom', 'vagval', 'kompass', 'morse', 'vibration'].map((station, i) => (
    { at: new Date(Date.now() - 3600e3 + i * 60e3).toISOString(), station, rating: 'igen', outcome: 'klarade', walk: 'w1', only: false, picked: false }))));
"""

out = []


class Stop(Exception):
    pass


def check(ok, what):
    out.append(("ok  " if ok else "FAIL") + "  " + what)
    if not ok and FAIL_FAST:
        raise Stop()


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    # A page closed mid-download resets the connection; that is not a failure.
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, client_address)


def serve():
    server = Server(("127.0.0.1", 0), functools.partial(Quiet, directory=str(REPO)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


# What the map answers, when a scenario asks for one: a bridge 180 m east of
# where the sim walk starts (59.38, 13.5).
BRIDGE = {"elements": [{"type": "way", "tags": {"bridge": "yes"}, "center": {"lat": 59.38, "lon": 13.5 + 180 / (111320 * 0.5096)}}]}


@functools.lru_cache(maxsize=None)
def test_sounds():
    """Made-up stand-ins for what only the private copy has (the bed, the
    riser, the credits' song), as glimt/ljud.json names them there. Sine
    tones made here, never the real files; the song as long as the credits."""
    folder = Path(tempfile.mkdtemp(prefix="glimt-ljud-test-"))
    seconds = json.loads((REPO / "stories/glimt/episod-1.json").read_text())["credits"]["seconds"]
    files = {"bed": ("audio/glimt/bed/test-bed.opus", 110, 6), "riser": ("audio/glimt/fx/test-riser.opus", 440, 2),
             "song": ("audio/glimt/music/test-song.opus", 330, seconds)}
    body = {}
    for kind, (path, hz, length) in files.items():
        out = folder / Path(path).name
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={hz}:duration={length}",
                        "-af", "volume=0.05", "-c:a", "libopus", "-b:a", "16k", str(out)], check=True)
        body[path] = out.read_bytes()
    manifest = {"bed": files["bed"][0], "riser": files["riser"][0], "credits": {"glimt-e1": files["song"][0]}}
    return json.dumps(manifest), body


def open_page(browser, base, ua=CHROME_UA, url="?banor=vagval,kompass,vibration", init="", answer=True, shake=1.5, lag=0, ring=0, motion=True, overpass=None, rotation=True, hang=(), sounds=False):
    ctx = browser.new_context(
        user_agent=ua,
        viewport={"width": 412, "height": 915},
        device_scale_factor=2,
        service_workers="block",
        geolocation={"latitude": 59.38, "longitude": 13.5},
        permissions=["geolocation"],
    )
    manifest, files = test_sounds() if sounds else (None, {})

    def route(r):
        if any(h in r.request.url for h in hang):
            return              # a dead connection: the request never settles
        # `sounds`: the address is a private copy's, with its bed, riser and song.
        path = r.request.url[len(base):].split("?", 1)[0].lstrip("/") if r.request.url.startswith(base) else None
        if manifest and path == "glimt/ljud.json":
            r.fulfill(status=200, content_type="application/json", body=manifest)
        elif path in files:
            r.fulfill(status=200, content_type="audio/ogg", body=files[path])
        elif r.request.url.startswith(base):
            r.continue_()
        elif overpass is not None and "/api/interpreter" in r.request.url:
            r.fulfill(status=200, content_type="application/json", body=json.dumps(overpass))
        else:
            r.abort()

    ctx.route("**/*", route)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: errors.append(f"{r.status} {r.url}") if r.status >= 400 else None)
    phone = json.dumps({"answer": answer, "shake": shake, "lag": lag, "ring": ring, "motion": motion, "rotation": rotation})
    page.add_init_script(PHONE % phone + init)
    page.goto(f"{base}/glimt/{url}")
    page.wait_for_function("document.getElementById('start-btn').textContent === 'Börja gå'", timeout=30000)
    return ctx, page, errors


def state(page):
    return page.evaluate(
        """() => ({
      box: !document.getElementById('vibra-box').hidden,
      state: document.getElementById('vibra-box').dataset.state,
      note: document.getElementById('vibra-note').textContent,
      btn: document.getElementById('vibra-btn').textContent,
      btnDisabled: document.getElementById('vibra-btn').disabled,
      answer: !document.getElementById('vibra-answer').hidden,
      pressed: [...document.querySelectorAll('#vibra-answer button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.value),
      load: document.getElementById('load-note').textContent,
      chrome: !document.getElementById('chrome-link').hidden,
      boxBottom: document.getElementById('vibra-box').getBoundingClientRect().bottom,
      startTop: document.getElementById('start-btn').getBoundingClientRect().top,
      startBottom: document.getElementById('start-btn').getBoundingClientRect().bottom,
      heights: [...document.querySelectorAll('#vibra-box button')].filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().height)),
      noteLines: Math.round(document.getElementById('vibra-note').getBoundingClientRect().height / parseFloat(getComputedStyle(document.getElementById('vibra-note')).lineHeight)),
    })"""
    )


def walk_log(page):
    return page.evaluate("() => [...document.querySelectorAll('#log li')].map(li => li.textContent)")


def asked(page):
    return [v["p"] for v in page.evaluate("window.__vib")]


def wait_state(page, want, timeout=5000):
    try:
        page.wait_for_function("s => document.getElementById('vibra-box').dataset.state === s", arg=want, timeout=timeout)
    except PlaywrightTimeout:
        pass
    return state(page)


def wait_log(page, text, timeout=10000):
    try:
        page.wait_for_function("t => [...document.querySelectorAll('#log li')].some(li => li.textContent.includes(t))", arg=text, timeout=timeout)
    except PlaywrightTimeout:
        return ""
    return [line for line in walk_log(page) if text in line][0]


def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)


def num(x):
    return float(x.replace(",", "."))


def first(browser, base):
    # Chrome on Android, a link with Hon knackar: the try-out is offered, above the start button.
    ctx, page, errors = open_page(browser, base)
    s = state(page)
    check(s["box"] and s["state"] == "idle" and s["btn"] == "Prova vibrationen" and not s["answer"], f"Chrome on Android, a walk with Hon knackar: the try-out is offered ({s['state']}, {s['btn']!r})")
    check(s["boxBottom"] <= s["startTop"] and s["startBottom"] < 915, f"above the start button, which stays on the first screen (box ends {s['boxBottom']:.0f}, button {s['startTop']:.0f}-{s['startBottom']:.0f} of 915)")
    check(all(h >= 44 for h in s["heights"]), f"its button is a thumb high ({s['heights']})")
    check("Firefox" not in s["load"] and not s["chrome"], "no Firefox line and no Chrome link in Chrome")
    shot(page, "1-idle")

    page.click("#vibra-btn")
    page.wait_for_timeout(150)
    s = state(page)
    check(s["state"] == "buzzing" and s["btnDisabled"] and s["btn"] == "Prova vibrationen", f"while it buzzes the button waits, and does not say again yet ({s['state']}, {s['btn']!r})")
    s = wait_state(page, "asked")
    check(asked(page) == [PATTERN], f"the phone is asked once, for her three knocks ({json.dumps(asked(page))})")
    check(s["answer"] and s["pressed"] == [] and s["btn"] == "Prova igen" and not s["btnDisabled"] and s["note"] == "Kände du alla tre surren?", f"then it asks, with nothing answered for the walker ({s['note']!r}, {s['btn']!r})")
    check(all(h >= 44 for h in s["heights"]) and len(s["heights"]) == 3, f"Ja, Nej and Prova igen are a thumb high ({s['heights']})")
    shot(page, "2-asked")

    page.click('#vibra-answer button[value="nej"]')
    s = state(page)
    check(s["state"] == "nej" and s["pressed"] == ["nej"] and "ljudlöst" in s["note"] and "hoppar vi över den banan" in s["note"] and "Prova igen" in s["note"], f"Nej says what to check and what happens ({s['note']!r})")
    check(s["note"].count("\n") == 5 and s["noteLines"] >= 6, f"one check a line ({s['noteLines']} lines on screen)")
    check(s["answer"] and len(s["heights"]) == 3, f"the question stays up with the answer marked ({len(s['heights'])} buttons)")
    shot(page, "3-nej")
    # A slip can be changed without a new try-out, either way.
    page.click('#vibra-answer button[value="ja"]')
    s = state(page)
    check(s["state"] == "ja" and s["pressed"] == ["ja"] and s["answer"], f"a no can be changed to a yes on the spot ({s['state']})")
    page.click('#vibra-answer button[value="nej"]')
    s = state(page)
    check(s["state"] == "nej" and s["pressed"] == ["nej"] and asked(page) == [PATTERN], f"and back, without the phone buzzing again ({s['state']})")

    page.click("#vibra-btn")
    s = wait_state(page, "asked")
    check(s["pressed"] == [], "a new try-out forgets the old answer")
    page.click('#vibra-answer button[value="ja"]')
    s = state(page)
    check(s["state"] == "ja" and s["pressed"] == ["ja"] and "hur det känns" in s["note"], f"Ja ({s['note']!r})")
    shot(page, "4-ja")

    # The walk's log says what the try-out gave, with the sensor's reading.
    page.click("#start-btn")
    line = wait_log(page, "vibration före start")
    m = re.search(r"kändes, sensorn (\d+,\d+) före, (\d+,\d+) under surren, (\d+,\d+) emellan", line)
    check(bool(m), f"the walk logs it: {line!r}")
    check(bool(m) and num(m.group(2)) > 5 * num(m.group(1)) and num(m.group(2)) > 5 * num(m.group(3)), "and the stand-in motor shows in the reading")
    check(not errors, f"no page errors ({errors[:3]})")
    ctx.close()


def no(browser, base):
    # Said no and started anyway: the station steps aside, and the phone is left alone.
    ctx, page, errors = open_page(browser, base, url="?bana=vibration", shake=0)
    page.click("#vibra-btn")
    wait_state(page, "asked")
    page.click('#vibra-answer button[value="nej"]')
    before = len(asked(page))
    page.click("#start-btn")
    line = wait_log(page, "vibration före start")
    check("kändes inte" in line, f"said no, the log: {line!r}")
    res = wait_log(page, "Hon knackar: ", 150000)
    log = walk_log(page)
    check("hoppade" in res and "vibrationen kändes inte i provet före start" in res, f"the station is skipped and says why: {res!r}")
    check(any("vibra-kan-inte" in line for line in log) and not any("vibra-intro" in line for line in log), "she says it without asking the walker to stop and feel for it")
    check(len(asked(page)) == before, "and the phone is not asked to buzz in the walk")
    check(not errors, f"no page errors ({errors[:3]})")
    ctx.close()


def cut(browser, base):
    # Said no, tapped "Prova igen", then "Börja gå" before it was over: the
    # try-out is cut short and the no stands.
    for label, pause in (("before the buzz", 120), ("while it buzzes", 800)):
        ctx, page, errors = open_page(browser, base, url="?bana=vibration", shake=0)
        page.click("#vibra-btn")
        wait_state(page, "asked")
        page.click('#vibra-answer button[value="nej"]')
        page.click("#vibra-btn")
        page.wait_for_timeout(pause)
        page.click("#start-btn")
        line = wait_log(page, "vibration före start")
        check("kändes inte" in line, f"started {label}, the earlier no stands: {line!r}")
        page.wait_for_timeout(2500)
        want = [PATTERN, 0] if pause < 400 else [PATTERN, PATTERN, 0]
        check(asked(page) == want, f"the try-out is cut short and the motor told to stop ({json.dumps(asked(page))})")
        if pause > 400:
            res = wait_log(page, "Hon knackar: ", 150000)
            check("hoppade" in res, f"and the station is skipped: {res!r}")
            check(asked(page) == want, "with no buzz in the walk")
        check(not errors, f"no page errors ({errors[:3]})")
        ctx.close()


def hidden(browser, base):
    # The page went out of sight inside the try-out: the phone is asked for
    # nothing, and it is as if it was not tried.
    ctx, page, errors = open_page(browser, base)
    page.click("#vibra-btn")
    page.evaluate("window.__hidden = true")
    page.wait_for_timeout(1200)
    s = state(page)
    check(s["state"] == "idle" and asked(page) == [0] and s["btn"] == "Prova vibrationen" and not s["btnDisabled"] and not s["answer"], f"a page out of sight is not read as a browser that refuses ({s['state']}, {json.dumps(asked(page))})")
    page.evaluate("window.__hidden = false")
    page.click("#vibra-btn")
    wait_state(page, "asked")
    check(asked(page) == [0, PATTERN], f"and the next try buzzes ({json.dumps(asked(page))})")
    ctx.close()


def refused(browser, base):
    ctx, page, errors = open_page(browser, base, answer=False)
    page.click("#vibra-btn")
    s = wait_state(page, "refused")
    check(s["state"] == "refused" and not s["answer"] and "säger nej" in s["note"] and "hoppar vi över den banan" in s["note"], f"a browser that refuses: said so, and nothing to answer ({s['note']!r})")
    shot(page, "5-refused")
    page.click("#start-btn")
    line = wait_log(page, "vibration före start")
    check("webbläsaren sa nej" in line, f"and the walk logs it: {line!r}")
    ctx.close()


def untried(browser, base):
    ctx, page, errors = open_page(browser, base)
    page.click("#start-btn")
    line = wait_log(page, "vibration före start")
    check(line.endswith("inte provad"), f"not tried, the log: {line!r}")
    ctx.close()


def where(browser, base):
    # Offered only where a walk from here has Hon knackar.
    ctx, page, errors = open_page(browser, base, url="?kapitel=1")
    check(not state(page)["box"], "chapter 1: no try-out")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?banor=vagval,kompass")
    check(not state(page)["box"], "a link without Hon knackar: no try-out")
    page.click("#start-btn")
    page.wait_for_timeout(1500)
    check(not any("vibration före start" in line for line in walk_log(page)), "and no line about it in the log")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?kapitel=labb2")
    check(state(page)["box"], "the whole of labb 2: the try-out is offered")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?kapitel=labb1")
    check(not state(page)["box"], "labb 1 has no Hon knackar: no try-out")
    ctx.close()


def resume(browser, base):
    # A round under way that already has Hon knackar: the try-out follows the
    # choice between the rest and all of them.
    ctx, page, errors = open_page(browser, base, url="?kapitel=labb2", init=ROUND)
    rest = page.evaluate("!document.getElementById('resume-box').hidden && document.getElementById('resume-rest').textContent")
    check(bool(rest) and "Tassa" in rest and not state(page)["box"], f"going on after Hon knackar: no try-out ({rest!r})")
    page.check('input[name="resume"][value="all"]')
    check(state(page)["box"], "all of them from the start: the try-out is offered")
    shot(page, "7-resume")
    page.check('input[name="resume"][value="rest"]')
    check(not state(page)["box"], "and taken away again with the rest")
    page.click("#start-btn")
    page.wait_for_timeout(1500)
    check(not any("vibration före start" in line for line in walk_log(page)), "no line about it in the log of a walk without the station")
    check(not errors, f"no page errors ({errors[:3]})")
    ctx.close()


def firefox(browser, base):
    # Firefox cannot vibrate: no try-out. On Android it says so, says the GPS
    # comes sparsely, and offers Chrome.
    ctx, page, errors = open_page(browser, base, ua=FIREFOX_UA)
    s = state(page)
    check(not s["box"], "Firefox on Android: no try-out")
    check("Firefox vibrerar inte" in s["load"] and "gps:en glest" in s["load"] and s["load"].count("Öppna Glimt i Chrome.") == 1 and s["chrome"], f"it says vibration and GPS, once, with the link ({s['load']!r})")
    shot(page, "6-firefox")
    ctx.close()
    ctx, page, errors = open_page(browser, base, ua=FIREFOX_UA, url="?kapitel=1")
    s = state(page)
    check("gps:en glest" in s["load"] and "vibrerar" not in s["load"], f"chapter 1 there: the GPS line alone ({s['load']!r})")
    ctx.close()
    ctx, page, errors = open_page(browser, base, ua=FIREFOX_DESKTOP_UA)
    s = state(page)
    check("Firefox vibrerar inte" in s["load"] and "glest" not in s["load"] and s["load"].count("Öppna Glimt i Chrome.") == 1 and not s["chrome"], f"Firefox on a desktop: vibration only ({s['load']!r})")
    ctx.close()


def station(browser, base):
    # Hon knackar from the start screen to its result, with a motor that
    # starts 150 ms late and rings on for 200, and a walker who knocks back
    # 0.7 s after her last buzz.
    ctx, page, errors = open_page(browser, base, url="?banor=vibration", lag=150, ring=200)
    load = state(page)["load"]
    check("Bara Hon knackar den här gången" in load, f"a link with the one station says so: {load!r}")
    page.click("#vibra-btn")
    wait_state(page, "asked")
    page.click('#vibra-answer button[value="ja"]')
    page.evaluate("window.__walking = true")
    page.click("#start-btn")
    res = wait_log(page, "Hon knackar: ", 280000)
    log = walk_log(page)
    check("klarade" in res and "2 → 2, 3 → 3" in res, f"knocks back 0.7 s after the buzz are counted in full: {res!r}")
    surr = [line for line in log if "surr: " in line]
    check(len(surr) == 2, f"a reading of each buzz in the log ({len(surr)})")
    for line in surr:
        m = re.search(r"sensorn (\d+,\d+) före, (\d+,\d+) under surren, (\d+,\d+) emellan", line)
        check(bool(m) and max(num(m.group(2)), num(m.group(3))) > 5 * num(m.group(1)), f"the late motor shows against the level before: {line!r}")
    buzzes = [v["p"] for v in page.evaluate("window.__vib") if v["walking"]]
    check(buzzes == [PATTERN[:4], PATTERN], f"she buzzed two knocks, then three ({[len(p) // 2 for p in buzzes]})")
    stray = [line for line in log if "dubbelknack utan" in line]
    check(len(stray) == 1 and " 0 dubbelknack utan" in stray[0], f"no double knock nobody asked for ({stray})")
    check(not errors, f"no page errors ({errors[:3]})")
    ctx.close()


# The test walks' walker, in the page: it reads Vega's lines off the log as
# they start and does with the sim's controls what each test asks of the
# body. Toward a place (Ljudkompassen, Hitta) it turns right whenever the
# distance has grown, which gets there in the end.
WALKER = """
(() => {
  const $ = id => document.getElementById(id);
  const speed = v => { $('sim-speed').value = String(v); $('sim-speed').dispatchEvent(new Event('input')); };
  const later = (s, fn) => setTimeout(fn, s * 1000);
  const sensor = on => { $('sim-sensor-off').checked = !on; };
  let steer = false, lastD = null, quietUntil = 0;
  setInterval(() => {
    if (!steer || !window.glimt || performance.now() < quietUntil) return;
    const d = window.glimt.walk.state().distToTarget;
    if (d === null) return;
    if (lastD !== null && d > lastD + 0.5) { $('sim-right').click(); lastD = null; quietUntil = performance.now() + 6000; return; }
    lastD = d;
  }, 3000);
  const walkOn = () => speed(1.4), stop = () => speed(0);
  const toward = () => { steer = true; lastD = null; };
  const on = {
    'prov-intro': walkOn,
    'frys-nu': () => later(1, stop), 'frys-klarade': walkOn, 'frys-rorde': walkOn, 'frys-sen': walkOn,
    'ja-q1': () => later(2.5, stop), 'ja-q2-ljust': () => later(2.5, stop), 'ja-q2-morkt': () => later(2.5, stop),
    'ja-svar-ja': () => later(1, walkOn),
    'kontakt-1': () => { later(4, stop); later(30, walkOn); },
    'kontakt-5': () => { later(2, stop); later(28, walkOn); },
    'vaxla-spring': () => later(1, () => speed(3)), 'vaxla-spring-igen': () => later(1, () => speed(3)),
    'vaxla-ga': () => later(1, walkOn), 'vaxla-ga-igen': () => later(1, walkOn),
    'knackgang-nu': () => { later(1.2, () => $('sim-knock').click()); later(1.5, () => $('sim-knock').click()); },
    'knackgang-ficka': () => { later(1, stop); later(8, walkOn); },
    'hopp-nu': () => later(1.5, () => $('sim-jump').click()), 'hopp-igen': () => later(1.5, () => $('sim-jump').click()),
    'hopp-jogga': () => later(1, () => speed(3)), 'hopp-jogga-nu': () => later(1.5, () => $('sim-jump').click()), 'hopp-ga': () => later(1, walkOn),
    'vagval-intro': () => later(12, () => $('sim-left').click()),
    'vandom-nu': () => later(2, () => $('sim-turn').click()), 'vandom-igen': () => later(2, () => $('sim-turn').click()),
    'kompass-intro': toward, 'hitta-intro-bro': toward, 'hitta-intro-plats': toward, 'hitta-intro-vatten': toward,
    'hitta-intro-skog': toward, 'hitta-intro-berg': toward, 'hitta-intro-kyrkogard': toward,
    'kompass-framme': () => { steer = false; }, 'kompass-tid': () => { steer = false; },
    'hitta-framme': () => { steer = false; }, 'hitta-tid': () => { steer = false; },
    'vakten-intro': () => later(3, () => sensor(false)),
    'sensor-tyst': () => later(3, () => sensor(true)),
  };
  const seen = new WeakSet();
  // The init script runs before there is a document to watch.
  const watch = () => new MutationObserver(() => {
    for (const li of document.querySelectorAll('#log li')) {
      if (seen.has(li)) continue;
      seen.add(li);
      const m = /▶ (\\S+)$/.exec(li.textContent);
      if (m && on[m[1]]) on[m[1]]();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
"""

# What each test walk must end with in the browser. Takten and Tassa cannot
# be walked right with a slider (a beat to follow, soft steps), so for them
# only that they ran to an end without a fault.
PROV_WANT = {
    "frys": {"frys": "klarade"}, "ja": {"ja": "klarade"}, "kontakt": {"kontakt": "klarade"}, "vaxla": {"vaxla": "klarade"},
    "knack": {"knackgang": "klarade"}, "riktning": {"vagval": "klarade", "vandom": "klarade"},
    "kompass": {"kompass": "klarade"}, "takten": {"takten": None}, "hitta": {"hitta": "klarade"},
    "tassa": {"tassa": None}, "vakten": {"vakten": "klarade"}, "hopp": {"hopp": "klarade"},
}
# GLIMT_PROV=frys,ja walks only those.
PROV_IDS = [x for x in PROV_WANT if not os.environ.get("GLIMT_PROV") or x in os.environ["GLIMT_PROV"].split(",")]


def prov(browser, base):
    # Every test link, from the start screen to the saved file, side by side.
    pages = []
    for pid in PROV_IDS:
        ctx, page, errors = open_page(browser, base, url=f"?prov={pid}&sim", init=WALKER, overpass=BRIDGE)
        card = page.evaluate("""() => ({
          box: !document.getElementById('prov-box').hidden,
          chapters: !document.getElementById('chapter-box').hidden,
          vibra: !document.getElementById('vibra-box').hidden,
          title: document.getElementById('prov-title').textContent,
          version: document.getElementById('prov-version').textContent,
          question: document.getElementById('prov-question').textContent,
          todo: document.getElementById('prov-todo').textContent,
          sub: document.getElementById('subtitle').textContent,
          doc: document.title,
        })""")
        check(card["box"] and not card["chapters"] and not card["vibra"] and card["version"] == f"Version {APP_VERSION}" and card["question"] and card["todo"],
              f"?prov={pid}: the start screen shows its card and nothing to choose ({card['title']!r}, {card['version']!r}, {card['sub']!r})")
        shot(page, f"prov-{pid}-start")
        page.click("#start-btn")
        pages.append((pid, ctx, page, errors))
    for pid, ctx, page, errors in pages:
        try:
            page.wait_for_function("!document.getElementById('done').hidden", timeout=600000)
        except PlaywrightTimeout:
            check(False, f"?prov={pid}: never reached the end screen ({walk_log(page)[-3:]})")
            ctx.close()
            continue
        log = walk_log(page)
        check(any(f"start, prov {pid} " in line and f"version {APP_VERSION}" in line for line in log), f"?prov={pid}: the log names the test and the version")
        check(any("▶ prov-slut" in line for line in log) and not any(re.search(r"▶ (labb-|franvaro|nyckel|varld)", line) for line in log),
              f"?prov={pid}: her end line, and no lab or memory lines")
        untouched = not any(line.split("  ", 1)[-1].startswith("minne:") for line in log) and page.evaluate("document.getElementById('world-end').hidden")
        check(untouched, f"?prov={pid}: her world is left as it was")
        results = page.evaluate("""() => [...document.querySelectorAll('#lab-list li')].map(li => ({
          title: li.querySelector('strong').textContent,
          outcome: li.querySelector('.lab-outcome').className.replace(/.*lab-/, ''),
          detail: li.querySelector('.lab-detail').textContent,
        }))""")
        for station, want in PROV_WANT[pid].items():
            title = TITLE[station]
            got = next((r for r in results if r["title"] == title), None)
            ok = got is not None and "fel:" not in got["detail"] and (want is None or got["outcome"] == want)
            check(ok, f"?prov={pid}: {title} {got['outcome'] + ', ' + got['detail'] if got else 'has no result'}")
        asks = page.evaluate("[...document.querySelectorAll('#prov-asks .prov-ask')].length")
        check(asks >= 1, f"?prov={pid}: the end screen asks {asks} question(s)")
        for b in page.query_selector_all("#prov-asks .lab-rate"):
            b.query_selector("button").click()
        for b in page.query_selector_all("#lab-list .lab-rate"):
            b.query_selector("button").click()
        shot(page, f"prov-{pid}-done")
        label = page.evaluate("document.getElementById('save-btn').hidden ? null : document.getElementById('save-btn').textContent")
        with page.expect_download() as dl:
            page.click("#save-btn")
        d = dl.value
        body = json.loads(Path(d.path()).read_text())
        p = body.get("prov") or {}
        check(d.suggested_filename.startswith(f"glimt-prov-{pid}-") and d.suggested_filename.endswith(".json"), f"?prov={pid}: the file is named for the test ({d.suggested_filename})")
        check(p.get("id") == pid and p.get("appVersion") == APP_VERSION and len(p.get("answers", {})) == asks and all(r.get("rating") == "igen" for r in p.get("results", [])) and p.get("results"),
              f"?prov={pid}: it carries the answers and the verdicts ({json.dumps(p.get('answers'), ensure_ascii=False)})")
        check(any(m[1].startswith("svar: ") for m in body["log"]), f"?prov={pid}: and the log in it has the answers")
        check(label is not None and "Demi" in page.evaluate("document.getElementById('save-btn').textContent"), f"?prov={pid}: the save button is there without a sensor recording too")
        check(not errors, f"?prov={pid}: no page errors ({errors[:3]})")
        ctx.close()


TITLE = {"frys": "Frys", "ja": "Stanna för ja", "kontakt": "Kontakten", "knackgang": "Knacket gående", "vagval": "Vägvalet",
         "vandom": "Vänd om", "kompass": "Ljudkompassen", "takten": "Takten", "hitta": "Hitta", "tassa": "Tassa", "vakten": "Sensorvakten", "vaxla": "Gå och spring", "hopp": "Hoppet"}


def provstart(browser, base):
    # The start screen's own checks, on a phone that is not simulated.
    ctx, page, errors = open_page(browser, base, url="?prov=frys")
    try:
        page.wait_for_function("document.getElementById('sensor-note').textContent.startsWith('Rörelsesensorn')", timeout=5000)
    except PlaywrightTimeout:
        pass
    note = page.evaluate("document.getElementById('sensor-note').textContent")
    check(note == "Rörelsesensorn svarar.", f"Frys, a sensor that answers: said so before the walk ({note!r})")
    page.click("#start-btn")
    line = wait_log(page, "sensor före start")
    check("svarar" in line and "inte" not in line and "med vridning" in line, f"and the walk logs it, the gyro's rotation too: {line!r}")
    # Stopped a few seconds in: the file has what the gyro needs to be
    # replayed, and says what it is (version 2, app version 30).
    page.wait_for_timeout(3000)
    page.click("#stop-btn")
    page.wait_for_function("!document.getElementById('done').hidden", timeout=15000)
    with page.expect_download() as dl:
        page.click("#save-btn")
    body = json.loads(Path(dl.value.path()).read_text())
    n = len(body.get("t", []))
    vectors = all(len(body.get(k) or []) == n for k in ("ax", "ay", "az", "ra", "rb", "rg"))
    told = all(k in body.get("units", {}) for k in ("ax, ay, az", "ra, rb, rg", "gyro", "orient"))
    orient = body.get("orient") or []
    told = told and len(orient) > 100 and len(orient[0]) == 4 and abs(orient[len(orient) // 2][1] - 3000) < 50
    flat = n and abs(body["az"][n // 2] - 981) < 10 and body["ra"][n // 2] is not None
    check(body.get("version") == 2 and n > 100 and vectors and told and flat and body.get("gyro") == {"enabled": True, "side": True},
          f"the saved file carries the acceleration's direction and the rotation, and its units say so (version {body.get('version')}, {n} samples)")
    ctx.close()
    # No gyro in the phone: the rotation is left out of the file, not a column of nulls.
    ctx, page, errors = open_page(browser, base, url="?prov=frys", rotation=False)
    page.wait_for_timeout(1800)
    page.click("#start-btn")
    line = wait_log(page, "sensor före start")
    check("ingen vridning" in line, f"a phone without a gyro: the log says so ({line!r})")
    page.wait_for_timeout(1500)
    page.click("#stop-btn")
    page.wait_for_function("!document.getElementById('done').hidden", timeout=15000)
    with page.expect_download() as dl:
        page.click("#save-btn")
    body = json.loads(Path(dl.value.path()).read_text())
    check("ra" not in body and len(body.get("ax") or []) == len(body.get("t", [])), "and its file has the acceleration but no rotation columns")
    ctx.close()
    # Börja gå pressed while the start screen still listens: the log says the
    # check was under way, and what it had heard. The check's 1.5 s is
    # stretched here so the press surely lands inside it.
    stretch = "const _st = window.setTimeout; window.setTimeout = (f, ms, ...a) => _st(f, ms === 1500 ? 20000 : ms, ...a);"
    ctx, page, errors = open_page(browser, base, url="?prov=frys", init=stretch)
    page.wait_for_timeout(500)
    page.click("#start-btn")
    line = wait_log(page, "sensor före start")
    check("kollen pågick" in line and "inte kollad" not in line and "hittills" in line, f"started during the check: the log says it was under way ({line!r})")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?prov=frys", motion=False)
    page.wait_for_timeout(2000)
    note = page.evaluate("document.getElementById('sensor-note').textContent")
    check(note.startswith("Rörelsesensorn svarar inte") and "Chrome" in note, f"a sensor that is silent: said so, with what to do ({note!r})")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?prov=kompass", overpass=BRIDGE)
    try:
        page.wait_for_function("document.getElementById('map-note').textContent.startsWith('Kartan hittar')", timeout=10000)
    except PlaywrightTimeout:
        pass
    note = page.evaluate("document.getElementById('map-note').textContent")
    check("en bro 180 m" in note and "Tonen leder till en bro" in note, f"Ljudkompassen: the map's answer before the walk ({note!r})")
    sensor = page.evaluate("document.getElementById('sensor-note').hidden")
    check(sensor, "and no sensor check for a walk that does not need one")
    shot(page, "prov-kompass-map")
    page.click("#start-btn")
    line = wait_log(page, "karta före start")
    check("en bro 180 m" in line and "mål en bro" in line, f"the walk logs it: {line!r}")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?prov=kompass")
    try:
        page.wait_for_function("document.getElementById('map-note').textContent.startsWith('Kartan svarar inte')", timeout=60000)
    except PlaywrightTimeout:
        pass
    note = page.evaluate("document.getElementById('map-note').textContent")
    check(note.startswith("Kartan svarar inte"), f"a map that does not answer: said so ({note!r})")
    ctx.close()
    # Links open in Firefox on his phone: the way to Chrome keeps the test.
    ctx, page, errors = open_page(browser, base, ua=FIREFOX_UA, url="?prov=riktning")
    href = page.evaluate("document.getElementById('chrome-link').hidden ? null : document.getElementById('chrome-link').getAttribute('href')")
    check(bool(href) and href.startswith("intent://") and "?prov=riktning#Intent" in href and "package=com.android.chrome" in href, f"Firefox: Öppna i Chrome keeps ?prov= ({href})")
    ctx.close()
    ctx, page, errors = open_page(browser, base, url="?prov=finnsinte")
    load = page.evaluate("document.getElementById('load-note').textContent")
    box = page.evaluate("!document.getElementById('prov-box').hidden")
    check("Länkens test (finnsinte) finns inte" in load and not box, f"an unknown test says so, and offers the lab ({load!r})")
    ctx.close()


# Episode 1's walkers. Both set off at her first line and turn for home at
# the end of scene 1, so the end comes on the distance. `asked` stops when
# she asks (both questions in scene 0, then at the tree, where it lights the
# lamp) and once where a stop is harmless, while she sits in scene 3; `own`
# never does, and stops by themselves among the trees and when she gets up
# in scene 4. Offsets are seconds from the start of the line, which the log
# marks.
EPISODE_WALKER = """
(() => {
  const who = %s;
  const $ = id => document.getElementById(id);
  const speed = v => { $('sim-speed').value = String(v); $('sim-speed').dispatchEvent(new Event('input')); };
  const later = (s, fn) => setTimeout(fn, s * 1000);
  const walkOn = () => speed(1.4), stop = () => speed(0);
  // What the mixer is doing, read a moment into a stop and again once walking.
  window.__mix = [];
  const sample = label => later(0, () => {
    const g = window.glimt;
    if (!g || !g.side) return;
    window.__mix.push({ label, voiceHz: g.mixer.voiceFilter.frequency.value, voice: g.mixer.voiceGain.gain.value,
      side: g.side.out.gain.value, bed: g.mixer.bedGain.gain.value, moving: g.walk.state().moving });
  });
  const on = {
    asked: {
      's0-1': walkOn,
      's0-ask1': () => { later(18.3, stop); later(27.8, walkOn); },
      's0-yes1-b': () => { later(10.4, stop); later(19.9, walkOn); },
      's1-3': () => later(10, () => $('sim-turn').click()),
      's2-ask': () => { later(9, stop); later(24, walkOn); },
      's3-1': () => { later(1, stop); later(10, () => sample('still')); later(13, walkOn); },
      's3-2': () => later(5, () => sample('walking')),
      's4-all': () => later(39, stop),
    },
    own: {
      's0-1': walkOn,
      's1-3': () => later(10, () => $('sim-turn').click()),
      's2-5': () => { later(1, stop); later(14, walkOn); },
      's4-2': () => { later(2, stop); later(15, walkOn); },
      's4-all': () => later(39, stop),
    },
  }[who];
  const seen = new WeakSet();
  const watch = () => new MutationObserver(() => {
    for (const li of document.querySelectorAll('#log li')) {
      if (seen.has(li)) continue;
      seen.add(li);
      const m = /▶ (\\S+)$/.exec(li.textContent);
      if (m && on[m[1]]) on[m[1]]();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
"""

EPISODE_WANT = {
    "asked": {
        "has": ["s0-1", "s0-2", "s0-ask1", "s0-yes1-a", "s0-yes1-b", "s0-yes2", "s1-walk", "s1-2",
                "s1-self", "s1-q2", "s1-q2-no", "s1-3", "s2-1", "s2-2", "s2-count", "s2-3", "s2-4", "s2-5", "s2-6", "s2-ask",
                "x-avvikelse (hennes sida)", "s2-lamp-plea", "s2-lamp-1", "s3-1", "s3-near", "s3-2", "s4-1", "s4-2", "s4-3",
                "s4-ok-lamp", "s4-yes", "s4-all"],
        "not": ["s0-no1", "s0-no2", "s2-count-stop", "s2-no", "s2-lamp-2", "s4-ok", "s4-lamp-1", "s4-lamp-2", "s4-never-1", "r-hjalp"],
        "lamps": 1, "memory": {"svarade": True, "misstanke": False, "klar": True},
    },
    "own": {
        "has": ["s0-no1", "s0-no2", "s2-5", "s2-6", "x-avvikelse (hennes sida)", "s2-lamp-1", "s4-lamp-1", "s4-lamp-2",
                "s4-never-1", "s4-never-no", "s4-all"],
        "not": ["s0-yes1-a", "s2-ask", "s2-no", "s2-lamp-2", "s4-ok", "s4-3", "s4-yes"],
        "lamps": 2, "memory": {"svarade": False, "misstanke": True, "klar": True},
    },
}


def clock(line):
    m, s = line.split("  ", 1)[0].split(":")
    return int(m) * 60 + int(s)


def episodstart(browser, base):
    # The start screen: the episode is first and chosen, and the chapters,
    # the labs and the test links are where they were.
    ctx, page, errors = open_page(browser, base, url="?sim")
    s = page.evaluate("""() => ({
      radios: [...document.querySelectorAll('input[name="chapter"]')].map(el => el.value),
      checked: document.querySelector('input[name="chapter"]:checked')?.value,
      label: document.querySelector('input[name="chapter"]').closest('label').textContent.trim(),
      sub: document.getElementById('subtitle').textContent,
      variant: !document.getElementById('variant-box').hidden,
      vibra: !document.getElementById('vibra-box').hidden,
      load: document.getElementById('load-note').textContent,
      traffic: (el => el && el.offsetParent !== null ? el.textContent : null)(document.getElementById('traffic-note')),
      doc: document.title,
    })""")
    check(s["radios"][0] == "episod1" and s["checked"] == "episod1" and s["label"].startswith("Episod 1"),
          f"a phone that has chosen nothing: Episod 1 is first and chosen ({s['radios']}, {s['checked']!r})")
    check(s["radios"][1:] == ["1", "2", "labb1", "labb2"], f"the chapters and the labs follow as before ({s['radios'][1:]})")
    check(s["sub"].startswith("Episod 1.") and s["doc"] == "Glimt, episod 1" and not s["variant"] and not s["vibra"],
          f"its subtitle, and neither her variants nor the vibration try-out ({s['sub']!r})")
    check("saknar" not in s["load"], f"everything it needs loaded ({s['load']!r})")
    check(s["traffic"] and "trafiken" in s["traffic"], f"the traffic warning shows before the first tap ({s['traffic']!r})")
    # The public build asks for none of what only the private copy has.
    asked = page.evaluate("performance.getEntriesByType('resource').map(e => e.name)")
    licensed = [u for u in asked if re.search(r"/audio/glimt/(bed|fx|music)/", u)]
    check(not licensed, f"and it asks for no bed, riser or song ({licensed[:3]})")
    shot(page, "episod-start")
    page.click('input[name="chapter"][value="1"]')
    page.wait_for_function("document.getElementById('start-btn').textContent === 'Börja gå'", timeout=30000)
    s1 = page.evaluate("({ sub: document.getElementById('subtitle').textContent, variant: !document.getElementById('variant-box').hidden })")
    check(s1["sub"].startswith("Kapitel 1.") and s1["variant"], f"chapter 1 is a tap away, with its variants ({s1['sub']!r})")
    check(not errors, f"no page errors ({errors[:3]})")
    ctx.close()
    for url, want in (("?kapitel=2&sim", "2"), ("?kapitel=episod1", "episod1"), ("?kapitel=labb2", "labb2"), ("?kapitel=finns-inte", "episod1")):
        ctx, page, errors = open_page(browser, base, url=url)
        got = page.evaluate("document.querySelector('input[name=\"chapter\"]:checked')?.value")
        check(got == want and not errors, f"{url} chooses {want} ({got!r}, {errors[:2]})")
        ctx.close()
    # A chapter walked from the start screen still runs: its first line, no her side.
    ctx, page, errors = open_page(browser, base, url="?kapitel=1&sim")
    page.click("#start-btn")
    line = wait_log(page, "▶ s0", 20000)
    side = page.evaluate("window.glimt && window.glimt.side")
    check(bool(line) and side is None and not errors, f"chapter 1 starts as before, without her side ({line!r}, {errors[:2]})")
    check(any("kapitel 1, variant" in x for x in walk_log(page)), "and its log names the chapter and the variant")
    check(page.evaluate("window.glimt.mixer.klarhet") == 1, "a chapter without a klarhet keeps her voice clean")
    ctx.close()
    # The line's clarity from the link: her lines on the radio, the hiss under them.
    ctx, page, errors = open_page(browser, base, url="?kapitel=episod1&sim&klarhet=0.2")
    page.click("#start-btn")
    line = wait_log(page, "▶ s0-2", 60000)
    page.wait_for_timeout(1500)
    k = page.evaluate("({ k: window.glimt.mixer.klarhet, hiss: window.glimt.mixer.hissGain.gain.value, lp: window.glimt.mixer.radioLp.frequency.value })")
    check(bool(line) and k["k"] == 0.2 and k["hiss"] > 0.01 and k["lp"] < 5000,
          f"?klarhet=0.2: her first line on the radio, with the hiss under it ({k})")
    check(any("linjens klarhet 0.2 (från länken)" in x for x in walk_log(page)), "and the log says the link set it")
    check(not errors, f"no page errors ({errors[:2]})")
    ctx.close()
    # A decimal comma, as a Swede types it, reads the same as a point.
    ctx, page, errors = open_page(browser, base, url="?kapitel=episod1&sim&klarhet=0,5")
    page.click("#start-btn")
    line = wait_log(page, "▶ s0-1", 60000)
    page.wait_for_timeout(500)
    check(bool(line) and page.evaluate("window.glimt.mixer.klarhet") == 0.5, f"?klarhet=0,5 reads as 0.5 ({page.evaluate('window.glimt.mixer.klarhet')})")
    ctx.close()


def fortexter(browser, base):
    # The credits' song on a dead connection: the fetch never settles. The
    # credits are skipped after their wait, and scene 1 comes.
    walks = """(() => { const t = setInterval(() => { const el = document.getElementById('sim-speed');
      if (el) { el.value = '1.4'; el.dispatchEvent(new Event('input')); clearInterval(t); } }, 200); })();"""
    ctx, page, errors = open_page(browser, base, url="?kapitel=episod1&sim", hang=("test-song.opus",), init=walks, sounds=True)
    page.click("#start-btn")
    skipped = wait_log(page, "förtexter: inte hämtade", 600000)
    scene1 = wait_log(page, "scene 1", 120000)
    check(bool(skipped) and bool(scene1), f"credits that never arrive are skipped and scene 1 comes ({skipped!r}, {scene1!r}; {walk_log(page)[-6:] if not scene1 else ''})")
    check(not any("▶ förtexter" in x for x in walk_log(page)), "and no song is played")
    ctx.close()


def episod(browser, base):
    # The episode walked to its end in the app, twice side by side.
    pages = []
    for who in EPISODE_WANT:
        ctx, page, errors = open_page(browser, base, url="?kapitel=episod1&sim", init=EPISODE_WALKER % json.dumps(who), sounds=True)
        page.click("#start-btn")
        pages.append((who, ctx, page, errors))
    for who, ctx, page, errors in pages:
        want = EPISODE_WANT[who]
        try:
            page.wait_for_function("!document.getElementById('done').hidden", timeout=900000)
        except PlaywrightTimeout:
            check(False, f"episod, {who}: never reached the end screen ({walk_log(page)[-4:]})")
            ctx.close()
            continue
        # The end screen's log: one line a row, the time and two spaces first.
        log = page.evaluate("document.getElementById('final-log').textContent.split('\\n')")
        heard = [line.split("▶ ", 1)[1] for line in log if "▶ " in line]
        check(any(f"Det är när du går (episod1), version {APP_VERSION}" in line for line in log), f"episod, {who}: the log names the episode and the version ({log[0]!r})")
        missing = [x for x in want["has"] if x not in heard]
        check(not missing, f"episod, {who}: every line of the walker's branches is heard ({'missing ' + ', '.join(missing) if missing else len(heard)})")
        extra = [x for x in want["not"] if any(h.split(" ")[0] == x for h in heard)]
        check(not extra, f"episod, {who}: and none of the other branches ({extra})")
        lamps = sum(1 for h in heard if h.startswith("x-avvikelse"))
        check(lamps == want["lamps"], f"episod, {who}: the lamp lights {lamps} time(s)")
        scenes = [line.split("  ", 1)[1] for line in log if re.search(r"  (scene \d|end|credits)", line)]
        order = [x for x in scenes if re.fullmatch(r"scene \d|end", x)]
        check(order == ["scene 1", "scene 2", "scene 4", "end"] and next((i for i, x in enumerate(scenes) if x.startswith("credits")), 99) < scenes.index("scene 1"),
              f"episod, {who}: the scenes come in order, the credits before scene 1 ({order})")
        check(any(x.startswith("scene 3: ") for x in scenes), f"episod, {who}: scene 3 names light, weather and landmark ({[x for x in scenes if x.startswith('scene 3')]})")
        credits = [line for line in log if "▶ förtexter" in line]
        check(len(credits) == 1 and "(68 s)" in credits[0], f"episod, {who}: the credits play once, the whole song ({credits})")
        stood = [clock(line) for line in log if "she stands still" in line]
        counted = [clock(line) for line in log if line.endswith("▶ s2-3")]
        cue = json.loads((REPO / "stories/glimt/episod-1.json").read_text())["cues"]["s2-3"]["trettio"]
        half = counted[-1] + cue - stood[-1] if stood and counted else None
        check(half is not None and abs(half - 30) <= 2, f"episod, {who}: from her last step to \"trettio\" is half a minute ({half})")
        missing_files = [line for line in log if "replik saknas" in line or "nådde aldrig slutet" in line or "fel:" in line]
        check(not missing_files, f"episod, {who}: no line missing or stalled ({missing_files[:3]})")
        memory = page.evaluate("JSON.parse(localStorage.getItem('glimt-episod-1-sim') || 'null')")
        real = page.evaluate("localStorage.getItem('glimt-episod-1')")
        ok = memory is not None and all(memory.get(k) == v for k, v in want["memory"].items())
        check(ok and real is None, f"episod, {who}: episode 2 is told the right things, and a simulated walk leaves the real memory alone ({memory})")
        check(any("minne till episod 2" in line for line in log), f"episod, {who}: and the log says what it was told")
        check(any("linjens klarhet 0.45" in line for line in log) and page.evaluate("window.glimt.mixer.klarhet") == 0.45,
              f"episod, {who}: her voice on the episode's line, klarhet 0.45")
        check(page.evaluate("window.glimt.mixer.hissGain.gain.value") < 0.001, f"episod, {who}: and no hiss once she is silent")
        if who == "asked":
            mix = {m["label"]: m for m in page.evaluate("window.__mix")}
            still, walking = mix.get("still"), mix.get("walking")
            check(bool(still and walking), f"episod, {who}: the mixer was read standing and walking ({list(mix)})")
            if still and walking:
                check(still["voiceHz"] < 1500 and walking["voiceHz"] > 8000 and still["voice"] < walking["voice"],
                      f"episod, {who}: her voice is dull while the walker stands and clear when they walk ({still['voiceHz']:.0f} Hz, then {walking['voiceHz']:.0f} Hz)")
                check(still["side"] > 0.8 and walking["side"] < 0.5 and still["bed"] < walking["bed"],
                      f"episod, {who}: her side comes forward and the bed steps back, then the other way ({still['side']:.2f}/{still['bed']:.2f}, then {walking['side']:.2f}/{walking['bed']:.2f})")
        sounds = page.evaluate("Object.keys(window.glimt.side.sounds).sort()")
        check(sounds == ["grus", "hand", "harda", "mjukt"] and page.evaluate("window.glimt.side.closed"),
              f"episod, {who}: her side had its four sounds, and is closed at the end ({sounds})")
        shot(page, f"episod-{who}-done")
        check(not errors, f"episod, {who}: no page errors ({errors[:3]})")
        ctx.close()


SCENARIOS = {
    "first": first,
    "no": no,
    "cut": cut,
    "hidden": hidden,
    "refused": refused,
    "untried": untried,
    "where": where,
    "resume": resume,
    "firefox": firefox,
    "station": station,
    "provstart": provstart,
    "prov": prov,
    "episodstart": episodstart,
    "fortexter": fortexter,
    "episod": episod,
}


def main():
    unknown = [x for x in ONLY if x not in SCENARIOS]
    if unknown:
        sys.exit(f"unknown scenario {', '.join(unknown)}; there are {', '.join(SCENARIOS)}")
    server, base = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, run in SCENARIOS.items():
            if ONLY and name not in ONLY:
                continue
            try:
                run(browser, base)
            except Stop:
                break
            except Exception as e:  # a scenario that falls over is a failed check, not a lost report
                out.append(f"FAIL  {name}: {type(e).__name__}: {str(e).splitlines()[0][:160]}")
                if FAIL_FAST:
                    break
        browser.close()
    server.shutdown()
    print("\n".join(out))
    sys.exit(1 if any(line.startswith("FAIL") for line in out) or not out else 0)


if __name__ == "__main__":
    main()
