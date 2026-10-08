# Motionstory

Arbetsnamn. Narrativt fitness-system där motionsformen styr berättelse-genren. Toy v0: pilgrimage-promenad med scriptade scener + LLM-grenar.

## Canonical docs

- `PROGRESS.md`: field tests and decisions, newest first.
- `stories/glimt/varld.md`: the world book (frozen 2026-09-25), Henric's decisions marked **beslut**.
- `stories/glimt/mekaniker.md`: the catalogue of mechanics, written for whoever writes a manuscript: what the walker does, what it is in the story, a one-word verdict (Håller, Delvis, Osäker, Oprövad, Idé) and what to watch for. This is the list of which mechanics exist. The measurements behind each verdict stay on the plan page. When a walk changes a mechanic's status, or a mechanic is built or struck, change the catalogue in the same session as the plan page. A trigger that begins `Ny mekanik:` in a manuscript is a writer's request: answer whether the phone can read it.
- Plan page for Henric: `data/uploads/glimt-plan/index.html` in generalassistant (not in this repo), https://demi.henricbarkman.se/uploads/glimt-plan/index.html. Every mechanic with its field status and his rating, the story decisions, proposals, open questions, and style. Update it in the same session whenever a walk changes a mechanic's status or a story or style decision is made, and change the date in its header.

## Manusrummet (the manuscript room)

- `rummet/` is the page where Henric and Liv read, listen to and write Glimt: a word processor over the md files (episodes, `varld.md`, `mekaniker.md`) and the lore pages. Click and type; it saves by itself and merges per paragraph against the file. The md file is the only truth, and a paragraph nobody touched is written back byte for byte. Plain HTML/CSS/JS, no build step: ProseMirror is vendored as `rummet/pm.js` (MIT, `pm-LICENSE.txt`; rebuilt only with `scripts/rummet_pm.py`). Deploy with `python3 scripts/rummet_deploy.py` to https://demi.henricbarkman.se/uploads/glimt-rummet/ (portal login only). Its notes (history, comments, proposals, lore pages) live in `~/generalassistant/data/glimt-rummet/`, outside this public repo; formats and rules in the README there. Never put any of it in this repo.
- **Everyone can change everything in the room.** Nothing is thrown away: every version of a paragraph stays in its history, and two changes of one paragraph are both kept (one in the text, one at the paragraph to choose from).
- **Demi's work rule: comment and propose by default; change text only when Henric or Liv asked.** It is a rule, not a lock. Demi takes part only through `scripts/rummet.py` (`nytt`, `rader`, `kommentera`, `foresla`, `svara`, `lore`, and when asked `andra`, `lagg-till`, `stryk`; `--dok 1|2|varld|mekaniker|lore:<id>`; `--prov` for the sandbox), which records every change as Demi's. Never edit the notes files by hand.
- Mechanics in the room: the tab Mekaniker shows `mekaniker.md` as a list and as text, read from the file every time. The `*Trigger: ...*` line is the paragraph kind Mekanik; names from the catalogue in it become chips in the verdict's colour. A Mekanik paragraph that begins `Ny mekanik:` is a request to Demi: `rummet.py nytt` lists it first until Demi has answered in a comment at that paragraph. The catalogue parser (`rummet/katalog.js`) reads `### Name`, `**Du gör:**`, `**Omdöme:** <word>.`; keep that form when editing the catalogue.
- After Demi commits a new draft straight into an md file, run `python3 scripts/rummet_grund.py --commit <sha>` so the room shows those paragraphs as Demi's draft, not as changed outside the room.
- The room's look is decided (Henric 2026-10-08): lunar punk as the ground, HELD as the light, the text as a book. `rummet/design/DESIGN.md` has the rules and `rummet/design/skiss.html` is the reference page with the tokens; `rummet/design/skarmar/` has screenshots of the built room. Follow them for anything visual in the room; do not design it anew.
- Tests: `node scripts/test_rummet.mjs`, `python3 scripts/test_rummet_cli.py`, `python3 scripts/test_rummet_browser.py` (Playwright, types for real at phone size and wide, two windows). Try changes against the real portal only on the sandbox (`rummet_grund.py --prov --nollstall`, then `?rot=prov`), never on the manuscript.

## Links

- Notion: https://www.notion.so/36fb0484bfa4817a9126e4f5784dfb7d
- Drive: https://drive.google.com/drive/folders/19XEuI3NlSsCI8JB9i3FkAtWFF4MU9cVe
- GitHub: https://github.com/henricbarkman/motionstory
- Parent (generalassistant): `~/generalassistant`
