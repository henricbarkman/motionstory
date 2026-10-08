#!/usr/bin/env python3
"""Demi's door into the manuscript room (rummet/), for use from a session.

The room is where Henric and Liv write Glimt: the episodes, the world book,
the mechanics catalogue and the lore pages. Everyone can change everything.
Demi takes part on the same terms, as an AI and marked as one, and every
change made here is recorded as Demi's in the room's history.

Demi's own rule (data/glimt-rummet/README.md, not a lock in the code):
comment and propose by default; change text directly (andra, lagg-till,
stryk) only when Henric or Liv asked for it.

    python3 scripts/rummet.py nytt                         # new mechanics and questions to Demi first, then what is new
    python3 scripts/rummet.py nytt --sedan 2026-10-08T06:00
    python3 scripts/rummet.py rader --dok 1 --scen 3       # paragraphs with their ids
    python3 scripts/rummet.py kommentera --dok 1 --stycke <id> --text "Kortare paus här?"
    python3 scripts/rummet.py kommentera --dok 1 --scen 3 --rad "Det är någon som går." --text "..." --galler paus
    python3 scripts/rummet.py foresla --dok 1 --stycke <id> --text "Det går någon här."
    python3 scripts/rummet.py svara --pa <id> --text "..."
    python3 scripts/rummet.py andra --dok 1 --stycke <id> --text "Ny lydelse."            # only when asked
    python3 scripts/rummet.py lagg-till --dok 1 --efter <id> --typ replik --text "..."      # only when asked
    python3 scripts/rummet.py stryk --dok 1 --stycke <id>                                   # only when asked
    python3 scripts/rummet.py lore --titel "Slingan" --text -                               # a new lore page, text from stdin

--dok is 1, 2, varld, mekaniker or lore:<id> (--episod N still works). A
paragraph is named by --stycke (its id, from 'rader'), or by --rad (its words,
or the whole line as it stands in the file) with --scen to narrow it and --n
when it stands more than once; --scen alone is the scene's heading. --text is
what the room shows (no "> " and no "**"); with --md it is a whole md line.

Files and their format: ~/generalassistant/data/glimt-rummet/README.md.
The work itself is done by scripts/rummet_cli.mjs with the room's own code
(rummet/lager.js): it reads the file fresh, merges per paragraph and writes
with the version just read. Every read and write goes through the portal's
read_file and write_file, the same mtime check and lock the page goes through.
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
EPISODER = ("1", "2")
DOKUMENT = (*EPISODER, "varld", "mekaniker")
NAMN = {"henric": "Henric", "liv": "Liv", "demi": "Demi"}
GALLER = ("orden", "tempo", "paus", "ljud", "nar")
TYPER = ("scen", "mekanik", "replik", "regi", "variant", "gren", "anteckning", "stycke", "rubrik", "punkt")


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


def vagar(rot: Path, prov: bool):
    """plats (as rummet/data.js names it) -> path. The same places as data.js."""
    if prov:
        p = rot / "data" / "glimt-rummet" / "prov"
        manus, rum, held = p / "manus", p, p / "manus" / "held-lore.md"
    else:
        manus = rot / "projects" / "motionstory" / "stories" / "glimt"
        rum = rot / "data" / "glimt-rummet"
        held = rot / "projects" / "held" / "universe" / "LORE.md"

    def filnamn(n: str) -> str:
        return f"episod-{n}" if n in EPISODER else n

    def sti(plats: str) -> Path:
        slag, _, n = plats.partition(":")
        if slag in ("manus", "ljud") and n in EPISODER:
            return manus / f"episod-{n}.{'md' if slag == 'manus' else 'json'}"
        if slag in ("varld", "mekaniker") and not n:
            return manus / f"{slag}.md"
        if slag == "held" and not n:
            return held
        if slag == "rum" and n in DOKUMENT:
            return rum / f"{filnamn(n)}.json"
        if slag == "grund" and n in DOKUMENT:
            return rum / "grund" / f"{filnamn(n)}.json"
        if slag in ("lore", "installningar") and not n:
            return rum / f"{slag}.json"
        raise Fel(f"Okänd plats: {plats}")

    return sti, rum


class Rum:
    def __init__(self, rot: Path, prov: bool):
        self.files = files_api(rot)
        self.prov = prov
        self.sti, self.mapp = vagar(rot, prov)
        self.sett = self.mapp / "demi-sett.json"
        # Notes that could not be written yet (the page keeps these in the
        # browser); sent first next time.
        self.vantande = self.mapp / "demi-vantande.json"

    def las(self, path: Path) -> tuple[str | None, float | None]:
        try:
            d = self.files.read_file(path)
        except FileNotFoundError:
            return None, None
        if d.get("binary") or d.get("too_large"):
            raise Fel(f"{path} går inte att läsa som text.")
        return d["content"], d["mtime"]

    def svar(self, m: dict) -> dict:
        """One request from rummet_cli.mjs, answered with the portal's functions."""
        try:
            if "las" in m:
                text, mtime = self.las(self.sti(m["las"]))
                return {"saknas": True} if text is None else {"text": text, "version": mtime}
            if "skriv" in m:
                path = self.sti(m["skriv"])
                v = m.get("version")
                try:
                    # 0 never matches a real file: one that appeared in between
                    # is a conflict, not overwritten.
                    w = self.files.write_file(path, m["text"], v if v is not None else 0)
                except FileExistsError:
                    return {"krock": True}
                return {"version": w["mtime"]}
        except Fel as e:
            return {"fel": str(e)}
        except (OSError, ValueError) as e:
            return {"fel": f"{type(e).__name__}: {e}"}
        return {"fel": "Okänd fråga."}

    def steg(self, uppdrag: dict) -> dict:
        """Run one step in rummet_cli.mjs, answering its reads and writes."""
        lagring, _ = self.las(self.vantande)
        try:
            uppdrag["lagring"] = json.loads(lagring) if lagring else {}
        except ValueError:
            uppdrag["lagring"] = {}
        uppdrag["prov"] = self.prov
        p = subprocess.Popen(["node", str(CLI)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        assert p.stdin and p.stdout
        p.stdin.write(json.dumps({"uppdrag": uppdrag}) + "\n")
        p.stdin.flush()
        ut = None
        for rad in p.stdout:
            if not rad.strip():
                continue
            m = json.loads(rad)
            if "rpc" in m:
                p.stdin.write(json.dumps({"rpc": m["rpc"], **self.svar(m)}) + "\n")
                p.stdin.flush()
                continue
            ut = m
            break
        try:
            p.stdin.close()
        except OSError:
            pass
        p.wait(timeout=30)
        if ut is None:
            raise Fel(f"rummet_cli.mjs svarade inte: {(p.stderr.read() if p.stderr else '').strip()[:400]}")
        if "fel" in ut:
            self.spara_vantande(uppdrag["lagring"], ut.get("lagring"))
            text = ut.get("fel") or "Något gick fel."
            if ut.get("nara"):
                text += "\nNärmast:\n" + "\n".join(f"  {x}" for x in ut["nara"])
            raise Fel(text)
        klart = ut["klart"]
        self.spara_vantande(uppdrag["lagring"], klart.pop("lagring", None))
        return klart

    def spara_vantande(self, fore: dict, efter: dict | None) -> None:
        """Write what still waits, keeping what another rummet.py put there meanwhile.

        Each value is a list of notes with ids, and sending a note twice does
        nothing: a note another process added since this one read the file is
        kept, and one this process sent is taken out.
        """
        if efter is None or not (efter or fore):
            return
        for _ in range(5):
            text, mtime = self.las(self.vantande)
            try:
                nu_ = json.loads(text) if text else {}
            except ValueError:
                nu_ = {}
            ut = dict(efter)
            for k, v in nu_.items():
                if "|osparat|" in k or v == fore.get(k):
                    continue
                andras = [x for x in lista(v) if x not in lista(fore.get(k))]
                egna = lista(ut.get(k))
                har = {x.get("id") for x in egna if isinstance(x, dict)}
                nya = [x for x in andras if not (isinstance(x, dict) and x.get("id") in har)]
                if nya:
                    ut[k] = json.dumps(nya + egna, ensure_ascii=False)
            if ut == nu_:
                return
            try:
                self.files.write_file(self.vantande, json.dumps(ut, ensure_ascii=False) + "\n", mtime if mtime is not None else 0)
                return
            except FileExistsError:
                continue
        raise Fel("Det gick inte att spara det som väntar (demi-vantande.json ändrades hela tiden). Kör kommandot igen.")


def lista(v: str | None) -> list:
    """A waiting list as the room's code stores it: a JSON list in a string."""
    try:
        x = json.loads(v) if v else []
    except ValueError:
        return []
    return x if isinstance(x, list) else []


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


def las_markering(rum: Rum) -> tuple[str, list[str], str]:
    """-> (since, keys already shown, a label for the output)."""
    text, _ = rum.las(rum.sett)
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
    if v != "-":
        return v
    text = sys.stdin.read()
    # A paragraph is one line: the newline echo or a heredoc ends with is not part of it.
    return text[:-1] if text.endswith("\n") else text


def kort(s: str | None, n: int = 90) -> str:
    s = (s or "").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def doknamn(d: str) -> str:
    if d in EPISODER:
        return f"episod {d}"
    return {"varld": "världsboken", "mekaniker": "katalogen"}.get(d, f"loresidan {d[5:]}" if d.startswith("lore:") else d)


def var(x: dict) -> str:
    plats = doknamn(x["dok"])
    if x.get("scen"):
        plats += f", scen {x['scen']}"
    if x.get("borta"):
        return f"{plats}, ett stycke som är borttaget"
    if x.get("text") is not None:
        plats += f", «{kort(x['text'], 70)}»"
    return plats


SLAG = {
    "kommentar": "kommenterade", "svar": "svarade", "forslag": "föreslog", "andrade": "ändrade", "skrev": "skrev",
    "strok": "tog bort", "tillbaka": "tog tillbaka", "krock": "ändrade samtidigt", "lore": "skrev loresidan",
    "lore-titel": "bytte titel på loresidan", "lore-borta": "tog bort loresidan",
}


def skriv_nytt(ut: dict, sedan: str) -> None:
    v = ut["vantar"]
    print(f"Väntar på Demi: {len(v)}")
    for x in v:
        if x["slag"] == "ny-mekanik":
            print(f"\n  Ny mekanik, {var(x)}")
            print(f"    svara i en kommentar vid raden: python3 scripts/rummet.py kommentera --dok {x['dok']} --stycke {x['stycke']} --text \"...\"")
            continue
        print(f"\n  [{x['id']}] {var(x)}")
        for t in x["trad"]:
            vem = NAMN.get(t["skrev"], t["skrev"])
            print(f"    {vem}{' (förslag)' if t.get('forslag') else ''}: {kort(t['text'], 200)}")
        print(f"    svara: python3 scripts/rummet.py svara --pa {x['svaraPa']} --text \"...\"")
    h = ut["handelser"]
    print(f"\nNytt sedan {sedan}: {len(h)}")
    for x in h:
        vem = NAMN.get(x.get("vem"), x.get("vem") or "någon")
        vad = SLAG.get(x["slag"], x["slag"])
        rad = f"  {str(x['nar'])[:16].replace('T', ' ')}  {vem} {vad}"
        if x["slag"].startswith("lore"):
            rad += f" «{kort(x.get('titel'), 50)}» [{x['id']}]"
        else:
            rad += f" i {var({**x['plats'], 'dok': x['dok']})}"
            if x["slag"] in ("kommentar", "svar", "forslag"):
                rad += f" [{x['id']}]: {kort(x.get('text'), 120)}"
                if x.get("till") == "demi":
                    rad += "  (till Demi)"
            elif x["slag"] in ("andrade", "skrev", "tillbaka", "krock") and x.get("text") is not None:
                rad += f": «{kort(x.get('text'), 100)}»"
        print(rad)


def lagg_valj(c: argparse.ArgumentParser, *, krav: bool = True) -> None:
    c.add_argument("--dok", help="1, 2, varld, mekaniker or lore:<id>")
    c.add_argument("--episod", choices=EPISODER, help=argparse.SUPPRESS)
    c.add_argument("--stycke", help="the paragraph's id (see 'rader')")
    c.add_argument("--rad", help="the paragraph's words, or the whole line as it stands in the file")
    c.add_argument("--scen", help="narrow --rad to a scene; alone: the scene's heading")
    c.add_argument("--n", type=int, help="which one, if it stands more than once (0 is the first)")


def lagg_text(c: argparse.ArgumentParser) -> None:
    c.add_argument("--text", required=True, help="'-' reads it from stdin")
    c.add_argument("--typ", choices=TYPER)
    c.add_argument("--etikett", help="a variant's label")
    c.add_argument("--niva", type=int, help="a heading's level")
    c.add_argument("--md", action="store_true", help="--text is a whole md line")


def dok_av(a: argparse.Namespace) -> str:
    d = a.dok or a.episod
    if not d:
        raise Fel("Säg vilket dokument: --dok 1, 2, varld, mekaniker eller lore:<id>.")
    return d


def main() -> int:
    ap = argparse.ArgumentParser(description="Demi in the manuscript room: read what is new, comment, propose, and change text when asked.")
    ap.add_argument("--rot", type=Path, default=GA, help=argparse.SUPPRESS)  # tests: a stand-in for ~/generalassistant
    ap.add_argument("--prov", action="store_true", help="the sandbox (data/glimt-rummet/prov), never the real room")
    sub = ap.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("nytt", help="new mechanics and questions to Demi first, then what is new")
    n.add_argument("--sedan", help="ISO time; default: since the last 'nytt' (or a week)")
    n.add_argument("--behall", action="store_true", help="do not move the 'last seen' mark")
    n.add_argument("--json", action="store_true")

    r = sub.add_parser("rader", help="a document's paragraphs with their ids")
    r.add_argument("--dok")
    r.add_argument("--episod", choices=EPISODER, help=argparse.SUPPRESS)
    r.add_argument("--scen")

    k = sub.add_parser("kommentera", help="comment on a paragraph")
    lagg_valj(k)
    k.add_argument("--text", required=True, help="'-' reads it from stdin")
    k.add_argument("--galler", choices=GALLER)

    f = sub.add_parser("foresla", help="propose new words for a paragraph")
    lagg_valj(f)
    lagg_text(f)

    s = sub.add_parser("svara", help="reply in a thread")
    s.add_argument("--pa", required=True, help="id of the comment or proposal")
    s.add_argument("--dok")
    s.add_argument("--episod", choices=EPISODER, help=argparse.SUPPRESS)
    s.add_argument("--text", required=True)

    an = sub.add_parser("andra", help="change a paragraph's text (only when asked)")
    lagg_valj(an)
    lagg_text(an)

    lt = sub.add_parser("lagg-till", help="add a paragraph (only when asked)")
    lt.add_argument("--dok")
    lt.add_argument("--episod", choices=EPISODER, help=argparse.SUPPRESS)
    lt.add_argument("--efter", help="the id of the paragraph it comes after")
    lt.add_argument("--efter-rad", help="the words of the paragraph it comes after")
    lt.add_argument("--scen", help="narrow --efter-rad to a scene; alone: last in the scene")
    lt.add_argument("--n", type=int)
    lagg_text(lt)

    st = sub.add_parser("stryk", help="remove a paragraph (only when asked); it stays in the history")
    lagg_valj(st)

    lo = sub.add_parser("lore", help="write a new lore page")
    lo.add_argument("--titel", required=True)
    lo.add_argument("--text", default="")

    a = ap.parse_args()
    rum = Rum(a.rot, a.prov)
    try:
        if a.cmd == "nytt":
            if a.sedan:
                sedan, sedda, etikett = tolka_tid(a.sedan), [], tolka_tid(a.sedan)
            else:
                sedan, sedda, etikett = las_markering(rum)
            nar = nu()
            ut = rum.steg({"op": "nytt", "sedan": sedan, "sedda": sedda})
            if a.json:
                print(json.dumps({"sedan": sedan, "vantar": ut["vantar"], "handelser": ut["handelser"]}, ensure_ascii=False, indent=1))
            else:
                skriv_nytt(ut, etikett)
            if not a.sedan and not a.behall:
                rum.files.write_file(rum.sett, json.dumps({"sett": nar, "nycklar": ut["nycklar"]}) + "\n", None)
            return 0

        if a.cmd == "rader":
            d = dok_av(a)
            ut = rum.steg({"op": "rader", "dok": d})
            scen = None
            for x in ut["stycken"]:
                if a.scen and x["scen"] != a.scen:
                    continue
                if x["iScen"] and x["scen"] != scen:
                    scen = x["scen"]
                    print(f"## scen {scen}")
                typ = x["typ"] + (f" [{x['etikett']}]" if x.get("etikett") else "")
                print(f"  {x['id']}  {typ:<12} {x['text'] if x['typ'] != 'linje' else '---'}")
            return 0

        if a.cmd == "kommentera":
            ut = rum.steg({"op": "kommentera", "dok": dok_av(a), "stycke": a.stycke, "rad": a.rad, "scen": a.scen, "n": a.n,
                           "text": las_text(a.text), "galler": a.galler, "id": nytt_id(), "nar": nu()})
            print(f"Kommenterat som Demi: {ut['id']} i {doknamn(ut['dok'])}, «{kort(ut['text'], 70)}»")
            return 0

        if a.cmd == "foresla":
            ut = rum.steg({"op": "foresla", "dok": dok_av(a), "stycke": a.stycke, "rad": a.rad, "scen": a.scen, "n": a.n,
                           "text": las_text(a.text), "typ": a.typ, "etikett": a.etikett, "niva": a.niva, "md": a.md, "id": nytt_id(), "nar": nu()})
            print(f"Föreslaget som Demi: {ut['id']} i {doknamn(ut['dok'])}, vid «{kort(ut['text'], 70)}»")
            return 0

        if a.cmd == "svara":
            ut = rum.steg({"op": "svara", "dok": a.dok or a.episod, "pa": a.pa, "text": las_text(a.text), "id": nytt_id(), "nar": nu()})
            print(f"Svarat som Demi: {ut['id']} i tråden {ut['svarPa']}, {doknamn(ut['dok'])}")
            # The end of the thread as it stands now: a question that came in
            # after Demi read the thread shows here, above Demi's answer.
            print("Tråden nu:")
            for t in ut["trad"][-6:]:
                vem = NAMN.get(t.get("skrev"), t.get("skrev") or "?")
                eget = "  <- ditt svar" if t.get("id") == ut["id"] else ("  (till Demi)" if t.get("till") == "demi" else "")
                print(f"  {vem}: {kort(str(t.get('text') or ''), 160)}{eget}")
            return 0

        if a.cmd in ("andra", "lagg-till", "stryk"):
            u = {"op": a.cmd, "dok": dok_av(a), "scen": a.scen, "n": a.n, "nar": nu()}
            if a.cmd == "lagg-till":
                u.update({"efter": a.efter, "efterRad": a.efter_rad})
            else:
                u.update({"stycke": a.stycke, "rad": a.rad})
            if a.cmd != "stryk":
                u.update({"text": las_text(a.text), "typ": a.typ, "etikett": a.etikett, "niva": a.niva, "md": a.md})
            ut = rum.steg(u)
            vad = {"andra": "Ändrat", "lagg-till": "Lagt till", "stryk": "Tagit bort"}[a.cmd]
            print(f"{vad} som Demi i {doknamn(ut['dok'])}: [{ut['id']}] «{kort(ut['text'] if ut['text'] is not None else ut['fore'], 90)}»")
            if ut.get("trangde"):
                vem = NAMN.get(ut["trangde"].get("vem"), ut["trangde"].get("vem") or "någon")
                print(f"Obs: {vem} ändrade samma stycke samtidigt. Din text står i manuset; deras version «{kort(ut['trangde'].get('text'), 90)}» ligger som en krock vid stycket i rummet, där vem som helst kan välja.", file=sys.stderr)
            if ut.get("notVantar"):
                print(f"Obs: texten är sparad, men anteckningen om att det var Demi väntar och skickas nästa gång ({ut.get('notFel')}).", file=sys.stderr)
            return 0

        if a.cmd == "lore":
            ut = rum.steg({"op": "lore-ny", "titel": a.titel, "text": las_text(a.text) if a.text else "", "nar": nu()})
            print(f"Skrivit loresidan {ut['id']} «{a.titel}» som Demi")
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
