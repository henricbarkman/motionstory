// The directing desk: how each line of an episode is to be heard.
//
// The text lives in the OnlyOffice document Manus and reaches the md file
// through the mirror (data/glimt-oo/mirror.py in generalassistant). The room
// no longer writes text. What it keeps, per line, is the timing, the voice,
// the direction as v4 tags, where the sound goes, the takes rendered here and
// which one is chosen, and a rewrite of the words asked for at the desk (it
// goes back into Manus with a comment, by data/glimt-oo/tillbaka.py).
//
// All of it is in one notes file per episode, regi-<dok>.json next to the
// room's other notes in generalassistant/data/glimt-rummet/, never in the
// public repo:
//
//   { format: 1, dok, stycken: [[id, md line]], rader: { <id>: Rad } }
//   Rad: { pausFore, pausEfter      seconds, or null for the app's
//          rost                     a key in the episode's "voices", or null
//          regi, regiFor            the text the voice gets, with v4 tags, and
//                                   the md line it was written for
//          ljud                     where the sound goes, in words
//          tagningar: [Tagning], vald  takes, newest last; the chosen take's id
//          omskrivningar: [Omskr]   rewrites asked for here, newest last
//          andrad: { vem, nar } }
//   Tagning: { id, fil, text, rost, voice, modell, sek, tecken, vem, nar }
//   Omskr: { fran, till, vem, nar, lage: 'vantar' | 'inford' | 'fel', svar?, klart? }
//
// stycken is the desk's shadow of the md file, so a line keeps its notes when
// the mirror rewrites its words (dok.js: justera).

import * as D from './dok.js';
import { tecken, kroppDelar } from './manus.js';
import { ljudFor } from './ljud.js';

export const FORMAT = 1;
export const MODELL = 'eleven_v4';
// The lines a voice says. Regi lines are direction and sound, not spoken.
export const TALADE = new Set(['replik', 'variant']);
// What the desk shows of a scene besides the spoken lines.
const VISAS = new Set(['scen', 'mekanik', 'replik', 'regi', 'variant', 'gren', 'stycke']);
// A pause at the desk: from nothing to a long held breath.
export const PAUS_MAX = 30;
export const PAUS_STEG = 0.25;
// The episodes whose text lives in Manus in OnlyOffice. The Swedish episode 1
// is not there, so its lines are not rewritten at the desk.
export const I_MANUS = ['1en', '2', '3'];

export class RegiFel extends Error {
  constructor(kod, text) {
    super(text);
    this.name = 'RegiFel';
    this.kod = kod;
  }
}

export const tomRegi = (dok) => ({ format: FORMAT, dok, stycken: [], rader: {} });

export function lasRegi(text, dok) {
  if (text == null || text === '') return tomRegi(dok);
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw new RegiFel('trasig', 'Regibordets anteckningar går inte att läsa.');
  }
  if (!r || typeof r !== 'object' || r.format !== FORMAT) {
    throw new RegiFel('format', 'Regibordets anteckningar har ett format sidan inte känner.');
  }
  if (r.dok !== dok) throw new RegiFel('dok', `Anteckningarna gäller ${r.dok}, inte ${dok}.`);
  return { ...r, stycken: Array.isArray(r.stycken) ? r.stycken : [], rader: r.rader && typeof r.rader === 'object' ? r.rader : {} };
}

export const skrivRegi = (r) => `${JSON.stringify(r, null, 2)}\n`;

const klon = (x) => JSON.parse(JSON.stringify(x));

// --- The lines ---------------------------------------------------------------------

// What a paragraph says, as the manuscript writes it inside the "> ".
export function kroppFor(p) {
  if (p.typ === 'regi') return `(${p.text})`;
  return p.text;
}

// md text + notes -> the rows the desk shows, each { id, typ, text, raw, scen,
// etikett, kropp, talad }, and the paragraphs (with ids) for the shadow.
export function raderFor(mdText, regi) {
  const { paras } = D.tolka(mdText, D.SLAG_EPISOD);
  D.justera(paras, regi ? regi.stycken : null);
  const scener = D.scenerFor(paras, D.SLAG_EPISOD);
  const rader = [];
  paras.forEach((p, k) => {
    if (scener[k] == null || !VISAS.has(p.typ)) return;
    rader.push({
      id: p.id,
      typ: p.typ,
      text: p.text,
      raw: p.raw,
      scen: scener[k],
      etikett: p.typ === 'variant' ? p.attrs.etikett : null,
      kropp: kroppFor(p),
      talad: TALADE.has(p.typ),
    });
  });
  return { rader, paras };
}

export const skuggaFor = (paras) => D.skuggaFor(paras);

// --- The text a voice gets ------------------------------------------------------

const ren = (s) => s.replace(/\s+/g, ' ').trim();

// One direction, "(to herself)", as a v4 tag. A pause the manuscript marks
// with its length ("pause about 2 s; was 1 s on 23/10") is [pause]: the length
// is the desk's timing, not something to read aloud.
function tagg(regi) {
  const inne = ren(regi.replace(/^\(|\)$/g, ''));
  if (!inne) return '';
  // A timed pause mark with its history ("was 1 s on 23/10") is all timing.
  if (/^paus(e)?\s+(?:about|ungefär|cirka|ca\.?)?\s*\d/i.test(inne)) return '[pause]';
  if (/^paus(e)?\b/i.test(inne)) {
    const rest = ren(inne.replace(/^paus(e)?\b[^,;]*[,;]?/i, ''));
    return rest ? `[pause] [${rest}]` : '[pause]';
  }
  return `[${inne.replace(/[[\]]/g, '')}]`;
}

// The manuscript's line -> the text a v4 voice is given. Directions become
// tags, Vega's words stay; a line that is another voice gives its words only
// (the name in the parentheses is who speaks, not how).
export function v4Text(kropp) {
  const d = kroppDelar(kropp);
  if (d.slag === 'annan') return ren(d.ord);
  if (d.slag === 'regi') return '';
  const ut = [];
  for (const t of tecken(kropp)) {
    if (t.typ === 'regi') {
      // A direction that holds another voice's words is not hers to say.
      if ((t.delar || []).some((x) => x.typ === 'annan')) continue;
      const g = tagg(t.text);
      if (g) ut.push(g);
    } else {
      const s = ren(t.text.replace(/"/g, ''));
      if (s) ut.push(s);
    }
  }
  return ren(ut.join(' '));
}

// The words alone, for counting and comparing: no tags.
export const ordI = (text) => ren(String(text || '').replace(/\[[^\]]*\]/g, ' '));

// --- What the app already has ------------------------------------------------------

// The episode's voices: [{ nyckel, namn, id }], from episod-N.json. The id is
// read from there every time, so changing a voice is changing one value.
export function rosterFor(kapitel) {
  const v = (kapitel && kapitel.voices) || {};
  const not = (kapitel && kapitel.voiceNotes) || {};
  return Object.entries(v).map(([nyckel, id]) => {
    const n = not[nyckel] ? String(not[nyckel]).split(/[,(]/)[0].trim() : '';
    return { nyckel, id, namn: n && n.length <= 24 ? n : nyckel === 'vega' ? 'Vega' : nyckel };
  });
}

// The voice a line has unless the desk says otherwise: the voice of the clip
// it is recorded in, or Vega's, or for another voice's line the first voice
// that is not Vega's.
export function forvaldRost(rad, ljud, kapitel) {
  const roster = rosterFor(kapitel);
  if (!roster.length) return null;
  const l = ljud ? ljudFor(rad.kropp, ljud) : null;
  if (l && l.lage === 'inspelad' && l.delar.length) {
    const k = ljud.klipp.get(l.delar[0].id);
    if (k && roster.some((r) => r.nyckel === k.rost)) return k.rost;
  }
  if (kroppDelar(rad.kropp).slag === 'annan') {
    const annan = roster.find((r) => r.nyckel !== 'vega');
    if (annan) return annan.nyckel;
  }
  return roster.some((r) => r.nyckel === 'vega') ? 'vega' : roster[0].nyckel;
}

// The app's pause before a line, from rummet/apptider.json: the silence the
// app plays before a clip ("gaps" in glimt/episod1.js). A line that is not
// the first paragraph of its clip has its pause inside the recording.
// -> { sek, iInspelning } or null when the app has nothing for the line.
export function appPausFore(rad, ljud, apptider) {
  if (!ljud) return null;
  const l = ljudFor(rad.kropp, ljud);
  if (l.lage !== 'inspelad' || !l.delar.length) return null;
  const del = l.delar[0];
  if (del.stycke > 0) return { sek: null, iInspelning: true };
  const gaps = (apptider && ljud.id && apptider[ljud.id]) || {};
  return { sek: Number(gaps[del.id]) || 0, iInspelning: false };
}

// The pause the manuscript asks for before a line: a direction of its own
// just above it, "(pause about 2 s; was about 1 s on 23/10)". rader: the rows
// from raderFor, k: the line's place in them. -> seconds or null.
export function manusPausFore(rader, k) {
  const fore = rader[k - 1];
  if (!fore || fore.typ !== 'regi') return null;
  const m = /^paus(?:e)?\s+(?:about|ungefär|cirka|ca\.?)?\s*([\d]+(?:[.,]\d+)?)\s*s\b/i.exec(fore.text.trim());
  return m ? Number(m[1].replace(',', '.')) : null;
}

// --- A row's notes, read --------------------------------------------------------------

const tomRad = () => ({
  pausFore: null, pausEfter: null, rost: null, regi: null, regiFor: null, ljud: '',
  tagningar: [], vald: null, omskrivningar: [], andrad: null,
});

export const radNot = (regi, id) => ({ ...tomRad(), ...((regi && regi.rader && regi.rader[id]) || {}) });

// The rewrite that still decides what the line says at the desk: the newest
// one, as long as the md line still reads as it did when it was asked for.
// Once the mirror has carried Manus's new words into md, the line has moved on.
export function oppenOmskrivning(rad, not) {
  const o = not.omskrivningar[not.omskrivningar.length - 1];
  if (!o || o.lage === 'fel' || rad.raw !== o.fran) return null;
  return o;
}

// The line as the desk shows and renders it.
export function aktuellKropp(rad, not) {
  const o = oppenOmskrivning(rad, not);
  if (!o) return rad.kropp;
  const ny = D.tolkaRad(o.till, true);
  return ny.typ === 'regi' ? `(${ny.text})` : ny.text;
}

// The text the voice gets: the desk's own, while it was written for the line
// as it stands; otherwise made from the manuscript's directions.
export function regiText(rad, not) {
  const kropp = aktuellKropp(rad, not);
  if (not.regi != null && not.regiFor === kropp) return not.regi;
  return v4Text(kropp);
}

// True when the desk has its own text, but for words the line no longer has.
export const regiForAldrad = (rad, not) => not.regi != null && not.regiFor !== aktuellKropp(rad, not);

// The take a play button plays: the chosen one, else none (the app's sound).
export function valdTagning(not) {
  return not.vald ? not.tagningar.find((t) => t.id === not.vald) || null : null;
}

// --- Changes -------------------------------------------------------------------------
// Each takes the notes as they are now and gives back new ones, so a save that
// meets someone else's can be done again on the fresh file.

// av: { vem, nar }, who changed it and when.
function med(regi0, id, fn, { vem, nar }) {
  const regi = klon(regi0);
  const r = radNot(regi, id);
  fn(r);
  r.andrad = { vem, nar };
  regi.rader[id] = r;
  return regi;
}

const avrunda = (x) => Math.round(x / PAUS_STEG) * PAUS_STEG;

export function sattPaus(regi, id, falt, sek, av) {
  if (falt !== 'pausFore' && falt !== 'pausEfter') throw new RegiFel('falt', `Okänt fält: ${falt}`);
  let v = sek;
  if (v !== null) {
    v = Number(v);
    if (!Number.isFinite(v) || v < 0) throw new RegiFel('paus', 'En paus är noll sekunder eller mer.');
    v = Math.min(PAUS_MAX, avrunda(v));
  }
  return med(regi, id, (r) => { r[falt] = v; }, av);
}

export function sattRost(regi, id, rost, av) {
  return med(regi, id, (r) => { r.rost = rost || null; }, av);
}

// regi null: back to the manuscript's directions.
export function sattRegi(regi, id, text, kropp, av) {
  if (text != null && /[\n\r]/.test(text)) throw new RegiFel('rader', 'Regin är en rad.');
  return med(regi, id, (r) => {
    r.regi = text == null ? null : ren(text);
    r.regiFor = text == null ? null : kropp;
  }, av);
}

export function sattLjud(regi, id, text, av) {
  return med(regi, id, (r) => { r.ljud = ren(String(text || '')); }, av);
}

export function laggTillTagning(regi, id, tagning, av) {
  for (const k of ['id', 'fil', 'text']) {
    if (!tagning || typeof tagning[k] !== 'string' || !tagning[k]) throw new RegiFel('tagning', `Tagningen saknar ${k}.`);
  }
  return med(regi, id, (r) => {
    if (!r.tagningar.some((t) => t.id === tagning.id)) r.tagningar.push({ ...tagning });
  }, av);
}

// tagId null: the app's sound again.
export function valjTagning(regi, id, tagId, av) {
  return med(regi, id, (r) => {
    if (tagId != null && !r.tagningar.some((t) => t.id === tagId)) throw new RegiFel('tagning', 'Den tagningen finns inte.');
    r.vald = tagId;
  }, av);
}

// A rewrite of the words, asked for at the desk. It is checked here the way
// the room checked a typed line: one line, and still the same kind of line.
// Only spoken lines can be rewritten; the words go back into Manus.
export function omskriv(regi, rad, nyKropp, av) {
  if (!rad.talad) throw new RegiFel('slag', 'Bara repliker skrivs om här.');
  const kropp = String(nyKropp == null ? '' : nyKropp);
  if (/[\n\r]/.test(kropp)) throw new RegiFel('rader', 'En replik är en rad.');
  if (!ren(kropp)) throw new RegiFel('tom', 'Repliken är tom.');
  const ny = { typ: rad.typ, attrs: rad.typ === 'variant' ? { etikett: rad.etikett } : {}, text: kropp };
  const till = D.skrivRad(ny);
  const tillbaka = D.tolkaRad(till, true);
  if (tillbaka.typ !== rad.typ || tillbaka.text !== kropp) {
    throw new RegiFel('format', 'Så som texten börjar eller är inramad läses den som något annat än en replik. Hakparentes först och stjärnor runt texten är upptagna.');
  }
  const not = radNot(regi, rad.id);
  if (aktuellKropp(rad, not) === kropp) throw new RegiFel('samma', 'Texten är densamma som förut.');
  return med(regi, rad.id, (r) => {
    // A rewrite of a rewrite that has not reached Manus yet replaces it.
    const sist = r.omskrivningar[r.omskrivningar.length - 1];
    if (sist && sist.lage === 'vantar' && sist.fran === rad.raw) r.omskrivningar.pop();
    r.omskrivningar.push({ fran: rad.raw, till, vem: av.vem, nar: av.nar, lage: 'vantar' });
  }, av);
}

export const vantandeOmskrivningar = (regi) => Object.values((regi && regi.rader) || {})
  .some((r) => (r.omskrivningar || []).some((o) => o.lage === 'vantar'));

// --- Timing ---------------------------------------------------------------------------

// The pause before a line as the desk plays it: the desk's own, else what the
// manuscript asks for, else what the app does. -> { sek, kalla: 'bord' |
// 'manus' | 'app' | null }.
export function pausFore(not, manus, app) {
  if (not && not.pausFore != null) return { sek: not.pausFore, kalla: 'bord' };
  if (manus != null) return { sek: manus, kalla: 'manus' };
  if (app && app.sek != null) return { sek: app.sek, kalla: 'app' };
  return { sek: 0, kalla: null };
}

// The silence between two lines that follow each other: what the first holds
// after it, and what the next waits before it.
export function pausMellan(foreNot, nastaFore) {
  const efter = foreNot && foreNot.pausEfter != null ? foreNot.pausEfter : 0;
  return efter + (nastaFore ? nastaFore.sek : 0);
}

// Seconds as the desk writes them: "1,5 s", "0 s".
export const sekText = (s) => `${String(Math.round(s * 100) / 100).replace('.', ',')} s`;
