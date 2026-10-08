// What the room knows beside the text, per document: the history of every
// paragraph, comments, proposals and the places where two people changed the
// same paragraph at once. One readable JSON file per document, outside the
// public repo (lore pages keep theirs inside lore.json, next to the page).
//
// Everyone in the room (Henric, Liv and Demi, who is an AI and marked as one)
// can change everything. There are no locks on who wrote what. What protects
// the text is that nothing is ever thrown away: every version of a paragraph
// stays in its history with who wrote it and when, a removed comment stays in
// the file, and two changes that meet are both kept. A comment's words belong
// to the one who wrote them: anyone can mark it done or remove it, only the
// writer can change it.
//
// Everything here is a pure function. The store (lager.js) and Demi's command
// line (scripts/rummet_cli.mjs) read the file fresh, apply one of these, and
// write it back.

import { PERSONER } from './data.js';
import {
  justera, nyckel, rensaAttrs, skrivRad, skuggaFor, tolka, tolkaRad, SLAG_EPISOD,
} from './dok.js';
import * as V1 from './manus.js';

export const FORMAT = 2;

export class RumFel extends Error {
  constructor(kod, text) {
    super(text);
    this.name = 'RumFel';
    this.kod = kod;
  }
}

const LISTOR = ['kommentarer', 'forslag', 'krockar'];
const kopia = (x) => JSON.parse(JSON.stringify(x));
export const arAI = (vem) => !!(PERSONER[vem] && PERSONER[vem].ai);
export const namnFor = (vem) => (PERSONER[vem] && PERSONER[vem].namn) || (vem ? String(vem) : 'Okänd');

export function tomAnteckning(dok) {
  return { format: FORMAT, dok: String(dok), stycken: [], skuggaVersion: null, historik: {}, kommentarer: [], forslag: [], krockar: [] };
}

function trasig(vad) {
  return new RumFel('trasig', `${vad} går inte att läsa: filen är trasig eller har fel form. Inget skrivs förrän den är lagad.`);
}

// A file that cannot be read is an error, never an empty room: writing an
// empty room over it would throw away what people wrote. A file in the first
// version's form comes back as it is (format 1); oppna() moves it over.
export function lasAnteckning(text, dok) {
  if (text == null) return tomAnteckning(dok);
  let not;
  try {
    not = JSON.parse(text);
  } catch {
    throw trasig('Rummets anteckningar');
  }
  if (!not || typeof not !== 'object' || Array.isArray(not)) throw trasig('Rummets anteckningar');
  if (not.format === 1 || (not.format == null && Array.isArray(not.rader))) return not;
  for (const l of LISTOR) {
    if (not[l] == null) not[l] = [];
    if (!Array.isArray(not[l])) throw trasig('Rummets anteckningar');
  }
  if (not.historik == null) not.historik = {};
  if (typeof not.historik !== 'object' || Array.isArray(not.historik)) throw trasig('Rummets anteckningar');
  if (!Array.isArray(not.stycken)) not.stycken = [];
  if (not.dok == null) not.dok = String(dok);
  not.format = FORMAT;
  return not;
}

export const skrivAnteckning = (not) => `${JSON.stringify(not, null, 2)}\n`;

// Notes in any form, bound to the text as it stands: format 1 is moved over
// (it is written in the new form with the next change).
export function oppna(text, dok, filtext, slag = SLAG_EPISOD) {
  const not = lasAnteckning(text, dok);
  if (not.format === FORMAT) return not;
  return migrera(not, filtext || '', slag);
}

// The baseline: the lines that are Demi's drafts, written by
// scripts/rummet_grund.py, never by the room. The first version kept only the
// inside of the quote lines; those are the "> " lines.
export function lasGrund(text) {
  if (text == null) return null;
  try {
    const g = JSON.parse(text);
    if (Array.isArray(g.stycken)) return new Set(g.stycken);
    if (Array.isArray(g.rader)) return new Set(g.rader.map((r) => `> ${r}`));
    return null;
  } catch {
    return null;
  }
}

// --- History ---------------------------------------------------------------
// historik[id]: the versions of one paragraph, oldest first:
//   { text, typ, attrs, vem, nar, hur, av? }   a version
//   { borta: true, efter, vem, nar }           removed (efter: the paragraph it stood after)
// hur: 'utkast' (Demi's draft, from the baseline), 'utanfor' (changed outside
// the room, nobody said by whom), 'skrev' (new), 'andrade', 'forslag' (a
// proposal laid in: vem wrote it, av laid it in), 'tillbaka' (an earlier
// version taken back, av did it), 'krock' (a version that met another one
// and is not the one in the text).

const SAMMA_STUND = 10 * 60 * 1000;

export const historikFor = (not, id) => (not.historik && not.historik[id]) || [];

const iGrund = (grund, p) => !!grund && (grund.has(skrivRad(p)) || (p.raw != null && grund.has(p.raw)));

// Who wrote the paragraph as it stands. -> { vem, nar, hur, av }
// vem null: changed outside the room. hur 'okant': no baseline to go by.
export function vemSkrev(not, id, p, grund) {
  const lista = historikFor(not, id);
  const k = nyckel(p);
  for (let n = lista.length - 1; n >= 0; n--) {
    const e = lista[n];
    if (e.borta || e.hur === 'krock') continue;
    if (nyckel(e) === k) return { vem: e.vem || null, nar: e.nar || null, hur: e.hur || 'andrade', av: e.av || null };
  }
  if (iGrund(grund, p)) return { vem: 'demi', nar: null, hur: 'utkast', av: null };
  return { vem: null, nar: null, hur: grund ? 'utanfor' : 'okant', av: null };
}

const version = (p) => ({ text: p.text, typ: p.typ, attrs: rensaAttrs(p.typ, p.attrs) });

function laggTillPost(not, id, post, fore, grund) {
  if (!not.historik[id]) not.historik[id] = [];
  const lista = not.historik[id];
  // The version that was there before, if the history does not already end
  // with it: whoever it was.
  if (fore) {
    const sista = [...lista].reverse().find((e) => !e.borta && e.hur !== 'krock');
    if (!sista || nyckel(sista) !== nyckel(fore)) {
      const v = vemSkrev(not, id, fore, grund);
      lista.push({ ...version(fore), vem: v.vem, nar: v.nar, hur: v.hur === 'okant' ? 'utanfor' : v.hur, ...(v.av ? { av: v.av } : {}) });
    }
  }
  const sista = lista[lista.length - 1];
  // One person typing for a while is one version, not one per save.
  if (!post.borta && sista && !sista.borta && sista.vem === post.vem && !sista.av && !post.av
    && ['andrade', 'skrev'].includes(sista.hur) && post.hur === 'andrade'
    && sista.nar && post.nar && Date.parse(post.nar) - Date.parse(sista.nar) < SAMMA_STUND
    && Date.parse(post.nar) >= Date.parse(sista.nar)) {
    Object.assign(sista, version(post), { nar: post.nar });
    return;
  }
  lista.push(post.borta ? { ...post } : { ...version(post), vem: post.vem, nar: post.nar, hur: post.hur || 'andrade', ...(post.av ? { av: post.av } : {}) });
}

// Where something about a paragraph that is gone shows: at the paragraph it
// stood after, and so on back. null: at the top.
export function hem(not, id, finns) {
  const sett = new Set();
  let x = id;
  while (x && !finns(x)) {
    if (sett.has(x)) return null;
    sett.add(x);
    const lista = historikFor(not, x);
    const b = [...lista].reverse().find((e) => e.borta);
    x = b ? b.efter : null;
  }
  return x || null;
}

// Paragraphs that were removed and are not back: [{ id, sista (last version), borta }]
export function borttagna(not, finns) {
  const ut = [];
  for (const [id, lista] of Object.entries(not.historik || {})) {
    if (finns(id) || !lista.length) continue;
    const b = lista[lista.length - 1];
    if (!b.borta) continue;
    const sista = [...lista].reverse().find((e) => !e.borta && e.hur !== 'krock');
    if (sista) ut.push({ id, sista, borta: b });
  }
  return ut.sort((a, b) => String(b.borta.nar || '').localeCompare(String(a.borta.nar || '')));
}

// --- Applying a save ------------------------------------------------------------
// delta, from a save in the room or a command from Demi:
//   vem, nar
//   skugga: { version, stycken }   the file as just written, with ids
//   poster: [{ id, post, fore }]  history; fore: the version it replaced
//   krockar: [{ stycke, text, typ, attrs, vem, nar }]   versions not in the text
//   forslag: [{ id, lage, av, nar }]
//   grund: Set | null             for who wrote the versions replaced
export function tillampa(not0, delta) {
  // Applying the same save twice (a lost answer, two windows sending the
  // same waiting note) changes nothing.
  if (delta.id && Array.isArray(not0.gjort) && not0.gjort.includes(delta.id)) return not0;
  const not = kopia(not0);
  if (delta.id) not.gjort = [...(not.gjort || []), delta.id].slice(-200);
  const grund = delta.grund || null;
  const poster = (delta.poster || []).map((x) => ({ ...x }));
  const krockar = (delta.krockar || []).map((x) => ({ ...x }));
  if (delta.skugga) forsona(not, delta.skugga, [...poster, ...krockar.map((k) => ({ id: k.stycke, krock: k }))]);
  for (const { id, post, fore } of poster) laggTillPost(not, id, post, fore || null, grund);
  for (const k of krockar) {
    const finns = not.krockar.find((x) => x.lage === 'oppen' && x.stycke === k.stycke && (x.vem || null) === (k.vem || null));
    if (finns) Object.assign(finns, version(k), { nar: k.nar });
    else not.krockar.push({ id: k.id, stycke: k.stycke, ...version(k), vem: k.vem || null, nar: k.nar, mot: delta.vem, lage: 'oppen' });
    // The version that is not in the text is in the history too.
    if (!not.historik[k.stycke]) not.historik[k.stycke] = [];
    const lista = not.historik[k.stycke];
    const sista = lista[lista.length - 1];
    if (!sista || sista.hur !== 'krock' || nyckel(sista) !== nyckel(k)) {
      lista.push({ ...version(k), vem: k.vem || null, nar: k.nar, hur: 'krock' });
    }
  }
  for (const f of delta.forslag || []) {
    const x = not.forslag.find((y) => y.id === f.id);
    if (!x) continue;
    x.lage = f.lage;
    if (f.lage === 'inlagt') x.inlagt = { av: f.av, nar: f.nar };
    else if (f.lage === 'avfard') x.avfard = { av: f.av, nar: f.nar };
  }
  for (const k of delta.krockLagen || []) {
    const x = not.krockar.find((y) => y.id === k.id);
    if (x) { x.lage = k.lage; x.avgjord = { av: delta.vem, nar: delta.nar }; }
  }
  return not;
}

const anvands = (not, id) => !!(not.historik[id] && not.historik[id].length)
  || LISTOR.some((l) => not[l].some((x) => x.stycke === id));

function bytId(not, fran, till) {
  if (fran === till) return;
  if (not.historik[fran]) {
    const a = not.historik[till] || [];
    not.historik[till] = [...not.historik[fran], ...a]
      .map((e, n) => [e, n]).sort((x, y) => String(x[0].nar || '').localeCompare(String(y[0].nar || '')) || x[1] - y[1]).map((x) => x[0]);
    delete not.historik[fran];
  }
  for (const l of LISTOR) for (const x of not[l]) if (x.stycke === fran) x.stycke = till;
  for (const lista of Object.values(not.historik)) for (const e of lista) if (e.borta && e.efter === fran) e.efter = till;
}

// The room came to know a paragraph under another name (the file's): what
// hangs on the old name moves over. par: [[from, to], ...]. Doing it twice
// changes nothing.
export function bytStycken(not0, par) {
  const flytta = (par || []).filter(([fran, till]) => fran && till && fran !== till && anvands(not0, fran));
  if (!flytta.length) return not0;
  const not = kopia(not0);
  for (const [fran, till] of flytta) bytId(not, fran, till);
  return not;
}

// Two windows can each have named the same line: one wrote the file, the
// other wrote the notes in between. The shadow kept is the one for the newest
// file; where the two shadows say the same line under different ids, the id
// the notes already use wins, and everything is moved over to it.
// mina: what this save is about to hang on ids ({ id } and krock records),
// renamed in place when their id gives way.
function forsona(not, mitt, mina) {
  const deras = { version: not.skuggaVersion, stycken: Array.isArray(not.stycken) ? not.stycken : [] };
  const nyast = deras.version != null && mitt.version != null && deras.version > mitt.version ? deras : mitt;
  const andra = nyast === mitt ? deras : mitt;
  const egna = new Set(mina.map((x) => x.id));
  const byt = new Map();
  for (const [i, j] of parAvRader(nyast.stycken, andra.stycken)) {
    const a = nyast.stycken[i][0];
    const b = andra.stycken[j][0];
    if (a === b || byt.has(a)) continue;
    // Keep the id that something already hangs on; this save's own counts.
    const aAnv = anvands(not, a) || egna.has(a);
    const bAnv = anvands(not, b) || egna.has(b);
    const behall = bAnv && !aAnv ? b : a;
    const slapp = behall === a ? b : a;
    bytId(not, slapp, behall);
    for (const x of mina) {
      if (x.id === slapp) x.id = behall;
      if (x.krock && x.krock.stycke === slapp) x.krock.stycke = behall;
    }
    byt.set(a, behall);
  }
  not.stycken = nyast.stycken.map(([id, ra]) => [byt.get(id) || id, ra]);
  not.skuggaVersion = nyast.version;
}

function parAvRader(a, b) {
  const A = a.map((x) => x[1]);
  const B = b.map((x) => x[1]);
  const n = A.length;
  const m = B.length;
  if (!n || !m) return [];
  if (n * m > 4e6) {
    // Too big to compare cheaply: equal lines in the same place.
    const ut = [];
    for (let k = 0; k < Math.min(n, m); k++) if (A[k] === B[k]) ut.push([k, k]);
    return ut;
  }
  const t = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * (m + 1) + j] = A[i] === B[j] ? t[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(t[(i + 1) * (m + 1) + j], t[i * (m + 1) + j + 1]);
    }
  }
  const ut = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ut.push([i, j]); i++; j++; } else if (t[(i + 1) * (m + 1) + j] >= t[i * (m + 1) + j + 1]) i++; else j++;
  }
  return ut;
}

// --- Comments -----------------------------------------------------------------

export const GALLER = { orden: 'orden', tempo: 'tempot', paus: 'pausen', ljud: 'ljudnivån', nar: 'när det händer' };

// A comment on a paragraph, or a reply in a thread (svarPa: the id of the
// comment or proposal that started it). galde: the paragraph's text when the
// comment was written. till: 'demi' asks Demi for an answer.
export function nyKommentar(not0, { id, stycke, galde = null, text, galler = null, vem, nar, svarPa = null, till = null }) {
  if (not0.kommentarer.some((x) => x.id === id)) return not0;
  const not = kopia(not0);
  if (typeof text !== 'string' || !text.trim()) throw new RumFel('tom', 'Kommentaren är tom.');
  if (till != null && !Object.hasOwn(PERSONER, till)) throw new RumFel('okand', 'Den personen finns inte i rummet.');
  const post = { id, stycke, galde, text, galler, skrev: vem, nar };
  if (svarPa) {
    const fore = not.kommentarer.find((x) => x.id === svarPa) || not.forslag.find((x) => x.id === svarPa);
    if (!fore || fore.borta) throw new RumFel('saknas', 'Det du svarar på finns inte kvar.');
    post.svarPa = fore.svarPa || fore.id;
    post.stycke = fore.stycke;
    post.galler = null;
  }
  if (till) post.till = till;
  not.kommentarer.push(post);
  return not;
}

function kommentar(not, id) {
  const k = not.kommentarer.find((x) => x.id === id);
  if (!k) throw new RumFel('saknas', 'Kommentaren finns inte kvar.');
  return k;
}

// The words are the writer's: only they change them.
export function andraKommentar(not0, { id, text, vem, nar }) {
  const not = kopia(not0);
  const k = kommentar(not, id);
  if (k.skrev !== vem) throw new RumFel('inte-din', 'Bara den som skrev kommentaren kan ändra orden i den. Svara i tråden i stället.');
  if (typeof text !== 'string' || !text.trim()) throw new RumFel('tom', 'Kommentaren är tom.');
  if (k.text === text) return not0;
  k.tidigare = [...(k.tidigare || []), { text: k.text, nar: k.andrad || k.nar }];
  k.text = text;
  k.andrad = nar;
  return not;
}

export function kommentarKlar(not0, { id, vem, nar, klar = true }) {
  const not = kopia(not0);
  const k = kommentar(not, id);
  if (klar) k.klar = { av: vem, nar }; else delete k.klar;
  return not;
}

// Anyone can remove a comment; it stays in the file, marked.
export function taBortKommentar(not0, { id, vem, nar, tillbaka = false }) {
  const not = kopia(not0);
  const k = kommentar(not, id);
  if (tillbaka) delete k.borta; else k.borta = { av: vem, nar };
  return not;
}

export const trad = (not, rotId) => not.kommentarer.filter((x) => x.svarPa === rotId && !x.borta);

// Posts addressed to someone that still wait for their answer: the thread is
// open, and the person has not written in it since. "Since" is the order in
// the file, never the time stamps: those come from different clocks.
export function vantarPa(not, vem) {
  const ut = [];
  const rotar = new Map([...not.forslag, ...not.kommentarer].map((x) => [x.id, x]));
  const plats = new Map(not.kommentarer.map((x, n) => [x.id, n]));
  for (const k of not.kommentarer) {
    if (k.till !== vem || k.borta) continue;
    const rotId = k.svarPa || k.id;
    const rot = rotar.get(rotId);
    if (!rot || rot.borta || rot.klar || (rot.lage != null && rot.lage !== 'oppet')) continue;
    const har = plats.get(k.id);
    if (!trad(not, rotId).some((x) => x.skrev === vem && plats.get(x.id) > har)) ut.push(k);
  }
  return ut;
}

// A Mekanik paragraph asking for a new mechanic waits for Demi until Demi has
// written a comment on it, about the text as it stands now.
export function demiHarSvarat(not, id, text) {
  return not.kommentarer.some((k) => k.stycke === id && k.skrev === 'demi' && !k.borta && (k.galde == null || k.galde === text));
}

// --- Proposals ------------------------------------------------------------------
// A proposal is a whole new version of one paragraph, lying beside it until
// someone lays it in or dismisses it. Anyone can do either. fri: a note on a
// scene from the first version, with no paragraph to replace.

export function nyttForslag(not0, { id, stycke, galde, text, typ, attrs, vem, nar }) {
  if (not0.forslag.some((x) => x.id === id)) return not0;
  const not = kopia(not0);
  if (typeof text !== 'string' || !text.trim()) throw new RumFel('tom', 'Förslaget är tomt.');
  not.forslag.push({ id, stycke, galde: galde || null, text, typ, attrs: rensaAttrs(typ, attrs), skrev: vem, nar, lage: 'oppet' });
  return not;
}

export function forslagLage(not0, { id, lage, vem, nar }) {
  const not = kopia(not0);
  const f = not.forslag.find((x) => x.id === id);
  if (!f) throw new RumFel('saknas', 'Förslaget finns inte kvar.');
  if (!['oppet', 'inlagt', 'avfard'].includes(lage)) throw new RumFel('okand', 'Okänt läge för ett förslag.');
  f.lage = lage;
  if (lage === 'oppet') { f.oppnat = { av: vem, nar }; delete f.inlagt; delete f.avfard; } else f[lage] = { av: vem, nar };
  return not;
}

export function krockLage(not0, { id, lage, vem, nar }) {
  const not = kopia(not0);
  const k = not.krockar.find((x) => x.id === id);
  if (!k) throw new RumFel('saknas', 'Krocken finns inte kvar.');
  k.lage = lage;
  k.avgjord = { av: vem, nar };
  return not;
}

// --- What happened -----------------------------------------------------------------
// Everything with a time in a document's notes, newest first:
// { nar, vem, slag, stycke, text, fore? }
export function handelser(not) {
  const ut = [];
  for (const [id, lista] of Object.entries(not.historik || {})) {
    lista.forEach((e, n) => {
      if (!e.nar || e.hur === 'utkast' || e.hur === 'utanfor') return;
      const fore = [...lista.slice(0, n)].reverse().find((x) => !x.borta && x.hur !== 'krock');
      if (e.borta) ut.push({ nar: e.nar, vem: e.vem, slag: 'strok', stycke: id, text: fore ? fore.text : '' });
      else ut.push({ nar: e.nar, vem: e.av || e.vem, skrev: e.vem, slag: e.hur === 'krock' ? 'krock' : e.hur || 'andrade', stycke: id, text: e.text, fore: fore ? fore.text : null });
    });
  }
  for (const k of not.kommentarer) {
    if (k.borta) continue;
    ut.push({ nar: k.nar, vem: k.skrev, slag: k.svarPa ? 'svar' : 'kommentar', stycke: k.stycke, text: k.text, id: k.id, till: k.till || null });
  }
  for (const f of not.forslag) {
    ut.push({ nar: f.nar, vem: f.skrev, slag: 'forslag', stycke: f.stycke, text: f.text, id: f.id, lage: f.lage });
  }
  return ut.sort((a, b) => String(b.nar || '').localeCompare(String(a.nar || '')));
}

// --- From the first version --------------------------------------------------------
// The first version anchored notes to a line's text in a scene. Each anchor is
// looked up the way the first version did, and the note moves to that
// paragraph. Nothing is dropped: what cannot be placed goes to its scene's
// heading, and the whole first-version file is kept under "fore".
export function migrera(v1, filtext, slag = SLAG_EPISOD) {
  const not = tomAnteckning(v1.episod != null ? String(v1.episod) : '');
  const paras = justera(tolka(filtext, slag).paras, null);
  const manus = V1.tolka(filtext);
  const paRad = new Map(paras.map((p) => [p.rad, p]));
  const scenId = (nr) => {
    const p = paras.find((x) => x.typ === 'scen' && x.text.startsWith(`${nr}.`));
    return p ? p.id : (paras[0] ? paras[0].id : null);
  };
  const finn = (mal) => {
    if (!mal || mal.text == null || mal.struken) return null;
    const i = V1.hitta(manus, mal);
    if (i < 0 || manus.rader[i].innehall !== mal.text) return null;
    return paRad.get(i) || null;
  };
  const somStycke = (innehall) => {
    const q = tolkaRad(`> ${innehall}`, true);
    return { text: q.text, typ: q.typ, attrs: rensaAttrs(q.typ, q.attrs) };
  };
  const medKropp = (innehall, kropp) => {
    const r = V1.tolkaInnehall(innehall);
    if (r.typ === 'replik' && typeof r.kropp === 'string' && innehall.endsWith(r.kropp)) return innehall.slice(0, innehall.length - r.kropp.length) + kropp;
    return kropp;
  };
  for (const post of v1.rader || []) {
    const p = finn(post.mal);
    if (!p) continue;
    const lista = not.historik[p.id] || (not.historik[p.id] = []);
    for (const t of post.tidigare || []) {
      lista.push({ ...somStycke(medKropp(post.mal.text, t.kropp)), vem: t.skrev || null, nar: t.nar || null, hur: t.skrev === 'demi' && !t.nar ? 'utkast' : 'andrade' });
    }
    lista.push({ ...somStycke(post.mal.text), vem: post.skrev || null, nar: post.nar || null, hur: post.hur || 'andrade', ...(post.av ? { av: post.av } : {}) });
  }
  const struken = new Map();
  for (const s of v1.strukna || []) {
    const id = `v1s-${s.id}`;
    struken.set(s.id, id);
    const efter = finn(s.granne);
    not.historik[id] = [
      ...(s.tidigare || []).map((t) => ({ ...somStycke(medKropp(s.innehall, t.kropp)), vem: t.skrev || null, nar: t.nar || null, hur: 'andrade' })),
      { ...somStycke(s.innehall), vem: s.skrev || null, nar: s.skrevNar || null, hur: s.skrev === 'demi' && !s.skrevNar ? 'utkast' : 'andrade' },
      { borta: true, efter: efter ? efter.id : scenId(s.scen), vem: (s.strok && s.strok.av) || null, nar: (s.strok && s.strok.nar) || null },
    ];
  }
  const plats = (mal) => {
    if (mal && mal.struken && struken.has(mal.struken)) return { stycke: struken.get(mal.struken), galde: mal.text != null ? somStycke(mal.text).text : null };
    const p = finn(mal);
    if (p) return { stycke: p.id, galde: p.text };
    return { stycke: scenId(mal && mal.scen), galde: mal && mal.text != null ? somStycke(mal.text).text : null, los: !!(mal && mal.text != null) };
  };
  for (const f of v1.forslag || []) {
    const pl = plats(f.mal);
    const post = { id: f.id, stycke: pl.stycke, galde: pl.galde, skrev: f.skrev, nar: f.nar, lage: f.lage || 'oppet' };
    if (!f.mal || f.mal.text == null) {
      Object.assign(post, { fri: true, text: f.kropp, typ: 'stycke', attrs: { form: 'fri' } });
    } else {
      Object.assign(post, somStycke(medKropp(f.mal.text, f.kropp)));
      if (pl.los) post.los = true;
    }
    if (f.inlagt) post.inlagt = f.inlagt;
    if (f.undan) post.undan = f.undan;
    if (f.ja && f.ja.length) post.ja = f.ja;
    not.forslag.push(post);
  }
  for (const k of v1.kommentarer || []) {
    const pl = plats(k.mal);
    const post = { id: k.id, stycke: pl.stycke, galde: pl.galde, text: k.text, galler: k.galler || null, skrev: k.skrev, nar: k.nar };
    for (const f of ['svarPa', 'till', 'klar', 'borta']) if (k[f] != null) post[f] = k[f];
    not.kommentarer.push(post);
  }
  // Replies follow the post that started their thread.
  const rot = new Map([...not.kommentarer, ...not.forslag].map((x) => [x.id, x]));
  for (const k of not.kommentarer) if (k.svarPa && rot.has(k.svarPa)) k.stycke = rot.get(k.svarPa).stycke;
  not.stycken = skuggaFor(paras);
  not.fore = v1;
  return not;
}

// --- Lore pages ---------------------------------------------------------------------
// One file for all pages people write. A page's text is a list of lines (it
// reads well in an editor); joined with "\n" it is the page. Its notes (the
// same kind a manuscript has) live on the page, under "rum".

export const tomLore = () => ({ format: 2, sidor: [] });

export function lasLore(text) {
  if (text == null) return tomLore();
  let lore;
  try {
    lore = JSON.parse(text);
  } catch {
    throw trasig('Loresidorna');
  }
  if (!lore || typeof lore !== 'object' || (lore.sidor != null && !Array.isArray(lore.sidor))) throw trasig('Loresidorna');
  if (lore.sidor == null) lore.sidor = [];
  for (const s of lore.sidor) {
    if (!Array.isArray(s.text)) s.text = typeof s.text === 'string' ? s.text.split('\n') : [];
  }
  return lore;
}

export const skrivLore = (lore) => `${JSON.stringify(lore, null, 2)}\n`;
export const loreText = (sida) => (sida.text || []).join('\n');

export function loreSida(lore, id) {
  const s = lore.sidor.find((x) => x.id === id);
  if (!s) throw new RumFel('saknas', 'Sidan finns inte kvar.');
  return s;
}

export function nyLoresida(lore0, { id, titel, text = '', vem, nar }) {
  const lore = kopia(lore0);
  lore.sidor.push({ id, titel: titel || 'Ny sida', text: String(text).split('\n'), skrev: vem, skapad: nar });
  return lore;
}

export function loreTitel(lore0, { id, titel, vem, nar }) {
  const lore = kopia(lore0);
  const s = loreSida(lore, id);
  if (!String(titel || '').trim()) throw new RumFel('tom', 'Sidan behöver en titel.');
  s.titlar = [...(s.titlar || []), { titel: s.titel, nar: (s.titelAndrad && s.titelAndrad.nar) || s.skapad }];
  s.titel = titel;
  s.titelAndrad = { av: vem, nar };
  return lore;
}

export function taBortLoresida(lore0, { id, vem, nar, tillbaka = false }) {
  const lore = kopia(lore0);
  const s = loreSida(lore, id);
  if (tillbaka) delete s.borta; else s.borta = { av: vem, nar };
  return lore;
}

// --- Settings ----------------------------------------------------------------------
// What each person has chosen for themselves: whether Demi's posts are hidden
// (doljDemi), whether the margin shows who last changed each paragraph
// (visaVem), and when they last had each document open (besok).

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
  return {
    doljDemi: typeof egna.doljDemi === 'boolean' ? egna.doljDemi : !!forval.doljDemi,
    visaVem: typeof egna.visaVem === 'boolean' ? egna.visaVem : true,
    besok: egna.besok && typeof egna.besok === 'object' ? egna.besok : {},
  };
}

const NYCKLAR = { doljDemi: 'boolean', visaVem: 'boolean' };

export function sattInstallning(inst0, { vem, nyckel: n, varde, nar }) {
  const inst = kopia(inst0);
  const egna = { ...(inst.personer[vem] || {}) };
  if (n === 'besok') {
    if (!varde || typeof varde.dok !== 'string') throw new RumFel('okand', 'Den inställningen finns inte.');
    egna.besok = { ...(egna.besok || {}), [varde.dok]: varde.nar };
  } else {
    if (!NYCKLAR[n] || typeof varde !== NYCKLAR[n]) throw new RumFel('okand', 'Den inställningen finns inte.');
    egna[n] = varde;
    egna.andrad = nar;
  }
  inst.personer[vem] = egna;
  return inst;
}
