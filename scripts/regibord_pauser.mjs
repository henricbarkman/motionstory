// The directing desk's pauses, carried into the app (English episode 2 on).
//
// Episode 1's pauses live in the app's code (EN.gaps in glimt/episod1.js) and
// go the other way, app to desk (rummet_apptider.mjs). From episode 2 the
// desk decides: Henric sets the pause before and after each line there, and
// this script writes what the desk plays into glimt/pauser.json, which the
// episode reads (glimt/episode2.js). Run it again whenever the desk has
// changed; nothing else needs to change (Henric's brief 30/10: "bygg så att
// regibordets pauser kan föras över igen utan omarbete").
//
// What the desk plays before a line (rummet/regi.js, pausFore): the desk's
// own pause, else the manuscript's "(pause about N s)", else the standard
// (0.5 s, STANDARD in rummet_apptider.mjs). The standard is read here, not
// the app's file: a pause Henric sets and later clears in the desk must fall
// back to the standard, not to the number this script wrote last time.
// After a line: the desk's own, else none.
//
// The desk's notes are in generalassistant, outside this public repo
// (data/glimt-rummet/regi-<dok>.json); only the seconds come here, as the app
// needs them, the same as episode 1's gaps in its code.
//
//     node scripts/regibord_pauser.mjs                 # all episodes in PAUSER
//     node scripts/regibord_pauser.mjs --check         # is glimt/pauser.json what the desk says?
//     node scripts/regibord_pauser.mjs --regi <dir>    # the desk's folder (default below)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as R from '../rummet/regi.js';
import { tolkaLjud, ljudFor } from '../rummet/ljud.js';
import { STANDARD } from './rummet_apptider.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const UT = join(REPO, 'glimt', 'pauser.json');
const REGI = join(homedir(), 'generalassistant', 'data', 'glimt-rummet');

// The episodes whose pauses the desk decides: desk document, md, json.
export const PAUSER = {
  '2en': { md: 'stories/glimt/episode-2.md', json: 'stories/glimt/episode-2.json' },
};

// -> { id, fore: {clip: s}, efter: {clip: s}, kalla: {clip: 'bord'|'manus'|'standard'} }
export function pauserFor(mdText, story, regi, std = 0.5) {
  const ljud = tolkaLjud(story);
  const standard = { [story.id]: Object.fromEntries(Object.keys(story.lines).map(k => [k, std])) };
  const { rader } = R.raderFor(mdText, regi);
  const fore = {}, efter = {}, kalla = {};
  rader.forEach((rad, k) => {
    if (!rad.talad) return;
    const l = ljudFor(rad.kropp, ljud);
    if (l.lage !== 'inspelad' || !l.delar.length) return;
    const not = R.radNot(regi, rad.id);
    const first = l.delar[0];
    if (first.stycke === 0 && !(first.id in fore)) {
      const p = R.pausFore(not, R.manusPausFore(rader, k), R.appPausFore(rad, ljud, standard));
      fore[first.id] = p.sek;
      kalla[first.id] = p.kalla === 'app' ? 'standard' : p.kalla;
    }
    const last = l.delar[l.delar.length - 1];
    if (not.pausEfter != null) efter[last.id] = not.pausEfter;
  });
  return { id: story.id, fore, efter, kalla };
}

export function pauser(regiDir = REGI) {
  const ut = {};
  for (const [dok, f] of Object.entries(PAUSER)) {
    const md = readFileSync(join(REPO, f.md), 'utf8');
    const story = JSON.parse(readFileSync(join(REPO, f.json), 'utf8'));
    const file = join(regiDir, `regi-${dok}.json`);
    const regi = R.lasRegi(existsSync(file) ? readFileSync(file, 'utf8') : null, dok);
    const p = pauserFor(md, story, regi, STANDARD[f.json] ?? 0.5);
    ut[p.id] = { dok, fore: p.fore, efter: p.efter, kalla: p.kalla };
  }
  return ut;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--regi');
  const dir = i > 0 ? process.argv[i + 1] : REGI;
  const all = pauser(dir);
  const text = `${JSON.stringify({ note: 'Written by scripts/regibord_pauser.mjs from the directing desk. Do not edit by hand: change the pause in the desk and run the script again.', ...all }, null, 1)}\n`;
  if (process.argv.includes('--check')) {
    let nu = '';
    try { nu = readFileSync(UT, 'utf8'); } catch { /* missing */ }
    if (nu !== text) { console.error('glimt/pauser.json is not what the desk says: run node scripts/regibord_pauser.mjs'); process.exit(1); }
    console.log('glimt/pauser.json is what the desk says');
  } else {
    writeFileSync(UT, text);
    for (const [id, p] of Object.entries(all)) {
      const n = k => Object.values(p.kalla).filter(v => v === k).length;
      console.log(`${id}: ${Object.keys(p.fore).length} pauses before (desk ${n('bord')}, manuscript ${n('manus')}, standard ${n('standard')}), ${Object.keys(p.efter).length} after`);
    }
    console.log('wrote glimt/pauser.json');
  }
}
