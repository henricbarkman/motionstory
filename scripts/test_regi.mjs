#!/usr/bin/env node
// Checks the directing desk's logic (rummet/regi.js): the rows of an episode
// and their ids across a mirror rewrite, the text a v4 voice gets, the voices
// read from the episode's json, the pauses (the desk's own, the manuscript's,
// the app's), takes, and a rewrite asked for at the desk.
//
//   node scripts/test_regi.mjs
//   RUMMET_DIR=/some/copy/ node scripts/test_regi.mjs    # a mutated copy

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.RUMMET_DIR || join(REPO, 'rummet');
const R = await import(pathToFileURL(join(DIR, 'regi.js')).href);
const L = await import(pathToFileURL(join(DIR, 'ljud.js')).href);

let failures = 0;
let checks = 0;
const ok = (cond, what) => {
  checks++;
  if (!cond || process.env.VERBOSE) console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
};
const throwsKod = (fn, kod) => { try { fn(); return false; } catch (e) { return e.kod === kod; } };
const las = (f) => readFileSync(join(REPO, f), 'utf8');
const AV = { vem: 'henric', nar: '2026-10-28T12:00:00Z' };

const MD = [
  '# Glimt, episode 1: Test',
  '',
  'About.',
  '',
  '---',
  '',
  '## 0. Start',
  '*Trigger: the start button.*',
  '',
  '> (to herself) There it is.',
  '>',
  '> (pause about 2 s; was about 1 s on 23/10)',
  '>',
  '> Hello, the walker.',
  '>',
  '> (the earpiece) "Vega. You are stationary."',
  '>',
  '> [mörkt] It is dark.',
  '',
  '## 1. Next',
  '',
  '> Keep going.',
  '',
].join('\n');

// --- 1. Rows -------------------------------------------------------------------------
{
  const { rader, paras } = R.raderFor(MD, null);
  const talade = rader.filter((r) => r.talad);
  ok(rader[0].typ === 'scen' && rader[0].text === '0. Start', 'the first row is the scene');
  ok(talade.map((r) => r.kropp).join(' | ') === '(to herself) There it is. | Hello, the walker. | (the earpiece) "Vega. You are stationary." | It is dark. | Keep going.',
    'spoken rows: the lines and the variant, not the pause');
  ok(talade.find((r) => r.typ === 'variant').etikett === 'mörkt', 'a variant keeps its label');
  ok(rader.some((r) => r.typ === 'regi'), 'the pause mark is a regi row');
  ok(new Set(rader.map((r) => r.id)).size === rader.length, 'every row has its own id');
  ok(talade.every((r) => r.raw.startsWith('> ')), 'raw is the md line');

  // The mirror rewrites a line and inserts another: the others keep their ids.
  const regi = { ...R.tomRegi('1en'), stycken: R.skuggaFor(paras) };
  const id = (rs, kropp) => (rs.find((r) => r.kropp === kropp) || {}).id;
  const md2 = MD.replace('> Hello, the walker.', '> Hello again, Shape.').replace('> Keep going.', '> Go on.\n>\n> Keep going.');
  const { rader: r2 } = R.raderFor(md2, regi);
  ok(id(r2, 'Keep going.') === id(rader, 'Keep going.'), 'an untouched line keeps its id when the mirror inserts one before it');
  ok(id(r2, 'It is dark.') === id(rader, 'It is dark.'), 'the variant keeps its id');
  ok(id(r2, 'Hello again, Shape.') === id(rader, 'Hello, the walker.'), 'a rewritten line keeps its id (the notes follow it)');
}

// --- 2. The text a v4 voice gets -------------------------------------------------------
{
  ok(R.v4Text('(to herself) There it is.') === '[to herself] There it is.', 'a direction becomes a tag');
  ok(R.v4Text('Hello, the walker.') === 'Hello, the walker.', 'plain words stay');
  ok(R.v4Text('(the earpiece) "Vega. You are stationary."') === 'Vega. You are stationary.', 'another voice: its words only');
  ok(R.v4Text('(pause, calm, slowly, serious) Ok. Can you see me?') === '[pause] [calm, slowly, serious] Ok. Can you see me?', 'a pause in a direction becomes [pause]');
  ok(R.v4Text('(pause about 2 s; was about 1 s on 23/10) Go.') === '[pause] Go.', 'a timed pause becomes [pause] without the numbers');
  ok(R.ordI('[whispers] Hello [pause] you.') === 'Hello you.', 'ordI drops the tags');
}

// --- 3. Voices, from the episode's json --------------------------------------------------
const KAP = JSON.parse(las('stories/glimt/episode-1.json'));
{
  const roster = R.rosterFor(KAP);
  ok(roster.map((r) => `${r.nyckel}=${r.namn}`).join(',') === 'vega=Jessica,snackan=Rowan', 'the roster names the voices from voiceNotes');
  ok(roster.find((r) => r.nyckel === 'vega').id === KAP.voices.vega, 'the id is the json\'s');
  const byte = { ...KAP, voices: { ...KAP.voices, vega: 'NEW_AMERICAN' } };
  ok(R.rosterFor(byte).find((r) => r.nyckel === 'vega').id === 'NEW_AMERICAN', 'changing Vega\'s voice is one value in the json');
  ok(R.rosterFor(null).length === 0, 'no recordings, no voices');
  const { rader } = R.raderFor(MD, null);
  const ljud = L.tolkaLjud(KAP);
  ok(R.forvaldRost(rader.find((r) => r.kropp === 'Hello, the walker.'), ljud, KAP) === 'vega', 'Vega\'s line: vega');
  ok(R.forvaldRost(rader.find((r) => r.kropp.startsWith('(the earpiece)')), ljud, KAP) === 'snackan', 'another voice\'s line: the other voice');
}

// --- 4. Pauses --------------------------------------------------------------------------
{
  const { rader } = R.raderFor(MD, null);
  const k = rader.findIndex((r) => r.kropp === 'Hello, the walker.');
  ok(R.manusPausFore(rader, k) === 2, 'the manuscript\'s pause mark just above a line');
  ok(R.manusPausFore(rader, rader.findIndex((r) => r.kropp === 'It is dark.')) === null, 'no mark, no manuscript pause');
  ok(R.pausFore({ pausFore: 0.5 }, 2, { sek: 1 }).kalla === 'bord', 'the desk\'s own pause wins');
  ok(R.pausFore({ pausFore: null }, 2, { sek: 1 }).sek === 2, 'then the manuscript\'s');
  ok(R.pausFore({ pausFore: null }, null, { sek: 1 }).kalla === 'app', 'then the app\'s');
  ok(R.pausFore({ pausFore: 0 }, 2, null).sek === 0, 'a desk pause of zero is a pause of zero');
  ok(R.pausMellan({ pausEfter: 1.5 }, { sek: 2 }) === 3.5, 'the silence between two lines adds up');
  ok(R.sekText(1.5) === '1,5 s' && R.sekText(0) === '0 s', 'seconds in Swedish');

  // The app's gap before a clip, from apptider.json, on the English recording.
  const APP = JSON.parse(las('rummet/apptider.json'));
  const ljud = L.tolkaLjud(KAP);
  const forst = Object.entries(KAP.lines).find(([id]) => APP[KAP.id] && APP[KAP.id][id]);
  ok(!!forst, 'apptider has gaps for the English episode');
  if (forst) {
    const [cid, text] = forst;
    const stycke = text.split(/\n\s*\n/)[0].replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    const rad = { kropp: stycke };
    const a = R.appPausFore(rad, ljud, APP);
    ok(a && a.sek === APP[KAP.id][cid] && !a.iInspelning, `the app's pause before ${cid}`);
    const andra = text.split(/\n\s*\n/)[1];
    if (andra) {
      const b = R.appPausFore({ kropp: andra.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() }, ljud, APP);
      ok(b && b.iInspelning, 'a later paragraph has its pause inside the recording');
    }
  }
  try {
    execFileSync('node', [join(REPO, 'scripts/rummet_apptider.mjs'), '--check'], { stdio: 'pipe' });
    ok(true, 'apptider.json matches glimt/episod1.js');
  } catch {
    ok(false, 'apptider.json matches glimt/episod1.js (run node scripts/rummet_apptider.mjs)');
  }
}

// --- 5. Changes: pauses, voice, direction, takes --------------------------------------------
{
  const { rader } = R.raderFor(MD, null);
  const rad = rader.find((r) => r.kropp === 'Hello, the walker.');
  let regi = R.tomRegi('1en');
  regi = R.sattPaus(regi, rad.id, 'pausFore', 1.1, AV);
  ok(R.radNot(regi, rad.id).pausFore === 1, 'a pause snaps to quarter seconds');
  regi = R.sattPaus(regi, rad.id, 'pausEfter', 99, AV);
  ok(R.radNot(regi, rad.id).pausEfter === R.PAUS_MAX, 'and is capped');
  ok(throwsKod(() => R.sattPaus(regi, rad.id, 'pausFore', -1, AV), 'paus'), 'a negative pause is refused');
  ok(throwsKod(() => R.sattPaus(regi, rad.id, 'annat', 1, AV), 'falt'), 'an unknown field is refused');
  regi = R.sattPaus(regi, rad.id, 'pausFore', null, AV);
  ok(R.radNot(regi, rad.id).pausFore === null, 'null goes back to the manuscript or the app');
  ok(R.radNot(regi, rad.id).andrad.vem === 'henric', 'who changed it is noted');

  regi = R.sattRegi(regi, rad.id, '[warm] Hello, the walker.', rad.kropp, AV);
  ok(R.regiText(rad, R.radNot(regi, rad.id)) === '[warm] Hello, the walker.', 'the desk\'s own direction is used');
  ok(throwsKod(() => R.sattRegi(regi, rad.id, 'a\nb', rad.kropp, AV), 'rader'), 'a direction is one line');

  const t1 = { id: 't1', fil: '1en/t1.mp3', text: 'x', rost: 'vega' };
  regi = R.laggTillTagning(regi, rad.id, t1, AV);
  regi = R.laggTillTagning(regi, rad.id, t1, AV);
  ok(R.radNot(regi, rad.id).tagningar.length === 1, 'the same take twice is one take');
  ok(R.valdTagning(R.radNot(regi, rad.id)) === null, 'a new take is not chosen by itself');
  regi = R.valjTagning(regi, rad.id, 't1', AV);
  ok(R.valdTagning(R.radNot(regi, rad.id)).fil === '1en/t1.mp3', 'a chosen take is what plays');
  ok(throwsKod(() => R.valjTagning(regi, rad.id, 'nope', AV), 'tagning'), 'an unknown take cannot be chosen');
  ok(throwsKod(() => R.laggTillTagning(regi, rad.id, { id: 'x' }, AV), 'tagning'), 'a take without a file is refused');
  regi = R.valjTagning(regi, rad.id, null, AV);
  ok(R.valdTagning(R.radNot(regi, rad.id)) === null, 'and back to the app\'s sound');

  const fresh = R.lasRegi(R.skrivRegi(regi), '1en');
  ok(JSON.stringify(fresh) === JSON.stringify(regi), 'the notes go through the file unchanged');
  ok(throwsKod(() => R.lasRegi(R.skrivRegi(regi), '2'), 'dok'), 'another episode\'s notes are refused');
  ok(throwsKod(() => R.lasRegi('{', '1en'), 'trasig'), 'a broken file is refused, not overwritten');
  ok(R.lasRegi('', '1en').rader && Object.keys(R.lasRegi(null, '1en').rader).length === 0, 'no file: empty notes');
}

// --- 6. A rewrite asked for at the desk ------------------------------------------------------
{
  const { rader } = R.raderFor(MD, null);
  const rad = rader.find((r) => r.kropp === 'Hello, the walker.');
  let regi = R.tomRegi('1en');
  regi = R.sattRegi(regi, rad.id, '[warm] Hello, the walker.', rad.kropp, AV);
  regi = R.omskriv(regi, rad, 'Hello there, the walker.', AV);
  const o = R.radNot(regi, rad.id).omskrivningar[0];
  ok(o.fran === '> Hello, the walker.' && o.till === '> Hello there, the walker.' && o.lage === 'vantar', 'the rewrite is noted as md lines, waiting');
  ok(R.vantandeOmskrivningar(regi), 'and the desk knows something waits');
  ok(R.aktuellKropp(rad, R.radNot(regi, rad.id)) === 'Hello there, the walker.', 'the desk shows the new words at once');
  ok(R.regiForAldrad(rad, R.radNot(regi, rad.id)), 'the old direction is marked as written for other words');
  ok(R.regiText(rad, R.radNot(regi, rad.id)) === 'Hello there, the walker.', 'and the voice gets the new words');
  regi = R.omskriv(regi, rad, 'Hello you, the walker.', AV);
  ok(R.radNot(regi, rad.id).omskrivningar.length === 1, 'a second rewrite before Manus has it replaces the first');
  ok(throwsKod(() => R.omskriv(regi, rad, 'Hello you, the walker.', AV), 'samma'), 'the same words again are refused');
  ok(throwsKod(() => R.omskriv(regi, rad, 'two\nlines', AV), 'rader'), 'a line is one line');
  ok(throwsKod(() => R.omskriv(regi, rad, '  ', AV), 'tom'), 'an empty line is refused');
  ok(throwsKod(() => R.omskriv(regi, rad, '[mörkt] x', AV), 'format'), 'words that would read as a variant are refused');
  ok(throwsKod(() => R.omskriv(regi, rader[0], 'x', AV), 'slag'), 'a scene heading is not rewritten here');
  const variant = rader.find((r) => r.typ === 'variant');
  const rv = R.omskriv(R.tomRegi('1en'), variant, 'It is very dark.', AV);
  ok(R.radNot(rv, variant.id).omskrivningar[0].till === '> [mörkt] It is very dark.', 'a variant keeps its label');

  // The mirror brings Manus's words: the line has moved on, the rewrite is history.
  const moved = { ...rad, raw: '> Hello you, Shape.', kropp: 'Hello you, Shape.' };
  ok(R.aktuellKropp(moved, R.radNot(regi, rad.id)) === 'Hello you, Shape.', 'after the mirror, md\'s words');
  ok(R.oppenOmskrivning(moved, R.radNot(regi, rad.id)) === null, 'and nothing is open');
  // A refused rewrite does not hold the line.
  const fel = JSON.parse(JSON.stringify(regi));
  fel.rader[rad.id].omskrivningar[0].lage = 'fel';
  ok(R.aktuellKropp(rad, R.radNot(fel, rad.id)) === 'Hello, the walker.', 'a refused rewrite gives md\'s words back');
  ok(!R.vantandeOmskrivningar(fel), 'and nothing waits');
  ok(R.I_MANUS.includes('1en') && !R.I_MANUS.includes('1'), 'the Swedish episode 1 is not in Manus');
}

// --- 7. The live manuscript reads ----------------------------------------------------------------
for (const [dok, fil] of [['1en', 'episode-1'], ['1', 'episod-1'], ['2', 'episod-2'], ['3', 'episod-3']]) {
  const { rader } = R.raderFor(las(`stories/glimt/${fil}.md`), null);
  const talade = rader.filter((r) => r.talad);
  ok(talade.length > 20, `episode ${dok}: ${talade.length} spoken rows`);
  ok(talade.every((r) => R.v4Text(r.kropp) !== '' || /^\(/.test(r.kropp)), `episode ${dok}: every spoken row gives the voice something`);
}

console.log(`${checks - failures}/${checks} ok${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
