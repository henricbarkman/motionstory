# Glimt's look

One look for the four surfaces: the app (`glimt/`), the plan and the test page
(`data/uploads/glimt-plan/` in generalassistant), and the manuscript room
(`rummet/`). Henric 2026-10-10: "gör designen mycket mer avskalad,
minimalistisk. Välj teckensnitt med extra stor omsorg. Ha inte med
Held-loggan." This replaces the room's lunar punk + HELD look of 2026-10-08
and the plan's HELD curtains.

The tokens, the fonts and the two shared components (the name, the verdict
marks) live in `design/glimt.css`. Every surface links that file and adds only
its own layout. `design/referens.html` shows every part on one page: when in
doubt, match it.

## The idea

Two voices, two typefaces, and nothing else carries personality.

- **Literata** is hers: Vega's lines, the manuscript, every title. A
  contemporary book face drawn for long reading on screens, with an optical
  size axis: light and tight at 64px, sturdy at 17px. Its wedge serifs hold
  up on a dark ground where finer serifs (Spectral, Newsreader) thin out.
- **Atkinson Hyperlegible Next** is the phone's: buttons, numbers, status,
  hints, logs. Drawn for low vision by the Braille Institute: 1, I, l and 0
  can't be confused, which matters for "12,3 / 12,6" read in the rain. Its
  plain grotesque shapes keep it clearly apart from Literata.

A line is set in the voice of whoever says it. A test's question is the
phone's; a quoted line of hers is hers.

Both are self-hosted (`design/fonts/`, latin subset, variable, OFL), because
the app works offline from the service worker and must not wait for Google.

## Colour

| Token | Hex | Use |
|---|---|---|
| `--natt` | #1a2130 | the ground: the blue hour, not black |
| `--skymning` | #232b3c | the one raised surface: a field, a selected row, the toolbar's current item |
| `--linje` | #323b4e | lines that mean something: a field's edge, rows in a long list |
| `--text` | #e6e3da | text |
| `--dampad` | #9aa0ad | secondary text |
| `--svag` | #6d7486 | the quietest: timestamps, the build, "Demi (AI)" |
| `--vega` | #c8d6ff | the star: the dot over the i, the one filled button per screen, focus, "held up outdoors" |
| `--varm` | #e2b872 | what needs you: missed, unsure, waiting for an answer |

No gradients, no glow (except the star), no shadows, no translucent panels.

## Type

Base 17px. Scale: 13 / 15 / 17 / 21 / 27 / 34 / 64 (`--s-1` to `--s5`).

- The name: `.namn`, Literata 300 at opsz 72. Its i carries a dot of
  `--vega` light (a dotless ı with the star over it). It is the only thing
  that glows, and it lights once on load. It replaces the HELD logo; there is
  no other mark.
- Page title: Literata 300, `--s4`, sentence case, letter-spacing -0.01em.
- Section title: Literata 400, `--s3`. Subsection: Literata 600, `--s1`.
- Her lines read on a page: Literata 400, `--s2`, line-height 1.55.
  Stage directions: Literata italic, `--dampad`.
- Phone text: Atkinson 400, `--s0`/`--s1`, line-height 1.5. Numbers in
  Atkinson always, `font-variant-numeric: tabular-nums` in tables and logs.
- Measure: `--matt` (34rem). Left aligned, ragged right, never justified,
  never centred (the app's centred start screen goes).

Never: all-caps labels, letter-spaced titles, a word picked out in colour or
italic inside a title, labels above content that the content already says,
monospace.

## Layout

One column, left aligned, the measure as its width, generous space
(`2.5rem` between sections, `1rem` between paragraphs). Space separates
groups; there are no cards and no boxes around groups. A hairline
(`--linje`, 1px) only separates rows of a long list where rows would
otherwise run together (test results, the plan's mechanics).

```
Glımt•                      <- the name, top left

Episod 1. Ungefär tolv      <- phone text, --dampad
minuter. Hon hörs när
du går.

Kapitel                     <- plain label, sentence case
( ) Episod 1. Det är när …
( ) 1. Det är när du går …

[        Börja gå        ]  <- the screen's one filled button

Sätt på lurarna. …          <- hint, --dampad, --s0
```

## Controls

- The primary action, one per screen: filled `--vega`, text `--natt`,
  Atkinson 600 `--s1`, min-height 52px, radius 6px, full measure on a phone.
- Other buttons: text buttons in `--dampad` with a 1px underline, or for a
  choice (Ja/Nej, ratings) a 1px `--linje` outline, radius 6px, min-height
  44px; the pressed one is filled `--vega`.
- Links: `--text`, underline 1px `--svag`, offset 0.2em; hover: underline
  `--text`.
- Focus: 2px `--vega` outline, offset 3px, everywhere.
- Radio and checkbox: `accent-color: var(--vega)`.

## Status

- Verdicts (Håller, Delvis, Osäker, Oprövad, Idé) are marks, not colours:
  `.dom` with `data-dom="haller|delvis|osaker|oprovad|ide"`: full, half, a
  warm ring, a faint ring, a point. Always followed by the word.
- A count like "19 av 32" is a sentence. If it gets a figure, a row of small
  points (lit = held) in `--vega` and `--linje`, no glow.
- Outcomes: klarade in `--text`, missade in `--varm`, said in words.

## The room

The room is a book on the blue hour: the page is the measure, the margin
holds comments. Paragraph kinds by type, not by boxes: Scenrubrik Literata
600 `--s2`; Replik Literata `--s2`; Regi Literata italic `--dampad`;
Mekanik, Variant and Gren in Atkinson `--s0` `--dampad`, mechanic names
with their `.dom` mark and no pill; Anteckning Atkinson `--s0` `--svag`.
Who wrote a paragraph is an initial (H, L, D) in `--svag` in the left
margin, not a coloured dot. Demi's comments are marked "Demi (AI)" in words,
not with a dashed frame. The toolbar is plain text; the current item sits on
`--skymning`.

## Motion

One moment: the star lights after the name. Everything else answers a
touch (a pressed button fills, a panel opens) and nothing else moves.
`prefers-reduced-motion` turns the star off too.
