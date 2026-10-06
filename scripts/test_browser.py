#!/usr/bin/env python3
"""Glimt in a real browser: the start screen's vibration try-out, and Hon
knackar walked from start to end.

The node tests run the engine and the stations. This runs what app.js wires
together, which nothing else does: Chromium with Chrome-on-Android's user
agent, navigator.vibrate replaced by a stand-in that records what it was
asked, and a made-up accelerometer (devicemotion at 60 Hz): flat, restless
while the stand-in motor "runs", and in the station a sharp sample for every
knock back. The motor there starts late and rings on, as a real one may.

    pip install playwright && playwright install chromium
    python3 scripts/test_browser.py                # all of it, about four minutes
    python3 scripts/test_browser.py first,resume   # some scenarios
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
import sys
import threading
from pathlib import Path

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Install deps: pip install playwright && playwright install chromium")

REPO = Path(__file__).resolve().parents[1]
ONLY = [x for x in (sys.argv[1].split(",") if len(sys.argv) > 1 else []) if x]
SHOTS = os.environ.get("GLIMT_SHOTS")
FAIL_FAST = bool(os.environ.get("GLIMT_FAIL_FAST"))
CHROME_UA = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Mobile Safari/537.36"
)
FIREFOX_UA = "Mozilla/5.0 (Android 14; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0"
FIREFOX_DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0"
PATTERN = [180, 320, 180, 320, 180, 320]

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
    const e = new Event('devicemotion');
    e.accelerationIncludingGravity = { x: 0, y: 0, z: 9.81 + extra + (Math.random() - 0.5) * 0.04 };
    window.dispatchEvent(e);
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


def open_page(browser, base, ua=CHROME_UA, url="?banor=vagval,kompass,vibration", init="", answer=True, shake=1.5, lag=0, ring=0):
    ctx = browser.new_context(
        user_agent=ua,
        viewport={"width": 412, "height": 915},
        device_scale_factor=2,
        service_workers="block",
        geolocation={"latitude": 59.38, "longitude": 13.5},
        permissions=["geolocation"],
    )
    ctx.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: errors.append(f"{r.status} {r.url}") if r.status >= 400 else None)
    phone = json.dumps({"answer": answer, "shake": shake, "lag": lag, "ring": ring})
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
