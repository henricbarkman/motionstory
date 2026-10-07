#!/usr/bin/env python3
"""Render Glimt episode drafts as one reading page for Henric.

The drafts live as markdown in stories/glimt/episod-N.md. Henric reads in the
portal, not in the repo, so this turns them into a single HTML page in the same
look as the plan page (data/uploads/glimt-plan/ in generalassistant).

Usage:
    python3 scripts/manus_sida.py OUT.html stories/glimt/episod-1.md [episod-2.md ...]

Needs the `markdown` package (generalassistant's .venv has it).
"""
from __future__ import annotations

import html
import re
import sys
from datetime import date
from pathlib import Path

import markdown

MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli",
          "augusti", "september", "oktober", "november", "december"]

# Blocks in the notes before the first scene that stay visible; the rest folds
# into a <details> so the story starts within one screen.
VISIBLE_NOTES = ("**Vad episoden ska göra:**", "**Bågen:**", "**Riktlängd:**")

TITLE_RE = re.compile(r"^# Glimt, episod (\d+): (.+)$")


def hard_breaks(md: str) -> str:
    """Keep the line structure inside blockquotes (one line per variant or cue).

    Also opens a list that follows a paragraph line directly: GitHub renders
    that as a list, python-markdown needs the blank line.
    """
    lines = md.split("\n")
    out = []
    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        prev = lines[i - 1] if i else ""
        if line.startswith("- ") and prev.strip() and not prev.startswith("- "):
            out.append("")
        if line.startswith("> ") and line.strip() != ">" and nxt.startswith("> ") and nxt.strip() != ">":
            line = line.rstrip() + "  "
        out.append(line)
    return "\n".join(out)


def to_html(md: str) -> str:
    return markdown.markdown(hard_breaks(md), extensions=["tables"])


def style_manus(match: re.Match) -> str:
    s = match.group(1)
    # Order matters: quotes first, while the markup still has no attributes.
    s = re.sub(r'"([^"<>]+)"', r"<span class='annan'>”\1”</span>", s)
    s = re.sub(r"\(([^()]*)\)", r"<span class='regi'>(\1)</span>", s)
    s = re.sub(r"(<p>|<br />\n?)\[([^\]<]+)\] ", r"\1<span class='var'>\2</span> ", s)
    s = re.sub(r"<strong>([^<]*:)</strong>", r"<span class='gren'>\1</span>", s)
    s = re.sub(r"(<p>|<br />\n?)<em>([^<]*:)</em>", r"\1<span class='gren gren2'>\2</span>", s)
    return f"<blockquote class='manus'>{s}</blockquote>"


def style_body(body: str) -> str:
    body = re.sub(r"<blockquote>(.*?)</blockquote>", style_manus, body, flags=re.S)
    body = re.sub(
        r"<h2>(\d+)\. (.*?)</h2>",
        r"<h3 class='scen'><span class='nr'>\1</span>\2</h3>",
        body,
    )
    body = re.sub(r"<h2>(.*?)</h2>", r"<h3 class='bilaga'>\1</h3>", body)

    def trigger(m: re.Match) -> str:
        text = m.group(1)
        return f"<p class='trigger'><b>När</b>{text[:1].upper()}{text[1:]}</p>"

    body = re.sub(r"<p><em>Trigger: (.*?)</em></p>", trigger, body, flags=re.S)
    body = re.sub(r"<p><em>((?:(?!</p>).)*?)</em></p>", r"<p class='not'>\1</p>", body, flags=re.S)
    body = re.sub(r"<p><strong>([^<]*:)</strong></p>", r"<p class='gren-rubrik'>\1</p>", body)
    body = body.replace("<table>", "<div class='tabell'><table>").replace("</table>", "</table></div>")
    return body


def render_episode(path: Path) -> tuple[str, str, str]:
    """Return (number, title, section html) for one draft file."""
    text = path.read_text(encoding="utf-8")
    first, _, rest = text.partition("\n")
    m = TITLE_RE.match(first.strip())
    if not m:
        raise SystemExit(f"{path}: first line must be '# Glimt, episod N: Titel'")
    number, title = m.group(1), m.group(2)

    parts = re.split(r"^---\s*$", rest, flags=re.M)
    if len(parts) != 3:
        raise SystemExit(f"{path}: expected notes, scenes and appendix separated by two '---' lines")
    notes, scenes, appendix = parts

    visible, folded = [], []
    for block in re.split(r"\n\s*\n", notes.strip()):
        if not visible and not block.startswith("**"):
            visible.append(block)  # the opening line: draft number and date
        elif block.startswith(VISIBLE_NOTES):
            visible.append(block)
        else:
            folded.append(block)

    section = [
        f"<section class='episod' id='episod-{number}'>",
        f"<h2>Episod {number}</h2>",
        f"<p class='ep-titel'>{html.escape(title)}</p>",
        f"<div class='om'>{to_html(chr(10).join(b + chr(10) for b in visible))}</div>",
    ]
    if folded:
        section.append(
            "<details class='bakom'><summary>Logiken, rösterna och varianterna bakom</summary>"
            f"{to_html(chr(10).join(b + chr(10) for b in folded))}</details>"
        )
    section.append(style_body(to_html(scenes)))
    section.append(f"<div class='bilagor'>{style_body(to_html(appendix))}</div>")
    section.append("</section>")
    return number, title, "\n".join(section)


PAGE = """<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Glimt: utkast till episoderna</title>
<meta name="theme-color" content="#152E43">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..700;1,400&family=Spectral:ital,wght@1,300;1,400&display=swap" rel="stylesheet">
<style>
  :root {
    --natt: #0d1c2b; --marin: #152E43; --lila: #271240; --sken: #A4DADB;
    --yta: rgba(164, 218, 219, 0.07); --kant: rgba(164, 218, 219, 0.17);
    --kant-stark: rgba(164, 218, 219, 0.32);
    --text: #E4F6F5; --dov: #9dbcc1; --svag: #7d9ea4;
    --kontakt: #48FEC8; --replika: #ecc98e;
    --sans: 'Open Sans', system-ui, sans-serif;
    --serif: 'Spectral', Georgia, serif;
  }
  * { box-sizing: border-box; }
  html { background: var(--natt); scroll-behavior: smooth; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  body {
    margin: 0; color: var(--text); font-family: var(--sans);
    font-size: 1.0625rem; line-height: 1.6; -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      linear-gradient(90deg, rgba(39, 18, 64, 0.9) 0%, rgba(39, 18, 64, 0) 32%),
      linear-gradient(270deg, rgba(7, 15, 24, 0.85) 0%, rgba(7, 15, 24, 0) 24%),
      linear-gradient(180deg, var(--marin) 0%, var(--natt) 85%);
  }
  a { color: var(--sken); text-underline-offset: 0.2em; }
  :focus-visible { outline: 2px solid var(--kontakt); outline-offset: 3px; border-radius: 2px; }
  .wrap { overflow: clip; }
  header, main { max-width: 44rem; margin: 0 auto; padding: 0 1.25rem; }
  header { position: relative; z-index: 0; padding-top: 3rem; padding-bottom: 1rem; }
  header::before {
    content: ''; position: absolute; z-index: -1; pointer-events: none;
    left: 28%; top: 1.5rem; width: min(30rem, 78vw); height: 13rem;
    background: var(--sken); opacity: 0.2; border-radius: 2.5rem;
    transform: rotate(-17deg); filter: blur(46px);
  }
  .held { display: block; width: 4.6rem; margin: 0 0 2.6rem; opacity: 0.92; }
  .held img { display: block; width: 100%; height: auto; }
  h1 {
    font-weight: 300; font-size: clamp(1.35rem, 6vw, 3.2rem); line-height: 1.1;
    letter-spacing: 0.3em; text-transform: uppercase; margin: 0 0 1.2rem;
    text-shadow: 0.24em 0.08em 0 rgba(72, 254, 200, 0.38);
    animation: glid 2.6s cubic-bezier(.2, .7, .2, 1) both;
  }
  @keyframes glid {
    from { text-shadow: 0 0 0 rgba(72, 254, 200, 0); }
    to { text-shadow: 0.24em 0.08em 0 rgba(72, 254, 200, 0.38); }
  }
  @media (prefers-reduced-motion: reduce) { h1 { animation: none; } }
  .lead { color: var(--dov); font-size: 1.15rem; max-width: 34rem; margin: 0 0 1.4rem; }
  .back { font-size: 0.92rem; }
  .updated { color: var(--svag); font-size: 0.85rem; margin-top: 1.4rem; }
  main { padding-bottom: 6rem; }
  section { padding-top: 3rem; }
  h2 { font-weight: 300; font-size: 1.45rem; line-height: 1.3; letter-spacing: 0.32em; text-transform: uppercase; margin: 0 0 1.4rem; }
  p { margin: 0 0 1rem; }
  ul { padding-left: 1.2rem; margin: 0 0 1rem; }
  li { margin: 0 0 0.45rem; }
  li::marker { color: var(--svag); }
  code {
    font-family: var(--sans); font-size: 0.8em; color: var(--sken); white-space: nowrap;
    border: 1px solid var(--kant-stark); border-radius: 3px; padding: 0 0.38rem;
  }

  /* Vägvisare: de två episoderna */
  .hitta { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.9rem; }
  .hitta li { margin: 0; }
  .hitta a {
    display: block; text-decoration: none; color: var(--text);
    border: 1px solid var(--kant-stark); border-radius: 8px; background: var(--yta);
    padding: 1rem 1.2rem 1.05rem;
  }
  .hitta a:hover { border-color: var(--sken); }
  .hitta .nr { display: block; color: var(--dov); font-size: 0.9rem; }
  .hitta .titel { display: block; font-family: var(--serif); font-style: italic; color: var(--replika); font-size: 1.4rem; line-height: 1.3; }
  .hitta .vad { display: block; color: var(--dov); font-size: 0.95rem; margin-top: 0.3rem; }

  /* Läsnyckel */
  .nyckel { margin: 0; }
  .nyckel > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.4rem 1.2rem; padding: 0.7rem 0; border-top: 1px solid var(--kant); align-items: baseline; }
  .nyckel dt { margin: 0; }
  .nyckel dd { margin: 0; color: var(--dov); font-size: 0.95rem; }
  .nyckel .regi-prov { color: var(--svag); font-size: 0.92rem; }
  .nyckel .manus-prov { font-family: var(--serif); font-style: italic; color: var(--replika); font-size: 1.14rem; }
  @media (max-width: 30rem) { .nyckel > div { grid-template-columns: 1fr; } }

  /* Episod */
  .episod { padding-top: 4.5rem; }
  .episod > h2 { margin-bottom: 0.3rem; }
  .ep-titel { font-family: var(--serif); font-style: italic; color: var(--replika); font-size: clamp(1.7rem, 6vw, 2.4rem); line-height: 1.2; margin: 0 0 1.6rem; }
  .om p:first-child { color: var(--svag); font-size: 0.9rem; }
  .om strong, .bakom strong { font-weight: 600; color: var(--sken); }
  details.bakom { margin: 0 0 1rem; border-top: 1px solid var(--kant); border-bottom: 1px solid var(--kant); padding: 0.75rem 0; color: var(--dov); font-size: 0.96rem; }
  details.bakom summary { cursor: pointer; color: var(--sken); }
  details.bakom[open] summary { margin-bottom: 0.9rem; }

  h3.scen {
    display: flex; align-items: center; gap: 0.9rem;
    font-weight: 300; font-size: 1.2rem; letter-spacing: 0.22em; text-transform: uppercase;
    margin: 3.4rem 0 0.7rem;
  }
  h3.scen .nr {
    flex: none; width: 2rem; height: 2rem; border-radius: 50%;
    border: 1px solid var(--kontakt); color: var(--kontakt);
    display: grid; place-items: center; font-size: 0.95rem; letter-spacing: 0;
  }
  .trigger, .not { color: var(--dov); font-size: 0.92rem; margin: 0 0 1.1rem; }
  .trigger b { font-weight: 600; color: var(--sken); letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.8rem; margin-right: 0.5rem; }
  .gren-rubrik { font-weight: 600; color: var(--kontakt); font-size: 0.95rem; margin: 1.8rem 0 0.7rem; }

  /* Manuset: det som hörs */
  .manus { margin: 0 0 1.5rem; padding: 0.15rem 0 0.15rem 1.15rem; border-left: 2px solid var(--kant-stark); }
  .manus p {
    font-family: var(--serif); font-style: italic; font-weight: 400; color: var(--replika);
    font-size: 1.17rem; line-height: 1.72; margin: 0 0 0.8rem;
  }
  .manus p:last-child { margin-bottom: 0; }
  .manus .regi { font-family: var(--sans); font-style: normal; font-size: 0.78em; color: var(--svag); }
  .manus .annan { color: var(--sken); }
  .manus .var {
    font-family: var(--sans); font-style: normal; font-size: 0.68em; color: var(--sken); white-space: nowrap;
    border: 1px solid var(--kant-stark); border-radius: 3px; padding: 0.05em 0.4em; margin-right: 0.3em;
    position: relative; top: -0.12em;
  }
  .manus .gren { display: block; font-family: var(--sans); font-style: normal; font-weight: 600; font-size: 0.8em; color: var(--kontakt); }
  .manus .gren2 { color: var(--sken); }
  .manus .gren + br { display: none; }
  .manus p:has(> .gren:first-child) { margin-top: 1.5rem; }
  .manus p:first-child:has(> .gren:first-child) { margin-top: 0; }
  .manus em { font-family: var(--sans); font-style: normal; font-size: 0.8em; color: var(--dov); }
  .manus p.not { font-family: var(--sans); font-style: normal; font-size: 0.92rem; line-height: 1.6; color: var(--dov); }

  /* Bilagor efter scenerna */
  .bilagor { margin-top: 4rem; border-top: 1px solid var(--kant-stark); }
  h3.bilaga { font-weight: 600; font-size: 1.05rem; color: var(--sken); margin: 2.2rem 0 0.8rem; }
  .tabell { overflow-x: auto; margin: 0 0 1.2rem; }
  table { border-collapse: collapse; width: 100%; min-width: 30rem; font-size: 0.92rem; }
  th { text-align: left; font-weight: 600; color: var(--dov); border-bottom: 1px solid var(--kant-stark); padding: 0.45rem 0.9rem 0.45rem 0; }
  td { vertical-align: top; border-bottom: 1px solid var(--kant); padding: 0.55rem 0.9rem 0.55rem 0; }
  td:first-child { white-space: nowrap; }
  footer { margin-top: 4rem; color: var(--svag); font-size: 0.85rem; border-top: 1px solid var(--kant); padding-top: 1.2rem; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <a class="held" href="https://www.instagram.com/held.band/"><img src="held-logo.svg" alt="HELD" width="1281" height="607"></a>
  <h1>Utkast</h1>
  <p class="lead">De första episoderna som manus. Läs, och säg vad som skaver. Allt går att ändra, också det som redan är inspelat.</p>
  <p class="back"><a href="index.html">Till planen och läget</a></p>
  <p class="updated">Senast ändrad __DATE__.</p>
</header>
</div>
<main>
<section id="hitta">
  <ul class="hitta">
__TOC__
  </ul>
</section>

<section id="nyckel">
  <h2>Så läser du</h2>
  <dl class="nyckel">
    <div><dt><span class="manus-prov">Det är när du går jag hör dig.</span></dt><dd>Det Vega säger.</dd></div>
    <div><dt><span class="regi-prov">(dovt, långt borta)</span></dt><dd>Hur hon säger det, och det som hörs runt henne.</dd></div>
    <div><dt><span class="manus-prov" style="color:var(--sken)">”Du går fint i kväll.”</span></dt><dd>Andra röster än hennes.</dd></div>
    <div><dt><code>mörkt</code> <code>regn</code> <code>löpning</code></dt><dd>Rader som telefonen väljer mellan, efter ljus, väder, fart och vad som hände förra gången.</dd></div>
    <div><dt><span style="color:var(--kontakt);font-weight:600;font-size:0.95rem">Vandraren stannar:</span></dt><dd>Berättelsen delar sig efter vad du gör. Den fortsätter alltid, vilken väg du än tar.</dd></div>
  </dl>
</section>

__EPISODES__

<footer>Manusen ligger i <code>stories/glimt/</code> i Glimts repo. Sidan byggs ur dem.</footer>
</main>
</body>
</html>
"""


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    out = Path(argv[1])
    toc, sections = [], []
    for name in argv[2:]:
        path = Path(name)
        number, title, section = render_episode(path)
        text = path.read_text(encoding="utf-8")
        what = re.search(r"^\*\*Bågen:\*\* (.+)$", text, flags=re.M)
        first_sentence = what.group(1).split(". ")[0].rstrip(".") + "." if what else ""
        first_sentence = first_sentence[:1].upper() + first_sentence[1:]
        toc.append(
            f"    <li><a href='#episod-{number}'><span class='nr'>Episod {number}</span>"
            f"<span class='titel'>{html.escape(title)}</span>"
            f"<span class='vad'>{html.escape(first_sentence)}</span></a></li>"
        )
        sections.append(section)
    today = date.today()
    page = (
        PAGE.replace("__DATE__", f"{today.day} {MONTHS[today.month - 1]} {today.year}")
        .replace("__TOC__", "\n".join(toc))
        .replace("__EPISODES__", "\n\n".join(sections))
    )
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out} ({len(page)} bytes, {len(sections)} episodes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
