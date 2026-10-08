// Manusrummet: the page. A document is open in the editor (redigerare.js)
// and saved by lager.js, which reads the file fresh, merges per paragraph and
// writes with the version it read. Everything the page draws is built from
// elements and text nodes, so a person's words never pass through innerHTML.

import { portalAdapter, valjAdapter, EPISODER, PERSONER } from './data.js';
import { skapaLager, slagFor } from './lager.js';
import * as D from './dok.js';
import * as A from './anteckn.js';
import * as K from './katalog.js';
import { skapaRedigerare, STILAR_SCEN, STILAR_TEXT, arStil } from './redigerare.js';
import { tolkaInnehall } from './manus.js';
import { ljudFor, stycketid } from './ljud.js';
import { renderMd } from './md.js';

const $ = (id) => document.getElementById(id);
const inne = $('inne');
// The sheet's content; a part that is not there (null) is skipped.
const fyll = (...delar) => inne.replaceChildren(...delar.flat().filter((x) => x != null && x !== false));

const S = {
  adapter: null,
  lager: null,
  jag: null,
  inst: { doljDemi: false, visaVem: true, besok: {} },
  rutt: null,
  vy: null, // the open view; for a document { dok, dokument, red, ... }
  katalog: null,
  lore: null,
  ljud: null,
};

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
  angra: 'M7.5 4.5 3.5 8.5l4 4M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9',
  gorom: 'M12.5 4.5l4 4-4 4M16 8.5H8.5a4.5 4.5 0 0 0 0 9H11',
  stang: 'M5 5l10 10M15 5 5 15',
};

const MANADER = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
function datum(nar) {
  if (!nar) return '';
  const d = new Date(nar);
  if (Number.isNaN(d.getTime())) return '';
  const ar = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MANADER[d.getMonth()]}${ar} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}
const namn = (id) => A.namnFor(id);
const arAI = A.arAI;
const nu = () => new Date().toISOString();
const kanSkriva = () => !!(S.adapter && S.adapter.kanSkriva && S.jag);
const mig = () => (S.jag ? S.jag.id : null);
const dold = (vem) => !!(S.inst.doljDemi && arAI(vem));
const kortText = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const lugn = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const bred = () => window.matchMedia('(min-width: 62.01rem)').matches;

function lista(ord) {
  if (ord.length < 2) return ord.join('');
  return `${ord.slice(0, -1).join(', ')} och ${ord[ord.length - 1]}`;
}

// A person, as a dot and a name. Demi is marked as an AI everywhere.
const prick = (vem) => h('span', { class: `av ${vem === 'henric' ? 'h' : vem === 'liv' ? 'l' : vem === 'demi' ? 'd' : 'x'}`, 'aria-hidden': 'true' });
const avsandare = (vem) => h('span', { class: 'vem-namn' }, prick(vem), namn(vem), arAI(vem) ? h('span', { class: 'ai', title: `${namn(vem)} är en AI, inte en människa.` }, 'AI') : null);

// --- Status ----------------------------------------------------------------------------

let statusTimer = null;
function status(text, typ = 'info', { kvar = false, knapp = null } = {}) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.className = `status ${typ}`;
  el.replaceChildren(h('span', null, text), knapp, h('button', { type: 'button', class: 'stang', 'aria-label': 'Stäng', onclick: () => { el.hidden = true; } }, svg(IKON.stang)));
  el.hidden = false;
  if (!kvar) statusTimer = setTimeout(() => { el.hidden = true; }, typ === 'fel' ? 9000 : 3200);
}

function felText(e) {
  if (!e) return 'Något gick fel.';
  // fetch says a network failure with a TypeError; any other TypeError is a
  // fault in the room itself and must not be dressed up as the portal's.
  if (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message || '')) {
    return 'Portalen svarar inte just nu. Det du skrev finns kvar här och sparas när den svarar igen.';
  }
  if (e.name === 'TypeError' || e.name === 'ReferenceError' || e.name === 'RangeError') {
    console.error(e);
    return `Något gick fel i rummet (${e.message}). Ladda om sidan; det du skrev finns kvar.`;
  }
  return e.message || 'Något gick fel.';
}

// The save state in the top bar.
function ritaLage() {
  const el = $('lage');
  const V = S.vy;
  if (!V || !V.dokument || !kanSkriva()) {
    el.replaceChildren();
    el.className = 'lage-text';
    return;
  }
  const { lage, felet } = V.dokument;
  const text = lage === 'fel' ? 'Inte sparat' : lage === 'sparat' ? 'Sparat' : 'Sparar …';
  el.className = `lage-text ${lage === 'fel' ? 'fel' : lage === 'sparat' ? 'sparat' : 'sparar'}`;
  if (lage === 'fel') {
    el.replaceChildren(h('button', {
      type: 'button',
      onclick: () => status(`${felText(felet)} Det du skrev finns kvar här.`, 'fel', {
        kvar: true,
        knapp: h('button', { type: 'button', class: 'knapp liten', onclick: () => { V.dokument.spara().catch(() => {}); } }, 'Försök igen'),
      }),
    }, text));
  } else {
    el.replaceChildren(text);
  }
}

// --- Sound -------------------------------------------------------------------------------
// One player for the page. A line can be several recorded paragraphs, in one
// clip or several; they play one after the other.

const ljud = new Audio();
ljud.preload = 'none';
let spelar = null;

const kroppFor = (p) => (p.typ === 'regi' ? `(${p.text})` : p.typ === 'variant' ? p.text : tolkaInnehall(p.text).kropp || '');
const ljudCache = new Map();
function ljudLage(p) {
  if (!S.ljud || !['replik', 'variant', 'regi'].includes(p.typ)) return { lage: 'tyst', delar: [] };
  const k = kroppFor(p);
  if (!ljudCache.has(k)) ljudCache.set(k, ljudFor(k, S.ljud));
  return ljudCache.get(k);
}

function spela(id, delar, knapp) {
  const samma = spelar && spelar.id === id;
  stoppa();
  if (samma) return;
  spelar = { id, delar, k: 0, knapp, till: null, byter: false, slutad: -1 };
  knapp.classList.add('spelar');
  knapp.setAttribute('aria-label', 'Stoppa');
  nastaDel();
}

function nastaDel() {
  const s = spelar;
  if (!s) return;
  if (s.k >= s.delar.length) { stoppa(); return; }
  const del = s.delar[s.k++];
  const t = stycketid(S.ljud, del) || { fran: 0, till: null };
  s.fran = t.fran;
  s.till = t.till;
  s.byter = true;
  ljud.src = S.adapter.ljudUrl(S.ljud.id, del.id) + `#t=${t.fran.toFixed(2)}${t.till != null ? `,${t.till.toFixed(2)}` : ''}`;
  ljud.play().then(() => { if (spelar === s) s.byter = false; }).catch((e) => {
    if (spelar !== s || (e && e.name === 'AbortError')) return;
    status('Ljudet gick inte att spela.', 'fel');
    stoppa();
  });
}

function delSlut() {
  const s = spelar;
  if (!s || s.byter || s.slutad === s.k) return;
  s.slutad = s.k;
  nastaDel();
}

ljud.addEventListener('ended', delSlut);
ljud.addEventListener('playing', () => {
  const s = spelar;
  if (s && s.fran && ljud.currentTime < s.fran - 0.25) ljud.currentTime = s.fran;
});
ljud.addEventListener('timeupdate', () => {
  const s = spelar;
  if (s && !s.byter && s.till != null && ljud.currentTime >= s.till) { ljud.pause(); delSlut(); }
});
ljud.addEventListener('pause', () => {
  const s = spelar;
  if (s && !s.byter && s.till != null && ljud.currentTime >= s.till - 0.3) delSlut();
});
ljud.addEventListener('error', () => {
  if (!spelar) return;
  status('Ljudet gick inte att hämta.', 'fel');
  stoppa();
});

function stoppa() {
  const s = spelar;
  spelar = null;
  ljud.pause();
  if (s && s.knapp) {
    s.knapp.classList.remove('spelar');
    s.knapp.setAttribute('aria-label', 'Lyssna');
  }
}

// --- Panel and menu ------------------------------------------------------------------------
// One panel for everything that needs more room than a button: comments,
// proposals, history, the mechanic picker. On a wide screen it floats at the
// right, on a phone it rises from below.

let panelFran = null;
function oppnaPanel(titel, ...innehall) {
  const p = $('panel');
  stangMeny();
  panelFran = document.activeElement;
  const rubrikId = 'panel-rubrik';
  p.replaceChildren(
    h('div', { class: 'panel-topp' },
      h('h2', { id: rubrikId }, titel),
      h('button', { type: 'button', class: 'stang', 'aria-label': 'Stäng', onclick: stangPanel }, svg(IKON.stang))),
    h('div', { class: 'panel-inne' }, ...innehall),
  );
  p.setAttribute('aria-labelledby', rubrikId);
  p.hidden = false;
  document.body.classList.add('panel-oppen');
  requestAnimationFrame(() => {
    const f = p.querySelector('[data-fokus]') || p.querySelector('textarea, input, .panel-inne button');
    if (f) f.focus({ preventScroll: true });
  });
  return p;
}

function stangPanel({ tillRedigeraren = true } = {}) {
  const p = $('panel');
  if (p.hidden) return;
  p.hidden = true;
  p.replaceChildren();
  document.body.classList.remove('panel-oppen');
  if (tillRedigeraren && S.vy && S.vy.red && kanSkriva()) S.vy.red.fokus();
  else if (panelFran && panelFran.focus && document.contains(panelFran)) panelFran.focus();
  panelFran = null;
}

let menyFran = null;
function oppnaMeny(knapp, poster, { etikett }) {
  const m = $('meny');
  stangMeny();
  menyFran = knapp;
  m.replaceChildren(...poster.map((x) => h('button', {
    type: 'button', role: 'menuitemradio', 'aria-checked': x.vald ? 'true' : 'false', class: x.vald ? 'vald' : null,
    onclick: () => { stangMeny(false); x.gor(); },
  }, h('span', null, x.namn), x.tips ? h('kbd', null, x.tips) : null)));
  m.setAttribute('aria-label', etikett);
  m.hidden = false;
  const r = knapp.getBoundingClientRect();
  const telefon = !window.matchMedia('(min-width: 40.01rem)').matches;
  m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
  if (telefon) {
    m.style.top = '';
    m.style.bottom = `${window.innerHeight - r.top + 6}px`;
  } else {
    m.style.bottom = '';
    m.style.top = `${r.bottom + 6}px`;
  }
  knapp.setAttribute('aria-expanded', 'true');
  const forsta = m.querySelector('.vald') || m.querySelector('button');
  if (forsta) forsta.focus();
}

function stangMeny(fokus = true) {
  const m = $('meny');
  if (m.hidden) return;
  m.hidden = true;
  m.replaceChildren();
  if (menyFran) {
    menyFran.setAttribute('aria-expanded', 'false');
    if (fokus) menyFran.focus();
  }
  menyFran = null;
}

$('meny').addEventListener('keydown', (e) => {
  const knappar = [...$('meny').querySelectorAll('button')];
  const k = knappar.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); knappar[(k + 1) % knappar.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); knappar[(k - 1 + knappar.length) % knappar.length].focus(); }
  if (e.key === 'Escape') { e.preventDefault(); stangMeny(); }
  if (e.key === 'Tab') stangMeny(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('panel').hidden) { e.preventDefault(); stangPanel(); }
});
document.addEventListener('mousedown', (e) => {
  const m = $('meny');
  if (!m.hidden && !m.contains(e.target) && e.target !== menyFran) stangMeny(false);
});

// --- Routing ---------------------------------------------------------------------------------
// #episod-1 · #episod-2 · #varlden · #varlden/held · #varlden/sidor ·
// #varlden/sida/<id> · #mekaniker · #mekaniker/<mekanik> · #mekaniker/text
// A document's address can end in /s/<paragraph id> to open at it.

function lasRutt() {
  let hash;
  try {
    hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  } catch {
    hash = '';
  }
  let stycke = null;
  const s = /^(.*)\/s\/([A-Za-z0-9_-]+)$/.exec(hash);
  if (s) { hash = s[1]; stycke = s[2]; }
  let m = /^episod-(\d+)$/.exec(hash);
  if (m && EPISODER.includes(m[1])) return { vy: 'dok', dok: m[1], flik: `episod-${m[1]}`, stycke };
  if (hash === 'varlden') return { vy: 'dok', dok: 'varld', flik: 'varlden', under: 'varld', stycke };
  if (hash === 'varlden/held') return { vy: 'held', flik: 'varlden', under: 'held' };
  if (hash === 'varlden/sidor') return { vy: 'sidor', flik: 'varlden', under: 'sidor' };
  m = /^varlden\/sida\/([A-Za-z0-9_-]+)$/.exec(hash);
  if (m) return { vy: 'dok', dok: `lore:${m[1]}`, sida: m[1], flik: 'varlden', under: 'sidor', stycke };
  if (hash === 'mekaniker/text') return { vy: 'dok', dok: 'mekaniker', flik: 'mekaniker', under: 'text', stycke };
  m = /^mekaniker(?:\/([a-z0-9-]+))?$/.exec(hash);
  if (m) return { vy: 'katalog', flik: 'mekaniker', under: 'lista', mek: m[1] || null };
  return { vy: 'dok', dok: EPISODER[0], flik: `episod-${EPISODER[0]}`, stycke };
}

const sammaVy = (a, b) => !!a && !!b && a.vy === b.vy && a.dok === b.dok && a.under === b.under;

function markeraFlik(r) {
  for (const a of document.querySelectorAll('.flikar a[data-flik]')) {
    if (a.dataset.flik === r.flik) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function visa() {
  const r = lasRutt();
  const forra = S.rutt;
  S.rutt = r;
  if (sammaVy(r, forra)) {
    // Same view: only the place in it changed.
    if (r.stycke && S.vy && S.vy.red) S.vy.red.ga(r.stycke);
    if (r.vy === 'katalog' && r.mek) oppnaMekanik(r.mek);
    return;
  }
  markeraFlik(r);
  stoppa();
  stangPanel({ tillRedigeraren: false });
  await stangVy();
  window.scrollTo(0, 0);
  if (r.vy === 'dok') await visaDokument(r);
  else if (r.vy === 'held') await visaHeld(r);
  else if (r.vy === 'sidor') await visaSidor(r);
  else if (r.vy === 'katalog') await visaKatalog(r);
}

async function stangVy() {
  const V = S.vy;
  S.vy = null;
  ritaVerktyg();
  ritaLage();
  if (!V) return;
  if (V.dokument) {
    V.dokument.minns();
    V.dokument.spara().catch(() => {});
  }
  if (V.red) V.red.forstor();
}

function underflikar(r) {
  if (r.flik === 'varlden') {
    return h('nav', { class: 'underflikar', 'aria-label': 'Världen' },
      [['varld', 'Världsboken', '#varlden'], ['held', 'HELD', '#varlden/held'], ['sidor', 'Våra sidor', '#varlden/sidor']]
        .map(([u, t, href]) => h('a', { href, 'aria-current': r.under === u ? 'page' : null }, t)));
  }
  if (r.flik === 'mekaniker') {
    return h('nav', { class: 'underflikar', 'aria-label': 'Mekaniker' },
      [['lista', 'Katalogen', '#mekaniker'], ['text', 'Redigera texten', '#mekaniker/text']]
        .map(([u, t, href]) => h('a', { href, 'aria-current': r.under === u ? 'page' : null }, t)));
  }
  return null;
}

// --- A document in the editor -------------------------------------------------------------------

const ARBETSTEXT = {
  varld: 'Glimts världsbok. Allt här sparas i filen, och alla kan ändra allt.',
  mekaniker: 'Mekanikkatalogen. Listan under Katalogen läses ur den här texten varje gång.',
};

async function visaDokument(r) {
  fyll(underflikar(r), h('p', { class: 'laddar' }, 'Läser …'));
  const arEpisod = EPISODER.includes(r.dok);
  const V = {
    rutt: r, dok: r.dok, arEpisod, slag: slagFor(r.dok), dokument: null, red: null, sedan: null, notRitad: null, karta: null,
  };
  S.vy = V;
  let start;
  let sida = null;
  try {
    if (r.sida) {
      S.lore = await S.lager.lasLore();
      sida = S.lore.sidor.find((x) => x.id === r.sida) || null;
      if (!sida) throw new Error('Sidan finns inte.');
    }
    V.dokument = await S.lager.dokument(r.dok, { ritad: () => dokumentRitat(V) });
    const [l, kat, ljudet] = await Promise.all([
      V.dokument.ladda(),
      S.katalog ? Promise.resolve(S.katalog) : S.lager.katalog().catch(() => null),
      arEpisod ? S.lager.ljud(r.dok).catch(() => null) : Promise.resolve(null),
    ]);
    start = l;
    S.katalog = kat;
    S.ljud = ljudet;
    ljudCache.clear();
  } catch (e) {
    if (S.vy !== V) return;
    fyll(underflikar(r), h('div', { class: 'band varning' }, felText(e)));
    return;
  }
  if (S.vy !== V) return;
  V.sedan = sedanSist(r.dok);
  const mount = h('div', { class: 'redigerare' });
  const delar = [underflikar(r)];
  if (sida) delar.push(loreHuvud(sida));
  else if (ARBETSTEXT[r.dok]) delar.push(h('p', { class: 'kalla' }, ARBETSTEXT[r.dok]));
  V.notis = h('div', { class: 'notis' });
  delar.push(V.notis, mount);
  fyll(...delar);
  let andradTimer = null;
  V.red = skapaRedigerare({
    plats: mount,
    paras: start.paras,
    slag: V.slag,
    kanSkriva: kanSkriva(),
    katalog: S.katalog,
    etikett: arEpisod ? `Episod ${r.dok}` : r.dok === 'varld' ? 'Världsboken' : r.dok === 'mekaniker' ? 'Mekanikkatalogen' : 'Loresidan',
    nyttId: D.nyttId,
    // The waiting copy in the browser is written at most every quarter
    // second while someone types; on leaving it is written at once.
    andrat: () => {
      if (andradTimer) return;
      andradTimer = setTimeout(() => { andradTimer = null; if (S.vy === V) V.dokument.andrat(); }, 250);
    },
    flyttat: () => ritaVerktyg(),
    rita: (vy, p, info) => ritaStycke(V, vy, p, info),
    ritat: () => planeraKomLayout(),
    klick: (e, vy) => klickIStycke(V, e, vy),
  });
  V.flush = () => {
    if (andradTimer) { clearTimeout(andradTimer); andradTimer = null; V.dokument.andrat(); }
  };
  if (kanSkriva()) V.dokument.koppla(V.red);
  ritaVerktyg();
  ritaLage();
  ritaNotis(V);
  if (start.vantande) status('Här är det du skrev förra gången men som inte hann sparas. Det sparas nu.', 'info', { kvar: true });
  if (V.dokument.notFel) status(`Historiken och kommentarerna går inte att läsa just nu: ${felText(V.dokument.notFel)}`, 'fel', { kvar: true });
  if (r.stycke) requestAnimationFrame(() => V.red.ga(r.stycke, { fokus: false }));
  markeraBesok(r.dok);
}

function dokumentRitat(V) {
  if (S.vy !== V) return;
  ritaLage();
  if (V.red && V.dokument.not !== V.notRitad) {
    V.notRitad = V.dokument.not;
    V.karta = null;
    V.red.ritaOm();
    ritaNotis(V);
  }
}

// What each paragraph has beside it: open comments, proposals and krockar,
// also those whose paragraph is gone (they show at the one it stood after).
// red: the editor, also while it is being built (V.red is set after).
function notKarta(V, red = V.red) {
  if (V.karta && V.karta.not === V.dokument.not && V.karta.ver === S.ver) return V.karta;
  const not = V.dokument.not;
  const alla = red.stycken();
  const finns = new Set(alla.map((p) => p.id));
  const har = (id) => finns.has(id);
  const ut = new Map();
  const till = (id, slag, x) => {
    const hem = A.hem(not, id, har) || (alla[0] && alla[0].id);
    if (!ut.has(hem)) ut.set(hem, { kommentarer: [], forslag: [], krockar: [] });
    ut.get(hem)[slag].push(x);
  };
  for (const k of not.kommentarer) {
    if (k.svarPa || k.borta || k.klar || dold(k.skrev)) continue;
    till(k.stycke, 'kommentarer', k);
  }
  for (const f of not.forslag) {
    if (f.lage !== 'oppet' || dold(f.skrev)) continue;
    till(f.stycke, 'forslag', f);
  }
  for (const k of not.krockar) {
    if (k.lage !== 'oppen') continue;
    till(k.stycke, 'krockar', k);
  }
  V.karta = { not, ver: S.ver, karta: ut };
  return V.karta;
}

S.ver = 0;

// --- One paragraph's margin, comments and notes ---

function ritaStycke(V, vy, p, info) {
  if (S.vy !== V) return;
  const dokument = V.dokument;
  const red = vy.red;
  const marg = [];
  if (p.typ !== 'linje' && S.inst.visaVem && kanSkriva()) {
    const v = dokument.vemSkrev(p);
    const nytt = V.sedan && v.nar && v.vem !== mig() && String(v.nar) > V.sedan;
    const titel = v.hur === 'osparat' ? 'Du, inte sparat än'
      : v.hur === 'utkast' ? 'Demi (AI), första utkastet'
        : !v.vem ? (v.hur === 'utanfor' ? 'Ändrat utanför rummet' : 'Okänt vem som skrev')
          : `${namn(v.vem)}${arAI(v.vem) ? ' (AI)' : ''}${v.av && v.av !== v.vem ? `, lagt in av ${namn(v.av)}` : ''}${v.nar ? `, ${datum(v.nar)}` : ''}`;
    marg.push(h('button', {
      type: 'button', class: `av ${v.vem === 'henric' ? 'h' : v.vem === 'liv' ? 'l' : v.vem === 'demi' ? 'd' : 'x'}${nytt ? ' nytt' : ''}${v.hur === 'osparat' ? ' osparat' : ''}`,
      title: `${titel}. Tryck för historiken.`, 'aria-label': `${titel}. Visa historiken.`, 'data-gor': 'historik',
    }));
  }
  if (V.arEpisod && info.iScen) {
    const lj = ljudLage(p);
    if (lj.lage === 'inspelad') {
      marg.push(h('button', { type: 'button', class: 'ring', 'aria-label': 'Lyssna', title: 'Lyssna', 'data-gor': 'lyssna' }));
    } else if (lj.lage === 'ej') {
      marg.push(h('span', { class: 'ring ny', title: 'Inte inspelad än', role: 'img', 'aria-label': 'Inte inspelad än' }));
    }
  }
  vy.marg.replaceChildren(...marg);

  // A mechanic: the catalogue's warning, and a request waiting for Demi.
  if (p.typ === 'mekanik' && vy.extra) {
    const extra = [];
    if (K.arNyMekanik(p.text)) {
      const svarat = A.demiHarSvarat(dokument.not, p.id, p.text);
      extra.push(h('span', { class: `vantar${svarat ? ' svarat' : ''}` }, svarat ? 'Demi har svarat i kommentaren' : 'Ny mekanik: väntar på Demi'));
    }
    if (S.katalog) {
      const per = new Map();
      for (const x of K.hittaNamn(p.text, S.katalog)) {
        for (const v of K.varsel(x.mekanik, S.katalog) || []) {
          const nyckel = `${v.ord}\u0001${v.text}`;
          if (!per.has(nyckel)) per.set(nyckel, { ...v, namn: [] });
          if (!per.get(nyckel).namn.includes(v.namn)) per.get(nyckel).namn.push(v.namn);
        }
      }
      for (const v of per.values()) {
        extra.push(h('span', { class: `varsel ${K.klassFor(v.ord)}` }, `${v.ord}: ${lista(v.namn)}. ${v.text}`));
      }
    }
    vy.extra.replaceChildren(...extra);
  }
  // The title: which document and which draft.
  if (p.typ === 'rubrik' && vy.extra) {
    let under = '';
    if (V.arEpisod) {
      const andra = red.stycken()[1];
      const m = andra && /^Utkast (\d+)/i.exec(andra.text);
      under = `Episod ${V.dok}${m ? `, utkast ${m[1]}` : ''}`;
    } else if (V.dok === 'varld') under = 'Världsboken';
    else if (V.dok === 'mekaniker') under = 'Mekanikerna';
    vy.extra.replaceChildren(under);
  }
  if (p.typ === 'variant' && vy.etikett) vy.etikett.disabled = !kanSkriva();

  // Under the paragraph: why it is not saved, if it is not.
  const under = [];
  const fel = p.typ === 'linje' ? null : D.fel(p, info.iScen) || (dokument.hallna.get(p.id) === 'form' ? 'form' : null);
  if (fel && fel !== 'tom' && kanSkriva()) {
    under.push(h('p', { class: 'hallen', role: 'note' }, `Inte sparat: ${D.FELTEXT[fel]}`));
  } else if (fel === 'tom' && kanSkriva() && V.dokument.bas.some((b) => b.id === p.id)) {
    under.push(h('p', { class: 'hallen', role: 'note' }, 'Tomt. Den gamla texten står kvar i filen tills du skriver något nytt eller tar bort stycket.'));
  }
  vy.under.replaceChildren(...under);

  // Comments, proposals and krockar in the margin.
  const kom = [];
  const x = kanSkriva() ? notKarta(V, red).karta.get(p.id) : null;
  if (x) {
    for (const k of x.krockar) kom.push(krockKort(V, k, p));
    for (const f of x.forslag) kom.push(forslagKort(V, f, p));
    for (const k of x.kommentarer) kom.push(kommentarKort(V, k, p));
  }
  vy.kom.replaceChildren(...kom);
  vy.dom.classList.toggle('har-kom', kom.length > 0);
}

// Comments never push the text: on a wide screen they hang in the right
// margin, moved down only as far as needed not to cover each other.
let komLayout = 0;
function planeraKomLayout() {
  if (komLayout) return;
  komLayout = requestAnimationFrame(() => { komLayout = 0; layoutKom(); });
}
function layoutKom() {
  const V = S.vy;
  if (!V || !V.red) return;
  const alla = [...inne.querySelectorAll('.st > .kom')];
  if (!bred()) {
    for (const k of alla) k.style.transform = '';
    return;
  }
  const matt = alla.filter((k) => k.childElementCount).map((k) => ({ k, top: k.parentElement.offsetTop, hojd: k.offsetHeight }));
  let botten = -Infinity;
  for (const m of matt) {
    const flytt = Math.max(0, botten - m.top);
    m.k.style.transform = flytt ? `translateY(${flytt}px)` : '';
    botten = m.top + flytt + m.hojd + 8;
  }
}
window.addEventListener('resize', planeraKomLayout);

function klickIStycke(V, e, vy) {
  const t = e.target;
  const p = V.red.stycken().find((x) => x.id === vy.node.attrs.id);
  if (!p) return false;
  const bricka = t.closest && t.closest('.bricka');
  if (bricka && bricka.dataset.mek) {
    visaBricka(bricka.dataset.mek);
    return false;
  }
  const gor = t.closest && t.closest('[data-gor]');
  if (!gor) return false;
  e.preventDefault();
  if (gor.dataset.gor === 'historik') visaHistorik(V, p.id);
  else if (gor.dataset.gor === 'lyssna') {
    const lj = ljudLage(p);
    if (lj.lage === 'inspelad') spela(p.id, lj.delar, gor);
  } else if (gor.dataset.gor === 'etikett' && kanSkriva()) valjEtikett(V, p.id);
  return true;
}

// --- Cards in the margin ---

function kortHuvud(vem, nar, extra = null) {
  return h('b', null, avsandare(vem), nar ? h('span', { class: 'nar' }, datum(nar)) : null, extra);
}

function kommentarKort(V, k, p) {
  const svar = A.trad(V.dokument.not, k.id).filter((x) => !dold(x.skrev));
  const egen = k.skrev === mig();
  const galdeAnnat = k.galde != null && k.galde !== p.text && k.stycke === p.id;
  return h('div', { class: `kort${arAI(k.skrev) ? ' ai' : ''}` },
    kortHuvud(k.skrev, k.nar, k.till ? h('span', { class: 'till' }, `till ${namn(k.till)}`) : null),
    galdeAnnat ? h('span', { class: 'galde' }, `Om: «${kortText(k.galde, 70)}»`) : null,
    k.stycke !== p.id ? h('span', { class: 'galde' }, `Om ett stycke som är borttaget${k.galde ? `: «${kortText(k.galde, 60)}»` : ''}`) : null,
    h('span', { class: 'kort-text' }, k.text),
    svar.map((s) => h('div', { class: `svar${arAI(s.skrev) ? ' ai' : ''}` }, kortHuvud(s.skrev, s.nar), h('span', { class: 'kort-text' }, s.text))),
    kanSkriva() ? h('span', { class: 'val' },
      h('button', { type: 'button', onclick: () => skrivKommentar(V, p, { svarPa: k }) }, 'Svara'),
      h('button', { type: 'button', onclick: () => anteckna(V, 'klar', { id: k.id, vem: mig(), nar: nu() }, 'Markerad som klar.') }, 'Klar'),
      egen ? h('button', { type: 'button', onclick: () => skrivKommentar(V, p, { andra: k }) }, 'Ändra') : null,
      h('button', { type: 'button', onclick: () => anteckna(V, 'ta-bort', { id: k.id, vem: mig(), nar: nu() }, 'Kommentaren är borttagen. Den finns kvar under Historik.') }, 'Ta bort')) : null);
}

function forslagKort(V, f, p) {
  const andrat = f.galde != null && f.galde !== p.text && f.stycke === p.id;
  const somNytt = f.stycke !== p.id || f.los;
  return h('div', { class: `kort${arAI(f.skrev) ? ' ai' : ''}` },
    kortHuvud(f.skrev, f.nar),
    f.fri ? 'Om scenen:' : somNytt ? 'Förslag på ett nytt stycke här:' : 'Förslag i stället:',
    h('span', { class: 'forslag' }, f.text),
    andrat ? h('span', { class: 'galde' }, 'Stycket har ändrats sedan förslaget skrevs.') : null,
    kanSkriva() ? h('span', { class: 'val' },
      f.fri ? null : h('button', { type: 'button', onclick: () => laggIn(V, f, p, somNytt) }, 'Lägg in'),
      h('button', { type: 'button', onclick: () => anteckna(V, 'forslag-lage', { id: f.id, lage: 'avfard', vem: mig(), nar: nu() }, 'Förslaget är avfärdat. Det finns kvar under Historik.') }, f.fri ? 'Klar' : 'Avfärda'),
      h('button', { type: 'button', onclick: () => skrivKommentar(V, p, { svarPa: f }) }, 'Svara')) : null);
}

// A Swedish genitive: Henrics, Livs, but Demis stays Demis.
const gen = (n) => (/[sxz]$/i.test(n) ? n : `${n}s`);

function krockText(k) {
  const mot = k.mot ? namn(k.mot) : null;
  const iTexten = mot ? `I texten står nu ${gen(mot)} version.` : 'I texten står nu den version som sparades sist.';
  if (!k.vem) return `Stycket ändrades utanför rummet medan ${mot || 'någon'} skrev i det. ${iTexten} Den andra versionen var:`;
  const vem = `${namn(k.vem)}${arAI(k.vem) ? ' (AI)' : ''}`;
  if (k.vem === k.mot) return `Samma stycke ändrades i två fönster samtidigt. ${iTexten} Den andra versionen var:`;
  return `${vem} ändrade samma stycke samtidigt${mot ? ` som ${mot}` : ''}. ${iTexten} ${gen(namn(k.vem))} version var:`;
}

function krockKort(V, k, p) {
  return h('div', { class: 'kort krock', role: 'note' },
    h('b', null, 'Två ändringar möttes'),
    h('span', { class: 'kort-text' }, krockText(k)),
    h('span', { class: 'forslag' }, k.text),
    kanSkriva() ? h('span', { class: 'val' },
      h('button', { type: 'button', onclick: () => anvandVersion(V, p.id, k, { hur: 'krock', vem: k.vem, krock: k.id }) }, 'Använd den här'),
      h('button', { type: 'button', onclick: () => anteckna(V, 'krock-lage', { id: k.id, lage: 'behallen', vem: mig(), nar: nu() }, 'Texten står kvar som den är. Den andra versionen finns under Historik.') }, 'Behåll texten')) : null);
}

// A note (comment, done, removed, proposal, krock settled): written at once
// if it can be, otherwise it waits in the browser and is sent later.
async function anteckna(V, slag, args, klart) {
  try {
    const ok = await V.dokument.anteckna(slag, args);
    status(ok ? klart : 'Sparat här. Det skickas när portalen svarar.', ok ? 'ok' : 'fel');
  } catch (e) {
    status(felText(e), 'fel');
  }
  dokumentRitat(V);
  if (V.red) V.red.ritaOm();
}

// Text from someone (a proposal, an earlier version, the other side of a
// krock) goes in as a change of the paragraph, in the undo history, and
// the save records whose words they are.
function anvandVersion(V, id, x, avsikt) {
  const p = { typ: x.typ || 'replik', attrs: D.rensaAttrs(x.typ || 'replik', x.attrs), text: x.text };
  V.dokument.avsikt(id, { nyckel: D.nyckel(p), ...avsikt });
  V.red.ersattStycke(id, p);
  status('Inlagt. Det sparas om en stund, och går att ångra.', 'ok');
}

function laggIn(V, f, p, somNytt) {
  if (somNytt) {
    const id = D.nyttId();
    const ny = { id, typ: f.typ, attrs: D.rensaAttrs(f.typ, f.attrs), text: f.text };
    V.dokument.avsikt(id, { nyckel: D.nyckel(ny), hur: 'forslag', vem: f.skrev, forslag: f.id });
    V.red.infogaStycke(p.id, ny);
    status('Förslaget är inlagt som ett nytt stycke.', 'ok');
    return;
  }
  anvandVersion(V, p.id, f, { hur: 'forslag', vem: f.skrev, forslag: f.id });
}

// --- Writing a comment or a proposal ---

const utkastNyckel = (V, x) => `glimt-rummet|${S.adapter.rot || S.adapter.namn}|kommentar|${V.dok}|${x}`;
const lasUtkast = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const skrivUtkast = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* the field still has it */ } };

function skrivKommentar(V, p, { svarPa = null, andra = null, forslag = false } = {}) {
  if (!kanSkriva()) return;
  const nyckel = utkastNyckel(V, `${forslag ? 'forslag' : andra ? `andra-${andra.id}` : svarPa ? `svar-${svarPa.id}` : 'ny'}|${p.id}`);
  const forval = andra ? andra.text : forslag ? p.text : '';
  const text = h('textarea', { class: 'falt', rows: forslag ? 4 : 3, 'data-fokus': true, 'aria-label': forslag ? 'Förslaget' : 'Kommentaren' });
  text.value = lasUtkast(nyckel) || forval;
  const fragaDemi = h('input', { type: 'checkbox', id: 'fraga-demi' });
  const fel = h('p', { class: 'fel', role: 'alert' });
  text.addEventListener('input', () => skrivUtkast(nyckel, text.value !== forval ? text.value : ''));
  const titel = forslag ? 'Föreslå i stället' : andra ? 'Ändra din kommentar' : svarPa ? 'Svara' : 'Kommentera';
  const skicka = async (ev) => {
    ev.preventDefault();
    const t = text.value;
    if (!t.trim()) { fel.textContent = 'Skriv något först.'; return; }
    let slag;
    let args;
    if (forslag) {
      if (t === p.text) { fel.textContent = 'Förslaget är samma som texten. Ändra något först.'; return; }
      if (/[\n\r]/.test(t)) { fel.textContent = 'Ett stycke är en rad. Skriv förslaget utan radbrytning.'; return; }
      slag = 'forslag';
      args = { id: D.nyttId(), stycke: p.id, galde: p.text, text: t, typ: p.typ, attrs: p.attrs, vem: mig(), nar: nu() };
    } else if (andra) {
      slag = 'andra-kommentar';
      args = { id: andra.id, text: t, vem: mig(), nar: nu() };
    } else {
      slag = 'kommentar';
      args = { id: D.nyttId(), stycke: p.id, galde: p.text, text: t, vem: mig(), nar: nu(), svarPa: svarPa ? svarPa.id : null, till: fragaDemi.checked ? 'demi' : null };
    }
    skrivUtkast(nyckel, '');
    stangPanel();
    await anteckna(V, slag, args, forslag ? 'Förslaget ligger vid stycket.' : 'Kommentaren är sparad.');
  };
  oppnaPanel(titel,
    h('p', { class: 'om' }, svarPa ? `Svar till ${namn(svarPa.skrev)}: «${kortText(svarPa.text, 80)}»` : `Om: «${kortText(p.text || '(tomt stycke)', 90)}»`),
    h('form', { class: 'form', onsubmit: skicka },
      text,
      forslag ? h('p', { class: 'hjalp' }, 'Förslaget ligger vid stycket tills någon lägger in det eller avfärdar det. Texten ändras inte förrän dess.') : null,
      !forslag && !andra && !arAI(mig()) ? h('label', { class: 'kryss', for: 'fraga-demi' }, fragaDemi, 'Be Demi svara') : null,
      fel,
      h('div', { class: 'knappar' },
        h('button', { type: 'submit', class: 'knapp huvud' }, forslag ? 'Lägg förslaget' : andra ? 'Spara' : 'Skicka'),
        h('button', { type: 'button', class: 'knapp', onclick: () => stangPanel() }, 'Avbryt'))));
}

// --- History ---

const HUR = {
  utkast: 'första utkastet', utanfor: 'ändrat utanför rummet', skrev: 'skrev', andrade: 'ändrade',
  forslag: 'förslag', tillbaka: 'tog tillbaka', krock: 'mötte en annan ändring, står inte i texten',
};

function visaHistorik(V, id = null) {
  const not = V.dokument.not;
  const stycken = V.red.stycken();
  const finns = new Set(stycken.map((p) => p.id));
  const markor = V.red.markor();
  const p = stycken.find((x) => x.id === (id || (markor && markor.p.id)));
  const delar = [];
  if (p) {
    const lista = A.historikFor(not, p.id).filter((e) => !e.borta);
    const nuNyckel = D.nyckel(p);
    const versioner = [...lista].reverse();
    const v = V.dokument.vemSkrev(p);
    delar.push(h('section', { class: 'avsnitt' },
      h('h3', null, 'Det här stycket'),
      h('p', { class: 'version nu' }, h('span', { class: 'meta' }, v.vem ? avsandare(v.vem) : (v.hur === 'osparat' ? 'Du, inte sparat än' : HUR[v.hur] || 'Okänt'), v.nar ? ` ${datum(v.nar)}` : '', ' · står i texten nu'), h('span', { class: 'text-version' }, p.text || '(tomt)')),
      versioner.filter((e) => D.nyckel(e) !== nuNyckel || e.hur === 'krock').map((e) => h('div', { class: `version${e.hur === 'krock' ? ' krockad' : ''}` },
        h('span', { class: 'meta' }, e.vem ? avsandare(e.vem) : 'Okänt vem', ` ${HUR[e.hur] || e.hur}`, e.av && e.av !== e.vem ? `, av ${namn(e.av)}` : '', e.nar ? `, ${datum(e.nar)}` : ''),
        h('span', { class: 'text-version' }, e.text),
        kanSkriva() ? h('button', { type: 'button', class: 'knapp liten', onclick: () => { stangPanel(); anvandVersion(V, p.id, e, { hur: 'tillbaka', vem: e.vem }); } }, 'Ta tillbaka den här') : null)),
      versioner.length <= 1 && !versioner.some((e) => D.nyckel(e) !== nuNyckel) ? h('p', { class: 'dov' }, 'Inga tidigare versioner.') : null));
    // Comments and proposals that are done, removed, laid in or dismissed.
    const stangda = [
      ...not.kommentarer.filter((k) => k.stycke === p.id && !k.svarPa && (k.klar || k.borta)),
      ...not.forslag.filter((f) => f.stycke === p.id && f.lage !== 'oppet'),
    ];
    if (stangda.length) {
      delar.push(h('section', { class: 'avsnitt' }, h('h3', null, 'Klara och borttagna'),
        stangda.map((x) => h('div', { class: 'version' },
          h('span', { class: 'meta' }, avsandare(x.skrev), ` ${x.lage ? (x.lage === 'inlagt' ? 'förslag, inlagt' : 'förslag, avfärdat') : x.borta ? 'kommentar, borttagen' : 'kommentar, klar'}`, x.nar ? `, ${datum(x.nar)}` : ''),
          h('span', { class: 'text-version' }, x.text),
          kanSkriva() ? h('button', {
            type: 'button', class: 'knapp liten',
            onclick: () => {
              stangPanel();
              if (x.lage) anteckna(V, 'forslag-lage', { id: x.id, lage: 'oppet', vem: mig(), nar: nu() }, 'Förslaget är öppet igen.');
              else if (x.borta) anteckna(V, 'ta-bort', { id: x.id, vem: mig(), nar: nu(), tillbaka: true }, 'Kommentaren är tillbaka.');
              else anteckna(V, 'klar', { id: x.id, vem: mig(), nar: nu(), klar: false }, 'Kommentaren är öppen igen.');
            },
          }, x.lage ? 'Öppna igen' : x.borta ? 'Lägg tillbaka' : 'Öppna igen') : null))));
    }
  }
  // Since last time.
  const sedan = sedanLista(V);
  delar.push(h('section', { class: 'avsnitt' },
    h('h3', null, V.sedan ? `Sedan du var här ${datum(V.sedan)}` : 'Senaste ändringarna'),
    sedan.length ? h('ul', { class: 'handelser' }, sedan.slice(0, 40).map((x) => h('li', null,
      h('button', { type: 'button', class: 'lank', onclick: () => { stangPanel({ tillRedigeraren: false }); V.red.ga(finns.has(x.stycke) ? x.stycke : A.hem(not, x.stycke, (i) => finns.has(i)) || stycken[0].id); } },
        avsandare(x.vem), ` ${HANDELSE[x.slag] || x.slag} `, h('span', { class: 'dov' }, datum(x.nar))),
      x.text ? h('span', { class: 'utdrag' }, kortText(x.text, 120)) : null))) : h('p', { class: 'dov' }, V.sedan ? 'Inget nytt från någon annan.' : 'Inget ännu.')));
  // Removed paragraphs.
  const borta = A.borttagna(not, (i) => finns.has(i));
  if (borta.length) {
    delar.push(h('section', { class: 'avsnitt' }, h('h3', null, `Borttagna stycken (${borta.length})`),
      borta.slice(0, 60).map((b) => h('div', { class: 'version' },
        h('span', { class: 'meta' }, 'Borttaget av ', b.borta.vem ? avsandare(b.borta.vem) : 'okänd', b.borta.nar ? `, ${datum(b.borta.nar)}` : ''),
        h('span', { class: 'text-version' }, b.sista.text),
        kanSkriva() ? h('button', { type: 'button', class: 'knapp liten', onclick: () => { stangPanel(); laggTillbaka(V, b); } }, 'Lägg tillbaka') : null))));
  }
  oppnaPanel('Historik', ...delar);
}

const HANDELSE = {
  andrade: 'ändrade', skrev: 'skrev', strok: 'tog bort', forslag: 'föreslog', kommentar: 'kommenterade', svar: 'svarade',
  tillbaka: 'tog tillbaka', krock: 'ändrade samtidigt',
};

function sedanLista(V) {
  const jag = mig();
  return A.handelser(V.dokument.not).filter((x) => x.vem !== jag && !dold(x.vem) && (!V.sedan || String(x.nar) > V.sedan));
}

function laggTillbaka(V, b) {
  const finns = new Set(V.red.stycken().map((p) => p.id));
  const efter = A.hem(V.dokument.not, b.borta.efter, (i) => finns.has(i));
  const p = { id: b.id, typ: b.sista.typ, attrs: D.rensaAttrs(b.sista.typ, b.sista.attrs), text: b.sista.text };
  V.dokument.avsikt(b.id, { nyckel: D.nyckel(p), hur: 'tillbaka', vem: b.sista.vem });
  V.red.infogaStycke(efter, p);
  V.red.ga(b.id);
  status('Stycket är tillbaka. Det går att ångra.', 'ok');
}

// --- Since last time ---

function sedanSist(dok) {
  const k = `glimt-rummet|sedan|${dok}`;
  try {
    const sparad = sessionStorage.getItem(k);
    if (sparad != null) return sparad || null;
    const v = (S.inst.besok && S.inst.besok[dok]) || '';
    sessionStorage.setItem(k, v);
    return v || null;
  } catch {
    return (S.inst.besok && S.inst.besok[dok]) || null;
  }
}

function markeraBesok(dok) {
  if (!kanSkriva()) return;
  S.lager.sattInstallning('besok', { dok, nar: nu() }).then((i) => { S.inst = i; }).catch(() => {});
}

function ritaNotis(V) {
  if (!V.notis) return;
  const delar = [];
  const n = kanSkriva() ? sedanLista(V).length : 0;
  if (n && V.sedan) {
    delar.push(h('p', { class: 'sedan' }, `${n === 1 ? 'En sak' : `${n} saker`} har hänt sedan du var här sist. `,
      h('button', { type: 'button', class: 'lank', onclick: () => visaHistorik(V) }, 'Visa')));
  }
  const vantar = V.dokument.ko().length;
  if (vantar) delar.push(h('p', { class: 'sedan' }, 'Anteckningar om vem som skrev väntar i webbläsaren och skickas så fort det går.'));
  V.notis.replaceChildren(...delar);
}

// --- Mechanics in a scene ---

function visaBricka(mekId) {
  const k = S.katalog && S.katalog.mekaniker.find((x) => x.id === mekId);
  if (!k) return;
  oppnaPanel(k.namn, mekanikDetaljer(k, { lank: true }));
}

function omdomeMarke(k) {
  return h('span', { class: `omdome ${K.klassFor(k.omdome)}` }, h('i', { 'aria-hidden': 'true' }), k.omdome || 'Inget omdöme');
}

function mekanikDetaljer(k, { lank = false, anvands = null } = {}) {
  const v = K.varsel(k, S.katalog) || [];
  return h('div', { class: 'mekanik-detaljer' },
    h('p', { class: 'mek-rad' }, omdomeMarke(k), k.grupp ? h('span', { class: 'dov' }, ` · ${k.grupp}`) : null),
    k.du ? h('p', null, h('strong', null, 'Du gör: '), k.du) : null,
    k.berattelse ? h('p', null, h('strong', null, 'I berättelsen: '), k.berattelse) : null,
    k.omdomeText ? h('p', null, h('strong', null, 'Omdöme: '), k.omdomeText) : null,
    k.tank ? h('p', null, h('strong', null, 'Tänk på: '), k.tank) : null,
    k.varianter.length ? h('p', null, h('strong', null, 'Varianter: '), k.varianter.join(', ')) : null,
    v.map((x) => h('p', { class: `varsel ${K.klassFor(x.ord)}` }, `${x.ord}: ${x.text}`)),
    anvands,
    lank ? h('p', null, h('a', { href: `#mekaniker/${k.id}`, onclick: () => stangPanel({ tillRedigeraren: false }) }, 'Visa i katalogen')) : null);
}

function infogaMekanik(V) {
  if (!S.katalog || !S.katalog.mekaniker.length) { status('Katalogen gick inte att läsa.', 'fel'); return; }
  const m = V.red.markor();
  if (!m || !m.iScen) { status('Ställ markören i en scen först. Mekaniker hör till scenerna.', 'info'); return; }
  const sok = h('input', { type: 'search', class: 'falt', placeholder: 'Sök bland mekanikerna', 'aria-label': 'Sök bland mekanikerna', 'data-fokus': true, autocomplete: 'off' });
  const ut = h('div', { class: 'mek-lista', role: 'list' });
  const rita = () => {
    const traffar = K.sok(S.katalog, sok.value);
    const grupper = new Map();
    for (const k of traffar) {
      if (!grupper.has(k.grupp)) grupper.set(k.grupp, []);
      grupper.get(k.grupp).push(k);
    }
    ut.replaceChildren(...[...grupper].map(([g, ks]) => h('div', { class: 'grupp' }, h('h3', null, g || 'Övrigt'),
      ks.map((k) => h('button', {
        type: 'button', class: 'mek-val', role: 'listitem',
        onclick: () => {
          stangPanel({ tillRedigeraren: false });
          const r = V.red.infogaMekanik(k.namn);
          if (!r.ok) { status(r.fel, 'info'); return; }
          status(`${k.namn} står nu i scenens mekanik${r.grenar ? ', och scenen har fått två tomma grenar att skriva i' : ''}.`, 'ok');
        },
      }, h('span', { class: 'mek-namn' }, h('i', { class: `prick-omdome ${K.klassFor(k.omdome)}`, 'aria-hidden': 'true' }), k.namn, h('span', { class: 'dov' }, ` ${k.omdome || ''}`)),
      k.du ? h('span', { class: 'mek-du' }, `Du ${kortText(k.du, 110)}`) : null)))));
    if (!traffar.length) ut.replaceChildren(h('p', { class: 'dov' }, 'Ingen mekanik passar. Skriv den med egna ord i scenens mekanik, och börja med Ny mekanik:, så svarar Demi.'));
  };
  sok.addEventListener('input', rita);
  rita();
  oppnaPanel(`Infoga mekanik i scen ${m.scen || ''}`.trim(), h('p', { class: 'hjalp' }, 'Namnet läggs sist i scenens mekanik. Har scenen inga grenar får den två tomma.'), sok, ut);
}

function valjEtikett(V, id) {
  const p = V.red.stycken().find((x) => x.id === id);
  if (!p) return;
  const nu0 = p.typ === 'variant' ? p.attrs.etikett : '';
  const val = S.katalog ? K.varianter(S.katalog) : [];
  const perMek = new Map();
  for (const v of val) {
    if (!perMek.has(v.mekanik.namn)) perMek.set(v.mekanik.namn, []);
    perMek.get(v.mekanik.namn).push(v.etikett);
  }
  const egen = h('input', { type: 'text', class: 'falt', 'aria-label': 'Egen etikett', placeholder: 'Egen etikett', autocomplete: 'off' });
  const fel = h('p', { class: 'fel', role: 'alert' });
  const satt = (e) => {
    if (!e.trim()) { fel.textContent = 'Skriv en etikett.'; return; }
    if (/[\]\n\r]/.test(e)) { fel.textContent = D.FELTEXT.etikett; return; }
    stangPanel();
    V.red.sattEtikett(id, e.trim());
  };
  oppnaPanel('Etikett för varianten',
    h('p', { class: 'hjalp' }, 'Telefonen väljer raden när det här stämmer. Etiketterna kommer ur katalogen.'),
    [...perMek].map(([mek, ets]) => h('div', { class: 'etikett-grupp' }, h('h3', null, mek),
      h('div', { class: 'etiketter' }, ets.map((e) => h('button', { type: 'button', class: `etikett-val${e === nu0 ? ' vald' : ''}`, 'aria-pressed': e === nu0 ? 'true' : 'false', 'data-fokus': e === nu0 ? true : null, onclick: () => satt(e) }, e))))),
    h('form', { class: 'form rad-form', onsubmit: (ev) => { ev.preventDefault(); satt(egen.value); } }, egen, h('button', { type: 'submit', class: 'knapp' }, 'Använd')),
    fel);
}

// --- The toolbar --------------------------------------------------------------------------------

function ritaVerktyg() {
  const t = $('verktyg');
  const V = S.vy;
  if (!V || !V.red || !kanSkriva()) {
    t.hidden = true;
    document.body.classList.remove('med-verktyg');
    return;
  }
  t.hidden = false;
  document.body.classList.add('med-verktyg');
  const m = V.red.markor();
  const stil = m ? m.stil : '';
  if (!t.firstChild) byggVerktyg(t);
  t.querySelector('.typval span').textContent = stil || 'Stil';
  t.querySelector('[data-gor="infoga"]').hidden = !V.arEpisod;
  t.querySelector('[data-gor="etikett"]').hidden = !(m && m.p.typ === 'variant');
  const ets = t.querySelector('[data-gor="etikett"]');
  if (m && m.p.typ === 'variant') ets.textContent = m.p.attrs.etikett ? `Etikett: ${m.p.attrs.etikett}` : 'Välj etikett';
  t.querySelector('.skilje.mek').hidden = !V.arEpisod && !(m && m.p.typ === 'variant');
}

function byggVerktyg(t) {
  const knapp = (gor, text, extra = {}) => h('button', { type: 'button', 'data-gor': gor, ...extra }, text);
  t.replaceChildren(
    h('button', { type: 'button', class: 'typval', 'data-gor': 'stil', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Styckets stil' }, h('span', null, 'Stil')),
    h('span', { class: 'skilje mek' }),
    knapp('infoga', 'Infoga mekanik'),
    knapp('etikett', 'Etikett'),
    h('span', { class: 'skilje' }),
    knapp('kommentera', 'Kommentera'),
    knapp('foresla', 'Föreslå'),
    knapp('historik', 'Historik'),
    h('span', { class: 'skilje' }),
    h('button', { type: 'button', 'data-gor': 'angra', class: 'ikon', 'aria-label': 'Ångra', title: 'Ångra (Ctrl+Z)' }, svg(IKON.angra)),
    h('button', { type: 'button', 'data-gor': 'gorom', class: 'ikon', 'aria-label': 'Gör om', title: 'Gör om (Ctrl+Y)' }, svg(IKON.gorom)),
    h('span', { class: 'vem', 'aria-hidden': 'true' }, h('span', { class: 'h' }, h('i'), 'Henric'), h('span', { class: 'l' }, h('i'), 'Liv'), h('span', { class: 'd' }, h('i'), 'Demi')),
  );
}

// The editor keeps the cursor while a tool is pressed.
$('verktyg').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});
$('verktyg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-gor]');
  const V = S.vy;
  if (!b || !V || !V.red) return;
  const m = V.red.markor();
  const gor = b.dataset.gor;
  if (gor === 'stil') {
    const stilar = m && m.iScen ? STILAR_SCEN : STILAR_TEXT;
    oppnaMeny(b, stilar.map((s, k) => ({ namn: s.namn, tips: `Ctrl+Shift+${k + 1}`, vald: !!(m && arStil(s, m.p)), gor: () => { V.red.sattStil(s); if (s.typ === 'variant' && m && m.p.typ !== 'variant') valjEtikett(V, m.p.id); } })), { etikett: 'Styckets stil' });
  } else if (gor === 'infoga') infogaMekanik(V);
  else if (gor === 'etikett' && m) valjEtikett(V, m.p.id);
  else if (gor === 'kommentera' && m) skrivKommentar(V, m.p);
  else if (gor === 'foresla' && m) skrivKommentar(V, m.p, { forslag: true });
  else if (gor === 'historik') visaHistorik(V);
  else if (gor === 'angra') V.red.angra();
  else if (gor === 'gorom') V.red.gorOm();
});

// On a phone the toolbar sits right above the keyboard. Chrome on Android
// does that by itself with interactive-widget=resizes-content; elsewhere the
// visual viewport says where the keyboard begins.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const flytta = () => {
    const under = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--tangentbord', `${under}px`);
  };
  vv.addEventListener('resize', flytta);
  vv.addEventListener('scroll', flytta);
}

// --- The world: HELD's lore and the pages we write -------------------------------------------

async function visaHeld(r) {
  fyll(underflikar(r), h('p', { class: 'laddar' }, 'Läser …'));
  let text = null;
  try {
    text = await S.lager.lasText('held');
  } catch {
    text = null;
  }
  if (S.rutt !== r) return;
  fyll(underflikar(r),
    h('p', { class: 'kalla' }, 'HELD:s gemensamma lore, Henrics ord. Den läses här och ändras i HELD-projektet.'),
    text == null ? h('p', { class: 'dov' }, 'HELD:s lore går bara att läsa i portalen.') : h('article', { class: 'md' }, renderMd(text)));
}

async function visaSidor(r) {
  fyll(underflikar(r), h('p', { class: 'laddar' }, 'Läser …'));
  try {
    S.lore = await S.lager.lasLore();
  } catch (e) {
    if (S.rutt === r) fyll(underflikar(r), h('div', { class: 'band varning' }, felText(e)));
    return;
  }
  if (S.rutt !== r) return;
  const senast = (s) => (s.titelAndrad && s.titelAndrad.nar) || s.skapad || '';
  const synliga = S.lore.sidor.filter((s) => !s.borta && !dold(s.skrev)).sort((a, b) => String(senast(b)).localeCompare(String(senast(a))));
  const doldaN = S.lore.sidor.filter((s) => !s.borta && dold(s.skrev)).length;
  const borta = S.lore.sidor.filter((s) => s.borta);
  const ny = async () => {
    try {
      const id = await S.lager.nyLoresida('Ny sida');
      location.hash = `#varlden/sida/${id}`;
    } catch (e) {
      status(felText(e), 'fel');
    }
  };
  fyll(underflikar(r),
    h('p', { class: 'kalla' }, 'Lore vi skriver själva: personer, platser, regler, sådant som inte står i världsboken än. Alla kan ändra allt.'),
    kanSkriva() ? h('p', null, h('button', { type: 'button', class: 'knapp huvud', onclick: ny }, 'Skriv en ny sida')) : null,
    synliga.length ? h('ul', { class: 'sidlista' }, synliga.map((s) => {
      const forsta = A.loreText(s).split('\n').find((x) => x.trim()) || '';
      return h('li', null, h('a', { href: `#varlden/sida/${s.id}` },
        h('span', { class: 'sid-titel' }, s.titel),
        h('span', { class: 'meta' }, avsandare(s.skrev), s.skapad ? ` ${datum(s.skapad)}` : ''),
        forsta ? h('span', { class: 'utdrag' }, kortText(forsta, 140)) : null));
    })) : h('p', { class: 'dov' }, 'Inga sidor än.'),
    doldaN ? h('p', { class: 'dov liten' }, `${doldaN === 1 ? 'En sida' : `${doldaN} sidor`} av Demi är dolda för dig.`) : null,
    borta.length ? h('details', { class: 'borttagna' }, h('summary', null, `Borttagna sidor (${borta.length})`),
      borta.map((s) => h('div', { class: 'version' }, h('span', { class: 'text-version' }, s.titel),
        h('span', { class: 'meta' }, `Borttagen av ${namn(s.borta.av)} ${datum(s.borta.nar)}`),
        kanSkriva() ? h('button', { type: 'button', class: 'knapp liten', onclick: async () => { await S.lager.taBortLoresida(s.id, true); visaSidor(r); } }, 'Hämta tillbaka') : null))) : null);
}

function loreHuvud(sida) {
  const titel = h('input', { type: 'text', class: 'sidtitel', value: sida.titel, 'aria-label': 'Sidans titel', autocomplete: 'off', readonly: kanSkriva() ? null : true });
  let sparad = sida.titel;
  const spara = async () => {
    const t = titel.value.trim();
    if (!t || t === sparad) { if (!t) titel.value = sparad; return; }
    try {
      await S.lager.loreTitel(sida.id, t);
      sparad = t;
      status('Titeln är sparad.', 'ok');
    } catch (e) {
      status(felText(e), 'fel');
    }
  };
  titel.addEventListener('change', spara);
  titel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titel.blur(); if (S.vy && S.vy.red) S.vy.red.fokus(); } });
  const taBort = async () => {
    try {
      await S.lager.taBortLoresida(sida.id);
      status('Sidan är borttagen. Den går att hämta tillbaka under Våra sidor.', 'ok');
      location.hash = '#varlden/sidor';
    } catch (e) {
      status(felText(e), 'fel');
    }
  };
  return h('div', { class: 'lore-huvud' },
    h('p', null, h('a', { href: '#varlden/sidor' }, 'Alla sidor')),
    titel,
    h('p', { class: 'meta' }, 'Skriven av ', avsandare(sida.skrev), sida.skapad ? ` ${datum(sida.skapad)}` : '',
      kanSkriva() ? h('button', { type: 'button', class: 'lank fara', onclick: taBort }, 'Ta bort sidan') : null));
}

// --- The mechanics, as a list ---------------------------------------------------------------------

async function visaKatalog(r) {
  fyll(underflikar(r), h('p', { class: 'laddar' }, 'Läser katalogen …'));
  let kat;
  try {
    kat = await S.lager.katalog();
  } catch (e) {
    if (S.rutt === r) fyll(underflikar(r), h('div', { class: 'band varning' }, felText(e)));
    return;
  }
  if (S.rutt !== r) return;
  S.katalog = kat;
  const V = { rutt: r, katalog: kat, anvands: null };
  S.vy = V;
  const sok = h('input', { type: 'search', class: 'falt', placeholder: 'Sök på namn, vad du gör eller omdöme', 'aria-label': 'Sök bland mekanikerna', autocomplete: 'off' });
  const ut = h('div', { class: 'katalog' });
  const antal = (o) => kat.mekaniker.filter((k) => k.omdome === o).length;
  const forklaring = h('p', { class: 'omdomen' }, [...K.OMDOMEN, null].map((o) => {
    const n = o ? antal(o) : kat.mekaniker.filter((k) => !k.omdome).length;
    if (!n) return null;
    return h('span', { class: `omdome ${K.klassFor(o)}`, title: o ? kat.betydelse[o] || '' : 'Omdömet börjar inte med något av de fem orden.' }, h('i', { 'aria-hidden': 'true' }), `${o || 'Inget omdöme'} ${n}`);
  }));
  const rita = () => {
    const traffar = K.sok(kat, sok.value);
    const grupper = new Map();
    for (const k of traffar) {
      if (!grupper.has(k.grupp)) grupper.set(k.grupp, []);
      grupper.get(k.grupp).push(k);
    }
    ut.replaceChildren(...[...grupper].map(([g, ks]) => h('section', { class: 'grupp' }, h('h2', null, g || 'Övrigt'),
      ks.map((k) => {
        const d = h('details', { class: 'mekanik-post', id: `mek-${k.id}` },
          h('summary', null, h('span', { class: 'mek-namn' }, k.namn), omdomeMarke(k), k.du ? h('span', { class: 'mek-du' }, `Du ${k.du}`) : null),
          mekanikDetaljer(k, { anvands: anvandsI(V, k) }));
        return d;
      }))));
    if (!traffar.length) ut.replaceChildren(h('p', { class: 'dov' }, 'Ingen mekanik passar sökningen.'));
    if (r.mek) oppnaMekanik(r.mek);
  };
  sok.addEventListener('input', rita);
  fyll(underflikar(r),
    h('p', { class: 'kalla' }, 'Allt vandraren kan göra och telefonen kan läsa, ur katalogen. Listan läses ur filen varje gång; ändra den under Redigera texten.'),
    sok, forklaring, ut);
  rita();
  // Where each mechanic is used: read the episodes, then draw again.
  hamtaAnvandning(kat).then((a) => {
    if (S.vy !== V) return;
    V.anvands = a;
    for (const k of kat.mekaniker) {
      const plats = document.getElementById(`anv-${k.id}`);
      if (plats) plats.replaceWith(anvandsI(V, k));
    }
  });
}

function oppnaMekanik(id) {
  const d = document.getElementById(`mek-${id}`);
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ block: 'start', behavior: lugn() ? 'auto' : 'smooth' });
  d.querySelector('summary').focus({ preventScroll: true });
}

async function hamtaAnvandning(kat) {
  const ut = new Map();
  for (const nr of EPISODER) {
    let d;
    try {
      d = await S.lager.lasDokument(nr);
    } catch {
      d = null;
    }
    if (!d) continue;
    const scener = D.scenerFor(d.paras, D.SLAG_EPISOD);
    const titlar = new Map();
    d.paras.forEach((p, k) => {
      if (p.typ === 'scen' && scener[k]) titlar.set(scener[k], p.text);
      if (p.typ !== 'mekanik' || !scener[k]) return;
      for (const x of K.hittaNamn(p.text, kat)) {
        if (!ut.has(x.mekanik.id)) ut.set(x.mekanik.id, []);
        const lista = ut.get(x.mekanik.id);
        if (!lista.some((y) => y.nr === nr && y.scen === scener[k])) lista.push({ nr, scen: scener[k], titel: titlar.get(scener[k]) || scener[k], stycke: p.id });
      }
    });
  }
  return ut;
}

function anvandsI(V, k) {
  const plats = h('div', { class: 'anvands', id: `anv-${k.id}` });
  if (!V.anvands) {
    plats.append(h('p', { class: 'dov' }, 'Letar i episoderna …'));
    return plats;
  }
  const lista = V.anvands.get(k.id) || [];
  plats.append(h('h3', null, 'Används i'),
    lista.length ? h('ul', null, lista.map((x) => h('li', null, h('a', { href: `#episod-${x.nr}/s/${x.stycke}` }, `Episod ${x.nr}, scen ${x.titel}`))))
      : h('p', { class: 'dov' }, 'Ingen scen nämner den än.'));
  return plats;
}

// --- Who is here, and their own settings ----------------------------------------------------------

function ritaJag() {
  const jag = $('jag');
  if (!S.jag) {
    jag.hidden = true;
    return;
  }
  jag.hidden = false;
  jag.textContent = S.jag.namn[0];
  jag.className = `jag ${S.jag.id === 'liv' ? 'l' : S.jag.id === 'demi' ? 'd' : 'h'}`;
  jag.title = `Du är ${S.jag.namn}`;
}

$('jag').addEventListener('click', () => {
  const b = $('jag');
  const brytare = (nyckel, text, pa) => h('label', { class: 'brytare' },
    h('input', { type: 'checkbox', role: 'switch', checked: pa, onchange: (e) => sattInst(nyckel, e.target.checked) }), h('span', { class: 'spar', 'aria-hidden': 'true' }), text);
  oppnaPanel(`Du är ${S.jag.namn}`,
    h('p', { class: 'hjalp' }, 'Inställningarna gäller bara dig.'),
    brytare('visaVem', 'Visa vem som skrev, med en prick i marginalen', S.inst.visaVem),
    arAI(S.jag.id) ? null : brytare('doljDemi', 'Visa Demis kommentarer och förslag', !S.inst.doljDemi),
    h('p', { class: 'hjalp' }, 'Prickarna: ', h('span', { class: 'vem-namn' }, prick('henric'), 'Henric'), ' ', h('span', { class: 'vem-namn' }, prick('liv'), 'Liv'), ' ', h('span', { class: 'vem-namn' }, prick('demi'), 'Demi, en AI')),
    S.adapter.rot === 'prov' ? h('p', { class: 'hjalp' }, 'Du är i provläget. Allt här är kopior.') : null);
  b.setAttribute('aria-expanded', 'true');
});

async function sattInst(nyckel, pa) {
  const varde = nyckel === 'doljDemi' ? !pa : pa;
  const fore = S.inst;
  S.inst = { ...S.inst, [nyckel]: varde };
  ritaOmAllt();
  try {
    S.inst = await S.lager.sattInstallning(nyckel, varde);
  } catch (e) {
    S.inst = fore;
    status(`Inställningen sparades inte. ${felText(e)}`, 'fel');
    ritaOmAllt();
  }
}

function ritaOmAllt() {
  S.ver += 1;
  const V = S.vy;
  if (V && V.red) {
    V.karta = null;
    V.red.ritaOm();
    ritaNotis(V);
  } else if (S.rutt && S.rutt.vy === 'sidor') visaSidor(S.rutt);
}

function ritaRam() {
  ritaJag();
  const band = $('band');
  band.replaceChildren();
  if (S.adapter.rot === 'prov') {
    band.append(h('div', { class: 'band prov' }, 'Provläge: det här är kopior i en sandlåda, inte manuset. Allt som sparas hamnar i kopiorna.'));
  }
  if (!kanSkriva()) {
    band.append(h('div', { class: 'band' }, 'Här går det att läsa och lyssna. Att skriva går bara i portalen.'));
  }
}

function visaInloggning() {
  fyll(h('section', { class: 'smal' },
    h('h2', null, 'Logga in först'),
    h('p', null, 'Manusrummet läser och sparar genom portalen, och portalen känner inte igen dig just nu.'),
    h('p', null, h('a', { class: 'knapp huvud', href: '/' }, 'Öppna portalen')),
    h('p', { class: 'dov' }, 'Logga in där och kom sedan tillbaka hit.')));
}

// --- Reading what others did, and saving on the way out ---------------------------------------

let tick = 0;
async function lyssna() {
  tick += 1;
  const V = S.vy;
  if (document.visibilityState !== 'visible' || !V || !V.dokument || !kanSkriva()) return;
  if (tick % 8 === 0) V.dokument.lever();
  try {
    if (tick % 15 === 0 && V.red && V.arEpisod) {
      const kat = await S.lager.katalog();
      if (S.vy === V && JSON.stringify(kat.mekaniker.map((k) => [k.namn, k.omdome])) !== JSON.stringify((S.katalog ? S.katalog.mekaniker : []).map((k) => [k.namn, k.omdome]))) {
        S.katalog = kat;
        V.red.ritaOm({ katalog: kat });
      }
    }
    const andrat = await V.dokument.hamta();
    if (andrat && S.vy === V) dokumentRitat(V);
  } catch {
    // The next tick tries again; the save state says if something is wrong.
  }
}

function sparaNu() {
  const V = S.vy;
  if (!V || !V.dokument) return;
  if (V.flush) V.flush();
  V.dokument.minns();
  if (V.dokument.harOsparat()) V.dokument.spara().catch(() => {});
}

// --- Start -------------------------------------------------------------------------------------------

const lasTider = () => fetch(new URL('./ljudtider.json', import.meta.url)).then((r) => (r.ok ? r.json() : null));

function flikId() {
  try {
    let f = sessionStorage.getItem('glimt-rummet|flik');
    if (!f) {
      f = D.nyttId();
      sessionStorage.setItem('glimt-rummet|flik', f);
    }
    return f;
  } catch {
    return D.nyttId();
  }
}

async function start() {
  const sida = location.href;
  let adapter;
  if (location.pathname.includes('/uploads/')) {
    adapter = portalAdapter({ rot: new URL(sida).searchParams.get('rot') === 'prov' ? 'prov' : 'skarp' });
    if (!(await adapter.finns())) {
      visaInloggning();
      return;
    }
  } else {
    adapter = await valjAdapter({ sida });
  }
  S.adapter = adapter;
  let lagring = null;
  try {
    lagring = window.localStorage;
  } catch {
    lagring = null;
  }
  S.lager = skapaLager(adapter, {
    lasTider,
    lagring,
    flik: flikId(),
    klocka: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) },
  });
  S.jag = await S.lager.vem();
  try {
    S.inst = await S.lager.lasInstallningar();
  } catch {
    S.inst = { doljDemi: !!(S.jag && PERSONER[S.jag.id] && PERSONER[S.jag.id].doljDemi), visaVem: true, besok: {} };
  }
  ritaRam();
  window.addEventListener('hashchange', () => { visa(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sparaNu();
    else lyssna();
  });
  window.addEventListener('pagehide', sparaNu);
  window.addEventListener('beforeunload', (e) => {
    sparaNu();
    const V = S.vy;
    if (V && V.dokument && V.dokument.lage === 'sparar') e.preventDefault();
  });
  setInterval(lyssna, 4000);
  await visa();
}

start().catch((e) => {
  fyll(h('div', { class: 'band varning' }, felText(e)));
});
