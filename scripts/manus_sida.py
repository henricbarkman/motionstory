#!/usr/bin/env python3
"""Render Glimt episode drafts as one reading page for Henric.

The drafts live as markdown in stories/glimt/episod-N.md. Henric reads in the
portal, not in the repo, so this turns them into a single HTML page in Glimt's
shared look (design/DESIGN.md). The page links design/glimt.css relative to
itself, so OUT's folder needs design/ next to it (data/uploads/glimt-plan/ in
generalassistant has it).

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
        return f"<p class='trigger'><b>När:</b>{text[:1].upper()}{text[1:]}</p>"

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
<meta name="theme-color" content="#0b0a12">
<link rel="stylesheet" href="design/glimt.css">
<style>
  /* Tokens, typefaces and the verdict marks come from design/glimt.css; the rules in design/DESIGN.md. */
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  body {
    margin: 0; color: var(--text); font-family: var(--telefonens);
    font-size: var(--s1); line-height: 1.5; -webkit-font-smoothing: antialiased;
  }
  header, main { max-width: var(--matt); margin: 0 auto; padding: 0 1.5rem; }
  header { padding-top: 3.5rem; padding-bottom: 0.5rem; }
  main { padding-bottom: 6rem; }
  a { color: var(--text); text-decoration-color: var(--svag); text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
  a:hover { text-decoration-color: var(--text); }
  :focus-visible { outline: 2px solid var(--mint); outline-offset: 3px; border-radius: 2px; }
  h1 { font-family: var(--hennes); font-weight: 300; font-size: var(--s4); letter-spacing: -0.01em; line-height: 1.15; margin: 0 0 1rem; font-variation-settings: "opsz" 48; }
  .lead { margin: 0 0 1rem; }
  .back { font-size: var(--s0); }
  .updated { color: var(--svag); font-size: var(--s-1); margin: 0; }
  section { padding-top: 3.5rem; }
  h2 { font-family: var(--hennes); font-weight: 400; font-size: var(--s3); line-height: 1.25; margin: 0 0 1.25rem; font-variation-settings: "opsz" 36; }
  p { margin: 0 0 1rem; }
  strong, b { font-weight: 600; }
  ul { padding-left: 1.2rem; margin: 0 0 1rem; }
  li { margin: 0 0 0.45rem; }
  li::marker { color: var(--svag); }
  code { font: inherit; color: var(--dampad); }

  /* The two episodes */
  .hitta { list-style: none; padding: 0; margin: 0; }
  .hitta li { margin: 0 0 1.4rem; }
  .hitta a { display: block; text-decoration: none; }
  .hitta .nr { display: block; color: var(--dampad); font-size: var(--s0); }
  .hitta .titel {
    display: block; font-family: var(--hennes); font-size: var(--s2); line-height: 1.3;
    text-decoration: underline 1px var(--svag); text-underline-offset: 0.2em;
  }
  .hitta a:hover .titel { text-decoration-color: var(--text); }
  .hitta .vad { display: block; color: var(--dampad); font-size: var(--s0); margin-top: 0.2rem; }

  /* Reading key */
  .nyckel { margin: 0; }
  .nyckel > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.3rem 1.2rem; padding: 0.6rem 0; align-items: baseline; }
  .nyckel dt { margin: 0; }
  .nyckel dd { margin: 0; color: var(--dampad); font-size: var(--s0); }
  .nyckel .manus-prov { font-family: var(--hennes); font-size: var(--s2); line-height: 1.4; }
  .nyckel .regi-prov { font-family: var(--hennes); font-style: italic; color: var(--dampad); }
  .nyckel .annan-prov { font-family: var(--hennes); font-size: var(--s2); color: var(--dampad); }
  .nyckel .gren-prov { color: var(--dampad); font-size: var(--s0); }
  @media (max-width: 30rem) { .nyckel > div { grid-template-columns: 1fr; } }

  /* Episode */
  .episod { padding-top: 5rem; }
  .episod > h2 { color: var(--dampad); font-size: var(--s1); font-family: var(--telefonens); font-weight: 400; margin-bottom: 0.2rem; }
  .ep-titel { font-family: var(--hennes); font-weight: 300; font-size: var(--s4); letter-spacing: -0.01em; line-height: 1.15; margin: 0 0 1.5rem; font-variation-settings: "opsz" 48; }
  .om p:first-child { color: var(--svag); font-size: var(--s-1); }
  details.bakom { margin: 0 0 1rem; color: var(--dampad); font-size: var(--s0); }
  details.bakom summary {
    display: inline-block; cursor: pointer; padding: 0.5rem 0; color: var(--dampad);
    text-decoration: underline 1px var(--svag); text-underline-offset: 0.2em;
  }
  details.bakom summary::-webkit-details-marker { display: none; }
  details.bakom summary:hover { color: var(--text); }
  details.bakom[open] summary { margin-bottom: 0.6rem; }
  details.bakom strong { color: var(--text); }

  /* Scenes: the heading in her face, the trigger and notes in the phone's. */
  h3.scen { font-family: var(--hennes); font-weight: 600; font-size: var(--s2); line-height: 1.3; margin: 3rem 0 0.6rem; }
  h3.scen .nr { margin-right: 0.4em; }
  .trigger, .not { color: var(--dampad); font-size: var(--s0); margin: 0 0 1rem; }
  .trigger b { color: var(--text); margin-right: 0.3em; }
  .gren-rubrik { color: var(--dampad); font-size: var(--s0); margin: 1.8rem 0 0.6rem; }

  /* The manuscript: what is heard, in Literata, without a frame. */
  .manus { margin: 0 0 1.5rem; padding: 0; }
  .manus p { font-family: var(--hennes); font-size: var(--s2); line-height: 1.55; margin: 0 0 0.8rem; }
  .manus p:last-child { margin-bottom: 0; }
  .manus .regi { font-style: italic; color: var(--dampad); }
  .manus .annan { color: var(--dampad); }
  .manus .var { font-family: var(--telefonens); font-size: var(--s0); color: var(--dampad); white-space: nowrap; margin-right: 0.35em; }
  .manus .gren { display: block; font-family: var(--telefonens); font-size: var(--s0); color: var(--dampad); }
  .manus .gren + br { display: none; }
  .manus p:has(> .gren:first-child) { margin-top: 1.5rem; }
  .manus p:first-child:has(> .gren:first-child) { margin-top: 0; }
  .manus em { font-family: var(--telefonens); font-style: normal; font-size: var(--s0); color: var(--dampad); }
  .manus p.not { font-family: var(--telefonens); font-size: var(--s0); line-height: 1.5; color: var(--dampad); }

  /* Appendices after the scenes */
  .bilagor { margin-top: 4rem; }
  h3.bilaga { font-family: var(--hennes); font-weight: 600; font-size: var(--s1); margin: 2.5rem 0 0.6rem; }
  .tabell { overflow-x: auto; margin: 0 0 1.2rem; }
  table { border-collapse: collapse; width: 100%; min-width: 30rem; font-size: var(--s0); }
  th { text-align: left; font-weight: 600; color: var(--dampad); border-bottom: 1px solid var(--linje); padding: 0.45rem 0.9rem 0.45rem 0; }
  td { vertical-align: top; border-bottom: 1px solid var(--linje); padding: 0.55rem 0.9rem 0.55rem 0; font-variant-numeric: tabular-nums; }
  td:first-child { white-space: nowrap; }
  footer { margin-top: 4rem; color: var(--svag); font-size: var(--s-1); }
</style>
</head>
<body>
<header>
  <h1>Utkast</h1>
  <p class="lead">De första episoderna som manus. Läs, och säg vad som skaver. Allt går att ändra, också det som redan är inspelat.</p>
  <p class="back"><a href="index.html">Till planen och läget</a></p>
  <p class="updated">Senast ändrad __DATE__.</p>
</header>
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
    <div><dt><span class="annan-prov">”Du går fint i kväll.”</span></dt><dd>Andra röster än hennes.</dd></div>
    <div><dt><code>mörkt</code> <code>regn</code> <code>löpning</code></dt><dd>Rader som telefonen väljer mellan, efter ljus, väder, fart och vad som hände förra gången.</dd></div>
    <div><dt><span class="gren-prov">Vandraren stannar:</span></dt><dd>Berättelsen delar sig efter vad du gör. Den fortsätter alltid, vilken väg du än tar.</dd></div>
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
