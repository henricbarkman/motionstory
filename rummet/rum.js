// What the room knows beside the manuscript: who wrote which line, proposals,
// comments, struck lines and a log. It lives in one readable JSON file per
// episode, outside the public repo. Everything here is a pure function: the
// store reads the file fresh, applies one of these, and writes it back.
//
// Nothing in this file writes manuscript text. A proposal lies beside its
// line until a person presses "Lägg in i manus".
//
// Three people take part: Henric, Liv and Demi. Demi is an AI and is marked
// as one everywhere. Everyone writes their own comments, proposals, replies
// and lore pages, and nobody can change or remove someone else's. Deciding is
// for people: only they change the manuscript, say yes, lay a proposal in,
// or say whose a line is.

import { ankareFor, hitta, tolkaInnehall } from './manus.js';
import { PERSONER } from './data.js';

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

export const arAI = (vem) => !!(PERSONER[vem] && PERSONER[vem].ai);

export function baraManniskor(vem) {
  if (!vem || arAI(vem)) {
    throw new RumFel('bara-manniskor', 'Det här gör bara en människa i rummet: Henric eller Liv.');
  }
}

function egen(post, vem, vad) {
  if (!post.skrev || post.skrev !== vem) {
    throw new RumFel('inte-din', `Bara den som skrev ${vad} kan ändra eller ta bort det.`);
  }
}

// --- Who wrote a line ------------------------------------------------------

function postFor(manus, rum, i) {
  let basta = null;
  for (const p of rum.rader) {
    if (hitta(manus, p.mal, { strikt: true }) !== i) continue;
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
      if (x.borta || x.svarPa) continue;
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
  // Replies are shown under the post that started their thread.
  const svar = new Map();
  for (const k of rum.kommentarer) {
    if (!k.svarPa || k.borta) continue;
    if (!svar.has(k.svarPa)) svar.set(k.svarPa, []);
    svar.get(k.svarPa).push(k);
  }
  const vantar = new Set(vantarPa(rum, 'demi').map((k) => k.id));
  return { rader, scener, svar, vantar };
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
  rum.rader = rum.rader.filter((p) => !(hitta(manus, p.mal, { strikt: true }) === i && p.mal.text === manus.rader[i].innehall));
}

// A line got a new text. skrev is whose words the new text is: the person at
// the keyboard for an edit, the proposer when a proposal is laid in, the
// earlier writer when an old text is taken back.
// utanTidigare: when an earlier text is taken back, that entry ({kropp, skrev,
// nar}) leaves the list of earlier texts (it is the line again) and the
// replaced one joins it.
export function efterAndrad(rum0, { manusFore, manusEfter, i, vem, nar, grund, hur = 'andrade', skrev = vem, skrevNar = nar, utanTidigare = null }) {
  baraManniskor(vem);
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
  baraManniskor(vem);
  const rum = kopia(rum0);
  flytta(rum, manusFore, manusEfter, karta);
  rum.rader.push({ mal: ankareFor(manusEfter, i), skrev: vem, nar, hur: 'skrev', tidigare: [] });
  rum.logg.push({ nar, vem, vad: 'lade-till', scen: manusEfter.rader[i].scen, efter: manusEfter.rader[i].innehall });
  return rum;
}

export function efterStruken(rum0, { manusFore, manusEfter, karta, i, struken, id, vem, nar, grund }) {
  baraManniskor(vem);
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
  baraManniskor(vem);
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
  baraManniskor(vem);
  if (i == null || i < 0 || !manus.rader[i]) throw new RumFel('saknas', 'Repliken står inte längre så i manuset.');
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
  baraManniskor(vem);
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
  egen(f, vem, 'förslaget');
  if (f.lage !== 'oppet') throw new RumFel('inte-oppet', f.lage === 'inlagt' ? 'Förslaget är redan inlagt i manus.' : 'Förslaget är redan undandraget.');
  f.lage = 'undan';
  f.undan = { av: vem, nar };
  return rum;
}

// Marks a proposal as laid in. For a line this goes together with efterAndrad
// (the store does both in one write); for a whole scene it is a note that the
// people have carried it out themselves.
export function forslagInlagt(rum0, { id, vem, nar, ersatte = null }) {
  baraManniskor(vem);
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  f.lage = 'inlagt';
  f.inlagt = { av: vem, nar };
  if (ersatte) f.inlagt.ersatte = ersatte;
  rum.logg.push({ nar, vem, vad: 'lade-in-forslag', scen: f.mal.scen, forslag: id, av: f.skrev });
  return rum;
}

export function forslagOppnatIgen(rum0, { id, vem, nar }) {
  baraManniskor(vem);
  const rum = kopia(rum0);
  const f = forslag(rum, id);
  f.lage = 'oppet';
  f.togsTillbaka = { av: vem, nar };
  delete f.inlagt;
  return rum;
}

// --- Comments ------------------------------------------------------------------

export const GALLER = { orden: 'orden', tempo: 'tempot', paus: 'pausen', ljud: 'ljudnivån', nar: 'när det händer' };

// A comment on a line or a scene, or a reply in a thread (svarPa: the id of
// the comment or proposal that started it). till: 'demi' asks Demi for an
// answer; the room shows it as waiting until Demi has replied in the thread.
export function nyKommentar(rum0, { id, mal, text, galler = null, vem, nar, svarPa = null, till = null }) {
  const rum = kopia(rum0);
  if (typeof text !== 'string' || !text.trim()) throw new RumFel('tom', 'Kommentaren är tom.');
  if (till != null && !Object.hasOwn(PERSONER, till)) throw new RumFel('okand', 'Den personen finns inte i rummet.');
  const post = { id, mal, text, galler, skrev: vem, nar };
  if (svarPa) {
    const fore = rum.kommentarer.find((x) => x.id === svarPa) || rum.forslag.find((x) => x.id === svarPa);
    if (!fore || fore.borta) throw new RumFel('saknas', 'Det du svarar på finns inte kvar.');
    // Every reply hangs on the thread's first post, so a thread is one list.
    post.svarPa = fore.svarPa || fore.id;
    post.mal = kopia(fore.mal);
    post.galler = null;
  }
  if (till) post.till = till;
  rum.kommentarer.push(post);
  return rum;
}

function kommentar(rum, id) {
  const k = rum.kommentarer.find((x) => x.id === id);
  if (!k) throw new RumFel('saknas', 'Kommentaren finns inte kvar.');
  return k;
}

// Marking a thread done is not changing anyone's words, so any person can do
// it. Demi can only mark its own, and never opens what a person closed.
export function kommentarKlar(rum0, { id, vem, nar, klar = true }) {
  const rum = kopia(rum0);
  const k = kommentar(rum, id);
  if (arAI(vem)) {
    egen(k, vem, 'kommentaren');
    if (!klar && k.klar && k.klar.av !== vem) throw new RumFel('bara-manniskor', 'Bara en människa kan öppna en tråd som en människa har stängt.');
  }
  if (klar) k.klar = { av: vem, nar }; else delete k.klar;
  return rum;
}

export function taBortKommentar(rum0, { id, vem, nar }) {
  const rum = kopia(rum0);
  const k = kommentar(rum, id);
  egen(k, vem, 'kommentaren');
  // Removing the first post would hide everyone's replies with it.
  if (!k.svarPa && rum.kommentarer.some((x) => x.svarPa === k.id && !x.borta && x.skrev !== vem)) {
    throw new RumFel('har-svar', 'Andra har svarat i tråden, så den går inte att ta bort. Markera den som klar i stället.');
  }
  k.borta = { av: vem, nar };
  return rum;
}

// The first post of each thread and its replies, in order.
export function trad(rum, rotId) {
  return rum.kommentarer.filter((x) => x.svarPa === rotId && !x.borta);
}

// Posts addressed to someone (till) that still wait for their answer: the
// thread is open (not marked done by a person, not a proposal that has been
// laid in or withdrawn), and the person has not written in it since.
// "Since" is the order in the file, never the time stamps: those come from
// different clocks (a phone, a laptop, the mini-PC), while every post is
// appended to the file it was read from.
export function vantarPa(rum, vem) {
  const ut = [];
  const rotar = new Map([...rum.forslag, ...rum.kommentarer].map((x) => [x.id, x]));
  const plats = new Map(rum.kommentarer.map((x, n) => [x.id, n]));
  for (const k of rum.kommentarer) {
    if (k.till !== vem || k.borta) continue;
    const rotId = k.svarPa || k.id;
    const rot = rotar.get(rotId);
    if (!rot || rot.borta || (rot.klar && !arAI(rot.klar.av)) || (rot.lage != null && rot.lage !== 'oppet')) continue;
    const har = plats.get(k.id);
    if (!trad(rum, rotId).some((x) => x.skrev === vem && plats.get(x.id) > har)) ut.push(k);
  }
  return ut;
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
  egen(s, vem, 'sidan');
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
  egen(s, vem, 'sidan');
  s.borta = { av: vem, nar };
  return lore;
}

export function hamtaTillbakaLoresida(lore0, { id, vem }) {
  const lore = kopia(lore0);
  const s = lore.sidor.find((x) => x.id === id);
  if (!s) throw new RumFel('saknas', 'Sidan finns inte kvar.');
  egen(s, vem, 'sidan');
  delete s.borta;
  return lore;
}

// --- Settings ------------------------------------------------------------------
// What each person has chosen for themselves. Only doljDemi for now: whether
// Demi's comments, proposals, replies and lore pages are hidden for them.

export const tomaInstallningar = () => ({ format: 1, personer: {} });

export function lasInstallningar(text) {
  if (text == null) return tomaInstallningar();
  let inst;
  try {
    inst = JSON.parse(text);
  } catch {
    throw new RumFel('trasig', 'Inställningarna går inte att läsa: filen är trasig.');
  }
  if (!inst || typeof inst !== 'object' || Array.isArray(inst)) throw new RumFel('trasig', 'Inställningarna har fel form.');
  if (!inst.personer || typeof inst.personer !== 'object' || Array.isArray(inst.personer)) inst.personer = {};
  return inst;
}

export function installningFor(inst, vem) {
  const egna = (vem && inst.personer[vem]) || {};
  const forval = (vem && PERSONER[vem]) || {};
  return { doljDemi: typeof egna.doljDemi === 'boolean' ? egna.doljDemi : !!forval.doljDemi };
}

const NYCKLAR = { doljDemi: 'boolean' };

export function sattInstallning(inst0, { vem, nyckel, varde, nar }) {
  if (!NYCKLAR[nyckel] || typeof varde !== NYCKLAR[nyckel]) throw new RumFel('okand', 'Den inställningen finns inte.');
  const inst = kopia(inst0);
  inst.personer[vem] = { ...(inst.personer[vem] || {}), [nyckel]: varde, andrad: nar };
  return inst;
}

// Used by the store to check a kropp read back from the file is still a line.
export const arReplik = (innehall) => tolkaInnehall(innehall).typ === 'replik';
