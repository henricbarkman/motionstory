# Motionstory

Arbetsnamn. Narrativt fitness-system där motionsformen styr berättelse-genren. Toy v0: pilgrimage-promenad med scriptade scener + LLM-grenar.

## Canonical docs

- `PROGRESS.md`: field tests and decisions, newest first.
- `stories/glimt/varld.md`: the world book (frozen 2026-09-25), Henric's decisions marked **beslut**.
- `stories/glimt/mekaniker.md`: the catalogue of mechanics, written for whoever writes a manuscript: what the walker does, what it is in the story, a one-word verdict (Håller, Delvis, Osäker, Oprövad, Idé) and what to watch for. This is the list of which mechanics exist. The measurements behind each verdict stay on the plan page. When a walk changes a mechanic's status, or a mechanic is built or struck, change the catalogue in the same session as the plan page. A trigger that begins `Ny mekanik:` in a manuscript is a writer's request: answer whether the phone can read it.
- Plan page for Henric: `data/uploads/glimt-plan/index.html` in generalassistant (not in this repo), https://demi.henricbarkman.se/uploads/glimt-plan/index.html. Every mechanic with its field status and his rating, the story decisions, proposals, open questions, and style. Update it in the same session whenever a walk changes a mechanic's status or a story or style decision is made, and change the date in its header.

## Regibordet (the directing desk, formerly the manuscript room)

- **The text of the episodes lives in the OnlyOffice document Manus** (Henric 2026-10-28; `~/generalassistant/data/glimt-oo/`, README there). `mirror.py` carries it to `episode-1.md`, `episode-2.md`, `episod-2.md`, `episod-3.md`, one way, and refuses an md file changed beside it. So these four md files are changed only through Manus; `rummet.py andra/lagg-till/stryk` refuses them. The Swedish `episod-1.md`, `varld.md` and `mekaniker.md` are not in Manus.
- `rummet/` is the directing desk: each line of an episode with a play button, the pause before and after (the desk's own, else the manuscript's `(pause about N s)` mark, else the app's gap from `rummet/apptider.json`, made from `glimt/episod1.js` by `node scripts/rummet_apptider.mjs`; `--check` in the tests), the voice, the text the voice gets with eleven_v4 tags (`[whispers]`, `[pause]`, made from the line's directions, adjustable), the sound, and the takes. **Gör om** renders the line again on eleven_v4 through the portal (`/api/glimt/tagning`, `scripts/dashboard/glimt_regi.py` in generalassistant, which calls `scripts/render_glimt.py: render`), notes the take, chooses it and plays it. The voice ids are read from the episode's json (`voices`) every time, so changing a voice is one value there. "Skriv om repliken" notes a rewrite and asks the portal (`/api/glimt/tillbaka`) to carry it into Manus with `data/glimt-oo/tillbaka.py`: matched on text, never position, never over someone else's change, with upload.py's version guard and the comment "Ändrad i regibordet för tajmingens skull."; an open document makes it wait. Plain ES modules, no build step (`regi.js` the logic, `app.js` the page). Deploy with `python3 scripts/rummet_deploy.py` to https://demi.henricbarkman.se/uploads/glimt-rummet/ (portal login only).
- **Timing, voices, takes and rewrites live only in `~/generalassistant/data/glimt-rummet/regi-<dok>.json` and `tagningar/`, never in this public repo.** The room's older notes (history, comments, proposals, lore pages) stay there too; formats and rules in the README there.
- Demi takes part in comments through `scripts/rummet.py` (`nytt`, `rader`, `kommentera`, `foresla`, `svara`, `lore`; `andra`, `lagg-till`, `stryk` only when asked and only for documents not in Manus; `--dok 1|2|3|1en|2en|varld|mekaniker|lore:<id>`; `--prov` for the sandbox). Never edit the notes files by hand. The comments and proposals have no page now; `katalog.js`, `anteckn.js` and `lager.js` stay for the script.
- The mechanics catalogue's form is read by code (`rummet/katalog.js`, and the mirror's known names): keep `### Name`, `**Du gör:**`, `**Omdöme:** <word>.` when editing it. A `{Ny mekanik: ...}` in Manus is a writer asking whether the phone can read it; the mirror lists it.
- **One look for all four surfaces** (app, plan, test page, room; Henric 2026-10-10: "mycket mer avskalad, minimalistisk", no HELD logo). `design/DESIGN.md` has the rules, `design/glimt.css` the tokens, the two self-hosted typefaces (Literata for her words and every title, Atkinson Hyperlegible Next for the phone's) and the shared parts, `design/referens.html` shows every part with real content. Every surface links `design/glimt.css` and adds only its layout; anything visual follows these files, do not design it anew. The desk's own parts: `rummet/design/DESIGN.md`.
- Tests: `node scripts/test_regi.mjs`, `node scripts/test_rummet.mjs`, `python3 scripts/test_rummet_cli.py`, `python3 scripts/test_regibord_browser.py` (Playwright at phone size and wide, two windows, against `rummet_provserver.py`, which runs the portal's own `files.py` and `glimt_regi.py` and renders nothing). Try changes against the real portal only on the sandbox (`rummet_grund.py --prov --nollstall`, then generalassistant's `data/glimt-oo/tillbaka.py --prov --nollstall`, then `?rot=prov`), never on the manuscript.

## Reviews

Run `/glimt-granska` (a command in generalassistant; briefs and Henric's story rules in `~/generalassistant/.claude/refs/glimt-granska/`, reports in `~/generalassistant/data/glimt-granska/`) when an episode draft is revised, before its lines are rendered, and when an app version is merged, before Henric walks it.

## Links

- Notion: https://www.notion.so/36fb0484bfa4817a9126e4f5784dfb7d
- Drive: https://drive.google.com/drive/folders/19XEuI3NlSsCI8JB9i3FkAtWFF4MU9cVe
- GitHub: https://github.com/henricbarkman/motionstory
- Parent (generalassistant): `~/generalassistant`
