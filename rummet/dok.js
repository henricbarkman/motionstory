// A text file as the room edits it: a list of paragraphs, one per line of
// the file. The file stays the only truth for the text. Reading and writing
// it back without a change gives the same bytes: a paragraph nobody touched is
// written as the exact line it was read from, with the exact blank lines (or
// lone ">") that stood before it.
//
// Paragraph kinds (typ), and the line each one is in the file:
//   rubrik  {niva, prefix}  "## text"         prefix: "Glimt, episod 1: " on the title
//   scen                    "## 3. Trädet"   a scene, between the first one and the next ---
//   mekanik                 "*Trigger: text*"
//   replik                  "> text"         what is heard (directions in parentheses inside)
//   regi                    "> (text)"       a whole line of direction or sound
//   variant {etikett}       "> [mörkt] text" a line the phone chooses between
//   gren    {form}          "> **text**" (fet), "> *text:*" (kursiv), "**text**" (fri)
//   stycke  {form}          "text" (fri), "*text*" (kursiv), "> text" (citat), "> *text*" (citat-kursiv)
//   punkt   {markor}        "- text", "1. text"
//   tabell                  "| a | b |", kept as written
//   linje                   "---"
//
// Which kind a line is depends on where it stands: inside the scenes a "> "
// line is something heard, outside them it is a quote. People write words;
// this module writes the marks around them, and checks that what it writes
// reads back as the same kind of paragraph before anything is saved.

export const SLAG_EPISOD = 'episod';
export const SLAG_FRI = 'fri';

export const NAMN = {
  rubrik: 'Rubrik', scen: 'Scenrubrik', mekanik: 'Mekanik', replik: 'Replik', regi: 'Regi och ljud',
  variant: 'Variant', gren: 'Gren', stycke: 'Text', punkt: 'Punkt', tabell: 'Tabellrad', linje: 'Linje',
};

// Attributes that are part of a paragraph's content, per kind.
const ATTR = {
  rubrik: ['niva', 'prefix'], variant: ['etikett'], gren: ['form'], stycke: ['form'], punkt: ['markor'],
};

export function rensaAttrs(typ, attrs = {}) {
  const ut = {};
  for (const k of ATTR[typ] || []) ut[k] = attrs[k] == null ? FORVAL[typ][k] : attrs[k];
  return ut;
}

const FORVAL = {
  rubrik: { niva: 2, prefix: '' }, variant: { etikett: '' }, gren: { form: 'fet' }, stycke: { form: 'fri' }, punkt: { markor: '- ' },
};

// What a paragraph says, as one string: equal keys, equal paragraphs.
export function nyckel(p) {
  return `${p.typ}\u0001${JSON.stringify(rensaAttrs(p.typ, p.attrs))}\u0001${p.text}`;
}

export const arSeparator = (ra) => /^\s*$/.test(ra) || /^>\s*$/.test(ra);

const RE_SCEN = /^## (\d+\. .+)$/;
const RE_RUBRIK = /^(#{1,6}) (.*)$/;
const RE_VARIANT = /^\[([^\]]+)\] (.*)$/;
const RE_PUNKT = /^(\s*(?:[-*+]|\d+[.)]) )(.*)$/;

function slutparentes(s) {
  let djup = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '(') djup++;
    else if (s[k] === ')') { djup--; if (djup === 0) return k; }
  }
  return -1;
}

// What is inside a "> " line in a scene.
function citatIScen(innehall) {
  let m = /^\*\*(.+)\*\*$/.exec(innehall);
  if (m) return { typ: 'gren', attrs: { form: 'fet' }, text: m[1] };
  m = /^\*([^*]+:)\*$/.exec(innehall);
  if (m) return { typ: 'gren', attrs: { form: 'kursiv' }, text: m[1] };
  m = /^\*([^*]+)\*$/.exec(innehall);
  if (m) return { typ: 'stycke', attrs: { form: 'citat-kursiv' }, text: m[1] };
  m = RE_VARIANT.exec(innehall);
  if (m) return { typ: 'variant', attrs: { etikett: m[1] }, text: m[2] };
  if (innehall.startsWith('(') && innehall.length > 2 && slutparentes(innehall) === innehall.length - 1) {
    return { typ: 'regi', attrs: {}, text: innehall.slice(1, -1) };
  }
  return { typ: 'replik', attrs: {}, text: innehall };
}

// One line that is not a separator -> { typ, attrs, text }.
export function tolkaRad(ra, iScen) {
  if (ra.trim() === '---') return { typ: 'linje', attrs: {}, text: '' };
  if (iScen) {
    const s = RE_SCEN.exec(ra);
    if (s) return { typ: 'scen', attrs: {}, text: s[1] };
  }
  let m = RE_RUBRIK.exec(ra);
  if (m) {
    const niva = m[1].length;
    let text = m[2];
    let prefix = '';
    const p = niva === 1 ? /^(Glimt[^:]*: )(.+)$/.exec(text) : null;
    if (p) { prefix = p[1]; text = p[2]; }
    return { typ: 'rubrik', attrs: { niva, prefix }, text };
  }
  if (ra.startsWith('>')) {
    const innehall = ra.startsWith('> ') ? ra.slice(2) : ra.slice(1);
    if (iScen) return citatIScen(innehall);
    return { typ: 'stycke', attrs: { form: 'citat' }, text: innehall };
  }
  if (iScen) {
    m = /^\*Trigger: (.+)\*$/.exec(ra);
    if (m) return { typ: 'mekanik', attrs: {}, text: m[1] };
    m = /^\*\*(.+)\*\*$/.exec(ra);
    if (m) return { typ: 'gren', attrs: { form: 'fri' }, text: m[1] };
    m = /^\*([^*]+)\*$/.exec(ra);
    if (m) return { typ: 'stycke', attrs: { form: 'kursiv' }, text: m[1] };
  }
  m = RE_PUNKT.exec(ra);
  if (m) return { typ: 'punkt', attrs: { markor: m[1] }, text: m[2] };
  if (/^\s*\|/.test(ra)) return { typ: 'tabell', attrs: {}, text: ra };
  return { typ: 'stycke', attrs: { form: 'fri' }, text: ra };
}

// The line a paragraph is written as.
export function skrivRad(p) {
  const a = rensaAttrs(p.typ, p.attrs);
  const t = p.text;
  switch (p.typ) {
    case 'rubrik': return `${'#'.repeat(Math.min(6, Math.max(1, a.niva)))} ${a.prefix || ''}${t}`;
    case 'scen': return `## ${t}`;
    case 'mekanik': return `*Trigger: ${t}*`;
    case 'replik': return `> ${t}`;
    case 'regi': return `> (${t})`;
    case 'variant': return `> [${a.etikett}] ${t}`;
    case 'gren': return a.form === 'kursiv' ? `> *${t}*` : a.form === 'fri' ? `**${t}**` : `> **${t}**`;
    case 'stycke':
      if (a.form === 'kursiv') return `*${t}*`;
      if (a.form === 'citat') return `> ${t}`;
      if (a.form === 'citat-kursiv') return `> *${t}*`;
      return t;
    case 'punkt': return `${a.markor}${t}`;
    case 'tabell': return t;
    case 'linje': return '---';
    default: return t;
  }
}

export const arCitat = (p) => skrivRad(p).startsWith('>');

// Which paragraphs stand among the scenes: from the first scene heading to
// the next line. Only episodes have scenes.
export function scenomrade(typer, slag) {
  const ut = new Array(typer.length).fill(false);
  if (slag !== SLAG_EPISOD) return ut;
  const start = typer.indexOf('scen');
  if (start < 0) return ut;
  for (let k = start; k < typer.length; k++) {
    if (typer[k] === 'linje') break;
    ut[k] = true;
  }
  return ut;
}

// Why a paragraph cannot be saved as it stands, or null. A paragraph that
// would read back as something else is held in the browser instead of being
// written as something its writer did not mean.
export const SCENTYPER = new Set(['scen', 'mekanik', 'replik', 'regi', 'variant', 'gren']);

export function fel(p, iScen) {
  if (p.typ === 'linje') return null;
  if (/[\n\r]/.test(p.text)) return 'flera-rader';
  if (p.text.trim() === '') return 'tom';
  if (p.typ === 'variant') {
    const e = String((p.attrs && p.attrs.etikett) || '');
    if (!e.trim()) return 'utan-etikett';
    if (/[\]\n\r]/.test(e)) return 'etikett';
  }
  if (!iScen && SCENTYPER.has(p.typ)) return 'utanfor-scen';
  const ra = skrivRad(p);
  if (arSeparator(ra)) return 'tom';
  if (nyckel(tolkaRad(ra, iScen)) !== nyckel(p)) return p.typ === 'scen' ? 'scen' : p.typ === 'regi' ? 'regi' : 'form';
  return null;
}

// The whole file as it would be written reads back as exactly these
// paragraphs, in this order. The last check before anything is saved: where
// the scenes start and end is only known for the whole file.
export function lasesSom(text, paras, slag) {
  const q = tolka(text, slag).paras;
  if (q.length !== paras.length) return false;
  return q.every((x, k) => nyckel(x) === nyckel(paras[k]));
}

export const FELTEXT = {
  'flera-rader': 'Ett stycke är en rad. Tryck Enter för ett nytt stycke.',
  tom: 'Tomt stycke. Det sparas inte förrän det har text.',
  'utan-etikett': 'Varianten saknar etikett. Välj en, till exempel ljust eller gång.',
  etikett: 'Etiketten får inte innehålla ] eller radbrytning.',
  scen: 'En scenrubrik börjar med sitt nummer och en punkt, till exempel 3. Trädet.',
  regi: 'Regin har en parentes som stänger mitt i. Ta bort den, eller gör stycket till en replik.',
  'utanfor-scen': 'Den här stycketypen hör hemma i en scen. Byt typ, eller flytta stycket.',
  form: 'Så som stycket börjar eller slutar läses det som något annat i filen (en hakparentes först blir en variant, stjärnor runt texten blir kursiv). Ändra början eller slutet, eller byt stycketyp.',
};

// --- Reading and writing a whole file ------------------------------------------

// text -> { paras, slut }. Each paragraph: { typ, attrs, text, raw, sep, rad }.
// raw is the line as read, sep the separator lines just before it, rad its
// line number. slut: the separator lines after the last paragraph (the final
// newline is one of them).
export function tolka(text, slag = SLAG_EPISOD) {
  const raa = text.split('\n');
  let start = -1;
  let slut = raa.length;
  if (slag === SLAG_EPISOD) {
    start = raa.findIndex((ra) => RE_SCEN.test(ra));
    if (start >= 0) {
      const s = raa.findIndex((ra, i) => i > start && ra.trim() === '---');
      if (s >= 0) slut = s;
    }
  }
  const paras = [];
  let sep = [];
  raa.forEach((ra, i) => {
    if (arSeparator(ra)) { sep.push(ra); return; }
    const iScen = start >= 0 && i >= start && i < slut;
    const q = tolkaRad(ra, iScen);
    const p = { typ: q.typ, attrs: rensaAttrs(q.typ, q.attrs), text: q.text, raw: ra, sep, rad: i };
    p.orig = nyckel(p);
    paras.push(p);
    sep = [];
  });
  return { paras, slut: sep, slag };
}

// The separator lines a paragraph keeps when its neighbour above changed.
export function sepOk(fore, p, sep) {
  if (!fore) return true;
  if (!Array.isArray(sep) || !sep.every(arSeparator)) return false;
  const a = arCitat(fore);
  const b = arCitat(p);
  if (a && b) return true;
  if (a && !b) return sep.some((s) => /^\s*$/.test(s));
  return !sep.some((s) => s.startsWith('>'));
}

// foreSep: the separator the paragraph above stands with. Outside the quoted
// lines a new paragraph of the same kind as the one above follows its example
// (the catalogue's glued lines stay glued, a list stays a list).
export function forvaldSep(fore, p, foreSep) {
  if (!fore) return [];
  if (Array.isArray(foreSep) && fore.typ === 'stycke' && p.typ === 'stycke' && !arCitat(p) && !arCitat(fore)
    && sepOk(fore, p, foreSep)) {
    return foreSep.slice();
  }
  const a = arCitat(fore);
  const b = arCitat(p);
  if (a && b) {
    if (p.typ === 'variant' && fore.typ === 'variant') return [];
    if (fore.typ === 'gren') return [];
    return ['>'];
  }
  if (a !== b) return [''];
  if (p.typ === 'punkt' && fore.typ === 'punkt') return [];
  if (p.typ === 'tabell' && fore.typ === 'tabell') return [];
  if (p.typ === 'mekanik' && (fore.typ === 'scen' || fore.typ === 'rubrik')) return [];
  return [''];
}

const oforandrad = (p) => p.raw != null && p.orig != null && p.orig === nyckel(p);

export const radFor = (p) => (oforandrad(p) ? p.raw : skrivRad(p));

// { paras, slut } -> text. The lines of untouched paragraphs come back as
// they were read.
export function skriv(dok) {
  const ut = [];
  let foreSep = null;
  dok.paras.forEach((p, k) => {
    const fore = k ? dok.paras[k - 1] : null;
    const egen = p.sep != null && sepOk(fore, p, p.sep);
    const sep = egen ? p.sep : forvaldSep(fore, p, foreSep);
    ut.push(...sep, radFor(p));
    foreSep = egen ? sep : null;
  });
  ut.push(...(Array.isArray(dok.slut) ? dok.slut : ['']));
  return ut.join('\n');
}

// --- Identity ------------------------------------------------------------------
// The file carries no ids. The room keeps a shadow of the file as it last
// wrote it ([[id, line], ...]) and finds each paragraph again in it: equal
// lines in the same order first, then, between those, lines that look alike.
// A line it cannot place gets an id made from its text, so two windows that
// read the same file give it the same id.

function hash(s) {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = ((h2 * 33) ^ c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

export const fastId = (ra, n) => `f${hash(`${ra}\u0001${n}`)}`;

export function nyttId() {
  const slump = (globalThis.crypto && globalThis.crypto.getRandomValues)
    ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('')
    : Math.random().toString(36).slice(2, 12);
  return `s${Date.now().toString(36)}${slump}`;
}

// Longest common subsequence of two lists of strings -> pairs [i, j].
function lcs(a, b) {
  let fore = 0;
  while (fore < a.length && fore < b.length && a[fore] === b[fore]) fore++;
  let efter = 0;
  while (efter < a.length - fore && efter < b.length - fore && a[a.length - 1 - efter] === b[b.length - 1 - efter]) efter++;
  const par = [];
  for (let k = 0; k < fore; k++) par.push([k, k]);
  const A = a.slice(fore, a.length - efter);
  const B = b.slice(fore, b.length - efter);
  const n = A.length;
  const m = B.length;
  if (n && m) {
    const t = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * (m + 1) + j] = A[i] === B[j] ? t[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(t[(i + 1) * (m + 1) + j], t[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { par.push([fore + i, fore + j]); i++; j++; } else if (t[(i + 1) * (m + 1) + j] >= t[i * (m + 1) + j + 1]) i++; else j++;
    }
  }
  for (let k = 0; k < efter; k++) par.push([a.length - efter + k, b.length - efter + k]);
  return par;
}

function bigram(s) {
  const t = s.toLowerCase().replace(/\s+/g, ' ');
  const m = new Map();
  for (let k = 0; k < t.length - 1; k++) {
    const g = t.slice(k, k + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

export function likhet(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const x = bigram(a);
  const y = bigram(b);
  let gem = 0;
  let nx = 0;
  let ny = 0;
  for (const v of x.values()) nx += v;
  for (const v of y.values()) ny += v;
  for (const [g, v] of x) if (y.has(g)) gem += Math.min(v, y.get(g));
  return (2 * gem) / (nx + ny);
}

// paras: from tolka(). skugga: [[id, line], ...] or null. Sets p.id on each
// paragraph and returns the paragraphs.
export function justera(paras, skugga) {
  const S = Array.isArray(skugga) ? skugga.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string') : [];
  const F = paras.map((p) => p.raw != null ? p.raw : skrivRad(p));
  const ids = new Array(paras.length).fill(null);
  const anvand = new Array(S.length).fill(false);
  const par = lcs(F, S.map((x) => x[1]));
  for (const [i, j] of par) { ids[i] = S[j][0]; anvand[j] = true; }
  // Between the equal lines: pair the rest that look alike, in order.
  const kanter = [[-1, -1], ...par, [F.length, S.length]];
  for (let k = 0; k < kanter.length - 1; k++) {
    const fi = [];
    const sj = [];
    for (let i = kanter[k][0] + 1; i < kanter[k + 1][0]; i++) fi.push(i);
    for (let j = kanter[k][1] + 1; j < kanter[k + 1][1]; j++) sj.push(j);
    if (!fi.length || !sj.length) continue;
    const samma = fi.length === sj.length;
    let fran = 0;
    for (const i of fi) {
      let basta = -1;
      let poang = 0;
      for (let x = fran; x < sj.length; x++) {
        const j = sj[x];
        const typS = tolkaRad(S[j][1], paras[i].typ === 'scen' || ['replik', 'regi', 'variant', 'mekanik'].includes(paras[i].typ)).typ;
        let v = likhet(F[i], S[j][1]);
        // A rewritten line in the same place, of the same kind, is the same
        // paragraph even when few words are left.
        if (samma && x === fi.indexOf(i) && typS === paras[i].typ) v = Math.max(v, 0.5);
        if (v > poang) { poang = v; basta = x; }
      }
      if (basta >= 0 && poang >= 0.5) {
        ids[i] = S[sj[basta]][0];
        anvand[sj[basta]] = true;
        fran = basta + 1;
      }
    }
  }
  const sett = new Map();
  paras.forEach((p, i) => {
    if (!ids[i]) {
      const n = sett.get(F[i]) || 0;
      sett.set(F[i], n + 1);
      ids[i] = fastId(F[i], n);
    }
    p.id = ids[i];
  });
  // Two paragraphs can never share an id (a shadow written by hand, say).
  const har = new Set();
  paras.forEach((p, i) => {
    if (har.has(p.id)) p.id = fastId(`${F[i]}\u0002${i}`, 0);
    har.add(p.id);
  });
  return paras;
}

export const skuggaFor = (paras) => paras.map((p) => [p.id, radFor(p)]);

// --- Merging -----------------------------------------------------------------------
// Three versions of the same file as paragraph lists with ids: bas (what the
// editor and the file last agreed on, per paragraph), lokal (the editor now)
// and fjarr (the file now). The result is the file to write.
//
// Per paragraph: changed on one side only, that side wins. Changed on both
// sides to different text: the editor's version (the one being saved) goes in
// the text, and the file's is returned as a krock, so it is shown beside the
// paragraph with a way to choose, and kept in the history. Nothing is dropped
// without a trace: a paragraph one side removed and the other changed stays.
// Order: the side that moved paragraphs around decides; if both did, the file.

const ordning = (lista, med) => lista.filter((p) => med.has(p.id)).map((p) => p.id);
const lika = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

export function sammanfoga(bas0, lokal, fjarr) {
  const basLista = bas0 instanceof Map ? [...bas0.values()] : bas0;
  const bas = bas0 instanceof Map ? bas0 : new Map(bas0.map((p) => [p.id, p]));
  const L = new Map(lokal.map((p) => [p.id, p]));
  const F = new Map(fjarr.map((p) => [p.id, p]));
  const andrad = (M, id) => {
    const b = bas.get(id);
    const x = M.get(id);
    if (!b) return !!x;
    if (!x) return true;
    return nyckel(b) !== nyckel(x);
  };
  const tagen = new Map();
  const krockar = [];
  const alla = new Set([...L.keys(), ...F.keys(), ...bas.keys()]);
  for (const id of alla) {
    const b = bas.get(id);
    const l = L.get(id);
    const f = F.get(id);
    if (l && f) {
      if (!andrad(L, id)) tagen.set(id, f);
      else if (!andrad(F, id) || nyckel(l) === nyckel(f)) tagen.set(id, l);
      else { tagen.set(id, l); krockar.push({ id, slag: 'text', lokal: l, fjarr: f, bas: b || null }); }
    } else if (l) {
      if (!b) tagen.set(id, l);
      else if (andrad(L, id)) { tagen.set(id, l); krockar.push({ id, slag: 'borttagen-fjarr', lokal: l, bas: b }); }
    } else if (f) {
      if (!b) tagen.set(id, f);
      else if (andrad(F, id)) { tagen.set(id, f); krockar.push({ id, slag: 'borttagen-lokalt', fjarr: f, bas: b }); }
    }
  }
  const gemensamma = new Set([...L.keys()].filter((id) => F.has(id) && bas.has(id)));
  const lokalFlyttade = !lika(ordning(lokal, gemensamma), ordning(basLista, gemensamma));
  const fjarrFlyttade = !lika(ordning(fjarr, gemensamma), ordning(basLista, gemensamma));
  const [rygg, ovrig] = lokalFlyttade && !fjarrFlyttade ? [lokal, fjarr] : [fjarr, lokal];
  // The backbone's order; what only the other side has goes in after the
  // paragraph it follows there.
  const ut = rygg.filter((p) => tagen.has(p.id)).map((p) => p.id);
  let index = new Map(ut.map((id, k) => [id, k]));
  ovrig.forEach((p, k) => {
    if (!tagen.has(p.id) || index.has(p.id)) return;
    let plats = -1;
    for (let x = k - 1; x >= 0; x--) if (index.has(ovrig[x].id)) { plats = index.get(ovrig[x].id) + 1; break; }
    if (plats < 0) {
      plats = ut.length;
      for (let x = k + 1; x < ovrig.length; x++) if (index.has(ovrig[x].id)) { plats = index.get(ovrig[x].id); break; }
    }
    ut.splice(plats, 0, p.id);
    index = new Map(ut.map((id, n) => [id, n]));
  });
  return { paras: ut.map((id) => tagen.get(id)), krockar };
}

// Paragraphs the editor knows under one id and the file (as just read) under
// another: the file's lines are named from the notes, and when those are
// behind (a write whose answer was lost, notes that did not get through,
// a change made outside the room) a line the editor has can come back with a
// new id. Each id the base has and the file lacks is paired with a line that
// is new in the file: the same text as the editor's or the base's version
// first, then, in order, one that looks alike. -> Map editor id -> file id.
export function namnbyten(bas, lokal, fjarr) {
  const L = new Map(lokal.map((p) => [p.id, p]));
  const F = new Set(fjarr.map((p) => p.id));
  const borta = [...bas.keys()].filter((id) => !F.has(id));
  const nya = fjarr.filter((p) => !bas.has(p.id) && !L.has(p.id));
  const byt = new Map();
  const tagna = new Set();
  for (const id of borta) {
    const nycklar = [nyckel(bas.get(id))];
    if (L.has(id)) nycklar.push(nyckel(L.get(id)));
    const t = nya.find((p) => !tagna.has(p.id) && nycklar.includes(nyckel(p)));
    if (t) { byt.set(id, t.id); tagna.add(t.id); }
  }
  const kvar = nya.filter((p) => !tagna.has(p.id));
  let fran = 0;
  for (const id of borta) {
    if (byt.has(id)) continue;
    const b = bas.get(id);
    const l = L.get(id) || b;
    let basta = -1;
    let poang = 0;
    for (let x = fran; x < kvar.length; x++) {
      const q = kvar[x];
      if (q.typ !== b.typ && q.typ !== l.typ) continue;
      const v = Math.max(likhet(skrivRad(b), skrivRad(q)), likhet(skrivRad(l), skrivRad(q)));
      if (v > poang) { poang = v; basta = x; }
    }
    if (basta >= 0 && poang >= 0.6) { byt.set(id, kvar[basta].id); fran = basta + 1; }
  }
  return byt;
}

// The scene each paragraph is in: its heading's number, or null.
export function scenerFor(paras, slag) {
  const omr = scenomrade(paras.map((p) => p.typ), slag);
  let nr = null;
  return paras.map((p, k) => {
    if (!omr[k]) { nr = null; return null; }
    if (p.typ === 'scen') nr = /^(\d+)\./.exec(p.text) ? /^(\d+)\./.exec(p.text)[1] : nr;
    return nr;
  });
}
