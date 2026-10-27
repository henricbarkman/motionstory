#!/usr/bin/env python3
"""The service worker in a real browser, with the caches earlier copies left.

    python3 scripts/test_worker.py

The private copies sit side by side on one origin (the portal) and share its
CacheStorage. This serves this checkout as one such copy under /en/ and puts
older caches beside it, the way earlier builds left them: this copy's own
(named the old way, without a scope, with a stale line in it), the public
site's, and another copy's, plus one that is not Glimt's at all and holds the
same stale line. Then it opens the English page, lets the worker take over,
and asks for the line.

The other browser tests block service workers; this one is the only test of
the worker.
"""
import functools
import http.server
import sys
import tempfile
import threading
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Install deps: pip install playwright && playwright install chromium")

REPO = Path(__file__).resolve().parents[1]
LINE = "/en/audio/glimt/vega/glimt-e1en/s0-1.mp3"
OLD_OWN = "motionstory-v40-privat-abcabc00"     # this copy's, before caches had a scope
OLD_PUBLIC = "motionstory-v40"                  # the public site's
OTHER = "motionstory-v40-privat-5e5e5e5e"       # another copy's, under /sv/
# Not the worker's to clear, and holding this copy's line all the same: what
# keeps it from answering is that lookups go to the worker's own cache, not
# the clearing (which takes the two above away before they could answer).
FOREIGN = "ett-annat-verktyg"

out = []


def check(ok, what):
    out.append(("ok  " if ok else "FAIL") + "  " + what)


def main():
    root = Path(tempfile.mkdtemp(prefix="glimt-worker-test-"))
    (root / "en").symlink_to(REPO)
    (root / "blank.html").write_text("<!doctype html><title>blank</title>")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.func.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context().new_page()
        page.goto(f"{base}/blank.html")
        page.evaluate("""async ([base, line, own, pub, other, foreign]) => {
          await (await caches.open(foreign)).put(base + line, new Response('STALE'));
          await (await caches.open(own)).put(base + line, new Response('STALE'));
          await (await caches.open(pub)).put(base + line, new Response('STALE'));
          await (await caches.open(other)).put(base + '/sv/audio/glimt/vega/glimt-e1/s0-1.mp3', new Response('SV'));
        }""", [base, LINE, OLD_OWN, OLD_PUBLIC, OTHER, FOREIGN])
        page.goto(f"{base}/en/glimt/index.html?kapitel=episode1en&sim")
        page.wait_for_function("!!navigator.serviceWorker.controller", timeout=60000)
        head = page.evaluate("l => fetch(l).then(r => r.arrayBuffer()).then(b => String.fromCharCode(...new Uint8Array(b).slice(0, 5)))", LINE)
        check(head.startswith("ID3"), f"no other cache answers for this copy: the line is the file ({head!r})")
        page.wait_for_timeout(1000)
        keys = page.evaluate("caches.keys()")
        check(OLD_OWN not in keys and OLD_PUBLIC not in keys, f"and the worker clears this copy's older caches ({keys})")
        check(OTHER in keys and FOREIGN in keys, "another copy's old cache, and a cache that is not Glimt's, are left alone")
        check(any(k.endswith(f" {base}/en/") for k in keys), "its own cache is named with its scope")
        browser.close()
    server.shutdown()
    (root / "en").unlink()          # the link, never what it points to
    (root / "blank.html").unlink()
    root.rmdir()
    print("\n".join(out))
    sys.exit(1 if any(line.startswith("FAIL") for line in out) else 0)


if __name__ == "__main__":
    main()
