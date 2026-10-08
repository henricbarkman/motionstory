// The mechanics catalogue (stories/glimt/mekaniker.md), read from the file
// every time. Nothing about the mechanics is written here: a new "### Name"
// in the file is a new mechanic in the room.
//
// File form the reader expects (and what it does when something is missing):
//   ## Group                     a group of mechanics
//   ### Name                     a mechanic; "(x)" in the name is also a name
//   **Du gör:** ...              optional
//   **I berättelsen:** ...       optional; `[label]` in backticks are variant labels
//   **Omdöme:** Word. ...        first word one of the five verdicts, else no verdict
//   **Tänk på:** ...             optional
// and the sections "Vad omdömena betyder", "Regler som gäller alla" and
// "Idéer som inte är byggda" as lists of "- **Title.** text".

export const OMDOMEN = ['Håller', 'Delvis', 'Osäker', 'Oprövad', 'Idé'];
export const VARSLA = new Set(['Osäker', 'Oprövad', 'Idé']);
const KLASS = { Håller: 'haller', Delvis: 'delvis', Osäker: 'osaker', Oprövad: 'oprovad', Idé: 'ide' };
export const klassFor = (omdome) => KLASS[omdome] || 'inget';

const SEKTION = {
  betydelse: /^vad omdömena betyder/i,
  regler: /^regler som gäller alla/i,
  ideer: /^idéer som inte är byggda/i,
};
const RE_FALT = /^\*\*([^*]+?):\*\*\s?(.*)$/;
const RE_PUNKT = /^\s*[-*+]\s+\*\*(.+?)\*\*\s*(.*)$/;

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function tolkaKatalog(text) {
  const rader = String(text || '').split('\n');
  const mekaniker = [];
  const betydelse = {};
  const regler = [];
  let grupp = null;
  let sektion = null;
  let m = null;
  rader.forEach((ra, i) => {
    let x = /^## (.+)$/.exec(ra);
    if (x) {
      m = null;
      sektion = Object.keys(SEKTION).find((k) => SEKTION[k].test(x[1].trim())) || null;
      grupp = sektion ? null : x[1].trim();
      return;
    }
    x = /^### (.+)$/.exec(ra);
    if (x) {
      sektion = null;
      m = { namn: x[1].trim(), grupp: grupp || '', rad: i, falt: {}, omdome: null, omdomeText: '', varianter: [], baraGaende: false, ide: false };
      mekaniker.push(m);
      return;
    }
    if (m) {
      x = RE_FALT.exec(ra);
      if (x) {
        const falt = x[1].trim();
        m.falt[falt] = x[2].trim();
        if (/^omdöme$/i.test(falt)) {
          m.omdomeText = x[2].trim();
          const ord = /^([\p{L}]+)/u.exec(m.omdomeText);
          m.omdome = ord && OMDOMEN.includes(ord[1]) ? ord[1] : null;
        }
      }
      for (const v of ra.matchAll(/`\[([^\]`]+)\]`/g)) if (!m.varianter.includes(v[1])) m.varianter.push(v[1]);
      if (/\bbara gående\b/i.test(ra)) m.baraGaende = true;
      return;
    }
    if (sektion) {
      x = RE_PUNKT.exec(ra);
      if (!x) return;
      const rubrik = x[1].replace(/[.:]\s*$/, '').trim();
      if (sektion === 'betydelse') betydelse[rubrik] = x[2].trim();
      else if (sektion === 'regler') regler.push({ rubrik, text: x[2].trim() });
      else if (sektion === 'ideer') {
        mekaniker.push({ namn: rubrik, grupp: 'Idéer som inte är byggda', rad: i, falt: { 'I berättelsen': x[2].trim() }, omdome: 'Idé', omdomeText: 'Idé. Inte byggd.', varianter: [], baraGaende: false, ide: true });
      }
    }
  });
  const sett = new Map();
  for (const k of mekaniker) {
    const s = slug(k.namn) || 'mekanik';
    const n = sett.get(s) || 0;
    sett.set(s, n + 1);
    k.id = n ? `${s}-${n + 1}` : s;
    k.du = k.falt['Du gör'] || '';
    k.berattelse = k.falt['I berättelsen'] || '';
    k.tank = k.falt['Tänk på'] || '';
    k.namnformer = namnformer(k.namn);
  }
  return { mekaniker, betydelse, regler };
}

// The names a mechanic answers to: its name, and for "Farligt stopp
// (lampan)" also "Farligt stopp" and "lampan".
function namnformer(namn) {
  const ut = [namn];
  const p = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(namn);
  if (p) { if (p[1].trim()) ut.push(p[1].trim()); ut.push(p[2].trim()); }
  return [...new Set(ut.filter((s) => s.length >= 3))];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOKSTAV = '[\\p{L}\\p{N}]';

// Simple inflection, and nothing more: a genitive s, and for a name that ends
// in a consonant the definite -en/-et. "Hellre ingen bricka än fel."
function monster(form) {
  const delar = form.split(/\s+/).map(esc).join('\\s+');
  const vokal = /[aeiouyåäö]$/i.test(form);
  const slut = vokal ? '(?:s)?' : '(?:s|en|et|ens|ets)?';
  return `(?<!${BOKSTAV})${delar}${slut}(?!${BOKSTAV})`;
}

// Where in a text the catalogue's mechanics are named: [{ fran, till, mekanik }],
// longest names first, never overlapping.
export function hittaNamn(text, katalog) {
  if (!text || !katalog) return [];
  let cache = katalog._monster;
  if (!cache) {
    cache = [];
    for (const k of katalog.mekaniker) for (const f of k.namnformer) cache.push({ k, f, re: new RegExp(monster(f), 'giu') });
    cache.sort((a, b) => b.f.length - a.f.length);
    Object.defineProperty(katalog, '_monster', { value: cache, enumerable: false });
  }
  const ut = [];
  for (const { k, re } of cache) {
    re.lastIndex = 0;
    for (const t of text.matchAll(re)) {
      const fran = t.index;
      const till = fran + t[0].length;
      if (ut.some((u) => fran < u.till && till > u.fran)) continue;
      ut.push({ fran, till, mekanik: k });
    }
  }
  return ut.sort((a, b) => a.fran - b.fran);
}

// The quiet line under a Mekanik paragraph for a mechanic that is not to be
// leaned on, in the catalogue's own words.
export function varsel(k, katalog) {
  if (!k) return null;
  const ut = [];
  if (VARSLA.has(k.omdome)) {
    const regel = katalog.regler.find((r) => new RegExp(`(?<!${BOKSTAV})${esc(k.omdome)}(?!${BOKSTAV})`, 'u').test(r.text));
    const betyder = katalog.betydelse[k.omdome] || '';
    ut.push({ ord: k.omdome, namn: k.namn, text: regel ? regel.text : betyder, betyder });
  }
  if (k.baraGaende) {
    const regel = katalog.regler.find((r) => /bara gående/i.test(r.text));
    if (regel) ut.push({ ord: 'Bara gående', namn: k.namn, text: regel.text, betyder: '' });
  }
  return ut.length ? ut : null;
}

// "Ny mekanik:" first in a Mekanik paragraph is a request to Demi.
export const arNyMekanik = (text) => /^\s*(?:\*\*)?\s*ny mekanik\s*:/i.test(String(text || '').replace(/^\*+\s*/, ''));

// Every variant label the catalogue names, with the mechanic it belongs to.
export function varianter(katalog) {
  const ut = [];
  const sett = new Set();
  for (const k of katalog.mekaniker) {
    for (const v of k.varianter) {
      if (sett.has(v)) continue;
      sett.add(v);
      ut.push({ etikett: v, mekanik: k });
    }
  }
  return ut;
}

export function sok(katalog, fraga) {
  const q = String(fraga || '').trim().toLowerCase();
  if (!q) return katalog.mekaniker;
  return katalog.mekaniker.filter((k) => [k.namn, k.du, k.berattelse, k.omdomeText, k.tank, k.grupp]
    .some((s) => s && s.toLowerCase().includes(q)));
}
