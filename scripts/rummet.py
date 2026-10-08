#!/usr/bin/env python3
"""Demi's door into the manuscript room (rummet/), for use from a session.

The room is where Henric (and later Liv) read, listen to and comment on
Glimt's manuscript. Demi takes part on the same terms as the others, as an
AI and marked as one: Demi can comment, reply, propose and write lore pages,
and never changes the manuscript, says yes or lays anything in. Nobody,
Demi included, can change someone else's post. This script is how Demi does
its part without the page.

    python3 scripts/rummet.py nytt                     # what is new since last time; questions to Demi first
    python3 scripts/rummet.py nytt --sedan 2026-10-08T06:00
    python3 scripts/rummet.py rader --episod 1 --scen 3
    python3 scripts/rummet.py kommentera --episod 1 --scen 3 --rad "Det är någon som går." --text "Kortare paus här?" --galler paus
    python3 scripts/rummet.py kommentera --episod 1 --scen 3 --text "Om hela scenen: ..."
    python3 scripts/rummet.py svara --pa <id> --text "..."
    python3 scripts/rummet.py foresla --episod 1 --scen 3 --rad "Det är någon som går." --text "Det går någon här."
    python3 scripts/rummet.py lore --titel "Slingan" --text -          # text from stdin
    python3 scripts/rummet.py lore --sida <id> --titel "Slingan" --text -   # change Demi's own page

--rad names a line by its words (or by the whole quote line with its tag);
if it stands more than once in the scene, add --n (0 is the first). A
proposal must be a line the manuscript can hold: the same tag and form.

Files and their format: ~/generalassistant/data/glimt-rummet/README.md.
Every write reads the file fresh, makes the change with the room's own code
(scripts/rummet_cli.mjs, through node) and writes with the portal's
write_file and the mtime just read, the same check and the same per-path lock
the room's page goes through. If the file changed in between, it starts over.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import secrets
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GA = Path("/home/henric/generalassistant")
CLI = REPO / "scripts" / "rummet_cli.mjs"
# More patient than the page (6): each try runs node between the read and the
# write, so a busy file can win over the script several times in a row.
FORSOK = 20
EPISODER = ("1", "2")
NAMN = {"henric": "Henric", "liv": "Liv", "demi": "Demi"}
GALLER = ("orden", "tempo", "paus", "ljud", "nar")


class Fel(Exception):
    pass


def files_api(rot: Path):
    """The portal's file module, with its write_file and lock."""
    src = Path(os.environ.get("RUMMET_FILES_PY") or GA / "scripts" / "dashboard" / "files.py")
    spec = importlib.util.spec_from_file_location("portal_files", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.ALLOWED_ROOTS = [rot.resolve()]
    return mod


def vagar(rot: Path, prov: bool) -> dict:
    """Where the room's files lie; the same places as rummet/data.js."""
    if prov:
        p = rot / "data" / "glimt-rummet" / "prov"
        return {
            "manus": lambda n: p / "manus" / f"episod-{n}.md",
            "rum": lambda n: p / f"episod-{n}.json",
            "lore": lambda: p / "lore.json",
            "sett": lambda: p / "demi-sett.json",
        }
    glimt = rot / "projects" / "motionstory" / "stories" / "glimt"
    d = rot / "data" / "glimt-rummet"
    return {
        "manus": lambda n: glimt / f"episod-{n}.md",
        "rum": lambda n: d / f"episod-{n}.json",
        "lore": lambda: d / "lore.json",
        "sett": lambda: d / "demi-sett.json",
    }


class Rum:
    def __init__(self, rot: Path, prov: bool):
        self.files = files_api(rot)
        self.p = vagar(rot, prov)

    def las(self, path: Path) -> tuple[str | None, float | None]:
        try:
            d = self.files.read_file(path)
        except FileNotFoundError:
            return None, None
        if d.get("binary") or d.get("too_large"):
            raise Fel(f"{path} går inte att läsa som text.")
        return d["content"], d["mtime"]

    def steg(self, data: dict) -> dict:
        r = subprocess.run(["node", str(CLI)], input=json.dumps(data), capture_output=True, text=True, check=False)
        try:
            ut = json.loads(r.stdout)
        except json.JSONDecodeError:
            raise Fel(f"rummet_cli.mjs svarade inte: {r.stderr.strip()[:400]}") from None
        if not ut.get("ok"):
            text = ut.get("fel") or "Något gick fel."
            if ut.get("nara"):
                text += "\nNärmast i scenen:\n" + "\n".join(f"  {x}" for x in ut["nara"])
            raise Fel(text)
        return ut

    def byt(self, path: Path, bygg) -> dict:
        """Read fresh, build the new text, write with the mtime just read.
        bygg(text or None) -> step result with "text"."""
        for _ in range(FORSOK):
            text, mtime = self.las(path)
            ut = bygg(text)
            try:
                # 0 never matches a real file: one that appeared in between is
                # a conflict, not overwritten.
                self.files.write_file(path, ut["text"], mtime if mtime is not None else 0)
                return ut
            except FileExistsError:
                time.sleep(0.05 + secrets.randbelow(200) / 1000)
        raise Fel("Filen ändras av någon annan just nu, gång på gång. Försök igen om en stund.")

    def manus(self, nr: str) -> str:
        text, _ = self.las(self.p["manus"](nr))
        if text is None:
            raise Fel(f"Manuset för episod {nr} finns inte.")
        return text


def iso(t: datetime) -> str:
    """The room's time format, as the page writes it (Date.toISOString)."""
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def nu() -> str:
    return iso(datetime.now(UTC))


def tolka_tid(s: str) -> str:
    """--sedan: an ISO time; without a zone it is Swedish local time."""
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        raise Fel(f"Tiden går inte att läsa: {s} (skriv t.ex. 2026-10-08T06:00)") from None
    return iso(t if t.tzinfo else t.astimezone())


# The room's times come from different clocks (a phone, a laptop, this
# machine). 'nytt' therefore looks a day further back than its mark and
# recognises what it already showed by key, not by time.
OVERLAPP = timedelta(days=1)


def las_markering(rum: Rum, path: Path) -> tuple[str, list[str], str]:
    """-> (since, keys already shown, a label for the output)."""
    text, _ = rum.las(path)
    if text:
        try:
            m = json.loads(text)
            t = datetime.fromisoformat(str(m["sett"]).replace("Z", "+00:00"))
            if not t.tzinfo:
                raise ValueError
            nycklar = [str(x) for x in (m.get("nycklar") or [])]
            return iso(t - OVERLAPP), nycklar, f"förra gången ({iso(t)[:16].replace('T', ' ')} UTC)"
        except (ValueError, KeyError, TypeError, AttributeError):
            print("Obs: markeringen för vad Demi redan sett gick inte att läsa; visar en vecka bakåt.", file=sys.stderr)
    return iso(datetime.now(UTC) - timedelta(days=7)), [], "en vecka bakåt"


def nytt_id() -> str:
    return f"{int(time.time() * 1000):x}-{secrets.token_hex(3)}"


def las_text(v: str) -> str:
    return sys.stdin.read() if v == "-" else v


def kort(s: str | None, n: int = 90) -> str:
    s = (s or "").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def var(p: dict | None) -> str:
    if not p:
        return ""
    if p.get("rad") is None:
        return f"scen {p['scen']}, hela scenen"
    tillagg = " (struken)" if p.get("struken") else ("" if p.get("finns", True) else " (står inte så längre)")
    return f"scen {p['scen']}, «{kort(p['rad'], 70)}»{tillagg}"


TYPER = {
    "kommentar": "kommenterade", "svar": "svarade", "klar": "markerade klar", "forslag": "föreslog",
    "ja": "sa ja till", "undan": "drog undan", "lore": "skrev loresidan", "lore-andrad": "ändrade loresidan",
    "manus:andrade": "ändrade i manus", "manus:lade-till": "lade till en replik", "manus:strok": "strök en replik",
    "manus:lade-tillbaka": "lade tillbaka en replik", "manus:satte-namn": "satte namn på en replik",
    "manus:lade-in-forslag": "lade in ett förslag i manus",
}


def skriv_nytt(ut: dict, sedan: str) -> None:  # sedan: a time or a label
    v = ut["vantar"]
    print(f"Väntar på svar från Demi: {len(v)}")
    for x in v:
        print(f"\n  [{x['id']}] episod {x['episod']}, {var(x['plats'])}")
        for t in x["trad"]:
            vem = NAMN.get(t["skrev"], t["skrev"])
            print(f"    {vem}{' (förslag)' if t['forslag'] else ''}: {kort(t['text'], 200)}")
        if not any(t["id"] == x["id"] for t in x["trad"]):
            print(f"    {NAMN.get(x['fran'], x['fran'])}: {kort(x['text'], 200)}")
        print(f"    svara: python3 scripts/rummet.py svara --pa {x['svaraPa']} --text \"...\"")
    h = ut["handelser"]
    print(f"\nNytt sedan {sedan}: {len(h)}")
    for x in h:
        vem = NAMN.get(x.get("vem"), x.get("vem") or "någon")
        vad = TYPER.get(x["typ"], x["typ"])
        rad = f"  {x['nar'][:16].replace('T', ' ')}  e{x['episod'] if 'episod' in x else '-'}  {vem} {vad}"
        if x["typ"].startswith("manus:"):
            rad += f", scen {x.get('scen')}: «{kort(x.get('efter') or x.get('fore'), 70)}»"
        elif x["typ"].startswith("lore"):
            rad += f" «{kort(x.get('titel'), 50)}» [{x['id']}]"
        else:
            rad += f" [{x['id']}]"
            if x.get("plats"):
                rad += f" {var(x['plats'])}"
            rad += f": {kort(x.get('text'), 120)}"
            if x.get("till") == "demi":
                rad += "  (till Demi)"
        print(rad)


def main() -> int:
    ap = argparse.ArgumentParser(description="Demi in the manuscript room: read what is new, post as Demi.")
    ap.add_argument("--rot", type=Path, default=GA, help=argparse.SUPPRESS)  # tests: a stand-in for ~/generalassistant
    ap.add_argument("--prov", action="store_true", help="the sandbox (data/glimt-rummet/prov), never the real room")
    sub = ap.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("nytt", help="what is new; questions to Demi first")
    n.add_argument("--sedan", help="ISO time; default: since the last 'nytt' (or a week)")
    n.add_argument("--behall", action="store_true", help="do not move the 'last seen' mark")
    n.add_argument("--json", action="store_true")

    r = sub.add_parser("rader", help="the lines of an episode, to name one with --rad")
    r.add_argument("--episod", required=True, choices=EPISODER)
    r.add_argument("--scen")

    for namn, hjalp in (("kommentera", "comment on a line or a scene"), ("foresla", "propose new words for a line, or something for a scene")):
        c = sub.add_parser(namn, help=hjalp)
        c.add_argument("--episod", required=True, choices=EPISODER)
        c.add_argument("--scen", required=True)
        c.add_argument("--rad", help="the line's words; leave out for the whole scene")
        c.add_argument("--n", type=int, help="which one, if the line stands more than once (0 is the first)")
        c.add_argument("--text", required=True, help="'-' reads it from stdin")
        if namn == "kommentera":
            c.add_argument("--galler", choices=GALLER)

    s = sub.add_parser("svara", help="reply in a thread")
    s.add_argument("--pa", required=True, help="id of the comment or proposal")
    s.add_argument("--episod", choices=EPISODER)
    s.add_argument("--text", required=True)

    lo = sub.add_parser("lore", help="write a lore page, or change one of Demi's own")
    lo.add_argument("--sida", help="id of Demi's page to change")
    lo.add_argument("--titel", required=True)
    lo.add_argument("--text", required=True)

    a = ap.parse_args()
    rum = Rum(a.rot, a.prov)
    try:
        if a.cmd == "nytt":
            sett_path = rum.p["sett"]()
            if a.sedan:
                sedan, sedda, etikett = tolka_tid(a.sedan), [], tolka_tid(a.sedan)
            else:
                sedan, sedda, etikett = las_markering(rum, sett_path)
            nar = nu()
            episoder = {}
            for e in EPISODER:
                episoder[e] = {"rum": rum.las(rum.p["rum"](e))[0], "manus": rum.las(rum.p["manus"](e))[0]}
            ut = rum.steg({"op": "nytt", "episoder": episoder, "lore": rum.las(rum.p["lore"]())[0], "sedan": sedan, "sedda": sedda})
            if a.json:
                print(json.dumps({"sedan": sedan, "vantar": ut["vantar"], "handelser": ut["handelser"]}, ensure_ascii=False, indent=1))
            else:
                skriv_nytt(ut, etikett)
            if not a.sedan and not a.behall:
                rum.files.write_file(sett_path, json.dumps({"sett": nar, "nycklar": ut["nycklar"]}) + "\n", None)
            return 0

        if a.cmd == "rader":
            ut = rum.steg({"op": "rader", "manus": rum.manus(a.episod)})
            for sc in ut["scener"]:
                if a.scen and sc["scen"] != a.scen:
                    continue
                print(f"## {sc['scen']}. {sc['titel']}")
                for x in sc["rader"]:
                    print(f"  {'[n=' + str(x['n']) + '] ' if x['n'] else ''}{x['text']}")
            return 0

        if a.cmd in ("kommentera", "foresla"):
            text = las_text(a.text)
            if a.cmd == "foresla" and a.text == "-" and text.endswith("\n"):
                # A line is one line: the newline echo or a heredoc ends with is not part of it.
                text = text[:-1]
            manus = rum.manus(a.episod)
            ut = rum.byt(rum.p["rum"](a.episod), lambda t: rum.steg({
                "op": a.cmd, "rum": t, "manus": manus, "episod": a.episod, "scen": a.scen, "rad": a.rad, "n": a.n,
                "text": text, "galler": getattr(a, "galler", None), "id": nytt_id(), "nar": nu(),
            }))
            slag = "kommentar" if a.cmd == "kommentera" else "förslag"
            print(f"Postat som Demi: {slag} {ut['id']}, episod {a.episod}, {var({'scen': ut['mal']['scen'], 'rad': ut['mal']['text']})}")
            return 0

        if a.cmd == "svara":
            text = las_text(a.text)
            hittad = None
            for e in ([a.episod] if a.episod else EPISODER):
                t, _ = rum.las(rum.p["rum"](e))
                if not t:
                    continue
                try:
                    d = json.loads(t)
                    poster = list(d.get("kommentarer") or []) + list(d.get("forslag") or [])
                except (ValueError, AttributeError, TypeError):
                    raise Fel(f"Anteckningarna för episod {e} går inte att läsa.") from None
                if any(isinstance(x, dict) and x.get("id") == a.pa for x in poster):
                    hittad = e
                    break
            if not hittad:
                raise Fel(f"Hittar inget inlägg med id {a.pa}.")
            ut = rum.byt(rum.p["rum"](hittad), lambda t: rum.steg({
                "op": "svara", "rum": t, "episod": hittad, "svarPa": a.pa, "text": text, "id": nytt_id(), "nar": nu(),
            }))
            print(f"Postat som Demi: svar {ut['id']} i tråden {ut['svarPa']}, episod {hittad}")
            # The end of the thread as it stands now: a question that came in
            # after Demi read the thread shows here, above Demi's answer.
            print("Tråden nu:")
            for t in ut["trad"][-6:]:
                vem = NAMN.get(t.get("skrev"), t.get("skrev") or "?")
                eget = "  <- ditt svar" if t.get("id") == ut["id"] else ("  (till Demi)" if t.get("till") == "demi" else "")
                print(f"  {vem}: {kort(str(t.get('text') or ''), 160)}{eget}")
            return 0

        if a.cmd == "lore":
            text = las_text(a.text)
            if a.sida:
                ut = rum.byt(rum.p["lore"](), lambda t: rum.steg({"op": "lore-andra", "lore": t, "sida": a.sida, "titel": a.titel, "text": text, "nar": nu()}))
                print(f"Ändrat Demis loresida {ut['id']}")
            else:
                ut = rum.byt(rum.p["lore"](), lambda t: rum.steg({"op": "lore-ny", "lore": t, "titel": a.titel, "text": text, "id": nytt_id(), "nar": nu()}))
                print(f"Postat som Demi: loresida {ut['id']} «{a.titel}»")
            return 0
    except Fel as e:
        print(f"Fel: {e}", file=sys.stderr)
        return 2
    except (OSError, UnicodeError) as e:
        print(f"Fel: {e}", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
