# Glimt's look

One look for the four surfaces: the app (`glimt/`), the plan and the test page
(`data/uploads/glimt-plan/` in generalassistant), and the manuscript room
(`rummet/`). Henric 2026-10-10: "gör designen mycket mer avskalad,
minimalistisk. Välj teckensnitt med extra stor omsorg. Ha inte med
Held-loggan." And 2026-10-11, when the first version came out as a new
look (the blue hour, a blue-white accent): "Ville ha kvar lunar punk-temat
likt portalen, men mer avskalat/minimalistiskt." So: the portal's world,
quieter. This replaces the room's lunar punk + HELD look of 2026-10-08, the
plan's HELD curtains, and the blue hour of 2026-10-10.

The tokens, the fonts and the two shared components (the name, the verdict
marks) live in `design/glimt.css`. Every surface links that file and adds only
its own layout. `design/referens.html` shows every part on one page: when in
doubt, match it.

## The idea

Lunar punk, stripped. The portal's world (midnight violet, mint, a warm
moon-white, a soft light), with everything taken away that is not colour
and light. Lunar punk is carried by colour and light, not by objects,
patterns or symbols: no moons, no stars as ornament, no grain, no glass
panels, no gradients on text, no glow on anything but the one star.

Inside that light, two voices, two typefaces, and nothing else carries
personality.

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

The portal's lunar punk (`assets/lunarpunk.css` in generalassistant), with
the ground a step lighter because the portal's paper grain, which lifts its
darks, is gone here. Hex in `glimt.css`, the oklch source beside each.

| Token | Hex | Use |
|---|---|---|
| `--natt` | #0b0a12 | the ground: midnight violet |
| `--skymning` | #151621 | the one raised surface: a field, a selected row, the toolbar's current item |
| `--linje` | #323540 | lines that mean something: a field's edge, rows in a long list |
| `--text` | #f5f3ef | text, a warm moon-white |
| `--dampad` | #a6a59f | secondary text |
| `--svag` | #84837e | the quietest: timestamps, the build, "Demi (AI)" |
| `--mint` | #90d5a8 | the signature, the portal's send button: the star, the one filled button per screen, focus, "held up outdoors" |
| `--mint-ljus` | #a6e4ba | a hovered filled button |
| `--pa-mint` | #111813 | text on mint |
| `--orkide` | #c097c9 | the second colour, sparingly: a proposal in the room (its hairline), a text selection |
| `--varm` | #e9b364 | what needs you: missed, unsure, waiting for an answer |

Light: `--grund`, the portal's violet-to-indigo sweep at 155°, so faint it
reads as depth rather than a gradient, and `--sken`, one soft violet glow of
moonlight from above. `glimt.css` lays both behind every page
(`body::before`, fixed); a surface sets no background of its own on html or
body. A sticky bar uses `--bakgrund` (the same light, fixed to the screen,
so it lines up); a panel or a menu that floats sits on `--natt` with a
`--linje` edge.

Never: grain or noise, a vignette, a second glow, glow on anything but the
star, shadows, translucent or blurred panels, gradients on text or buttons,
mint or orchid as a fill behind text other than the one filled button.

Contrast, against the lightest point of the ground and against
`--skymning`: `--text` 16:1, `--dampad` 7.3:1, `--svag` 4.7:1, `--mint`
10:1, `--orkide` 7.3:1, `--varm` 9.5:1. All AA at 13px; keep it so when a
token changes (the app is read outdoors, in rain and in the dark).

## Type

Base 17px. Scale: 13 / 15 / 17 / 21 / 27 / 34 / 64 (`--s-1` to `--s5`).

- The name: `.namn`, Literata 300 at opsz 72. Its i carries a dot of
  `--mint` light (a dotless ı with the star over it). It is the only thing
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

- The primary action, one per screen: filled `--mint`, text `--pa-mint`,
  Atkinson 600 `--s1`, min-height 52px, radius 6px, full measure on a phone.
- Other buttons: text buttons in `--dampad` with a 1px underline, or for a
  choice (Ja/Nej, ratings) a 1px `--linje` outline, radius 6px, min-height
  44px; the pressed one is filled `--mint`.
- Links: `--text`, underline 1px `--svag`, offset 0.2em; hover: underline
  `--text`.
- Focus: 2px `--mint` outline, offset 3px, everywhere.
- Radio and checkbox: `accent-color: var(--mint)`.

## Status

- Verdicts (Håller, Delvis, Osäker, Oprövad, Idé) are marks, not colours:
  `.dom` with `data-dom="haller|delvis|osaker|oprovad|ide"`: full, half, a
  warm ring, a faint ring, a point. Always followed by the word.
- A count like "19 av 32" is a sentence. If it gets a figure, a row of small
  points (lit = held) in `--mint` and `--linje`, no glow.
- Outcomes: klarade in `--text`, missade in `--varm`, said in words.

## The room

The room is a book by moonlight: the page is the measure, the margin
holds comments. Paragraph kinds by type, not by boxes: Scenrubrik Literata
600 `--s2`; Replik Literata `--s2`; Regi Literata italic `--dampad`;
Variant is her line set like Replik, after its label in Atkinson `--s-1`
`--dampad`; Mekanik and Gren in Atkinson `--s0` `--dampad`, mechanic names
with their `.dom` mark and no pill; Anteckning Atkinson `--s0` `--svag`.
On a phone, under 40rem, Replik (and Variant with it) is `--s1`: the room
is a page to write on, and the Scenrubrik stays `--s2` 600 above it.
Who wrote a paragraph is an initial (H, L, D) in `--svag` in the left
margin, not a coloured dot, in the paragraph's own type: Literata beside
Scenrubrik, Replik, Regi (italic) and text, Atkinson beside Mekanik, Gren,
Variant's label and Anteckning. Demi's comments are marked "Demi (AI)" in words,
not with a dashed frame. A comment's hairline is `--linje`; a proposal's is
`--orkide`; two changes that met, `--varm`. The toolbar is plain text; the current item sits on
`--skymning`.

## Motion

One moment: the star lights after the name. Everything else answers a
touch (a pressed button fills, a panel opens) and nothing else moves.
`prefers-reduced-motion` turns the star off too.
