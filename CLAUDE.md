# Motionstory

Arbetsnamn. Narrativt fitness-system där motionsformen styr berättelse-genren. Toy v0: pilgrimage-promenad med scriptade scener + LLM-grenar.

## Canonical docs

- `PROGRESS.md`: field tests and decisions, newest first.
- `stories/glimt/varld.md`: the world book (frozen 2026-09-25), Henric's decisions marked **beslut**.
- `stories/glimt/mekaniker.md`: the catalogue of mechanics, written for whoever writes a manuscript: what the walker does, what it is in the story, a one-word verdict (Håller, Delvis, Osäker, Oprövad, Idé) and what to watch for. This is the list of which mechanics exist. The measurements behind each verdict stay on the plan page. When a walk changes a mechanic's status, or a mechanic is built or struck, change the catalogue in the same session as the plan page. A trigger that begins `Ny mekanik:` in a manuscript is a writer's request: answer whether the phone can read it.
- Plan page for Henric: `data/uploads/glimt-plan/index.html` in generalassistant (not in this repo), https://demi.henricbarkman.se/uploads/glimt-plan/index.html. Every mechanic with its field status and his rating, the story decisions, proposals, open questions, and style. Update it in the same session whenever a walk changes a mechanic's status or a story or style decision is made, and change the date in its header.

## Manusrummet (the manuscript room)

- `rummet/` is the page where Henric (later Liv) reads, listens to and edits Glimt's manuscript, proposes, comments and writes lore. Plain HTML/CSS/JS, no build step. Deploy with `python3 scripts/rummet_deploy.py` to https://demi.henricbarkman.se/uploads/glimt-rummet/ (portal login only). Its notes live in `~/generalassistant/data/glimt-rummet/`, outside this public repo; formats and rules in the README there.
- Demi takes part only through `scripts/rummet.py` (`nytt`, `kommentera`, `foresla`, `svara`, `lore`; `--prov` for the sandbox). Never edit the notes files by hand, and never change someone else's post. Demi never lays anything into the manuscript from the room.
- After Demi commits a new draft of an episode straight into the md file, run `python3 scripts/rummet_grund.py --commit <sha>` so the room shows those lines as Demi's draft, not "ändrad utanför rummet".
- The room's look is decided (Henric 2026-10-08): lunar punk as the ground, HELD as the light, the text as a book. `rummet/design/DESIGN.md` has the rules and `rummet/design/skiss.html` is the reference page with the tokens. Follow them for anything visual in the room; do not design it anew.
- Tests: `node scripts/test_rummet.mjs`, `python3 scripts/test_rummet_cli.py`, `python3 scripts/test_rummet_browser.py` (Playwright). Try changes against the real portal only on the sandbox (`rummet_grund.py --prov --nollstall`, then `?rot=prov`), never on the manuscript.

## Links

- Notion: https://www.notion.so/36fb0484bfa4817a9126e4f5784dfb7d
- Drive: https://drive.google.com/drive/folders/19XEuI3NlSsCI8JB9i3FkAtWFF4MU9cVe
- GitHub: https://github.com/henricbarkman/motionstory
- Parent (generalassistant): `~/generalassistant`
