// What the room knows beside the manuscript: who wrote which line, proposals,
// comments, struck lines and a log. It lives in one readable JSON file per
// episode, outside the public repo. Everything here is a pure function: the
// store reads the file fresh, applies one of these, and writes it back.
//
// Nothing in this file writes manuscript text. A proposal lies beside its
// line until a person presses "Lägg in i manus".

import { ankareFor, hitta, tolkaInnehall } from './manus.js';

export class RumFel extends Error {
  constructor(kod, text) {
    super(text);
    this.name = 'RumFel';
    this.kod = kod;
  }
}

const LISTOR = ['rader', 'forslag', 'kommentarer', 'strukna', 'logg'];

export function tomtRum(episod) {
  return { format: 1, episod: String(episod), rader: [], forslag: [], kommentarer: [], strukna: [], logg: [] };
}

// A file that cannot be read is an error, never an empty room: writing an
// empty room over it would throw away what people wrote.
export function lasRum(text, episod) {
  if (text == null) return tomtRum(episod);
  let rum;
  try {
    rum = JSON.parse(text);
  } catch {
    throw new RumFel('trasig', 'Rummets anteckningar går inte att läsa: filen är trasig. Inget skrivs förrän den är lagad.');
  }
  if (!rum || typeof rum !== 'object' || Array.isArray(rum)) {
    throw new RumFel('trasig', 'Rummets anteckningar går inte att läsa: filen har fel form. Inget skrivs förrän den är lagad.');
  }
  for (const l of LISTOR) {
    if (rum[l] == null) rum[l] = [];
    if (!Array.isArray(rum[l])) {
      throw new RumFel('trasig', 'Rummets anteckningar går inte att läsa: filen har fel form. Inget skrivs förrän den är lagad.');
    }
  }
  if (rum.format == null) rum.format = 1;
  if (rum.episod == null) rum.episod = String(episod);
  return rum;
}

export function skrivRum(rum) {
  return `${JSON.stringify(rum, null, 2)}\n`;
}

// The baseline: lines that are Demi's drafts. Written by
// scripts/rummet_grund.py, never by the room.
export function lasGrund(text) {
  if (text == null) return null;
  try {
    const g = JSON.parse(text);
    return new Set(Array.isArray(g.rader) ? g.rader : []);
  } catch {
    return null;
  }
}

const kopia = (x) => JSON.parse(JSON.stringify(x));

// --- Who wrote a line ------------------------------------------------------

function postFor(manus, rum, i) {
  let basta = null;
  for (const p of rum.rader) {
    if (hitta(manus, p.mal) !== i) continue;
    // A record must say this very text; a loose match on a changed line is
    // exactly the misattribution the room is there to avoid.
    if (p.mal.text !== manus.rader[i].innehall) continue;
    if (!basta || String(p.satt || p.nar || '') >= String(basta.satt || basta.nar || '')) basta = p;
  }
  return basta;
}

// -> { vem: 'henric'|'liv'|'demi'|null, nar, hur, av, tidigare }
// vem null: the text was changed outside the room and nobody has said whose
// it is. grund null (no baseline readable): nothing is claimed for anyone.
export function skrevRad(manus, rum, grund, i) {
  const p = postFor(manus, rum, i);
  if (p) return { vem: p.skrev || null, nar: p.nar || null, hur: p.hur, av: p.av || null, satt: p.satt || null, tidigare: p.tidigare || [] };
  if (grund && grund.has(manus.rader[i].innehall)) return { vem: 'demi', nar: null, hur: 'utkast', av: null, tidigare: [] };
  return { vem: null, nar: null, hur: grund ? 'utanfor' : 'okant', av: null, tidigare: [] };
}

// Everything the room shows for an episode, bound to the lines as they stand
// in the manuscript now.
export function vy(manus, rum, grund) {
  const rader = new Map();
  const scener = new Map();
  const scen = (nr) => {
    if (!scener.has(nr)) scener.set(nr, { forslag: [], kommentarer: [], losa: [], strukna: [] });
    return scener.get(nr);
  };
  const rad = (i) => {
    if (!rader.has(i)) rader.set(i, { forslag: [], kommentarer: [] });
    return rader.get(i);
  };
  for (const s of manus.scener) scen(s.nr);
  for (const r of manus.rader) {
    if (r.typ === 'replik' && r.scen != null) rad(r.i).skrev = skrevRad(manus, rum, grund, r.i);
  }
  const lagg = (lista, slag) => {
    for (const x of lista) {
      if (x.borta) continue;
      const hem = manus.scener.some((s) => s.nr === x.mal.scen) ? x.mal.scen : (manus.scener[0] || {}).nr;
      if (x.mal.text == null) { scen(hem)[slag].push(x); continue; }
      if (x.mal.struken) { scen(hem).losa.push({ slag, post: x }); continue; }
      const i = hitta(manus, x.mal);
      if (i >= 0 && manus.rader[i].innehall === x.mal.text) rad(i)[slag].push(x);
      else scen(hem).losa.push({ slag, post: x });
    }
  };
  lagg(rum.forslag, 'forslag');
  lagg(rum.kommentarer, 'kommentarer');
  for (const s of rum.strukna) scen(manus.scener.some((x) => x.nr === s.scen) ? s.scen : (manus.scener[0] || {}).nr).strukna.push(s);
  return { rader, scener };
}

// --- After the manuscript changed in the room -------------------------------
// The room changed the file from manusFore to manusEfter; karta takes a line
// number before to the same line after (-1 if it is gone). Every note that
// sat on a line follows that line, also when its text was the thing changed.

function flytta(rum, manusFore, manusEfter, karta) {
  const om = (mal, strikt) => {
    if (!mal || mal.text == null || mal.struken) return mal;
    const i = hitta(manusFore, mal, { strikt });
    if (i < 0 || manusFore.rader[i].innehall !== mal.text) return mal;
    const j = karta(i);
    return j >= 0 ? ankareFor(manusEfter, j) : mal;
  };
  for (const l of ['rader', 'forslag', 'kommentarer']) for (const x of rum[l]) x.mal = om(x.mal, false);
  for (const s of rum.strukna) s.granne = om(s.granne, true);
}

function utan(tidigare, en) {
  if (!en) return tidigare;
  const k = tidigare.findIndex((t) => t.kropp === en.kropp && (t.skrev || null) === (en.skrev || null) && (t.nar || null) === (en.nar || null));
  return k < 0 ? tidigare : tidigare.filter((_, n) => n !== k);
}

function utanPostFor(rum, manus, i) {
  rum.rader = rum.rader.filter((p) => !(hitta(manus, p.mal) === i && p.mal.text === manus.rader[i].innehall));
}

// A line got a new text. skrev is whose words the new text is: the person at
// the keyboard for an edit, the proposer when a proposal is laid in, the
// earlier writer when an old text is taken back.
// utanTidigare: when an earlier text is taken back, that entry ({kropp, skrev,
// nar}) leaves the list of earlier texts (it is the line again) and the
// replaced one joins it.
export function efterAndrad(rum0, { manusFore, manusEfter, i, vem, nar, grund, hur = 'andrade', skrev = vem, skrevNar = nar, utanTidigare = null }) {
  const rum = kopia(rum0);
  const forut = skrevRad(manusFore, rum, grund, i);
  const fore = manusFore.rader[i];
  utanPostFor(rum, manusFore, i);
  flytta(rum, manusFore, manusEfter, (k) => k);
  const post = {
    mal: ankareFor(manusEfter, i),
    skrev,
    nar: skrevNar,
    hur,
    tidigare: [...utan(forut.tidigare, utanTidigare), { kropp: fore.kropp, skrev: forut.vem, nar: forut.nar }],
  };
  if (skrev !== vem || hur !== 'andrade') { post.av = vem; post.satt = nar; }
  rum.rader.push(post);
  rum.logg.push({ nar, vem, vad: hur, scen: fore.scen, fore: fore.innehall, efter: manusEfter.rader[i].innehall });
  return rum;
}

export function efterTillagd(rum0, { manusFore, manusEfter, karta, i, vem, nar }) {
  const rum = kopia(rum0);
  flytta(rum, manusFore, manusEfter, karta);
  rum.rader.push({ mal: ankareFor(manusEfter, i), skrev: vem, nar, hur: 'skrev', tidigare: [] });
  rum.logg.push({ nar, vem, vad: 'lade-till', scen: manusEfter.rader[i].scen, efter: manusEfter.rader[i].innehall });
  return rum;
}

export function efterStruken(rum0, { manusFore, manusEfter, karta, i, struken, id, vem, nar, grund }) {
  const rum = kopia(rum0);
  const forut = skrevRad(manusFore, rum, grund, i);
  utanPostFor(rum, manusFore, i);
  // Notes on the struck line stay with it, and come back with it.
  for (const l of ['forslag', 'kommentarer']) {
    for (const x of rum[l]) {
      if (x.mal.text != null && !x.mal.struken && hitta(manusFore, x.mal) === i && x.mal.text === manusFore.rader[i].innehall) {
        x.mal = { ...x.mal, struken: id };
      }
    }
  }
  flytta(rum, manusFore, manusEfter, karta);
  rum.strukna.push({
    id, ...struken, skrev: forut.vem, skrevNar: forut.nar, tidigare: forut.tidigare, strok: { av: vem, nar },
  });
  rum.logg.push({ nar, vem, vad: 'strok', scen: struken.scen, fore: struken.innehall });
  return rum;
}

export function efterTillbakalagd(rum0, { manusFore, manusEfter, karta, i, id, vem, nar }) {
  const rum = kopia(rum0);
  const s = rum.strukna.find((x) => x.id === id);
  flytta(rum, manusFore, manusEfter, karta);
  rum.strukna = rum.strukna.filter((x) => x.id !== id);
  for (const l of ['forslag', 'kommentarer']) {
    for (const x of rum[l]) if (x.mal.struken === id) x.mal = ankareFor(manusEfter, i);
  }
  if (s && s.skrev && s.skrev !== 'demi') {
    rum.rader.push({ mal: ankareFor(manusEfter, i), skrev: s.skrev, nar: s.skrevNar, hur: 'tillbaka', av: vem, satt: nar, tidigare: s.tidigare || [] });
  } else if (s && s.skrev === 'demi') {
    rum.rader.push({ mal: ankareFor(manusEfter, i), skrev: 'demi', nar: null, hur: 'utkast', tidigare: s.tidigare || [] });
  }
  rum.logg.push({ nar, vem, vad: 'lade-tillbaka', scen: manusEfter.rader[i].scen, efter: manusEfter.rader[i].innehall });
  return rum;
}

// Someone says whose a line is, for text that was changed outside the room.
export function sattNamn(rum0, { manus, i, skrev, vem, nar, grund }) {
  const rum = kopia(rum0);
  const forut = skrevRad(manus, rum, grund, i);
  utanPostFor(rum, manus, i);
  rum.rader.push({ mal: ankareFor(manus, i), skrev, nar: null, hur: 'namn', av: vem, satt: nar, tidigare: forut.tidigare });
  rum.logg.push({ nar, vem, vad: 'satte-namn', scen: manus.rader[i].scen, efter: manus.rader[i].innehall, skrev });
  return rum;
}

// --- Proposals ---------------------------------------------------------------

export function nyttForslag(rum0, { id, mal, kropp, vem, nar }) {
  const rum = kopia(rum0);
  rum.forslag.push({ id, mal, kropp, skrev: vem, nar, ja: [], lage: 'oppet' });
  return rum;
}

function forslag(rum, id) {
  const f = rum.forslag.find((x) => x.id === id);
  if (!f) throw new RumFel('saknas', 'Förslaget finns inte kvar.');
  return f;
}

export function sagJa(rum0, { id, vem, nar }) {
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  if (!f.ja.some((j) => j.vem === vem)) f.ja.push({ vem, nar });
  return rum;
}

export function taTillbakaJa(rum0, { id, vem }) {
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  f.ja = f.ja.filter((j) => j.vem !== vem);
  return rum;
}

export function draUndanForslag(rum0, { id, vem, nar }) {
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  f.lage = 'undan';
  f.undan = { av: vem, nar };
  return rum;
}

// Marks a proposal as laid in. For a line this goes together with efterAndrad
// (the store does both in one write); for a whole scene it is a note that the
// people have carried it out themselves.
export function forslagInlagt(rum0, { id, vem, nar, ersatte = null }) {
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  f.lage = 'inlagt';
  f.inlagt = { av: vem, nar };
  if (ersatte) f.inlagt.ersatte = ersatte;
  rum.logg.push({ nar, vem, vad: 'lade-in-forslag', scen: f.mal.scen, forslag: id, av: f.skrev });
  return rum;
}

export function forslagOppnatIgen(rum0, { id, vem, nar }) {
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  f.lage = 'oppet';
  f.togsTillbaka = { av: vem, nar };
  delete f.inlagt;
  return rum;
}

// --- Comments ------------------------------------------------------------------

export const GALLER = { orden: 'orden', tempo: 'tempot', paus: 'pausen', ljud: 'ljudnivån', nar: 'när det händer' };

export function nyKommentar(rum0, { id, mal, text, galler = null, vem, nar }) {
  const rum = kopia(rum0);
  rum.kommentarer.push({ id, mal, text, galler, skrev: vem, nar });
  return rum;
}

function kommentar(rum, id) {
  const k = rum.kommentarer.find((x) => x.id === id);
  if (!k) throw new RumFel('saknas', 'Kommentaren finns inte kvar.');
  return k;
}

export function kommentarKlar(rum0, { id, vem, nar, klar = true }) {
  const rum = kopia(rum0);
  const k = kommentar(rum, id);
  if (klar) k.klar = { av: vem, nar }; else delete k.klar;
  return rum;
}

export function taBortKommentar(rum0, { id, vem, nar }) {
  const rum = kopia(rum0);
  kommentar(rum, id).borta = { av: vem, nar };
  return rum;
}

// --- Lore pages ------------------------------------------------------------------
// One file for all pages people write. The text is kept as a list of lines so
// the file reads well in an editor; joined with "\n" it is exactly what was
// typed.

export function tomLore() {
  return { format: 1, sidor: [] };
}

export function lasLore(text) {
  if (text == null) return tomLore();
  let lore;
  try {
    lore = JSON.parse(text);
  } catch {
    throw new RumFel('trasig', 'Loresidorna går inte att läsa: filen är trasig. Inget skrivs förrän den är lagad.');
  }
  if (!lore || typeof lore !== 'object' || (lore.sidor != null && !Array.isArray(lore.sidor))) {
    throw new RumFel('trasig', 'Loresidorna går inte att läsa: filen har fel form. Inget skrivs förrän den är lagad.');
  }
  if (lore.sidor == null) lore.sidor = [];
  return lore;
}

export const loreText = (sida) => (sida.text || []).join('\n');

export function nyLoresida(lore0, { id, titel, text, vem, nar }) {
  const lore = kopia(lore0);
  lore.sidor.push({ id, titel, text: text.split('\n'), skrev: vem, skapad: nar, versioner: [] });
  return lore;
}

// seddAndrad: the page's last change as the writer saw it when they opened
// it. If someone else saved in between, both texts are kept: theirs goes into
// the versions, and the caller is told.
export function andraLoresida(lore0, { id, titel, text, vem, nar }) {
  const lore = kopia(lore0);
  const s = lore.sidor.find((x) => x.id === id);
  if (!s) throw new RumFel('saknas', 'Sidan finns inte kvar.');
  s.versioner = s.versioner || [];
  s.versioner.push({ titel: s.titel, text: s.text, av: (s.andrad && s.andrad.av) || s.skrev, nar: (s.andrad && s.andrad.nar) || s.skapad });
  s.titel = titel;
  s.text = text.split('\n');
  s.andrad = { av: vem, nar };
  delete s.borta;
  return lore;
}

export function taBortLoresida(lore0, { id, vem, nar }) {
  const lore = kopia(lore0);
  const s = lore.sidor.find((x) => x.id === id);
  if (!s) throw new RumFel('saknas', 'Sidan finns inte kvar.');
  s.borta = { av: vem, nar };
  return lore;
}

export function hamtaTillbakaLoresida(lore0, { id }) {
  const lore = kopia(lore0);
  const s = lore.sidor.find((x) => x.id === id);
  if (!s) throw new RumFel('saknas', 'Sidan finns inte kvar.');
  delete s.borta;
  return lore;
}

// Used by the store to check a kropp read back from the file is still a line.
export const arReplik = (innehall) => tolkaInnehall(innehall).typ === 'replik';
