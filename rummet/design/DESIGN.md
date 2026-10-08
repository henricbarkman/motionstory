# Manusrummet: the look

Decided 2026-10-08. Henric: "Kör portalens lunar punk som grund. Skulle vilja att
den blev ett snäpp mindre tech bara. Och så ska den kännas som att den funkar med
HELDs grafiska språk."

`skiss.html` in this folder is the reference: a static page with real text from
episode 1. Its `:root` block is the token set, and its rules for each paragraph
kind are the starting point for `rummet.css`. Open it in a browser before
writing any CSS. Where this file and the sketch disagree, the sketch wins.

## The idea in one line

Lunar punk is the ground, HELD is the light, and the text is a book.

## Where each part comes from

| Part | Source | In the room |
|---|---|---|
| Night canvas, violet to indigo, at 155 degrees | lunar punk (`assets/lunarpunk.css` in generalassistant) | the page background, fixed |
| Paper grain | lunar punk | over everything, a little stronger than on the tool pages |
| Mint | lunar punk's soft mint, not HELD's sharper `#48FEC8` | the cursor, "Sparat", Henric's mark, focus rings, the verdict Håller |
| The wordmark in Syne with the mint to periwinkle to rose sweep | lunar punk | "Glimt", top left, in sentence case. The only place Syne is used |
| Purple curtain on the left edge (`#271240`) | HELD's cover for Drifting Away | a gradient from the left, fading out by a quarter of the width |
| The pale turquoise glow (`#A4DADB`) | HELD's cover | one tilted, blurred pane of light behind the episode title. Also the colour of listen rings, branch labels and variant labels |
| Thin wide capitals that double and drift apart | HELD's cover | the episode title, and nowhere else |
| HELD's logo | HELD | small, in the footer |

## What "one notch less tech" means here

- **No monospace anywhere.** Not for labels, not for times, not for ids.
- **The text is set in a book serif** (Spectral): lines that are heard, scene
  headings, lore. Open Sans is for the tools and for direction. Syne is for the
  wordmark only.
- **No hairline boxes.** A surface is a little light laid on the night
  (`--yta`, `--yta-2`), with soft uneven corners. The one outlined thing is a
  post from Demi, dashed, because it marks an AI.
- **Marks are dots, not badges.** Who last wrote a paragraph is a small dot in
  the margin: mint for Henric, orchid for Liv, a hollow periwinkle ring for Demi.
- **No uppercase labels, no tracked-out eyebrows.** Sentence case everywhere
  except the episode title.
- **Glow, not neon.** One glow on the page. Nothing else shines.

## Type

| Role | Face | Size and weight |
|---|---|---|
| Lines that are heard | Spectral 400 | 1.1875rem / 1.68, colour `--blad` |
| Scene heading | Spectral 500 | 1.75rem, the number in `--svag` |
| Episode title | Open Sans 300, capitals, letter-spacing 0.34em | clamp(1.25rem, 4.6vw, 1.85rem), with the doubled ghost |
| Direction, in or between lines | Open Sans italic | 0.9em, colour `--dov` |
| Mechanic block, tools, comments | Open Sans 400 and 600 | 0.875rem to 0.9375rem |
| Wordmark | Syne 700 | 1.3rem |

The text column is about 35rem, close to 66 characters of Spectral.

## Paragraph kinds

- **Replik:** plain serif text. The brightest thing on the page, because it is
  what the walker hears.
- **Regi:** grey sans italic, smaller. Inline when it sits inside a line.
- **Mekanik:** a soft lit block at the top of the scene, sans. Mechanic names
  from the catalogue are chips: a dot and the name on a wash of the verdict
  colour (mint Håller, turquoise Delvis, amber Osäker, dim violet Oprövad).
  A quiet amber line under the text when the scene leans on something unsure.
- **Gren:** a turquoise label with a small bent thread before it. The lines of
  the branch hang on a soft vertical thread.
- **Variant:** a small turquoise label in a narrow first column, the line beside
  it. On a phone the label sits above the line.
- **Where the cursor stands:** a soft wash behind the paragraph. No frame.

## Layout

```
wide
  Glimt manusrummet   [Episod 1] Episod 2 Världen Mekaniker            Sparat (H)
  [Replik v] | Mekanik Variant Gren | Kommentera Föreslå Historik      who wrote
            (glow)
            D E T  Ä R  N Ä R  D U  G Å R
   margin | text column, 35rem                     | comments, 17rem
     o >  | Jag måste få veta en sak ...           | Henric: ...

phone
  Glimt                      Sparat (H)
  [Episod 1] Episod 2 Världen Mekaniker   (scrolls sideways)
  o  text, full width
  >
  [Replik v] | Mekanik Variant Gren | ...   (fixed above the keyboard)
```

- The margin on the left holds the listen ring and the dot for who wrote.
- Comments hang in the right margin on a wide screen and never push the text.
  On a phone they sit under their paragraph, or open as a sheet from below.
- The top bar and the tool row stay quiet: no borders, a blurred wash of the
  night behind them. Everything is left-aligned. Nothing is centred but the
  footer.

## Rules for new parts

A part the sketch does not show (the mechanics tab, history, the lore pages,
the picker for a mechanic, error states) follows the same rules: surfaces of
light, dots for marks, serif for anything that is story, sans for anything that
is a tool. Use the lunar punk hues for anything that needs one more colour
(`--hue-*` in `assets/lunarpunk.css`), never a new one.

Keep the quality floor: visible focus, `prefers-reduced-motion` respected, text
contrast at least 4.5:1 against the darkest and the lightest part of the
background it can sit on, and the page usable at 360 px wide.
