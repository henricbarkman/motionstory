#!/usr/bin/env node
// Checks the room (rummet/): reading and writing the real manuscripts byte
// for byte, the line-by-line edits, recorded sound per line, who wrote what,
// proposals that never change the text by themselves, and saves that meet a
// file someone else changed in between. The last part runs the portal's own
// file code (scripts/dashboard/files.py) behind scripts/rummet_provserver.py.
//
//   node scripts/test_rummet.mjs
//   RUMMET_DIR=/some/copy/ node scripts/test_rummet.mjs    # a mutated copy, for mutation tests
//
// Never writes to stories/: every write goes to memory or to a temp folder.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.RUMMET_DIR || join(REPO, 'rummet');
const imp = (f) => import(pathToFileURL(join(DIR, f)).href);
const M = await imp('manus.js');
const L = await imp('ljud.js');
const R = await imp('rum.js');
const D = await imp('data.js');
const S = await imp('lager.js');

let failures = 0;
const check = (ok, what) => { if (!ok || process.env.VERBOSE) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };
let checks = 0;
const ok = (cond, what) => { checks++; check(cond, what); };
const throwsKod = (fn, kod) => { try { fn(); return false; } catch (e) { return e.kod === kod; } };
async function rejectsKod(p, kod) { try { await p; return false; } catch (e) { return e.kod === kod || e.name === kod; } }

// The checks that name particular lines and clips read episode 1 as it was
// recorded (commit ece9bb0, the text episod-1.json was made from). The files
// as they stand now are read too, for everything that must hold for any
// manuscript.
const INSPELAD = 'ece9bb0';
const vidCommit = (c, f) => execFileSync('git', ['-C', REPO, 'show', `${c}:${f}`], { encoding: 'utf8' });
const EP = {
  1: vidCommit(INSPELAD, 'stories/glimt/episod-1.md'),
  2: vidCommit(INSPELAD, 'stories/glimt/episod-2.md'),
};
const NU_EP = {
  1: readFileSync(join(REPO, 'stories/glimt/episod-1.md'), 'utf8'),
  2: readFileSync(join(REPO, 'stories/glimt/episod-2.md'), 'utf8'),
};
const JSON1 = readFileSync(join(REPO, 'stories/glimt/episod-1.json'), 'utf8');
const TIDER = JSON.parse(readFileSync(join(REPO, 'rummet/ljudtider.json'), 'utf8'));

const diffLines = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length !== y.length) return null;
  const ut = [];
  for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) ut.push(k);
  return ut;
};
// b is a with `antal` lines inserted at `vid`.
const insattVid = (a, b, vid, antal) => {
  const x = a.split('\n');
  const y = b.split('\n');
  return y.length === x.length + antal
    && x.slice(0, vid).every((r, k) => r === y[k])
    && x.slice(vid).every((r, k) => r === y[k + vid + antal]);
};
const repliker = (m) => m.rader.filter((r) => r.typ === 'replik' && r.scen != null);

// --- 1. Reading and writing the real manuscripts -------------------------------

const UPPLAGOR = [
  ...[1, 2].map((n) => ({ n, namn: `episod ${n} (${INSPELAD})`, text: EP[n], scener: 7, rader: 80 })),
  ...[1, 2].map((n) => ({ n, namn: `episod ${n} (now)`, text: NU_EP[n], scener: 5, rader: 50 })),
];
for (const { n, namn, text, scener, rader } of UPPLAGOR) {
  const m = M.tolka(text);
  ok(M.skriv(m) === text, `${namn}: read and written back is the same file, byte for byte`);
  ok(m.episod === String(n) && m.scener.length >= scener, `${namn}: title and ${m.scener.length} scenes found`);
  const r = repliker(m);
  ok(r.length > rader, `${namn}: ${r.length} lines people can edit`);

  let enRad = 0;
  let tillbaka = 0;
  let ankare = 0;
  let strukna = 0;
  let vagrade = 0;
  let lagda = 0;
  for (const rad of r) {
    const a = M.ankareFor(m, rad.i);
    if (M.hitta(m, a, { strikt: true }) === rad.i) ankare++;
    const ny = `${rad.kropp} ändrad`;
    const ut = M.andra(text, a, ny);
    const d = diffLines(text, ut.text);
    if (d && d.length === 1 && d[0] === rad.i && ut.text.split('\n')[rad.i] === rad.ra.replace(rad.kropp, '') + ny) enRad++;
    const atert = M.andra(ut.text, M.ankareFor(M.tolka(ut.text), rad.i), rad.kropp);
    if (atert.text === text) tillbaka++;
    try {
      const s = M.stryk(text, a);
      const igen = M.laggTillbaka(s.text, s.struken);
      if (igen.text === text && !igen.reserv) strukna++;
    } catch (e) {
      if (e.kod === 'variant' || e.kod === 'sista-i-blocket') vagrade++;
      else throw e;
    }
    const t = M.laggTill(text, { efter: a }, 'En ny replik.');
    const efter = M.tolka(t.text);
    if (efter.rader[t.i].typ === 'replik' && efter.rader[t.i].kropp === 'En ny replik.' && efter.rader[t.i].scen === rad.scen
        && insattVid(text, t.text, t.i - 1, 2) && M.skriv(efter) === t.text) lagda++;
  }
  ok(ankare === r.length, `${namn}: every line is found again by its anchor (${ankare}/${r.length})`);
  ok(enRad === r.length, `${namn}: changing a line changes exactly that one line (${enRad}/${r.length})`);
  ok(tillbaka === r.length, `${namn}: changing it back gives the original file (${tillbaka}/${r.length})`);
  ok(strukna + vagrade === r.length && strukna > r.length / 2,
    `${namn}: striking and putting back gives the original file (${strukna}; ${vagrade} refused: variants and lone lines)`);
  ok(lagda === r.length, `${namn}: adding after a line inserts exactly ">" and the new line (${lagda}/${r.length})`);
}

// Identical lines: only the one pointed at changes.
{
  const t = '# Glimt, episod 9: Prov\n\nAnteckning.\n\n---\n\n## 0. A\n\n> (väntar)\n>\n> Hej.\n>\n> (väntar)\n>\n> Hej.\n\n---\n\n## Bilaga\n';
  const m = M.tolka(t);
  const andra = repliker(m).filter((r) => r.kropp === 'Hej.')[1];
  const a = M.ankareFor(m, andra.i);
  ok(a.n === 1, 'twin lines: the second one is anchored as the second');
  const ut = M.andra(t, a, 'Hej igen.');
  ok(JSON.stringify(diffLines(t, ut.text)) === JSON.stringify([andra.i]), 'twin lines: only the second one changes');
  ok(M.hitta(m, { scen: '0', text: 'Hej.', n: 5 }, { strikt: true }) === -1, 'a sixth twin that does not exist is not found when it matters');
  ok(throwsKod(() => M.andra(t, { scen: '0', text: 'Finns inte.', n: 0 }, 'x'), 'hittas-inte'), 'a line that is gone is reported, not guessed');
}

// The format is kept by the room: words that would read as something else are refused.
{
  const m = M.tolka(EP[1]);
  const vanlig = repliker(m).find((r) => !r.variant && !r.etikett && M.kroppDelar(r.kropp).slag === 'vega');
  const variant = repliker(m).find((r) => r.variant);
  const a = M.ankareFor(m, vanlig.i);
  for (const [text, kod] of [
    ['[ljust] Det är ljust.', 'krock-format'], ['**Ja, vandraren stannar:**', 'krock-format'],
    ['*Gren:*', 'krock-format'], ['*bara kursiv*', 'krock-format'], ['*Ja:* svar', 'krock-format'],
    ['två\nrader', 'flera-rader'], ['', 'tom'], ['   ', 'tom'],
  ]) ok(throwsKod(() => M.andra(EP[1], a, text), kod), `refused for a plain line: ${JSON.stringify(text)} (${kod})`);
  ok(M.andra(EP[1], a, 'Hon säger (paus) något "annat".').text !== EP[1], 'parentheses and quotes inside the words are allowed');
  const kant = M.andra(EP[1], a, 'Med mellanslag efter. ');
  ok(kant.text.split('\n')[vanlig.i] === `> Med mellanslag efter. ` && M.tolka(kant.text).rader[vanlig.i].kropp === 'Med mellanslag efter. ',
    'a space at the end is saved exactly as typed, and reads back the same');
  ok(M.skriv(M.tolka(kant.text)) === kant.text, 'a line with a trailing space still roundtrips');
  const va = M.andra(EP[1], M.ankareFor(m, variant.i), 'Ny text.');
  ok(va.text.split('\n')[variant.i] === `> [${variant.variant}] Ny text.`, 'a variant keeps its tag: people write only the words');
  ok(M.byggKropp({ slag: 'regi', ord: 'dovt' }) === '(dovt)' && M.kroppDelar('(dovt)').slag === 'regi', 'direction: the room adds the parentheses');
  ok(M.byggKropp({ slag: 'annan', vem: 'lojalisten', ord: 'Vad ordentligt.' }) === '(lojalisten) "Vad ordentligt."', 'another voice: the room adds the format');
  ok(throwsKod(() => M.stryk(EP[1], M.ankareFor(m, variant.i)), 'variant'), 'a variant line is not struck in the room');
}

// --- 2. Recorded sound per line --------------------------------------------------

{
  const m = M.tolka(EP[1]);
  const ljud = L.tolkaLjud(JSON1, TIDER);
  const lagen = { tyst: 0, inspelad: 0, ej: 0 };
  const anvanda = new Set();
  for (const r of repliker(m)) {
    const l = L.ljudFor(r.kropp, ljud);
    lagen[l.lage]++;
    l.delar.forEach((d) => anvanda.add(d.id));
  }
  ok(lagen.ej === 0 && lagen.inspelad >= 70, `episod 1: every spoken line has its recording (${lagen.inspelad} recorded, ${lagen.tyst} silent, ${lagen.ej} missing)`);
  ok(anvanda.size >= 48, `episod 1: ${anvanda.size} of 50 clips are reached from the manuscript (the two reserve lines are not in a scene)`);
  const rad = repliker(m).find((r) => r.kropp.startsWith('Jag vet inte vem du är.'));
  ok(L.ljudFor(rad.kropp, ljud).lage === 'inspelad', 'a line that is the fourth paragraph of a clip is recorded');
  ok(L.ljudFor(rad.kropp.replace('vem du är', 'vad du är'), ljud).lage === 'ej', 'change one word and it is not recorded any more');
  ok(L.ljudFor('(hon räknar under andan. Slingans surr)', ljud).lage === 'tyst', 'a line of direction only has nothing to play');
  const del = L.ljudFor(rad.kropp, ljud).delar[0];
  const t = L.stycketid(ljud, del);
  ok(del.id === 's0' && t.matt && t.fran > 20 && t.till > t.fran, `the paragraph is played from its measured start (${t.fran} to ${t.till} s)`);
  const lojal = repliker(m).find((r) => r.kropp.includes('"God kväll, Vega. Du går fint i kväll."'));
  ok(L.ljudFor(lojal.kropp, ljud).delar.map((d) => d.id).join() === 's5-hon-walk', 'another voice inside a direction plays that voice');
  const ingen = L.ljudFor('Nej. Okej.', null);
  ok(ingen.lage === 'ej', 'an episode without recordings: nothing plays');
}

// --- 3. The room's own notes, through the store, in memory ----------------------

const NU = (() => { let t = Date.parse('2026-10-08T08:00:00Z'); return () => new Date((t += 60000)).toISOString(); })();
let idn = 0;
const ID = () => `id${++idn}`;

function minnesAdapter(filer, vem = 'henric') {
  let klocka = 1;
  const store = new Map(Object.entries(filer).map(([k, t]) => [k, { text: t, version: 1 }]));
  const a = {
    namn: 'minne', kanSkriva: true, store, fore: null, skrivningar: [],
    async vem() { return { id: vem, namn: vem }; },
    async las(p) { const f = store.get(p); return f ? { text: f.text, version: f.version } : null; },
    async skriv(p, text, version) {
      if (a.fore) await a.fore(p);
      const f = store.get(p);
      if (f && f.version !== version) throw new D.Krock(f.version);
      klocka += 1;
      store.set(p, { text, version: klocka });
      a.skrivningar.push(p);
      if (a.efter) await a.efter(p);
      return { version: klocka };
    },
    utifran(p, text) { klocka += 1; store.set(p, { text, version: klocka }); },
    text: (p) => (store.get(p) || {}).text,
  };
  return a;
}

async function grundFor(n) {
  const m = M.tolka(EP[n]);
  return JSON.stringify({ rader: repliker(m).map((r) => r.innehall) });
}

function nyttRum(vem) {
  return minnesAdapter({ 'manus:1': EP[1], 'manus:2': EP[2], 'ljud:1': JSON1 }, vem);
}

{
  const a = nyttRum();
  a.store.set('grund:1', { text: await grundFor(1), version: 1 });
  const lager = S.skapaLager(a, { nu: NU, nyttId: ID });
  let ep = await lager.lasEpisod('1');
  const vy0 = R.vy(ep.manus, ep.rum, ep.grund);
  const alla = repliker(ep.manus);
  ok(alla.every((r) => vy0.rader.get(r.i).skrev.vem === 'demi'), 'untouched: every line in episode 1 is marked as Demi\'s draft');

  // Edit a line: exactly one line changes, and it is Henric's now.
  const rad = alla.find((r) => r.kropp.startsWith('Fortsätt gå, om du kan. Jag pratar så länge.'));
  const ank = M.ankareFor(ep.manus, rad.i);
  await lager.andraRad('1', ank, 'Fortsätt gå. Jag pratar så länge.');
  const efter = a.text('manus:1');
  ok(JSON.stringify(diffLines(EP[1], efter)) === JSON.stringify([rad.i]), 'store: an edit changes exactly one line in the manuscript');
  ep = await lager.lasEpisod('1');
  let vy = R.vy(ep.manus, ep.rum, ep.grund);
  const s = vy.rader.get(rad.i).skrev;
  ok(s.vem === 'henric' && s.hur === 'andrade' && s.tidigare.length === 1 && s.tidigare[0].skrev === 'demi', 'the edited line is Henric\'s, and Demi\'s text is kept as the earlier one');
  ok(L.ljudFor(ep.manus.rader[rad.i].kropp, ep.ljud).lage === 'ej', 'the edited line is not recorded any more');

  // Henric changes another line in the file panel: not anyone's until named.
  const annan = alla.find((r) => r.kropp.startsWith('Så. Nu är du tydlig.'));
  const raa = a.text('manus:1').split('\n');
  raa[annan.i] = '> Så. Nu hör jag dig.';
  a.utifran('manus:1', raa.join('\n'));
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  ok(vy.rader.get(annan.i).skrev.vem === null && vy.rader.get(annan.i).skrev.hur === 'utanfor', 'text changed outside the room is nobody\'s until someone says');
  ok(vy.rader.get(rad.i).skrev.vem === 'henric', 'the change outside did not move the room\'s own record');
  // The line Henric edited in the room is changed again in the file panel:
  // the room's record no longer says this text, so it is not his any more.
  const raa2 = a.text('manus:1').split('\n');
  const hans = raa2[rad.i];
  raa2[rad.i] = '> Någon annan skrev om den.';
  a.utifran('manus:1', raa2.join('\n'));
  ep = await lager.lasEpisod('1');
  ok(R.vy(ep.manus, ep.rum, ep.grund).rader.get(rad.i).skrev.vem === null, 'a room-edited line changed again outside the room is not credited to the room\'s writer');
  raa2[rad.i] = hans;
  a.utifran('manus:1', raa2.join('\n'));
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  await lager.sattNamn('1', M.ankareFor(ep.manus, annan.i), 'henric');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  ok(vy.rader.get(annan.i).skrev.vem === 'henric' && vy.rader.get(annan.i).skrev.hur === 'namn', 'naming it makes it Henric\'s');

  // A proposal lies beside the line and does not change the text.
  const forslagsrad = alla.find((r) => r.kropp.startsWith('Men det gör det.'));
  const fAnk = M.ankareFor(ep.manus, forslagsrad.i);
  const fore = a.text('manus:1');
  const livsLager = S.skapaLager(Object.assign(Object.create(a), { vem: async () => ({ id: 'liv', namn: 'Liv' }) }), { nu: NU, nyttId: ID });
  await livsLager.foresla('1', fAnk, 'Men det gör det. Du går här.');
  ok(a.text('manus:1') === fore, 'a proposal never changes the manuscript by itself');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  const f = vy.rader.get(forslagsrad.i).forslag[0];
  ok(f && f.skrev === 'liv' && f.lage === 'oppet', 'the proposal lies beside the line, with who wrote it');
  await lager.sagJa('1', f.id);
  ok(a.text('manus:1') === fore, 'saying yes does not change the manuscript either');
  ep = await lager.lasEpisod('1');
  ok(ep.rum.forslag[0].ja.map((j) => j.vem).join() === 'henric', 'who said yes is kept');

  // "Lägg in i manus": an explicit act, logged with name and time.
  await lager.laggInForslag('1', f.id);
  const inlagd = a.text('manus:1');
  ok(JSON.stringify(diffLines(fore, inlagd)) === JSON.stringify([forslagsrad.i])
    && inlagd.split('\n')[forslagsrad.i] === '> Men det gör det. Du går här.', 'laying it in changes exactly that line, to the proposed words');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  const sk = vy.rader.get(forslagsrad.i).skrev;
  ok(sk.vem === 'liv' && sk.av === 'henric' && sk.hur === 'forslag', 'the line is Liv\'s words, laid in by Henric');
  const logg = ep.rum.logg.find((x) => x.vad === 'lade-in-forslag');
  ok(logg && logg.vem === 'henric' && /^2026-10-08T/.test(logg.nar) && logg.av === 'liv', 'the log says who laid it in, when, and whose it was');
  ok(sk.tidigare.at(-1).kropp === forslagsrad.kropp && sk.tidigare.at(-1).skrev === 'demi', 'the old text is kept');

  // The old text back: the file is as it was, and the proposal is open again.
  await lager.taTillbakaText('1', M.ankareFor(ep.manus, forslagsrad.i), sk.tidigare.at(-1));
  ok(a.text('manus:1') === fore, 'taking the old text back gives the file as it was');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  ok(vy.rader.get(forslagsrad.i).skrev.vem === 'demi' && ep.rum.forslag[0].lage === 'oppet', 'the line is Demi\'s again and the proposal lies open beside it');

  // Comments: on a line, on a scene, about what is not text.
  await lager.kommentera('1', M.ankareFor(ep.manus, forslagsrad.i), 'Längre paus före.', 'paus');
  await lager.kommentera('1', { scen: '3', text: null }, 'Lampan kommer för fort.', 'nar');
  ok(a.text('manus:1') === fore, 'comments never change the manuscript');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  ok(vy.rader.get(forslagsrad.i).kommentarer[0].galler === 'paus' && vy.scener.get('3').kommentarer[0].galler === 'nar', 'a comment can be about the pause or about when something happens');

  // A comment on a line stays on it when the line is edited, and notes on a
  // twin further down follow when the first twin's text changes.
  {
    const kom = repliker(ep.manus).find((r) => r.kropp.startsWith('Jag går också.'));
    await lager.kommentera('1', M.ankareFor(ep.manus, kom.i), 'Mer torrt.', null);
    await lager.andraRad('1', M.ankareFor(ep.manus, kom.i), 'Jag går också, varje kväll.');
    const e2 = await lager.lasEpisod('1');
    const v2 = R.vy(e2.manus, e2.rum, e2.grund);
    ok(v2.rader.get(kom.i).kommentarer.length === 1 && v2.scener.get('1').losa.length === 0, 'a comment stays on its line when the line is edited in the room');
    await lager.andraRad('1', M.ankareFor(e2.manus, kom.i), kom.kropp);
  }
  {
    const t = '# Glimt, episod 1: Prov\n\nA.\n\n---\n\n## 0. A\n\n> Hej.\n>\n> Mitt.\n>\n> Hej.\n\n---\n\n## Bilaga\n';
    const tw = minnesAdapter({ 'manus:1': t });
    const lt = S.skapaLager(tw, { nu: NU, nyttId: ID });
    let e3 = await lt.lasEpisod('1');
    const [forsta, andra] = repliker(e3.manus).filter((r) => r.kropp === 'Hej.');
    await lt.kommentera('1', M.ankareFor(e3.manus, andra.i), 'Om den andra.', null);
    await lt.andraRad('1', M.ankareFor(e3.manus, forsta.i), 'Hallå.');
    e3 = await lt.lasEpisod('1');
    const v3 = R.vy(e3.manus, e3.rum, null);
    ok(v3.rader.get(andra.i).kommentarer.length === 1 && v3.rader.get(forsta.i).kommentarer.length === 0,
      'twin lines: a note on the second stays on the second when the first one changes');
  }

  // Strike: notes go with the struck line, and come back with it.
  const strykes = alla.find((r) => r.kropp.startsWith('Men det gör det.'));
  await lager.strykRad('1', M.ankareFor(ep.manus, strykes.i));
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  ok(!ep.text.includes('> Men det gör det. Du går här inne.') && ep.rum.strukna.length === 1, 'struck: the line is out and kept in the list');
  ok(vy.scener.get('1').losa.length === 2, 'the notes on the struck line are kept, beside the scene');
  await lager.laggTillbakaRad('1', ep.rum.strukna[0].id);
  ok(a.text('manus:1') === fore, 'putting it back gives the file as it was');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  ok(vy.rader.get(strykes.i).forslag.length === 1 && vy.rader.get(strykes.i).kommentarer.length === 1, 'and the notes are on the line again');

  // A new line.
  await lager.nyRad('1', { efter: M.ankareFor(ep.manus, strykes.i) }, 'En helt ny replik.');
  ep = await lager.lasEpisod('1');
  vy = R.vy(ep.manus, ep.rum, ep.grund);
  const ny = repliker(ep.manus).find((r) => r.kropp === 'En helt ny replik.');
  ok(ny && vy.rader.get(ny.i).skrev.vem === 'henric' && vy.rader.get(ny.i).skrev.hur === 'skrev', 'a new line is Henric\'s');
  ok(vy.rader.get(strykes.i).forslag.length === 1 && vy.rader.get(strykes.i).kommentarer.length === 1 && vy.rader.get(ny.i).forslag.length === 0,
    'notes on other lines stay where they were');
}

// --- 4. Saves that meet a changed file --------------------------------------------

{
  // Someone changes another line between our read and our write.
  const a = nyttRum();
  const lager = S.skapaLager(a, { nu: NU, nyttId: ID });
  const m = M.tolka(EP[1]);
  const var1 = repliker(m)[3];
  const var2 = repliker(m)[20];
  let forsta = true;
  a.fore = (p) => {
    if (p === 'manus:1' && forsta) {
      forsta = false;
      const raa = a.text('manus:1').split('\n');
      raa[var2.i] = '> Demi skrev det här under tiden.';
      a.utifran('manus:1', raa.join('\n'));
    }
  };
  await lager.andraRad('1', M.ankareFor(m, var1.i), 'Min ändring.');
  const t = a.text('manus:1').split('\n');
  ok(t[var1.i] === '> Min ändring.' && t[var2.i] === '> Demi skrev det här under tiden.', 'a 409 in between: the save starts over and both changes are kept');
  ok(diffLines(EP[1], a.text('manus:1')).length === 2, 'and nothing else in the file changed');

  // Someone changes the very line we are saving: we stop, their text stays.
  const b = nyttRum();
  const lb = S.skapaLager(b, { nu: NU, nyttId: ID });
  let gang = true;
  b.fore = (p) => {
    if (p === 'manus:1' && gang) {
      gang = false;
      const raa = b.text('manus:1').split('\n');
      raa[var1.i] = '> Henric skrev det här i filpanelen.';
      b.utifran('manus:1', raa.join('\n'));
    }
  };
  ok(await rejectsKod(lb.andraRad('1', M.ankareFor(m, var1.i), 'Min ändring.'), 'hittas-inte'), 'the same line changed in between: the save stops and says so');
  ok(b.text('manus:1').split('\n')[var1.i] === '> Henric skrev det här i filpanelen.' && diffLines(EP[1], b.text('manus:1')).length === 1, 'and the other person\'s text is untouched');
  ok(!b.store.has('rum:1'), 'and nothing is noted about a change that was not made');

  // A file that keeps changing: give up after a few tries, write nothing.
  const c = nyttRum();
  const lc = S.skapaLager(c, { nu: NU, nyttId: ID });
  let varv = 0;
  c.fore = (p) => { if (p === 'manus:1') { varv++; c.utifran('manus:1', c.text('manus:1')); } };
  ok(await rejectsKod(lc.andraRad('1', M.ankareFor(m, var1.i), 'x'), 'upptagen') && c.text('manus:1') === EP[1] && varv === 6,
    'a file that changes on every try: stop after six, the text untouched');

  // A broken notes file: nothing is written, not even the manuscript.
  const d = nyttRum();
  d.store.set('rum:1', { text: '{ trasig', version: 1 });
  const ld = S.skapaLager(d, { nu: NU, nyttId: ID });
  ok(await rejectsKod(ld.andraRad('1', M.ankareFor(m, var1.i), 'x'), 'trasig') && d.text('manus:1') === EP[1] && d.text('rum:1') === '{ trasig',
    'a broken notes file stops the save before anything is written');
  ok(await rejectsKod(ld.foresla('1', M.ankareFor(m, var1.i), 'x'), 'trasig') && d.text('rum:1') === '{ trasig', 'and is never overwritten with an empty room');
  const epd = await ld.lasEpisod('1');
  ok(epd.rumFel && epd.rumFel.kod === 'trasig', 'reading tells the room the notes could not be read');

  // The manuscript is saved but the note fails: said so, and sent later.
  const e = nyttRum();
  const le = S.skapaLager(e, { nu: NU, nyttId: ID });
  let natet = false;
  e.fore = (p) => { if (p === 'rum:1' && !natet) throw new Error('nätet borta'); };
  ok(await rejectsKod(le.andraRad('1', M.ankareFor(m, var1.i), 'Sparad ändå.'), 'halvt') && e.text('manus:1').split('\n')[var1.i] === '> Sparad ändå.',
    'the text is saved even when the note about it does not get through');
  natet = true;
  await le.forsokIgen();
  const epe = await le.lasEpisod('1');
  ok(R.vy(epe.manus, epe.rum, null).rader.get(var1.i).skrev.vem === 'henric', 'trying again sends the note: the line is Henric\'s');

  // Read-only: nothing can be written.
  const ro = S.skapaLager({ ...nyttRum(), kanSkriva: false, vem: async () => null });
  ok(await rejectsKod(ro.andraRad('1', M.ankareFor(m, var1.i), 'x'), 'laslage'), 'read-only: a save is refused');
}

// --- 5. Lore pages ---------------------------------------------------------------

{
  const a = minnesAdapter({});
  const lager = S.skapaLager(a, { nu: NU, nyttId: ID });
  const text = 'Rör sig i Huset.\n\nIngen vet <b>vem</b> & varför.  ';
  const id = await lager.nyLoresida('Kollektivet', text);
  let lore = await lager.lasLore();
  ok(R.loreText(lore.sidor[0]) === text && lore.sidor[0].titel === 'Kollektivet' && lore.sidor[0].skrev === 'henric', 'a lore page keeps exactly what was typed, with who and when');
  const sedd = lore.sidor[0].skapad;
  // Henric on the phone saves the page while it is open on the desktop too.
  await S.skapaLager(a, { nu: NU, nyttId: ID }).andraLoresida(id, 'Kollektivet', 'Från telefonen.');
  const svar = await lager.andraLoresida(id, 'Kollektivet', 'Från datorn.', sedd);
  lore = await lager.lasLore();
  ok(svar.krockade && R.loreText(lore.sidor[0]) === 'Från datorn.' && lore.sidor[0].versioner.some((v) => v.text.join('\n') === 'Från telefonen.'),
    'the same page saved from two places: the later is shown, the other is kept among the versions, and it is said');
  const livs = S.skapaLager(Object.assign(Object.create(a), { vem: async () => ({ id: 'liv', namn: 'Liv' }) }), { nu: NU, nyttId: ID });
  const fore = a.text('lore');
  ok(await rejectsKod(livs.andraLoresida(id, 'Kollektivet', 'Livs version.'), 'inte-din') && a.text('lore') === fore,
    'someone else\'s page cannot be changed: Liv gets a no and the file is untouched');
  ok(await rejectsKod(livs.taBortLoresida(id), 'inte-din') && a.text('lore') === fore, 'nor removed');
  await lager.taBortLoresida(id);
  lore = await lager.lasLore();
  ok(lore.sidor[0].borta && R.loreText(lore.sidor[0]) === 'Från datorn.', 'removing a page hides it and keeps it');
  ok(await rejectsKod(livs.hamtaTillbakaLoresida(id), 'inte-din'), 'and only its writer brings it back');
  await lager.hamtaTillbakaLoresida(id);
  ok(!(await lager.lasLore()).sidor[0].borta, 'which the writer can');
  ok(throwsKod(() => R.lasLore('[1,2'), 'trasig'), 'a broken lore file is an error, not an empty list');
}

// --- 5a. The markdown reader (world book, HELD's lore) -------------------------------
// Run in a child with a tiny stand-in for the browser's document, and a time
// limit, so a reader that loops forever fails the check instead of the run.
{
  const prog = `
    const nod = (tag) => ({ tag, barn: [], append(...b) { for (const x of b) { if (x == null) continue; if (typeof x === 'string') this.barn.push({ tag: '#text', text: x }); else if (x.tag === '#frag') this.barn.push(...x.barn); else this.barn.push(x); } }, get lastChild() { return this.barn.at(-1) || null; } });
    globalThis.document = { createElement: nod, createDocumentFragment: () => nod('#frag'), createTextNode: (text) => ({ tag: '#text', text }) };
    const { renderMd } = await import(${JSON.stringify(pathToFileURL(join(DIR, 'md.js')).href)});
    const lankar = (n, ut = []) => { if (n.tag === 'a') ut.push(n.href); for (const b of n.barn || []) lankar(b, ut); return ut; };
    const text = (n) => n.tag === '#text' ? n.text : (n.barn || []).map(text).join('');
    const pipa = renderMd('| inte en tabell\\nfortsätter\\n\\n|ensam');
    const l = lankar(renderMd('[a](https://x.se) [b](//ond.se) [c](/\\\\ond.se) [d](#rubrik) [e](./sida.md) [f](../upp.md) [g](javascript:alert(1)) [h](/rot)'));
    process.stdout.write(JSON.stringify({ pipa: text(pipa), lankar: l }));
  `;
  const r = spawnSync('node', ['--input-type=module', '-e', prog], { encoding: 'utf8', timeout: 10000 });
  let ut = null;
  try { ut = JSON.parse(r.stdout); } catch { ut = null; }
  ok(r.status === 0 && ut && ut.pipa.includes('inte en tabell') && ut.pipa.includes('ensam'), 'markdown: a "|" line that is no table is read as text, without hanging');
  ok(ut && JSON.stringify(ut.lankar) === JSON.stringify(['https://x.se', '#rubrik', './sida.md', '../upp.md']),
    `markdown: links go only to http(s), a heading or a file beside it (${ut && ut.lankar.join(' ')})`);
}

// --- 5b. Finding the right one of two identical lines -----------------------------

{
  const t = '# Glimt, episod 1: Prov\n\nA.\n\n---\n\n## 0. A\n\n> Hej.\n>\n> A.\n>\n> Hej.\n>\n> B.\n\n## 1. B\n\n> Annat.\n\n---\n\n## Bilaga\n';
  const m = M.tolka(t);
  const [forsta, andra] = repliker(m).filter((r) => r.kropp === 'Hej.');
  const a = M.ankareFor(m, andra.i);
  ok(a.n === 1 && a.fore === 'A.' && a.efter === 'B.', 'an anchor carries the lines just before and after');
  // Someone puts one more "Hej." first in the scene, outside the room.
  const t2 = t.replace('## 0. A\n\n> Hej.', '## 0. A\n\n> Hej.\n>\n> Ny.\n>\n> Hej.');
  const m2 = M.tolka(t2);
  const ratt = repliker(m2).filter((r) => r.kropp === 'Hej.').find((r) => m2.rader[r.i + 2].innehall === 'B.');
  ok(M.hitta(m2, a, { strikt: true }) === ratt.i, 'a twin added above: the neighbours still find the line that was meant');
  ok(M.hitta(m2, { scen: a.scen, text: a.text, n: a.n }, { strikt: true }) !== ratt.i, 'control: by position alone it would have been the wrong twin');
  const ut = M.andra(t2, a, 'Hej igen.');
  ok(ut.text.split('\n')[ratt.i] === '> Hej igen.' && diffLines(t2, ut.text).length === 1, 'and the edit lands on that line only');
  // The first twin is removed: the second is the only "Hej." left, its n is stale.
  const t3 = t.replace('> Hej.\n>\n> A.', '> A.');
  const m3 = M.tolka(t3);
  ok(M.hitta(m3, a, { strikt: true }) === repliker(m3).find((r) => r.kropp === 'Hej.').i, 'the other twin removed: the line is still found');
  // Both neighbours changed and two identical lines: strict says no rather than guess.
  const t4 = t2.replace('> A.', '> X.').replace('> B.', '> Y.').replace('> Ny.', '> Z.');
  ok(M.hitta(M.tolka(t4), a, { strikt: true }) === -1, 'twins whose neighbours all changed: strict finding refuses to guess');
  // A line moved to another scene is not found there.
  const t5 = t.replace('> Hej.\n>\n> B.', '> B.').replace('> Annat.', '> Annat.\n>\n> Hej.');
  const m5 = M.tolka(t5);
  ok(M.hitta(m5, a) !== repliker(m5).find((r) => r.scen === '1' && r.kropp === 'Hej.').i, 'a line is never looked for in another scene');
  ok(M.hitta(m, forsta && M.ankareFor(m, forsta.i), { strikt: true }) === forsta.i, 'the first twin is found as itself');
}

// Who wrote a line is never taken from a line in another scene.
{
  const t = '# Glimt, episod 1: Prov\n\nA.\n\n---\n\n## 0. A\n\n> Ett.\n>\n> Två.\n\n## 1. B\n\n> Tre.\n\n---\n\n## Bilaga\n';
  const a = minnesAdapter({ 'manus:1': t, 'grund:1': JSON.stringify({ rader: ['Ett.', 'Två.', 'Tre.'] }) });
  const lager = S.skapaLager(a, { nu: NU, nyttId: ID });
  let ep = await lager.lasEpisod('1');
  await lager.andraRad('1', M.ankareFor(ep.manus, repliker(ep.manus)[0].i), 'Henrics rad.');
  // Outside the room the line is moved to scene 1.
  a.utifran('manus:1', a.text('manus:1').replace('> Henrics rad.\n>\n', '').replace('> Tre.', '> Tre.\n>\n> Henrics rad.'));
  ep = await lager.lasEpisod('1');
  const flyttad = repliker(ep.manus).find((r) => r.kropp === 'Henrics rad.');
  const skrev = R.vy(ep.manus, ep.rum, ep.grund).rader.get(flyttad.i).skrev;
  ok(flyttad.scen === '1' && skrev.vem === null && skrev.hur === 'utanfor', 'a line moved to another scene outside the room is not credited to anyone');
}

// --- 5c. Notes that wait, a lost answer, and a proposal that is already the text ----

{
  const m = M.tolka(EP[1]);
  const rad = repliker(m)[3];
  const annan = repliker(m)[9];
  const minne = { data: null, las() { return this.data ? JSON.parse(this.data) : null; }, skriv(v) { this.data = JSON.stringify(v); } };
  const a = nyttRum();
  let natet = false;
  a.fore = (p) => { if (p === 'rum:1' && !natet) throw new TypeError('Failed to fetch'); };
  const l1 = S.skapaLager(a, { nu: NU, nyttId: ID, ko: minne });
  ok(await rejectsKod(l1.andraRad('1', M.ankareFor(m, rad.i), 'Sparad, anteckningen väntar.'), 'halvt'), 'the note does not get through: said so');
  ok(minne.las() && minne.las().length === 1 && minne.las()[0].typ === 'andrad', 'the waiting note is kept in the browser, as plain data');
  // The page is reloaded while the network is still away.
  const l2 = S.skapaLager(a, { nu: NU, nyttId: ID, ko: minne });
  ok(l2.vantar.length === 1, 'after a reload the note still waits');
  const manusFore = a.text('manus:1');
  ok(await rejectsKod(l2.foresla('1', M.ankareFor(m, annan.i), 'Ett förslag.'), 'efterslapar') && !a.store.has('rum:1') && a.text('manus:1') === manusFore,
    'nothing new is saved while an older note waits, and nothing is written');
  ok(await rejectsKod(l2.andraRad('1', M.ankareFor(m, annan.i), 'Ny text.'), 'efterslapar') && a.text('manus:1') === manusFore,
    'not even the manuscript');
  natet = true;
  await l2.foresla('1', M.ankareFor(m, annan.i), 'Ett förslag.');
  const ep = await l2.lasEpisod('1');
  const vy = R.vy(ep.manus, ep.rum, null);
  ok(vy.rader.get(rad.i).skrev.vem === 'henric' && ep.rum.forslag.length === 1 && minne.las().length === 0,
    'with the network back, the old note goes first and then the new one: both are there, the queue is empty');
  ok(ep.rum.logg.findIndex((x) => x.vad === 'andrade') === 0, 'the waiting note was saved before the proposal');

  // Pressing save again on the same edit sends the note.
  const b = nyttRum();
  let natB = false;
  b.fore = (p) => { if (p === 'rum:1' && !natB) throw new TypeError('Failed to fetch'); };
  const lb = S.skapaLager(b, { nu: NU, nyttId: ID });
  await rejectsKod(lb.andraRad('1', M.ankareFor(m, rad.i), 'Igen.'), 'halvt');
  natB = true;
  await lb.andraRad('1', M.ankareFor(M.tolka(b.text('manus:1')), rad.i), 'Igen.');
  const epb = await lb.lasEpisod('1');
  ok(R.vy(epb.manus, epb.rum, null).rader.get(rad.i).skrev.vem === 'henric' && epb.rum.rader.length === 1, 'saving the same text again records the note, once');

  // A note whose proposal is gone by the time it is sent is dropped, and the queue moves on.
  const c = nyttRum();
  const gammal = { typ: 'steg', nr: '1', fore: EP[1], efter: EP[1], i: rad.i, skift: null, vem: 'henric', nar: NU(), foreKropp: rad.kropp, steg: [{ typ: 'inlagt', id: 'finns-inte' }] };
  const lc = S.skapaLager(c, { nu: NU, nyttId: ID, ko: { las: () => [gammal], skriv() {} } });
  await lc.kommentera('1', M.ankareFor(m, rad.i), 'Går fram ändå.');
  ok(lc.vantar.length === 0 && JSON.parse(c.text('rum:1')).kommentarer.length === 1, 'a note that can no longer apply is dropped, not stuck');

  // The write went through but the answer was lost on the way back.
  const d = nyttRum();
  let svaret = true;
  d.efter = (p) => { if (p === 'manus:1' && svaret) { svaret = false; throw new TypeError('Failed to fetch'); } };
  const ld = S.skapaLager(d, { nu: NU, nyttId: ID });
  await ld.andraRad('1', M.ankareFor(m, rad.i), 'Svaret kom bort.');
  const epd = await ld.lasEpisod('1');
  ok(!svaret && d.text('manus:1').split('\n')[rad.i] === '> Svaret kom bort.' && R.vy(epd.manus, epd.rum, null).rader.get(rad.i).skrev.vem === 'henric',
    'a lost answer after a write that went through: read back, seen as saved, and the note follows');

  // A proposal whose words are already the line: laid in, logged, text untouched.
  const e = nyttRum();
  const le = S.skapaLager(e, { nu: NU, nyttId: ID });
  await le.foresla('1', M.ankareFor(m, rad.i), rad.kropp);
  const id = JSON.parse(e.text('rum:1')).forslag[0].id;
  await le.laggInForslag('1', id);
  const rume = JSON.parse(e.text('rum:1'));
  ok(e.text('manus:1') === EP[1] && rume.forslag[0].lage === 'inlagt' && rume.logg.some((x) => x.vad === 'lade-in-forslag'),
    'a proposal that says what the line already says: marked as laid in and logged, the file untouched');
}

// --- 5d. Demi in the room ------------------------------------------------------------

{
  const a = nyttRum();
  a.store.set('grund:1', { text: await grundFor(1), version: 1 });
  const som = (vem) => S.skapaLager(Object.assign(Object.create(a), { vem: async () => ({ id: vem, namn: D.PERSONER[vem].namn }) }), { nu: NU, nyttId: ID });
  const henric = S.skapaLager(a, { nu: NU, nyttId: ID });
  const liv = som('liv');
  const demi = som('demi');
  const m = M.tolka(EP[1]);
  const rad = repliker(m).find((r) => r.kropp.startsWith('Så. Nu är du tydlig.'));
  const ank = M.ankareFor(m, rad.i);
  ok(R.arAI('demi') && !R.arAI('henric') && !R.arAI('liv'), 'Demi is an AI in the room; Henric and Liv are not');

  // Demi writes its own posts.
  await demi.foresla('1', ank, 'Så. Nu hör jag dig tydligt.');
  const kid = await demi.kommentera('1', ank, 'Pausen före kan vara längre.', 'paus');
  await demi.nyLoresida('Slingan', 'Den surrar.');
  let rum = JSON.parse(a.text('rum:1'));
  ok(rum.forslag[0].skrev === 'demi' && rum.kommentarer[0].skrev === 'demi' && JSON.parse(a.text('lore')).sidor[0].skrev === 'demi',
    'Demi can propose, comment and write a lore page, each marked as Demi\'s');
  ok(a.text('manus:1') === EP[1], 'none of it touches the manuscript');

  // Demi never decides.
  const manus0 = a.text('manus:1');
  const rum0 = a.text('rum:1');
  for (const [vad, p] of [
    ['change a line', demi.andraRad('1', ank, 'Demi skriver om.')],
    ['add a line', demi.nyRad('1', { efter: ank }, 'Ny.')],
    ['strike a line', demi.strykRad('1', ank)],
    ['say whose a line is', demi.sattNamn('1', ank, 'demi')],
    ['say yes', demi.sagJa('1', rum.forslag[0].id)],
    ['lay a proposal in', demi.laggInForslag('1', rum.forslag[0].id)],
  ]) ok(await rejectsKod(p, 'bara-manniskor'), `Demi cannot ${vad}`);
  ok(a.text('manus:1') === manus0 && a.text('rum:1') === rum0, 'and the files are untouched by all of it');
  // The notes' own rules say the same, without the store in front of them.
  {
    const r0 = JSON.parse(rum0);
    const fid = r0.forslag[0].id;
    const allt = { manusFore: m, manusEfter: m, karta: (i) => i, manus: m, i: rad.i, id: fid, skrev: 'demi', vem: 'demi', nar: NU(), grund: null, struken: {} };
    for (const fn of ['efterAndrad', 'efterTillagd', 'efterStruken', 'efterTillbakalagd', 'sattNamn', 'sagJa', 'forslagInlagt', 'forslagOppnatIgen']) {
      ok(throwsKod(() => R[fn](r0, allt), 'bara-manniskor'), `rum.js: ${fn} is for people only`);
    }
  }

  // Nobody changes someone else's words.
  const hid = await henric.kommentera('1', ank, 'Henrics kommentar.');
  await liv.foresla('1', ank, 'Livs förslag.');
  await henric.nyLoresida('Huset', 'Henrics sida.');
  rum = JSON.parse(a.text('rum:1'));
  const livsF = rum.forslag.find((f) => f.skrev === 'liv').id;
  const demisF = rum.forslag.find((f) => f.skrev === 'demi').id;
  const lore = JSON.parse(a.text('lore')).sidor;
  const hSida = lore.find((x) => x.skrev === 'henric').id;
  const dSida = lore.find((x) => x.skrev === 'demi').id;
  const fore = [a.text('rum:1'), a.text('lore')];
  for (const [vad, p] of [
    ['Demi removes Henric\'s comment', demi.taBortKommentar('1', hid)],
    ['Demi withdraws Liv\'s proposal', demi.draUndanForslag('1', livsF)],
    ['Demi changes Henric\'s lore page', demi.andraLoresida(hSida, 'Huset', 'Demis text.')],
    ['Demi removes Henric\'s lore page', demi.taBortLoresida(hSida)],
    ['Demi marks Henric\'s comment done', demi.kommentarKlar('1', hid)],
    ['Henric removes Demi\'s comment', henric.taBortKommentar('1', kid)],
    ['Henric withdraws Demi\'s proposal', henric.draUndanForslag('1', demisF)],
    ['Henric changes Demi\'s lore page', henric.andraLoresida(dSida, 'Slingan', 'Henrics text.')],
    ['Liv removes Henric\'s comment', liv.taBortKommentar('1', hid)],
  ]) ok(await rejectsKod(p, 'inte-din'), `refused: ${vad}`);
  ok(a.text('rum:1') === fore[0] && a.text('lore') === fore[1], 'and nothing was written');
  await henric.kommentarKlar('1', kid);
  ok(JSON.parse(a.text('rum:1')).kommentarer.find((k) => k.id === kid).klar.av === 'henric', 'a person can mark Demi\'s comment done: a status, not its words');
  await demi.draUndanForslag('1', demisF);
  ok(JSON.parse(a.text('rum:1')).forslag.find((f) => f.id === demisF).lage === 'undan', 'Demi withdraws its own proposal');

  // A person lays in Demi's words: the line is Demi's, laid in by Henric.
  await demi.foresla('1', ank, 'Så. Nu hör jag dig.');
  const nyF = JSON.parse(a.text('rum:1')).forslag.at(-1).id;
  await henric.sagJa('1', nyF);
  await henric.laggInForslag('1', nyF);
  const ep = await henric.lasEpisod('1');
  const sk = R.vy(ep.manus, ep.rum, ep.grund).rader.get(rad.i).skrev;
  ok(a.text('manus:1').split('\n')[rad.i] === '> Så. Nu hör jag dig.' && sk.vem === 'demi' && sk.av === 'henric' && sk.hur === 'forslag',
    'Henric lays in Demi\'s proposal: the words are Demi\'s, the act is Henric\'s');

  // Asking Demi, and Demi answering in the thread.
  const fraga = await henric.kommentera('1', ank, 'Demi, varför pausen?', null, { till: 'demi' });
  let e2 = await henric.lasEpisod('1');
  let v2 = R.vy(e2.manus, e2.rum, e2.grund);
  ok(v2.vantar.has(fraga) && R.vantarPa(e2.rum, 'demi').length === 1, 'a comment to Demi waits for an answer');
  const svar = await demi.svara('1', fraga, 'För att hon lyssnar.');
  e2 = await henric.lasEpisod('1');
  v2 = R.vy(e2.manus, e2.rum, e2.grund);
  const s1 = e2.rum.kommentarer.find((k) => k.id === svar);
  ok(!v2.vantar.has(fraga) && v2.svar.get(fraga).map((k) => k.id).join() === svar && s1.svarPa === fraga && s1.mal.text === ank.text,
    'Demi answers in the thread: no longer waiting, the answer hangs under the question');
  const somEgen = [...v2.rader.values()].flatMap((x) => x.kommentarer)
    .concat([...v2.scener.values()].flatMap((x) => [...x.kommentarer, ...x.losa.map((l) => l.post)]));
  ok(somEgen.some((k) => k.id === fraga) && !somEgen.some((k) => k.id === svar), 'a reply is shown in its thread, never as a comment of its own');
  const foljd = await henric.svara('1', svar, 'Och efter?', { till: 'demi' });
  e2 = await henric.lasEpisod('1');
  ok(e2.rum.kommentarer.find((k) => k.id === foljd).svarPa === fraga && R.vantarPa(e2.rum, 'demi').map((k) => k.id).join() === foljd,
    'a reply to a reply joins the same thread, and a new question to Demi waits again');
  await henric.kommentarKlar('1', fraga);
  e2 = await henric.lasEpisod('1');
  ok(R.vantarPa(e2.rum, 'demi').length === 0, 'a thread marked done waits for nobody');
  const pSvar = await liv.svara('1', livsF, 'Jag menar så här.');
  e2 = await henric.lasEpisod('1');
  ok(R.vy(e2.manus, e2.rum, e2.grund).svar.get(livsF)[0].id === pSvar, 'a proposal can be answered too');
  ok(await rejectsKod(henric.svara('1', 'finns-inte', 'x'), 'saknas'), 'answering something that is gone is refused');

  // Hiding Demi: a setting per person, kept in a small file.
  ok((await henric.lasInstallningar()).doljDemi === false && (await liv.lasInstallningar()).doljDemi === true,
    'by default Henric sees Demi\'s posts and Liv does not');
  await henric.sattInstallning('doljDemi', true);
  ok((await henric.lasInstallningar()).doljDemi === true && (await liv.lasInstallningar()).doljDemi === true, 'Henric hides them for himself');
  await liv.sattInstallning('doljDemi', false);
  ok((await liv.lasInstallningar()).doljDemi === false && (await henric.lasInstallningar()).doljDemi === true, 'each person\'s choice is their own');
  ok(await rejectsKod(henric.sattInstallning('allt', true), 'okand'), 'an unknown setting is refused');
}

// A record of who wrote a line holds only while something ties it to that
// line: twins whose neighbours all changed are credited to nobody.
{
  const t = '# Glimt, episod 1: Prov\n\nA.\n\n---\n\n## 0. A\n\n> A\n>\n> Ja.\n>\n> B\n>\n> Ja.\n>\n> C\n\n---\n\n## Bilaga\n';
  const m = M.tolka(t);
  const tva = repliker(m).filter((r) => r.kropp === 'Ja.');
  const rum = R.tomtRum('1');
  rum.rader.push({ mal: M.ankareFor(m, tva[1].i), skrev: 'henric', nar: NU(), hur: 'andrade', tidigare: [] });
  ok(R.skrevRad(m, rum, new Set(), tva[1].i).vem === 'henric' && R.skrevRad(m, rum, new Set(), tva[0].i).vem === null,
    'twins: the record credits the one Henric wrote, not its twin');
  const t2 = t.replace('> A\n', '> A2\n').replace('> B\n', '> B2\n').replace('> C\n', '> C2\n');
  const m2 = M.tolka(t2);
  const tva2 = repliker(m2).filter((r) => r.kropp === 'Ja.');
  ok(tva2.every((r) => R.skrevRad(m2, rum, new Set(), r.i).hur === 'utanfor'),
    'twins whose neighbours all changed outside: credited to nobody, read as changed outside the room');
}

// --- 5f. Waiting, threads and the queue, under clocks and windows that disagree --

{
  const m = M.tolka(EP[1]);
  const rad = repliker(m)[3];
  const ank = M.ankareFor(m, rad.i);
  const post = (id, skrev, nar, extra = {}) => ({ id, mal: ank, text: id, galler: null, skrev, nar, ...extra });

  // The order in the file decides, never the clocks.
  let rum = R.tomtRum('1');
  rum.kommentarer.push(post('q1', 'henric', '2026-10-08T12:00:00.000Z', { till: 'demi' }));
  rum.kommentarer.push(post('s1', 'demi', '2026-10-08T11:58:00.000Z', { svarPa: 'q1' })); // the mini-PC is two minutes behind
  ok(R.vantarPa(rum, 'demi').length === 0, 'clocks: an answer stamped before the question but written after it counts');
  rum.kommentarer.push(post('q2', 'henric', '2026-10-08T11:57:00.000Z', { svarPa: 'q1', till: 'demi' })); // the phone is behind
  ok(R.vantarPa(rum, 'demi').map((k) => k.id).join() === 'q2', 'clocks: a new question stamped before the last answer still waits');

  // A thread closed by a decision or by a person waits for nobody; Demi cannot close it.
  rum = R.tomtRum('1');
  rum.forslag.push({ id: 'f1', mal: ank, kropp: 'Nytt.', skrev: 'liv', nar: NU(), lage: 'oppet', ja: [] });
  rum.kommentarer.push(post('q3', 'henric', NU(), { svarPa: 'f1', till: 'demi' }));
  ok(R.vantarPa(rum, 'demi').length === 1, 'a question on an open proposal waits');
  rum.forslag[0].lage = 'inlagt';
  ok(R.vantarPa(rum, 'demi').length === 0, 'a proposal laid in closes its thread');
  rum = R.tomtRum('1');
  rum.kommentarer.push(post('d1', 'demi', NU()));
  rum.kommentarer.push(post('q4', 'henric', NU(), { svarPa: 'd1', till: 'demi' }));
  rum = R.kommentarKlar(rum, { id: 'd1', vem: 'demi', nar: NU() });
  ok(R.vantarPa(rum, 'demi').length === 1, 'Demi marking its own comment done does not silence a question to it');
  rum = R.kommentarKlar(rum, { id: 'd1', vem: 'henric', nar: NU() });
  ok(throwsKod(() => R.kommentarKlar(rum, { id: 'd1', vem: 'demi', nar: NU(), klar: false }), 'bara-manniskor'),
    'Demi cannot open a thread a person closed');

  // Removing a first post would hide the others' replies: refused.
  rum = R.tomtRum('1');
  rum.kommentarer.push(post('h1', 'henric', NU()));
  rum.kommentarer.push(post('l1', 'liv', NU(), { svarPa: 'h1' }));
  ok(throwsKod(() => R.taBortKommentar(rum, { id: 'h1', vem: 'henric', nar: NU() }), 'har-svar'), 'a comment others have answered cannot be removed');
  rum.kommentarer.push(post('h2', 'henric', NU(), { svarPa: 'h1' }));
  ok(R.taBortKommentar(rum, { id: 'h2', vem: 'henric', nar: NU() }).kommentarer.find((k) => k.id === 'h2').borta, 'one\'s own reply can be removed');

  // A proposal laid in cannot be withdrawn afterwards.
  rum = R.tomtRum('1');
  rum.forslag.push({ id: 'f2', mal: ank, kropp: 'Nytt.', skrev: 'liv', nar: NU(), lage: 'inlagt', ja: [] });
  ok(throwsKod(() => R.draUndanForslag(rum, { id: 'f2', vem: 'liv', nar: NU() }), 'inte-oppet'), 'a proposal laid in cannot be withdrawn');
  ok(throwsKod(() => R.nyKommentar(R.tomtRum('1'), { id: 'x', mal: ank, text: 'x', vem: 'henric', nar: NU(), till: 'toString' }), 'okand'),
    'asking someone who is not in the room is refused');

  // Twins: once only one is left, the first twin's anchor does not land on the second.
  const t = '# Glimt, episod 1: Prov\n\nA.\n\n---\n\n## 0. A\n\n> A\n>\n> Ja.\n>\n> B\n>\n> Ja.\n>\n> C\n\n---\n\n## Bilaga\n';
  const tm = M.tolka(t);
  const forsta = M.ankareFor(tm, repliker(tm).find((r) => r.kropp === 'Ja.').i);
  const t2 = M.tolka(t.replace('> Ja.\n>\n> B', '> Nej.\n>\n> B'));
  ok(forsta.tvillingar === 2 && M.hitta(t2, forsta, { strikt: true }) === -1, 'twins: the first one changed, its anchor does not move to the second');

  // Two windows with the same waiting note: it is applied once.
  let lagring = null;
  const ko = { las: () => (lagring ? JSON.parse(lagring) : null), skriv: (v) => { lagring = JSON.stringify(v); } };
  const a = nyttRum();
  let natet = false;
  a.fore = (p) => { if (p === 'rum:1' && !natet) throw new TypeError('Failed to fetch'); };
  const f1 = S.skapaLager(a, { nu: NU, nyttId: ID, ko });
  await rejectsKod(f1.andraRad('1', ank, 'Två fönster.'), 'halvt');
  const f2 = S.skapaLager(a, { nu: NU, nyttId: ID, ko });
  natet = true;
  ok(f2.vantar.length === 1, 'window 2 loaded the same waiting note');
  await f1.forsokIgen();
  await f2.forsokIgen();
  const rf = JSON.parse(a.text('rum:1'));
  ok(rf.rader.length === 1 && rf.logg.filter((l) => l.vad === 'andrade').length === 1 && rf.logg[0].avsikt,
    'two windows send the same note: it is in the file once, marked with its id');
  // Applying a stored note twice by hand: the second time changes nothing.
  const tidigare = a.text('rum:1');
  const gammal = { ...JSON.parse(JSON.stringify(rf.logg[0])) };
  ok(gammal.avsikt && lagring === '[]', 'the shared list is empty after the note went through');
  lagring = JSON.stringify([{ typ: 'andrad', nr: '1', fore: EP[1], efter: a.text('manus:1'), i: rad.i, skift: null, vem: 'henric', nar: NU(), aid: gammal.avsikt, post: {} }]);
  const f3 = S.skapaLager(a, { nu: NU, nyttId: ID, ko });
  await f3.forsokIgen();
  ok(a.text('rum:1') === tidigare && lagring === '[]', 'a note already in the file is recognised by its id and not applied again');

  // Junk in the browser's list never blocks saving.
  lagring = JSON.stringify([null, { typ: 'okand' }, 'x', { typ: 'andrad', nr: 1 }]);
  const f4 = S.skapaLager(a, { nu: NU, nyttId: ID, ko });
  ok(f4.vantar.length === 0 && lagring === '[]', 'junk in the stored list is dropped on load');
  await f4.kommentera('1', ank, 'Går fram.');
  ok(JSON.parse(a.text('rum:1')).kommentarer.some((k) => k.text === 'Går fram.'), 'and saving goes on');
  // A note that cannot be applied (its text is not a manuscript) is dropped, not retried forever.
  lagring = JSON.stringify([{ typ: 'andrad', nr: '1', fore: EP[1], efter: EP[1], i: 99999, skift: null, vem: 'henric', nar: NU(), aid: 'trasig-1', post: {} }]);
  const f5 = S.skapaLager(a, { nu: NU, nyttId: ID, ko });
  await f5.kommentera('1', ank, 'Också fram.');
  ok(lagring === '[]' && JSON.parse(a.text('rum:1')).kommentarer.some((k) => k.text === 'Också fram.'), 'a note that cannot apply is dropped and saving goes on');
  f5.slangVantande();
  ok(f5.vantar.length === 0, 'waiting notes can be thrown away');
}

// --- 5e. The manuscript as it is now, against the baseline of the recorded draft ----
// Draft 3 rewrote much of episode 1 outside the room. Lines it changed must read
// as changed outside the room, never as Henric's; lines it kept stay Demi's.
{
  const g = R.lasGrund(JSON.stringify({ rader: repliker(M.tolka(EP[1])).map((r) => r.innehall) }));
  const nu = M.tolka(NU_EP[1]);
  const vy = R.vy(nu, R.tomtRum('1'), g);
  const rader = repliker(nu);
  const utanfor = rader.filter((r) => vy.rader.get(r.i).skrev.hur === 'utanfor');
  const demis = rader.filter((r) => vy.rader.get(r.i).skrev.vem === 'demi');
  ok(rader.every((r) => vy.rader.get(r.i).skrev.vem === null || vy.rader.get(r.i).skrev.vem === 'demi'),
    'the file rewritten outside the room: no line is credited to Henric or Liv');
  ok(utanfor.length > 0 && utanfor.every((r) => !g.has(r.innehall)) && demis.every((r) => g.has(r.innehall)),
    `changed lines read "ändrad utanför rummet" (${utanfor.length}), unchanged ones stay Demi's (${demis.length})`);
}

// --- 6. The portal's real file code ---------------------------------------------

async function provserver(rot, extra = []) {
  const p = spawn('python3', [join(REPO, 'scripts/rummet_provserver.py'), '--rot', rot, ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    p.stdout.once('data', (b) => res(String(b).trim()));
    p.once('exit', (c) => rej(new Error(`provserver exited ${c}`)));
  });
  return { p, url };
}

{
  const rot = mkdtempSync(join(tmpdir(), 'rummet-'));
  const glimt = join(rot, 'projects/motionstory/stories/glimt');
  mkdirSync(glimt, { recursive: true });
  mkdirSync(join(rot, 'data/glimt-rummet'), { recursive: true });
  for (const f of ['episod-1.json', 'varld.md']) copyFileSync(join(REPO, 'stories/glimt', f), join(glimt, f));
  for (const n of [1, 2]) writeFileSync(join(glimt, `episod-${n}.md`), EP[n]);
  const { p, url } = await provserver(rot);
  try {
    // A browser sends Origin on its own; node has to be told.
    const fetch2 = (u, o = {}) => fetch(new URL(u, url), { ...o, headers: { ...(o.headers || {}), Origin: url.replace(/\/$/, '') } });
    const adapter = D.portalAdapter({ fetch: fetch2 });
    ok(await adapter.finns(), 'portal: the file API answers');
    const filen = join(glimt, 'episod-1.md');
    const m = M.tolka(EP[1]);
    const r1 = repliker(m)[5];
    const r2 = repliker(m)[40];
    const lager = S.skapaLager(adapter, { nu: NU, nyttId: ID });
    ok(await adapter.las('rum:1') === null, 'portal: a notes file that does not exist yet reads as missing');

    // Henric saves in the file panel between our read and our write.
    let forsta = true;
    const skrivenFetch = async (u, o = {}) => {
      if (forsta && o.method === 'POST' && JSON.parse(o.body).path.endsWith('episod-1.md')) {
        forsta = false;
        const raa = readFileSync(filen, 'utf8').split('\n');
        raa[r2.i] = '> Ändrad i filpanelen.';
        writeFileSync(filen, raa.join('\n'));
        const s = statSync(filen);
        utimesSync(filen, s.atime, new Date(s.mtimeMs + 2000));
      }
      return fetch2(u, o);
    };
    const lager2 = S.skapaLager(D.portalAdapter({ fetch: skrivenFetch }), { nu: NU, nyttId: ID });
    await lager2.andraRad('1', M.ankareFor(m, r1.i), 'Ändrad i rummet.');
    const disk = readFileSync(filen, 'utf8');
    ok(!forsta, 'portal: the file really was changed in between (the 409 path ran)');
    ok(JSON.stringify(diffLines(EP[1], disk)) === JSON.stringify([r1.i, r2.i].sort((x, y) => x - y))
      && disk.split('\n')[r1.i] === '> Ändrad i rummet.' && disk.split('\n')[r2.i] === '> Ändrad i filpanelen.',
    'portal: after a 409 both texts are in the file, and nothing else changed');
    const rumDisk = JSON.parse(readFileSync(join(rot, 'data/glimt-rummet/episod-1.json'), 'utf8'));
    ok(rumDisk.rader.length === 1 && rumDisk.rader[0].skrev === 'henric', 'portal: the note about who wrote it is written as readable JSON');

    // Writing a file believed missing when someone just made it: 409, not overwritten.
    writeFileSync(join(rot, 'data/glimt-rummet/lore.json'), JSON.stringify({ format: 1, sidor: [{ id: 'x', titel: 'Någons', text: ['Finns redan.'], skrev: 'liv' }] }));
    let krock = false;
    try { await adapter.skriv('lore', '{}', null); } catch (e) { krock = e instanceof D.Krock; }
    ok(krock && readFileSync(join(rot, 'data/glimt-rummet/lore.json'), 'utf8').includes('Finns redan.'), 'portal: a file that appeared in between is not overwritten');
    await lager.nyLoresida('Min sida', 'Text.');
    const lore = await lager.lasLore();
    ok(lore.sidor.length === 2 && lore.sidor[0].titel === 'Någons', 'portal: a new page goes in beside the page already there');

    // A path outside the allowed ones is refused by the server.
    const fel = await fetch2(`/api/files/read?path=${encodeURIComponent('/etc/passwd')}`);
    ok(fel.status === 403, 'portal: a path outside the sandbox is refused');
    const utanOrigin = await fetch(new URL('/api/files/write', url), { method: 'POST', body: JSON.stringify({ path: filen.replace(rot, '/home/henric/generalassistant'), content: 'x' }) });
    ok(utanOrigin.status === 403 && readFileSync(filen, 'utf8') === disk, 'portal: a write without the page\'s origin is refused');
  } finally {
    p.kill();
    rmSync(rot, { recursive: true, force: true });
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
