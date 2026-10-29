// Regibordet (the directing desk): the page.
//
// The words live in the OnlyOffice document Manus and come here through the
// md file (the mirror in generalassistant/data/glimt-oo/). The desk does not
// write text. It shows an episode line by line, plays each line, and keeps how
// it is to be heard: the pause before and after, the voice, the direction as
// v4 tags, where the sound goes, and takes rendered here on eleven_v4. A
// rewrite of a line's words, asked for here, goes back into Manus with a
// comment (data/glimt-oo/tillbaka.py, started by the portal). Everything the
// desk keeps is in regi-<dok>.json with the room's notes (regi.js).
//
// Everything the page draws is built from elements and text nodes, so
// nobody's words pass through innerHTML.

import { portalAdapter, valjAdapter, EPISODER, Krock, DataFel } from './data.js';
import * as R from './regi.js';
import { tolkaLjud, ljudFor, stycketid } from './ljud.js';
import { tecken } from './manus.js';

const $ = (id) => document.getElementById(id);
const inne = $('inne');

const S = {
  adapter: null,
  jag: null,
  dok: null,
  md: null, // { text, version }
  kapitel: null, // episod-N.json, or null when the episode has no recordings
  ljud: null, // tolkaLjud(kapitel)
  tider: null, // rummet/ljudtider.json
  apptider: null, // rummet/apptider.json
  regi: null,
  regiVersion: null,
  skrivningar: 0, // own writes so far: a read begun before one is stale
  rader: [],
  paras: [],
  oppen: null, // the id of the line whose drawer is open
  upptagen: new Set(), // lines with a take on its way
  skriverOm: null, // the id of the line being rewritten
};

// The episodes, in the order of the tabs. Only the English episode 1: Glimt
// is made in English, and the Swedish episodes are hidden from the desk
// (Henric 2026-10-29). Hidden, not gone: their files stay, and #episod-1 etc.
// still open them.
const FLIKAR = ['1en'];
const FLIKNAMN = { '1en': 'Episode 1', 1: 'Episod 1', 2: 'Episod 2', 3: 'Episod 3' };

// --- Small helpers -------------------------------------------------------------------

function h(tag, props, ...barn) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const b of barn.flat(Infinity)) {
    if (b == null || b === false) continue;
    e.append(b instanceof Node ? b : document.createTextNode(String(b)));
  }
  return e;
}

const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
};
const IKON = {
  spela: 'M7 4.8v10.4l8.2-5.2z',
  stopp: 'M6.5 6.5h7v7h-7z',
  stang: 'M5 5l10 10M15 5 5 15',
};

const MANADER = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
function datum(nar) {
  const d = new Date(nar);
  if (!nar || Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MANADER[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}
const nu = () => new Date().toISOString();
const mig = () => (S.jag ? S.jag.id : null);
const av = () => ({ vem: mig(), nar: nu() });
const kanSkriva = () => !!(S.adapter && S.adapter.kanSkriva && S.jag);
const roster = () => R.rosterFor(S.kapitel);
const kanRendera = () => kanSkriva() && S.adapter.kanRendera && roster().length > 0;
const rostNamn = (nyckel) => (roster().find((r) => r.nyckel === nyckel) || { namn: nyckel || 'okänd röst' }).namn;
const lugnt = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fokusILadan = () => {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('.lada, .skrivom') && /^(TEXTAREA|INPUT)$/.test(a.tagName));
};
const radElement = (id) => inne.querySelector(`.rad[data-id="${CSS.escape(id)}"]`);

// --- Status ----------------------------------------------------------------------------

let statusTimer = null;
function status(text, typ = 'info', { kvar = false } = {}) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.className = `status ${typ}`;
  el.replaceChildren(h('span', null, text), h('button', { type: 'button', class: 'stang', 'aria-label': 'Stäng', onclick: () => { el.hidden = true; } }, svg(IKON.stang)));
  el.hidden = false;
  if (!kvar) statusTimer = setTimeout(() => { el.hidden = true; }, typ === 'fel' ? 9000 : 3200);
}

function felText(e) {
  if (!e) return 'Något gick fel.';
  if (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message || '')) {
    return 'Portalen svarar inte just nu. Försök igen om en stund.';
  }
  if (e.name === 'TypeError' || e.name === 'ReferenceError' || e.name === 'RangeError') {
    console.error(e);
    return `Något gick fel på sidan (${e.message}). Ladda om den.`;
  }
  return e.message || 'Något gick fel.';
}

// --- Reading and saving ------------------------------------------------------------------

// Literal './name' so the deploy can give each file its hashed name.
const lasJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

async function lasEpisod(dok) {
  const [md, ljud, regi] = await Promise.all([
    S.adapter.las(`manus:${dok}`),
    S.adapter.las(`ljud:${dok}`).catch(() => null),
    kanSkriva() ? S.adapter.las(`regi:${dok}`) : Promise.resolve(null),
  ]);
  if (!md) throw new DataFel('saknas', 'Manuset för episoden går inte att hitta.');
  return { md, ljud, regi };
}

function tillstand(dok, { md, ljud, regi }) {
  S.dok = dok;
  S.md = md;
  S.kapitel = ljud ? JSON.parse(ljud.text) : null;
  S.ljud = S.kapitel ? tolkaLjud(S.kapitel, S.tider) : null;
  S.regi = R.lasRegi(regi ? regi.text : null, dok);
  S.regiVersion = regi ? regi.version : null;
  const { rader, paras } = R.raderFor(md.text, S.regi);
  S.rader = rader;
  S.paras = paras;
}

// A change to the notes: read the file as it is now, apply, write with the
// version just read; if someone wrote in between, do it again on theirs.
async function andra(fn) {
  for (let forsok = 0; forsok < 8; forsok++) {
    const r = await S.adapter.las(`regi:${S.dok}`);
    const regi = R.lasRegi(r ? r.text : null, S.dok);
    const ny = fn(regi);
    ny.stycken = R.skuggaFor(S.paras);
    try {
      const { version } = await S.adapter.skriv(`regi:${S.dok}`, R.skrivRegi(ny), r ? r.version : null);
      S.regi = ny;
      S.regiVersion = version;
      S.skrivningar++;
      return ny;
    } catch (e) {
      if (e instanceof Krock) continue;
      throw e;
    }
  }
  throw new DataFel('krock', 'Någon annan sparar i samma anteckningar just nu. Försök igen.');
}

async function spara(fn) {
  try {
    await andra(fn);
    rita();
    return true;
  } catch (e) {
    status(felText(e), 'fel');
    return false;
  }
}

// --- Sound -------------------------------------------------------------------------------
// One player for the page. A line plays as one or more pieces (a take, or the
// app's recorded paragraphs inside their clips); a scene plays its lines in
// order with the silences between them.

const ljud = new Audio();
ljud.preload = 'none';
let spel = null; // { token, knapp, id, text, etikett }

const appBitar = (kropp) => ljudFor(kropp, S.ljud).delar.map((del) => {
  const tid = stycketid(S.ljud, del) || { fran: 0, till: null };
  return { url: S.adapter.ljudUrl(S.ljud.id, del.id), fran: tid.fran, till: tid.till };
});

// Whether the app's recording says this line: only while the words are the
// manuscript's own (a rewrite waiting for Manus has none).
function appInspelad(rad, not) {
  const kropp = R.aktuellKropp(rad, not);
  return !!(S.ljud && kropp === rad.kropp && ljudFor(kropp, S.ljud).lage === 'inspelad');
}

function bitarFor(rad) {
  const not = R.radNot(S.regi, rad.id);
  const t = R.valdTagning(not);
  if (t) return [{ url: S.adapter.tagningUrl(t.fil), fran: 0, till: null }];
  return appInspelad(rad, not) ? appBitar(rad.kropp) : [];
}

function spelaBit(bit, token) {
  return new Promise((klar) => {
    if (token.stopp) { klar(false); return; }
    let slut = false;
    const fardig = (ok) => {
      if (slut) return;
      slut = true;
      ljud.removeEventListener('ended', vidSlut);
      ljud.removeEventListener('timeupdate', vidTid);
      ljud.removeEventListener('error', vidFel);
      token.avbryt = null;
      klar(ok);
    };
    const vidSlut = () => fardig(true);
    const vidTid = () => { if (bit.till != null && ljud.currentTime >= bit.till) { ljud.pause(); fardig(true); } };
    const vidFel = () => { status('Ljudet gick inte att hämta.', 'fel'); fardig(false); };
    token.avbryt = () => { ljud.pause(); fardig(false); };
    ljud.addEventListener('ended', vidSlut);
    ljud.addEventListener('timeupdate', vidTid);
    ljud.addEventListener('error', vidFel);
    const del = bit.fran || bit.till != null ? `#t=${(bit.fran || 0).toFixed(2)}${bit.till != null ? `,${bit.till.toFixed(2)}` : ''}` : '';
    ljud.src = bit.url + del;
    ljud.play().catch((e) => {
      if (e && e.name === 'AbortError') return;
      status('Ljudet gick inte att spela.', 'fel');
      fardig(false);
    });
  });
}

function vanta(sek, token) {
  return new Promise((klar) => {
    if (token.stopp) { klar(false); return; }
    if (sek <= 0) { klar(true); return; }
    const t = setTimeout(() => { token.avbryt = null; klar(true); }, sek * 1000);
    token.avbryt = () => { clearTimeout(t); klar(false); };
  });
}

function stoppa() {
  const s = spel;
  spel = null;
  if (!s) return;
  s.token.stopp = true;
  if (s.token.avbryt) s.token.avbryt();
  ljud.pause();
  document.querySelectorAll('.spelas').forEach((e) => e.classList.remove('spelas'));
  if (s.knapp && s.knapp.isConnected) {
    s.knapp.classList.remove('spelar');
    s.knapp.setAttribute('aria-label', s.etikett);
    if (s.text) s.knapp.textContent = s.text;
    else s.knapp.replaceChildren(svg(IKON.spela));
  }
}

// -> a token, or null when the same thing was playing and is now stopped.
function borja(knapp, id, { text = null, etikett = 'Spela' } = {}) {
  const samma = spel && spel.id === id;
  stoppa();
  if (samma) return null;
  const token = { stopp: false, avbryt: null };
  spel = { token, knapp, id, text, etikett: knapp.getAttribute('aria-label') || etikett };
  knapp.classList.add('spelar');
  knapp.setAttribute('aria-label', 'Stoppa');
  if (text) knapp.textContent = 'Stoppa';
  else knapp.replaceChildren(svg(IKON.stopp));
  return token;
}

async function spelaBitar(bitar, knapp, id) {
  const token = borja(knapp, id);
  if (!token) return;
  for (const b of bitar) if (!(await spelaBit(b, token))) break;
  if (spel && spel.token === token) stoppa();
}

function spelaRad(rad, knapp) {
  const bitar = bitarFor(rad);
  if (!bitar.length) {
    status(kanRendera() ? 'Repliken har inget ljud än. Öppna den och tryck Gör om.' : 'Repliken har inget ljud än.');
    return;
  }
  spelaBitar(bitar, knapp, `rad:${rad.id}`);
}

// A scene's lines in order, each after the silence the desk (or the
// manuscript, or the app) puts before it. Every branch plays, in the order
// the manuscript has them.
async function spelaScen(scen, knapp) {
  const token = borja(knapp, `scen:${scen}`, { text: 'Spela scenen', etikett: 'Spela scenen' });
  if (!token) return;
  let fore = null;
  let utan = 0;
  for (let k = 0; k < S.rader.length; k++) {
    const rad = S.rader[k];
    if (rad.scen !== scen || !rad.talad) continue;
    const bitar = bitarFor(rad);
    if (!bitar.length) { utan += 1; continue; }
    if (fore && !(await vanta(R.pausMellan(R.radNot(S.regi, fore.id), pausForeFor(rad, k)), token))) return;
    const el = radElement(rad.id);
    if (el) {
      el.classList.add('spelas');
      el.scrollIntoView({ block: 'nearest', behavior: lugnt() ? 'auto' : 'smooth' });
    }
    for (const b of bitar) if (!(await spelaBit(b, token))) return;
    if (el) el.classList.remove('spelas');
    fore = rad;
  }
  if (spel && spel.token === token) stoppa();
  if (utan) status(`${utan} ${utan === 1 ? 'replik' : 'repliker'} i scenen har inget ljud än och hoppades över.`);
}

// --- Timing --------------------------------------------------------------------------------

function pausForeFor(rad, k) {
  return R.pausFore(R.radNot(S.regi, rad.id), R.manusPausFore(S.rader, k), R.appPausFore(rad, S.ljud, S.apptider));
}

// --- Drawing ---------------------------------------------------------------------------

// A line as it reads: her words, directions in italics.
const ordFor = (kropp) => tecken(kropp).map((t) => (t.typ === 'regi' ? h('span', { class: 'regi-i' }, t.text) : t.text));

function meta(rad, not) {
  const delar = [rostNamn(not.rost || R.forvaldRost(rad, S.ljud, S.kapitel))];
  const t = R.valdTagning(not);
  const n = not.tagningar.length;
  const fler = n ? `, ${n} ${n === 1 ? 'tagning' : 'tagningar'} till` : '';
  if (t) delar.push(`tagning ${not.tagningar.indexOf(t) + 1} av ${n}`);
  else if (appInspelad(rad, not)) delar.push(`appens inspelning${fler}`);
  else delar.push(n ? `${n} ${n === 1 ? 'tagning' : 'tagningar'}, ingen vald` : 'inget ljud än');
  return `${delar.join(', ')}.`;
}

function omskrivningLage(rad, not) {
  const o = not.omskrivningar[not.omskrivningar.length - 1];
  if (!o) return null;
  if (o.lage === 'fel') {
    if (rad.raw !== o.fran) return null;
    return h('p', { class: 'omskr fel' }, `Omskrivningen kom inte in i Manus: ${o.svar || 'okänt skäl'}`);
  }
  if (rad.raw !== o.fran) return null; // the mirror has carried Manus's words here
  if (o.lage === 'vantar') return h('p', { class: 'omskr' }, `Omskriven här ${datum(o.nar)}, på väg in i Manus.${o.svar ? ` ${o.svar}` : ''}`);
  return h('p', { class: 'omskr' }, `Omskriven här ${datum(o.nar)}, inne i Manus med en kommentar. Md-filen får orden vid nästa spegling.`);
}

// The silence before a line, drawn as space: the longer the pause, the more
// room between the lines.
function tystnad(sek, kalla) {
  if (!(sek > 0)) return null;
  const hojd = Math.min(6, 0.4 + sek * 0.6);
  const varifran = kalla === 'manus' ? ', manuset' : kalla === 'app' ? ', appen' : '';
  const el = h('div', { class: 'tystnad' }, h('span', null, `${R.sekText(sek)}${varifran}`));
  el.style.setProperty('--hojd', `${hojd.toFixed(2)}rem`);
  return el;
}

function rita() {
  const a = document.activeElement;
  const fokus = a && a.closest && a.closest('.rad') ? { id: a.closest('.rad').dataset.id, sel: a.classList.contains('spela') ? '.spela' : '.ord' } : null;
  const delar = [];
  if (!S.rader.length) delar.push(h('p', { class: 'tomt' }, 'Episoden har inga scener än.'));
  let fore = null;
  S.rader.forEach((rad, k) => {
    if (rad.typ === 'scen') {
      fore = null;
      delar.push(h('div', { class: 'scen' },
        h('h2', null, rad.text),
        h('button', { type: 'button', class: 'lank', 'aria-label': 'Spela scenen', onclick: (e) => spelaScen(rad.scen, e.currentTarget) }, 'Spela scenen')));
      return;
    }
    if (rad.typ === 'mekanik') { delar.push(h('p', { class: 'mek' }, `Trigger: ${rad.text}`)); return; }
    if (rad.typ === 'gren') { delar.push(h('p', { class: 'gren' }, rad.text)); return; }
    if (rad.typ === 'stycke') { delar.push(h('p', { class: 'not' }, rad.text)); return; }
    if (rad.typ === 'regi') {
      // A pause mark is drawn as the silence it asks for, before the next line.
      if (R.manusPausFore(S.rader, k + 1) == null) delar.push(h('p', { class: 'regirad' }, rad.text));
      return;
    }
    const not = R.radNot(S.regi, rad.id);
    const pf = pausForeFor(rad, k);
    const efter = fore ? R.radNot(S.regi, fore.id).pausEfter || 0 : 0;
    delar.push(tystnad(efter + pf.sek, efter && !pf.sek ? 'bord' : pf.kalla));
    delar.push(radEl(rad, not, k));
    fore = rad;
  });
  inne.replaceChildren(h('div', { class: 'bord' }, ...delar.filter(Boolean)));
  if (fokus) {
    const el = radElement(fokus.id);
    const m = el && el.querySelector(`:scope > ${fokus.sel}`);
    if (m) m.focus({ preventScroll: true });
  }
}

function radEl(rad, not, k) {
  const oppen = S.oppen === rad.id;
  const ladaId = `lada-${rad.id}`;
  return h('article', { class: `rad${oppen ? ' oppen' : ''}`, 'data-id': rad.id },
    h('button', { type: 'button', class: 'spela', 'aria-label': 'Spela', onclick: (e) => spelaRad(rad, e.currentTarget) }, svg(IKON.spela)),
    h('button', {
      type: 'button', class: 'ord', 'aria-expanded': oppen ? 'true' : 'false', 'aria-controls': oppen ? ladaId : null,
      onclick: () => { S.oppen = oppen ? null : rad.id; S.skriverOm = null; rita(); },
    },
    rad.etikett ? h('span', { class: 'etikett' }, `[${rad.etikett}] `) : null,
    h('span', { class: 'replik', lang: S.dok === '1en' ? 'en' : null }, ordFor(R.aktuellKropp(rad, not)))),
    h('p', { class: 'om' }, meta(rad, not)),
    omskrivningLage(rad, not),
    oppen ? lada(rad, not, k, ladaId) : null);
}

// --- The drawer: everything about how one line is heard -----------------------------------

function stegare(etikett, sek, efter, onandra) {
  const satt = (x) => onandra(Math.max(0, Math.min(R.PAUS_MAX, Math.round(x / R.PAUS_STEG) * R.PAUS_STEG)));
  const las = !kanSkriva();
  return h('div', { class: 'stegare', role: 'group', 'aria-label': etikett },
    h('span', { class: 'falt-namn' }, etikett),
    h('button', { type: 'button', class: 'steg', 'aria-label': `${etikett}, kortare`, disabled: las || sek <= 0, onclick: () => satt(sek - R.PAUS_STEG) }, '−'),
    h('output', { class: 'sek' }, R.sekText(sek)),
    h('button', { type: 'button', class: 'steg', 'aria-label': `${etikett}, längre`, disabled: las || sek >= R.PAUS_MAX, onclick: () => satt(sek + R.PAUS_STEG) }, '+'),
    h('span', { class: 'kallor' }, efter));
}

function lada(rad, not, k, id) {
  const pf = pausForeFor(rad, k);
  const manus = R.manusPausFore(S.rader, k);
  const app = R.appPausFore(rad, S.ljud, S.apptider);
  const kallor = [];
  if (manus != null) kallor.push(`Manuset ${R.sekText(manus)}`);
  if (app) kallor.push(app.iInspelning ? 'appen har pausen i inspelningen' : `appen ${R.sekText(app.sek)}`);
  const kalltext = kallor.length ? `${kallor.join(', ')}.` : '';
  const rost = not.rost || R.forvaldRost(rad, S.ljud, S.kapitel);
  const kropp = R.aktuellKropp(rad, not);
  const text = R.regiText(rad, not);
  const upptagen = S.upptagen.has(rad.id);
  const las = !kanSkriva();
  const sattFalt = (fn) => spara(fn);

  const pauser = h('div', { class: 'pauser' },
    stegare('Paus före', pf.sek, [
      kalltext ? `${kalltext} ` : null,
      not.pausFore != null ? h('button', { type: 'button', class: 'lank', onclick: () => sattFalt((r) => R.sattPaus(r, rad.id, 'pausFore', null, av())) }, 'Som förut') : null,
    ], (sek) => sattFalt((r) => R.sattPaus(r, rad.id, 'pausFore', sek, av()))),
    stegare('Paus efter', not.pausEfter || 0,
      not.pausEfter != null ? h('button', { type: 'button', class: 'lank', onclick: () => sattFalt((r) => R.sattPaus(r, rad.id, 'pausEfter', null, av())) }, 'Ingen') : null,
      (sek) => sattFalt((r) => R.sattPaus(r, rad.id, 'pausEfter', sek, av()))));

  const forval = R.forvaldRost(rad, S.ljud, S.kapitel);
  const rostval = roster().length
    ? h('div', { class: 'val', role: 'group', 'aria-label': 'Röst' },
      h('span', { class: 'falt-namn' }, 'Röst'),
      roster().map((r) => h('button', {
        type: 'button', class: 'valknapp', 'aria-pressed': r.nyckel === rost ? 'true' : 'false', disabled: las,
        onclick: () => sattFalt((x) => R.sattRost(x, rad.id, r.nyckel === forval ? null : r.nyckel, av())),
      }, r.namn)))
    : h('p', { class: 'hjalp' }, 'Episoden har inga röster än. De väljs när den spelas in första gången.');

  const regiFalt = h('textarea', {
    class: 'regitext', rows: '3', id: `regi-${rad.id}`, spellcheck: 'false', disabled: las, lang: S.dok === '1en' ? 'en' : null,
    onchange: (e) => {
      const v = e.target.value.replace(/\s+/g, ' ').trim();
      sattFalt((x) => R.sattRegi(x, rad.id, v === R.v4Text(kropp) ? null : v, kropp, av()));
    },
  });
  regiFalt.value = text;
  const regi = h('div', { class: 'falt' },
    h('label', { class: 'falt-namn', for: `regi-${rad.id}` }, 'Som rösten får den'),
    regiFalt,
    h('p', { class: 'hjalp' },
      'Regin står i hakparentes, till exempel [whispers], [dry, quietly pleased] eller [pause]. ',
      R.regiForAldrad(rad, not) ? h('span', { class: 'varm' }, 'Regin du skrev gällde en äldre text, så manusets används. ') : null,
      not.regi != null && !R.regiForAldrad(rad, not)
        ? h('button', { type: 'button', class: 'lank', onclick: () => sattFalt((x) => R.sattRegi(x, rad.id, null, kropp, av())) }, 'Ta manusets regi')
        : null));

  const ljudFalt = h('input', {
    type: 'text', class: 'ljudtext', id: `ljud-${rad.id}`, disabled: las,
    placeholder: 'Till exempel: låten börjar svagt under sista meningen',
    onchange: (e) => sattFalt((x) => R.sattLjud(x, rad.id, e.target.value, av())),
  });
  ljudFalt.value = not.ljud || '';

  return h('div', { class: 'lada', id },
    pauser,
    rostval,
    regi,
    h('div', { class: 'falt' }, h('label', { class: 'falt-namn', for: `ljud-${rad.id}` }, 'Ljud'), ljudFalt),
    tagningar(rad, not),
    h('div', { class: 'gorom' },
      h('button', { type: 'button', class: 'huvud', disabled: !kanRendera() || upptagen || !R.ordI(text), onclick: () => gorOm(rad) },
        upptagen ? 'Rösten läser …' : 'Gör om'),
      h('p', { class: 'hjalp' }, kanRendera()
        ? `En ny tagning på ${R.MODELL.replace('eleven_', '')} med ${rostNamn(rost)}: ${text.length} tecken av krediterna. Den spelas direkt och blir den som spelas.`
        : kanSkriva() ? 'Episoden har inga röster att göra tagningar med än.' : 'Tagningar görs i portalen.')),
    skrivOm(rad, kropp));
}

function tagningar(rad, not) {
  const inspelad = appInspelad(rad, not);
  if (!inspelad && !not.tagningar.length) return null;
  const namn = `vald-${rad.id}`;
  const val = (tagId) => spara((x) => R.valjTagning(x, rad.id, tagId, av()));
  const poster = [];
  if (inspelad) {
    poster.push(h('li', null,
      h('label', null,
        h('input', { type: 'radio', name: namn, checked: !not.vald, disabled: !kanSkriva(), onchange: () => val(null) }),
        h('span', null, 'Appens inspelning, v3')),
      h('button', { type: 'button', class: 'spela', 'aria-label': 'Spela appens inspelning', onclick: (e) => spelaBitar(appBitar(rad.kropp), e.currentTarget, `app:${rad.id}`) }, svg(IKON.spela))));
  }
  not.tagningar.forEach((t, n) => {
    const om = [rostNamn(t.rost), String(t.modell || '').replace('eleven_', ''), t.sek ? R.sekText(t.sek) : null, datum(t.nar)].filter(Boolean).join(', ');
    poster.push(h('li', null,
      h('label', null,
        h('input', { type: 'radio', name: namn, checked: not.vald === t.id, disabled: !kanSkriva(), onchange: () => val(t.id) }),
        h('span', null, `Tagning ${n + 1}. `, h('span', { class: 'dov' }, om)),
        t.text !== R.regiText(rad, not) ? h('span', { class: 'annan-text', lang: S.dok === '1en' ? 'en' : null }, t.text) : null),
      h('button', { type: 'button', class: 'spela', 'aria-label': `Spela tagning ${n + 1}`, onclick: (e) => spelaBitar([{ url: S.adapter.tagningUrl(t.fil), fran: 0, till: null }], e.currentTarget, `tag:${t.id}`) }, svg(IKON.spela))));
  });
  return h('fieldset', { class: 'tagningar' }, h('legend', { class: 'falt-namn' }, 'Det som spelas'), h('ul', null, poster));
}

function skrivOm(rad, kropp) {
  if (!kanSkriva()) return null;
  if (!R.I_MANUS.includes(S.dok)) {
    return h('p', { class: 'hjalp skrivom' }, 'Den svenska episod 1 finns inte i Manus, så dess repliker skrivs inte om här.');
  }
  if (S.skriverOm !== rad.id) {
    return h('div', { class: 'skrivom' },
      h('button', {
        type: 'button', class: 'lank',
        onclick: () => {
          S.skriverOm = rad.id;
          rita();
          const t = inne.querySelector('.skrivom textarea');
          if (t) t.focus();
        },
      }, 'Skriv om repliken'));
  }
  const falt = h('textarea', { rows: '3', class: 'nyord', id: `nyord-${rad.id}`, lang: S.dok === '1en' ? 'en' : null });
  falt.value = kropp;
  return h('div', { class: 'skrivom' },
    h('label', { class: 'falt-namn', for: `nyord-${rad.id}` }, 'Nya ord'),
    falt,
    h('p', { class: 'hjalp' }, 'Repliken byts i Manus med kommentaren "Ändrad i regibordet för tajmingens skull". Har någon ändrat den i Manus under tiden rörs den inte.'),
    h('div', { class: 'knappar' },
      h('button', {
        type: 'button', class: 'kontur',
        onclick: async () => {
          if (!(await spara((x) => R.omskriv(x, rad, falt.value, av())))) return;
          S.skriverOm = null;
          rita();
          try {
            await S.adapter.tillbaka(S.dok);
            status('Sparat. Repliken förs in i Manus nu.');
          } catch (e) {
            status(`Sparat här, men Manus nåddes inte: ${felText(e)}`, 'fel', { kvar: true });
          }
        },
      }, 'Spara och för in i Manus'),
      h('button', { type: 'button', class: 'lank', onclick: () => { S.skriverOm = null; rita(); } }, 'Avbryt')));
}

async function gorOm(rad) {
  const not = R.radNot(S.regi, rad.id);
  const text = R.regiText(rad, not);
  const rost = not.rost || R.forvaldRost(rad, S.ljud, S.kapitel);
  S.upptagen.add(rad.id);
  rita();
  try {
    const t = await S.adapter.rendera({ dok: S.dok, rad: rad.id, text, rost });
    const tagning = {
      id: t.id, fil: t.fil, text, rost, voice: t.voice || null, modell: t.modell || R.MODELL,
      sek: t.sek || null, tecken: t.tecken || text.length, vem: mig(), nar: nu(),
    };
    await andra((x) => R.valjTagning(R.laggTillTagning(x, rad.id, tagning, av()), rad.id, tagning.id, av()));
    S.upptagen.delete(rad.id);
    rita();
    const el = radElement(rad.id);
    if (el) spelaRad(rad, el.querySelector(':scope > .spela'));
  } catch (e) {
    S.upptagen.delete(rad.id);
    rita();
    status(felText(e), 'fel');
  }
}

// --- Frame, tabs, start --------------------------------------------------------------------------

function ritaRam() {
  const band = $('band');
  band.replaceChildren();
  if (S.adapter && S.adapter.rot === 'prov') {
    band.append(h('div', { class: 'band prov' }, 'Provläge: kopior i en sandlåda, inte manuset. Det som sparas och skrivs om hamnar i kopiorna och i provdokumentet i OnlyOffice.'));
  }
  if (!kanSkriva()) band.append(h('div', { class: 'band' }, 'Här går det att läsa och lyssna. Regin sparas bara i portalen.'));
}

function valdFlik() {
  const m = /^#episod-(\w+)$/.exec(location.hash);
  return m && EPISODER.includes(m[1]) ? m[1] : FLIKAR[0];
}

function ritaFlikar(dok) {
  $('flikar').replaceChildren(...FLIKAR.map((d) => h('a', {
    href: `#episod-${d}`, 'data-flik': `episod-${d}`, 'aria-current': d === dok ? 'page' : null,
  }, d === '1en' ? [h('span', { lang: 'en' }, FLIKNAMN[d]), h('span', { class: 'sprak' }, ' EN')] : FLIKNAMN[d])));
}

async function visa() {
  const dok = valdFlik();
  stoppa();
  ritaFlikar(dok);
  if (S.dok !== dok) { S.oppen = null; S.skriverOm = null; }
  inne.replaceChildren(h('p', { class: 'laddar' }, 'Läser episoden …'));
  try {
    tillstand(dok, await lasEpisod(dok));
    document.title = `${FLIKNAMN[dok]}${dok === '1en' ? ' EN' : ''}: regibordet`;
    rita();
    if (kanSkriva() && R.vantandeOmskrivningar(S.regi)) S.adapter.tillbaka(dok).catch(() => {});
  } catch (e) {
    inne.replaceChildren(h('p', { class: 'band varning' }, felText(e)));
  }
}

// Others write too: the mirror changes md, another window the notes,
// tillbaka.py the state of a rewrite. Read again every few seconds, and draw
// again when something moved, unless someone is typing in a drawer or
// something is playing.
async function lyssna() {
  if (document.visibilityState !== 'visible' || !S.dok || !S.md || fokusILadan()) return;
  try {
    const dok = S.dok;
    const fore = S.skrivningar;
    const ny = await lasEpisod(dok);
    if (dok !== S.dok || fokusILadan() || spel || fore !== S.skrivningar) return;
    if (ny.md.text === S.md.text && (ny.regi ? ny.regi.version : null) === S.regiVersion) return;
    tillstand(dok, ny);
    rita();
  } catch {
    // the next tick tries again
  }
}

function visaInloggning() {
  inne.replaceChildren(h('section', { class: 'smal' },
    h('h2', null, 'Logga in först'),
    h('p', null, 'Regibordet läser och sparar genom portalen, och portalen känner inte igen dig just nu.'),
    h('p', null, h('a', { class: 'knapp huvud', href: '/' }, 'Öppna portalen')),
    h('p', { class: 'dov' }, 'Logga in där och kom sedan tillbaka hit.')));
}

async function start() {
  const sida = location.href;
  let adapter;
  if (location.pathname.includes('/uploads/')) {
    adapter = portalAdapter({ rot: new URL(sida).searchParams.get('rot') === 'prov' ? 'prov' : 'skarp' });
    if (!(await adapter.finns())) { visaInloggning(); return; }
  } else {
    adapter = await valjAdapter({ sida });
  }
  S.adapter = adapter;
  S.jag = await adapter.vem();
  [S.tider, S.apptider] = await Promise.all([
    lasJson(new URL('./ljudtider.json', import.meta.url)),
    lasJson(new URL('./apptider.json', import.meta.url)),
  ]);
  ritaRam();
  window.addEventListener('hashchange', () => { visa(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lyssna(); });
  setInterval(lyssna, 4000);
  await visa();
}

start().catch((e) => {
  inne.replaceChildren(h('div', { class: 'band varning' }, felText(e)));
});
