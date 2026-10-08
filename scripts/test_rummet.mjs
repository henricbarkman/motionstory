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

import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

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

const EP = {
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

for (const n of [1, 2]) {
  const m = M.tolka(EP[n]);
  ok(M.skriv(m) === EP[n], `episod ${n}: read and written back is the same file, byte for byte`);
  ok(m.episod === String(n) && m.scener.length >= 7, `episod ${n}: title and ${m.scener.length} scenes found`);
  const r = repliker(m);
  ok(r.length > 80, `episod ${n}: ${r.length} lines people can edit`);

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
    const ut = M.andra(EP[n], a, ny);
    const d = diffLines(EP[n], ut.text);
    if (d && d.length === 1 && d[0] === rad.i && ut.text.split('\n')[rad.i] === rad.ra.replace(rad.kropp, '') + ny) enRad++;
    const atert = M.andra(ut.text, M.ankareFor(M.tolka(ut.text), rad.i), rad.kropp);
    if (atert.text === EP[n]) tillbaka++;
    try {
      const s = M.stryk(EP[n], a);
      const igen = M.laggTillbaka(s.text, s.struken);
      if (igen.text === EP[n] && !igen.reserv) strukna++;
    } catch (e) {
      if (e.kod === 'variant' || e.kod === 'sista-i-blocket') vagrade++;
      else throw e;
    }
    const t = M.laggTill(EP[n], { efter: a }, 'En ny replik.');
    const efter = M.tolka(t.text);
    if (efter.rader[t.i].typ === 'replik' && efter.rader[t.i].kropp === 'En ny replik.' && efter.rader[t.i].scen === rad.scen
        && insattVid(EP[n], t.text, t.i - 1, 2) && M.skriv(efter) === t.text) lagda++;
  }
  ok(ankare === r.length, `episod ${n}: every line is found again by its anchor (${ankare}/${r.length})`);
  ok(enRad === r.length, `episod ${n}: changing a line changes exactly that one line (${enRad}/${r.length})`);
  ok(tillbaka === r.length, `episod ${n}: changing it back gives the original file (${tillbaka}/${r.length})`);
  ok(strukna + vagrade === r.length && strukna > r.length / 2,
    `episod ${n}: striking and putting back gives the original file (${strukna}; ${vagrade} refused: variants and lone lines)`);
  ok(lagda === r.length, `episod ${n}: adding after a line inserts exactly ">" and the new line (${lagda}/${r.length})`);
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
  await S.skapaLager(Object.assign(Object.create(a), { vem: async () => ({ id: 'liv', namn: 'Liv' }) }), { nu: NU, nyttId: ID })
    .andraLoresida(id, 'Kollektivet', 'Livs version.');
  const svar = await lager.andraLoresida(id, 'Kollektivet', 'Henrics version.', sedd);
  lore = await lager.lasLore();
  ok(svar.krockade && R.loreText(lore.sidor[0]) === 'Henrics version.' && lore.sidor[0].versioner.some((v) => v.text.join('\n') === 'Livs version.'),
    'two people saving the same page: the later is shown, the other is kept among the versions, and it is said');
  await lager.taBortLoresida(id);
  lore = await lager.lasLore();
  ok(lore.sidor[0].borta && R.loreText(lore.sidor[0]) === 'Henrics version.', 'removing a page hides it and keeps it');
  ok(throwsKod(() => R.lasLore('[1,2'), 'trasig'), 'a broken lore file is an error, not an empty list');
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
  for (const f of ['episod-1.md', 'episod-2.md', 'episod-1.json', 'varld.md']) copyFileSync(join(REPO, 'stories/glimt', f), join(glimt, f));
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
