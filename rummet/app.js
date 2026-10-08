// Manusrummet: the page. Everything it shows is built from elements and text
// nodes, so a person's words never pass through innerHTML. Saving goes through
// lager.js, which reads the file fresh and finds its line again before it
// changes anything. Nothing here writes text a person did not type or press.

import { portalAdapter, valjAdapter, EPISODER, PERSONER } from './data.js';
import { skapaLager } from './lager.js';
import { ankareFor, hitta, tecken, kroppDelar, byggKropp, provaKropp } from './manus.js';
import { ljudFor, stycketid } from './ljud.js';
import { vy, GALLER, loreText, arAI } from './rum.js';
import { renderMd, renderText, inline } from './md.js';

const $ = (id) => document.getElementById(id);
const main = $('rum');

const S = {
  adapter: null,
  lager: null,
  jag: null,
  rutt: null,
  ep: null, // lager.lasEpisod()
  v: null, // rum.vy() for ep
  oppen: null, // { i, ankare } an open line, { scen } an open scene, { nyI } after a save
  form: null, // { typ, ... } the form inside what is open
  upptagen: false,
  lore: null,
  utkast: new Set(),
  inst: { doljDemi: false }, // this person's own settings (lager.lasInstallningar)
};

// --- Small helpers ----------------------------------------------------------------

function h(tag, props, ...barn) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
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

let faltNr = 0;
const nyttFaltId = () => `falt-${++faltNr}`;

const MANADER = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
function datum(nar) {
  if (!nar) return '';
  const d = new Date(nar);
  if (Number.isNaN(d.getTime())) return '';
  const ar = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MANADER[d.getMonth()]}${ar} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}
const tid = (nar) => (nar ? ` ${datum(nar)}` : '');
const namn = (id) => (id && PERSONER[id] ? PERSONER[id].namn : id || 'okänd');
const gen = (n) => (/[sxz]$/i.test(n) ? n : `${n}s`);
const storBokstav = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function lista(ord) {
  if (ord.length < 2) return ord.join('');
  return `${ord.slice(0, -1).join(', ')} och ${ord[ord.length - 1]}`;
}

const kanSkriva = () => !!(S.adapter && S.adapter.kanSkriva);
const kan = () => kanSkriva() && !(S.ep && S.ep.rumFel);

// Demi is an AI. Its posts are marked everywhere, and each person can hide
// them for themselves.
const dold = (vem) => !!(S.inst.doljDemi && arAI(vem));
const synliga = (lista) => lista.filter((x) => !dold(x.skrev));
const mitt = (post) => !!(S.jag && post.skrev === S.jag.id);
function avsandare(vem) {
  return h('span', { class: `av${arAI(vem) ? ' ai' : ''}` }, namn(vem),
    arAI(vem) ? h('span', { class: 'ai-markor', title: `${namn(vem)} är en AI, inte en människa.` }, 'AI') : null);
}
const namnText = (vem) => (arAI(vem) ? `${namn(vem)} (AI)` : namn(vem));

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
}

// --- Status line --------------------------------------------------------------------

let statusTimer = null;
function status(text, typ = 'info', { kvar = false } = {}) {
  const el = $('status');
  clearTimeout(statusTimer);
  el.className = `status ${typ}`;
  el.replaceChildren(h('span', null, text));
  if (typ === 'fel') el.append(h('button', { type: 'button', onclick: () => { el.hidden = true; } }, 'Stäng'));
  el.hidden = false;
  if (!kvar) statusTimer = setTimeout(() => { el.hidden = true; }, typ === 'fel' ? 8000 : 2600);
}

function felText(e) {
  if (!e) return 'Något gick fel.';
  if (e.name === 'TypeError') return 'Portalen svarar inte just nu. Texten finns kvar här; försök igen om en stund.';
  if (e.kod === 'hittas-inte') {
    return 'Repliken står inte längre så i manuset: någon har ändrat den medan du skrev. Din text finns kvar här.';
  }
  return e.message || 'Något gick fel.';
}

// --- Text you have typed but not saved -------------------------------------------------
// Kept in the browser until it is saved or thrown away, so a reload, a lost
// connection or a line someone else changed never takes the words with it.

const UTKAST = 'glimt-rummet';
const utkastPrefix = (del) => `${UTKAST}|${S.adapter.rot || S.adapter.namn}|${del}|`;
const utkastNyckel = (del, typ, mal) => `${utkastPrefix(del)}${typ}|${mal}`;
function lasUtkast(k) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function skrivUtkast(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify({ ...v, sparat: new Date().toISOString() }));
    S.utkast.add(k);
  } catch {
    // Storage full or blocked: the form still holds the text.
  }
}
function slangUtkast(k) {
  try {
    localStorage.removeItem(k);
  } catch {
    // nothing to do
  }
  S.utkast.delete(k);
}
function allaUtkast(prefix) {
  const ut = [];
  try {
    for (let n = 0; n < localStorage.length; n++) {
      const k = localStorage.key(n);
      if (k && k.startsWith(prefix)) ut.push(k);
    }
  } catch {
    // no storage
  }
  return ut;
}
const RADFORMER = ['andra', 'foresla', 'kommentera', 'ny'];
const TYPNAMN = {
  andra: 'Ändring', foresla: 'Förslag', kommentera: 'Kommentar', ny: 'Ny replik efter',
  'kommentera-scen': 'Kommentar', 'foresla-scen': 'Förslag', 'ny-forst': 'Ny replik',
};
// Keyed by scene, text and position only: the neighbours an anchor carries
// change when a nearby line is edited, and the draft must still be found.
const radNyckel = (typ, ankare) => utkastNyckel(`e${S.ep.nr}`, typ, JSON.stringify({ scen: ankare.scen, text: ankare.text, n: ankare.n }));
const harUtkast = (typ, ankare) => S.utkast.has(radNyckel(typ, ankare));

// --- Sound ------------------------------------------------------------------------------
// One player for the page. A line can be several paragraphs, sometimes in
// different clips; they play one after the other, each from where it starts
// in its clip to where the next paragraph starts.

const ljud = new Audio();
ljud.preload = 'none';
let spelar = null;

function spela(i, delar, knapp) {
  const samma = spelar && spelar.i === i;
  stoppa();
  if (samma) return;
  spelar = { i, delar, k: 0, knapp, till: null, byter: false, slutad: -1 };
  knapp.classList.add('spelar');
  knapp.setAttribute('aria-label', 'Stoppa');
  nastaDel();
}

function nastaDel() {
  const s = spelar;
  if (!s) return;
  if (s.k >= s.delar.length) { stoppa(); return; }
  const del = s.delar[s.k++];
  const t = stycketid(S.ep.ljud, del) || { fran: 0, till: null };
  s.fran = t.fran;
  s.till = t.till;
  s.byter = true;
  const fragment = `#t=${t.fran.toFixed(2)}${t.till != null ? `,${t.till.toFixed(2)}` : ''}`;
  ljud.src = S.adapter.ljudUrl(S.ep.ljud.id, del.id) + fragment;
  ljud.play().then(() => {
    if (spelar === s) s.byter = false;
  }).catch((e) => {
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
// The #t= hint is enough where the server lets the browser jump; elsewhere
// the start is set by hand once the clip plays.
ljud.addEventListener('playing', () => {
  const s = spelar;
  if (s && s.fran && ljud.currentTime < s.fran - 0.25) ljud.currentTime = s.fran;
});
ljud.addEventListener('timeupdate', () => {
  const s = spelar;
  if (s && !s.byter && s.till != null && ljud.currentTime >= s.till) {
    ljud.pause();
    delSlut();
  }
});
// The media fragment's end pauses the clip by itself.
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

// --- Saving -----------------------------------------------------------------------------
// One save at a time. On success the episode is read again, so what shows is
// what the file says. On failure the form stays open with the text in it.

async function gora(fn, { fel = null, nyckel = null, efter = null, vidFel = null, klart = null } = {}) {
  if (S.upptagen) return undefined;
  S.upptagen = true;
  document.body.classList.add('upptagen');
  status('Sparar …', 'info', { kvar: true });
  let ut;
  try {
    ut = await fn();
  } catch (e) {
    S.upptagen = false;
    document.body.classList.remove('upptagen');
    if (e && e.kod === 'halvt') {
      // The manuscript has the text; only the note about it is missing.
      if (nyckel) slangUtkast(nyckel);
      S.form = null;
      if (efter) efter(undefined);
      status('Texten är sparad i manuset, men anteckningen om vem som skrev den kom inte fram.', 'fel', { kvar: true });
      await laddaOm();
      return undefined;
    }
    const text = felText(e);
    if (fel) {
      fel.replaceChildren(h('p', null, text));
      const extra = vidFel ? vidFel(e) : null;
      if (extra) fel.append(extra);
      status('Det gick inte att spara.', 'fel');
    } else {
      status(text, 'fel', { kvar: true });
    }
    return undefined;
  }
  if (nyckel) slangUtkast(nyckel);
  S.form = null;
  if (efter) efter(ut);
  S.upptagen = false;
  document.body.classList.remove('upptagen');
  status((klart && klart(ut)) || (ut && ut.reserv
    ? 'Sparat. Repliken lades sist i scenen, för raden den stod bredvid finns inte kvar.'
    : 'Sparat.'), 'ok');
  await laddaOm();
  return ut;
}

async function laddaOm() {
  if (!S.rutt) return;
  if (S.rutt.vy === 'episod') await laddaEpisod({ behallPlats: true });
  else await visaVarlden(S.rutt, { tyst: true });
}

// --- Routing ------------------------------------------------------------------------------

function lasRutt() {
  let hash;
  try {
    hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  } catch {
    hash = '';
  }
  let m = /^episod-(\d+)$/.exec(hash);
  if (m && EPISODER.includes(m[1])) return { vy: 'episod', nr: m[1] };
  if (hash === 'varlden') return { vy: 'varlden', flik: 'varld' };
  m = /^varlden\/(held|sidor|ny)$/.exec(hash);
  if (m) return { vy: 'varlden', flik: m[1] };
  m = /^varlden\/sida\/([A-Za-z0-9-]+)$/.exec(hash);
  if (m) return { vy: 'varlden', flik: 'sida', id: m[1] };
  return { vy: 'episod', nr: EPISODER[0] };
}
const sammaRutt = (a, b) => !!a && !!b && a.vy === b.vy && a.nr === b.nr && a.flik === b.flik && a.id === b.id;

function markeraFlik(r) {
  const aktiv = r.vy === 'episod' ? `episod-${r.nr}` : 'varlden';
  for (const a of document.querySelectorAll('nav.flikar a[data-flik]')) {
    if (a.dataset.flik === aktiv) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function visa() {
  const r = lasRutt();
  if (sammaRutt(r, S.rutt)) return;
  const forra = S.rutt;
  S.rutt = r;
  markeraFlik(r);
  stoppa();
  S.oppen = null;
  S.form = null;
  if (forra && (forra.vy !== r.vy || forra.nr !== r.nr)) window.scrollTo(0, 0);
  if (r.vy === 'episod') {
    main.replaceChildren(h('p', { class: 'laddar' }, 'Läser manuset …'));
    S.ep = null;
    await laddaEpisod();
  } else {
    await visaVarlden(r);
  }
}

// --- An episode --------------------------------------------------------------------------

async function laddaEpisod({ behallPlats = false } = {}) {
  const rutt = S.rutt;
  const y = window.scrollY;
  let ep;
  try {
    ep = await S.lager.lasEpisod(rutt.nr);
  } catch (e) {
    if (behallPlats && S.ep) status(felText(e), 'fel', { kvar: true });
    else visaLaddfel(e);
    return;
  }
  if (S.rutt !== rutt) return;
  stoppa();
  S.ep = ep;
  S.v = vy(ep.manus, ep.rum, ep.grund);
  S.utkast = new Set(allaUtkast(utkastPrefix(`e${ep.nr}`)));
  // Keep the open line open, found again in the text just read.
  if (S.oppen && S.oppen.nyI != null) {
    const r = ep.manus.rader[S.oppen.nyI];
    S.oppen = r && r.typ === 'replik' && r.scen != null ? { i: r.i, ankare: ankareFor(ep.manus, r.i) } : null;
  } else if (S.oppen && S.oppen.ankare) {
    const i = hitta(ep.manus, S.oppen.ankare, { strikt: true });
    S.oppen = i >= 0 ? { i, ankare: S.oppen.ankare } : null;
  } else if (S.oppen && S.oppen.scen != null && !ep.manus.scener.some((s) => s.nr === S.oppen.scen)) {
    S.oppen = null;
  }
  if (!S.oppen) S.form = null;
  ritaEpisod();
  if (behallPlats) {
    window.scrollTo(0, y);
    const text = S.oppen && S.oppen.i != null ? document.querySelector(`#rad-${S.oppen.i} .radtext`) : null;
    if (text) text.focus({ preventScroll: true });
  }
}

function visaLaddfel(e) {
  main.replaceChildren(h('div', { class: 'band varning' },
    h('p', null, felText(e)),
    h('div', { class: 'knappar' }, h('button', { class: 'knapp', type: 'button', onclick: () => { S.rutt = null; visa(); } }, 'Försök igen'))));
}

// Counts what has been drawn, so a test can wait for the page instead of the clock.
let ritningar = 0;
const ritad = () => { main.dataset.ritad = String(++ritningar); };

function ritaEpisod() {
  const m = S.ep.manus;
  ritad();
  main.replaceChildren(...[
    episodHuvud(),
    ...m.scener.map(ritaScen),
    m.bilagor ? h('details', { class: 'om bilagor' },
      h('summary', null, 'Bilagor till episoden'),
      h('article', { class: 'md' }, renderMd(m.bilagor))) : null,
  ].filter(Boolean));
}

function marke(skrev, { dold = false } = {}) {
  if (!skrev) return null;
  const etikett = dold ? null : vemText(skrev);
  const props = (klass) => ({ class: `marke ${klass}`, role: dold ? null : 'img', 'aria-label': etikett, title: etikett, 'aria-hidden': dold ? 'true' : null });
  if (skrev.vem && PERSONER[skrev.vem]) return h('span', props(skrev.vem), PERSONER[skrev.vem].namn[0]);
  if (skrev.hur === 'utanfor') return h('span', props('utanfor'), '?');
  return h('span', props('okant'), '·');
}

function vemText(s) {
  const n = s.vem ? namn(s.vem) : null;
  switch (s.hur) {
    case 'utkast': return 'Demis utkast.';
    case 'andrade': return `${n} skrev om den${tid(s.nar)}.`;
    case 'skrev': return `${n} skrev den${tid(s.nar)}.`;
    case 'forslag': return `${gen(n)} förslag, inlagt i manus av ${namn(s.av)}${tid(s.satt)}.`;
    case 'tillbaka': return n
      ? `${gen(n)} text, tagen tillbaka av ${namn(s.av)}${tid(s.satt)}.`
      : `Tidigare text, tagen tillbaka av ${namn(s.av)}${tid(s.satt)}.`;
    case 'namn': return `Märkt som ${gen(n)} ord av ${namn(s.av)}${tid(s.satt)}.`;
    case 'utanfor': return 'Ändrad utanför rummet.';
    default: return 'Vem som skrev den går inte att säga här.';
  }
}

function episodHuvud() {
  const { ep } = S;
  const m = ep.manus;
  const f = document.createDocumentFragment();
  f.append(
    h('h2', null, `Episod ${ep.nr}`),
    h('p', { class: 'ep-titel' }, m.titel),
  );
  if (ep.rumFel) {
    f.append(h('div', { class: 'band varning' }, h('strong', null, 'Inget kan sparas just nu. '), ep.rumFel.message,
      ' Manuset går att läsa och lyssna på som vanligt.'));
  }
  if (kanSkriva() && S.lager.vantar.length) {
    const visade = S.lager.vantar.map((a) => a.aid);
    f.append(h('div', { class: 'band varning' },
      h('p', null, h('strong', null, 'Halvt sparat. '), 'Texten står i manuset, men anteckningen om vem som skrev den kom inte fram. Tills den gör det visas raden som ändrad utanför rummet.'),
      h('p', { class: 'dov liten' }, 'Slänger du anteckningen står texten kvar i manuset, och du kan säga vems den är.'),
      h('div', { class: 'knappar' },
        h('button', { class: 'knapp liten', type: 'button', onclick: () => gora(() => S.lager.forsokIgen()) }, 'Försök igen'),
        h('button', { class: 'knapp liten', type: 'button', onclick: () => { S.lager.slangVantande(visade); ritaEpisod(); } }, 'Släng anteckningen'))));
  }
  if (kanSkriva() && !ep.grund && !ep.rumFel) {
    f.append(h('div', { class: 'band' }, 'Listan över Demis utkast går inte att läsa, så rummet säger inte vem som skrev de rader som inte ändrats här.'));
  }
  if (kanSkriva()) {
    const forlorat = osparat();
    if (forlorat) f.append(forlorat);
  }
  if (kanSkriva()) {
    f.append(h('div', { class: 'nyckel' },
      h('span', null, marke({ vem: 'demi', hur: 'utkast' }, { dold: true }), 'Demis utkast'),
      h('span', null, marke({ vem: 'henric', hur: 'skrev' }, { dold: true }), 'Henric'),
      h('span', null, marke({ vem: 'liv', hur: 'skrev' }, { dold: true }), 'Liv'),
      h('span', null, marke({ vem: null, hur: 'utanfor' }, { dold: true }), 'ändrad utanför rummet'),
      S.inst.doljDemi ? null : h('span', null, h('span', { class: 'ai-markor', 'aria-hidden': 'true' }, 'AI'), 'Demis kommentarer och förslag')));
    if (S.inst.doljDemi) {
      const antal = ep.rum.kommentarer.filter((k) => arAI(k.skrev) && !k.borta).length
        + ep.rum.forslag.filter((f) => arAI(f.skrev) && f.lage === 'oppet').length;
      if (antal) f.append(h('p', { class: 'dov liten smal' }, `Demis inlägg är dolda för dig: ${antal === 1 ? 'ett' : antal} i den här episoden.`));
    }
  }
  if (!ep.ljud) {
    f.append(h('p', { class: 'dov liten smal' }, `Episod ${ep.nr} är inte inspelad än.`));
  } else {
    let ej = 0;
    for (const r of m.rader) if (r.typ === 'replik' && r.scen != null && ljudFor(r.kropp, ep.ljud).lage === 'ej') ej++;
    f.append(h('p', { class: 'dov liten smal' }, ej
      ? `Tryck på ringen före en replik för att höra den. ${ej === 1 ? 'En replik har' : `${ej} repliker har`} ändrats sedan inspelningen och är inte inspelade än.`
      : 'Tryck på ringen före en replik för att höra den.'));
  }
  if (m.anteckningar) {
    f.append(h('details', { class: 'om' }, h('summary', null, 'Om episoden: logiken, rösterna och varianterna'),
      h('article', { class: 'md' }, renderMd(m.anteckningar))));
  }
  f.append(h('ul', { class: 'scenlista', 'aria-label': 'Hoppa till scen' }, m.scener.map((s) => h('li', null,
    h('button', {
      type: 'button', title: s.titel, 'aria-label': `Scen ${s.nr}, ${s.titel}`,
      onclick: () => { const el = $(`scen-${s.nr}`); if (el) el.scrollIntoView({ block: 'start' }); },
    }, s.nr)))));
  return f;
}

// Drafts whose line no longer stands as it did: shown at the top so the words
// are never lost, even when there is nowhere left to save them.
function osparat() {
  const { ep } = S;
  const prefix = utkastPrefix(`e${ep.nr}`);
  const kvar = [];
  for (const k of S.utkast) {
    if (!k.startsWith(prefix)) continue;
    const delar = k.slice(prefix.length).split('|');
    const typ = delar[0];
    const mal = delar.slice(1).join('|');
    if (mal.startsWith('scen-')) {
      if (!ep.manus.scener.some((s) => `scen-${s.nr}` === mal)) kvar.push({ k, typ, ankare: null });
      continue;
    }
    if (mal.startsWith('svar-')) {
      // A reply whose thread is gone keeps its words here too.
      const rotId = mal.slice(5);
      const finns = [...ep.rum.kommentarer, ...ep.rum.forslag].some((x) => x.id === rotId && !x.borta);
      if (!finns) kvar.push({ k, typ, ankare: null, svar: true });
      continue;
    }
    let ankare;
    try {
      ankare = JSON.parse(mal);
    } catch {
      continue;
    }
    if (hitta(ep.manus, ankare, { strikt: true }) < 0) kvar.push({ k, typ, ankare });
  }
  if (!kvar.length) return null;
  return h('div', { class: 'band varning osparat' },
    h('p', null, h('strong', null, 'Text som inte blev sparad. '),
      'Repliken den gällde står inte längre likadant i manuset, så texten ligger kvar här i webbläsaren tills du slänger den.'),
    kvar.map(({ k, typ, ankare, svar }) => {
      const v = lasUtkast(k) || {};
      const text = v.text != null ? v.text : byggKropp({ slag: v.slag || 'vega', ord: v.ord || '', vem: v.vem || '' });
      const falt = h('textarea', { class: 'falt', readonly: true, rows: '2', value: text, 'aria-label': 'Osparad text' });
      const kort = h('div', { class: 'kort' },
        h('p', { class: 'galde' }, svar ? 'Svar i en tråd som inte finns kvar' : [`${TYPNAMN[typ] || 'Text'} till `, ankare ? h('q', null, ankare.text) : 'en scen som inte finns kvar']),
        falt,
        h('div', { class: 'knappar' },
          h('button', {
            class: 'knapp liten', type: 'button',
            onclick: () => {
              falt.select();
              if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => status('Kopierad.', 'ok'), () => {});
            },
          }, 'Kopiera'),
          h('button', { class: 'knapp liten', type: 'button', onclick: () => { slangUtkast(k); kort.remove(); } }, 'Släng')));
      return kort;
    }));
}

function ritaScen(s) {
  const sek = h('section', { class: 'scen', id: `scen-${s.nr}`, 'aria-labelledby': `scenrubrik-${s.nr}` },
    h('h3', { class: 'scen-rubrik', id: `scenrubrik-${s.nr}` }, h('span', { class: 'nr', 'aria-hidden': 'true' }, s.nr), h('span', null, s.titel)));
  for (const d of s.delar) {
    if (d.typ === 'citat') sek.append(ritaBlock(d.rader));
    else if (d.typ === 'trigger') sek.append(h('p', { class: 'trigger' }, h('b', null, 'När'), inline(storBokstav(d.rad.text))));
    else if (d.typ === 'not') sek.append(h('p', { class: 'not' }, inline(d.rad.text)));
    else if (d.typ === 'blockrubrik') sek.append(h('p', { class: 'gren-rubrik' }, inline(d.rad.text)));
    else sek.append(h('p', { class: 'stycke-text' }, inline(d.rad.text || d.rad.ra)));
  }
  sek.append(ritaFot(s));
  return sek;
}

function ritaBlock(rader) {
  const block = h('div', { class: 'manus' });
  let stycke = h('div', { class: 'stycket' });
  for (const r of rader) {
    if (r.typ === 'q-tom') {
      if (stycke.childNodes.length) { block.append(stycke); stycke = h('div', { class: 'stycket' }); }
      continue;
    }
    if (r.typ === 'gren') stycke.append(h('p', { class: 'gren' }, r.rubrik));
    else if (r.typ === 'gren2') stycke.append(h('p', { class: 'gren gren2' }, r.rubrik));
    else if (r.typ === 'q-not') stycke.append(h('p', { class: 'q-not' }, inline(r.text)));
    else if (r.typ === 'replik') stycke.append(ritaRad(r));
  }
  if (stycke.childNodes.length) block.append(stycke);
  return block;
}

// The words of a line: Vega's warm, direction small, other voices pale.
function radText(kropp) {
  const f = document.createDocumentFragment();
  for (const t of tecken(String(kropp || ''))) {
    if (t.typ === 'regi') {
      f.append(h('span', { class: 'regi' }, (t.delar || []).map((d) => (d.typ === 'annan' ? h('span', { class: 'annan' }, d.text) : d.text))));
    } else if (t.typ === 'annan') {
      f.append(h('span', { class: 'annan' }, t.text));
    } else {
      f.append(t.text);
    }
  }
  return f;
}

const markerar = () => {
  const s = window.getSelection ? window.getSelection() : null;
  return !!(s && !s.isCollapsed && String(s).trim());
};

function ritaRad(r) {
  const info = S.v.rader.get(r.i) || { forslag: [], kommentarer: [] };
  const oppen = !!(S.oppen && S.oppen.i === r.i);
  const ankare = ankareFor(S.ep.manus, r.i);
  const lj = S.ep.ljud ? ljudFor(r.kropp, S.ep.ljud) : null;
  const spel = h('div', { class: 'spel' });
  if (lj && lj.lage === 'inspelad') spel.append(spelKnapp(r, lj));

  const om = [];
  if (lj && lj.lage === 'ej') om.push(h('span', { class: 'ej' }, 'inte inspelad än'));
  if (kanSkriva() && info.skrev && info.skrev.hur === 'utanfor') om.push(h('span', { class: 'utanfor' }, 'ändrad utanför rummet'));
  if (kanSkriva() && RADFORMER.some((t) => harUtkast(t, ankare))) om.push(h('span', { class: 'osparad' }, 'osparad text'));
  const innehall = [
    r.etikett ? h('span', { class: 'etikett' }, r.etikett) : null,
    r.variant ? h('span', { class: 'var' }, r.variant) : null,
    radText(r.kropp),
    om.length ? h('span', { class: 'radinfo' }, om) : null,
  ];
  const text = kanSkriva()
    ? h('div', {
      class: 'radtext', role: 'button', tabindex: '0', 'aria-expanded': String(oppen),
      onclick: () => { if (!markerar()) vaxlaRad(r.i); },
      onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); vaxlaRad(r.i); } },
    }, innehall)
    : h('div', { class: 'radtext' }, innehall);

  const sida = h('div', { class: 'sida' });
  for (const f of synliga(info.forslag)) if (visaForslag(f)) sida.append(forslagKort(f, { rad: r }));
  sida.append(...kommentarer(synliga(info.kommentarer), { rad: r }));
  if (oppen) sida.append(verktyg(r, info, ankare));

  return h('div', { class: `rad${oppen ? ' oppen' : ''}`, id: `rad-${r.i}` },
    spel, text, h('div', { class: 'vem' }, kanSkriva() ? marke(info.skrev) : null), sida);
}

function spelKnapp(r, lj) {
  const igang = !!(spelar && spelar.i === r.i);
  const b = h('button', { class: `spela${igang ? ' spelar' : ''}`, type: 'button', 'aria-label': igang ? 'Stoppa' : 'Lyssna' });
  b.addEventListener('click', () => spela(r.i, lj.delar, b));
  if (igang) spelar.knapp = b;
  return b;
}

// --- Opening a line or a scene -------------------------------------------------------------

const samma = (a, b) => !!a && !!b && (a.i != null ? a.i === b.i : (b.i == null && a.scen === b.scen));

function ritaOm(o) {
  if (!o || !S.ep) return;
  if (o.i != null) {
    const gammal = $(`rad-${o.i}`);
    const r = S.ep.manus.rader[o.i];
    if (gammal && r) gammal.replaceWith(ritaRad(r));
  } else if (o.scen != null) {
    const gammal = $(`fot-${o.scen}`);
    const s = S.ep.manus.scener.find((x) => x.nr === o.scen);
    if (gammal && s) gammal.replaceWith(ritaFot(s));
  }
}

function oppna(o, form = null) {
  const forra = S.oppen;
  S.oppen = o;
  S.form = form;
  if (forra && !samma(forra, o)) ritaOm(forra);
  if (o) ritaOm(o);
  if (form) fokusera();
}

function vaxlaRad(i) {
  if (S.upptagen) return;
  if (S.oppen && S.oppen.i === i) oppna(null);
  else oppna({ i, ankare: ankareFor(S.ep.manus, i) });
}

function sattForm(form) {
  S.form = form;
  ritaOm(S.oppen);
  fokusera();
}

function stangForm() {
  S.form = null;
  ritaOm(S.oppen);
  if (S.oppen && S.oppen.i != null) {
    const t = document.querySelector(`#rad-${S.oppen.i} .radtext`);
    if (t) t.focus({ preventScroll: true });
  }
}

function fokusera() {
  requestAnimationFrame(() => {
    const plats = S.oppen && (S.oppen.i != null ? $(`rad-${S.oppen.i}`) : $(`fot-${S.oppen.scen}`));
    if (!plats) return;
    for (const t of plats.querySelectorAll('textarea')) autosize(t);
    const falt = plats.querySelector('form textarea:not([readonly]), form input, .bekrafta .knapp');
    if (falt) {
      falt.focus({ preventScroll: true });
      falt.scrollIntoView({ block: 'nearest' });
      if (falt.tagName === 'TEXTAREA') falt.setSelectionRange(falt.value.length, falt.value.length);
    }
  });
}

const ctxOppen = (rad, scen) => (rad ? { i: rad.i, ankare: ankareFor(S.ep.manus, rad.i) } : { scen });

// --- The tools of an open line -------------------------------------------------------------

function verktyg(r, info, ankare) {
  const skrev = info.skrev || { hur: 'okant', tidigare: [] };
  const p = h('div', { class: 'verktyg' });
  p.append(h('p', { class: 'vemrad' }, vemText(skrev)));
  if (!kan()) return p;
  const radform = S.form && ['andra', 'foresla', 'kommentera', 'ny', 'stryk'].includes(S.form.typ);
  if (radform) {
    p.append(radForm(r, ankare));
    return p;
  }
  if (skrev.hur === 'utanfor') p.append(namnVal(ankare));
  if (skrev.tidigare && skrev.tidigare.length) p.append(tidigareLista(ankare, skrev.tidigare));
  const knapp = (text, typ) => h('button', { class: 'knapp liten', type: 'button', onclick: () => sattForm({ typ }) },
    harUtkast(typ, ankare) ? `${text} · osparat` : text);
  p.append(h('div', { class: 'knappar' },
    knapp('Ändra', 'andra'),
    knapp('Föreslå', 'foresla'),
    knapp('Kommentera', 'kommentera'),
    knapp('Ny replik efter', 'ny'),
    r.variant || r.etikett ? null : knapp('Stryk', 'stryk')));
  return p;
}

function namnVal(ankare) {
  return h('div', { class: 'bekrafta lugn' },
    h('p', null, 'Texten har ändrats utanför rummet. Vems ord är det?'),
    h('div', { class: 'knappar' }, Object.entries(PERSONER).map(([id, p]) => h('button', {
      class: 'knapp liten', type: 'button',
      onclick: () => gora(() => S.lager.sattNamn(S.ep.nr, ankare, id)),
    }, namnText(id)))));
}

function tidigareLista(ankare, tidigare) {
  return h('details', { class: 'tidigare' },
    h('summary', null, `Tidigare text (${tidigare.length})`),
    h('ol', null, [...tidigare].reverse().map((t) => h('li', null,
      h('p', { class: 'tidigare-text' }, radText(t.kropp)),
      h('p', { class: 'meta' }, t.skrev === 'demi' && !t.nar ? 'Demis utkast' : t.skrev ? `${namnText(t.skrev)}${tid(t.nar)}` : 'ändrad utanför rummet'),
      h('button', {
        class: 'knapp liten', type: 'button',
        onclick: () => gora(() => S.lager.taTillbakaText(S.ep.nr, ankare, t), { efter: (m) => { if (m) S.oppen = { nyI: m.i }; } }),
      }, 'Ta tillbaka den här')))));
}

function radForm(r, ankare) {
  const nr = S.ep.nr;
  const typ = S.form.typ;
  const nyckel = radNyckel(typ, ankare);
  if (typ === 'andra') {
    return ordForm({
      rubrik: 'Ändra repliken', start: r.kropp, rad: r, nyckel, knapp: 'Spara i manus', jamfor: true,
      spara: (k) => S.lager.andraRad(nr, ankare, k),
      efter: (m) => { if (m) S.oppen = { nyI: m.i }; },
      vidFel: (e, k) => (e.kod === 'hittas-inte' ? h('div', { class: 'knappar' },
        h('button', {
          class: 'knapp liten', type: 'button',
          onclick: (ev) => gora(() => S.lager.foresla(nr, ankare, k), { nyckel, fel: ev.currentTarget.closest('.fel') }),
        }, 'Lägg det som förslag i stället'),
        h('button', { class: 'knapp liten', type: 'button', onclick: () => laddaOm() }, 'Läs in manuset igen')) : null),
    });
  }
  if (typ === 'foresla') {
    return ordForm({
      rubrik: 'Föreslå en ny text. Den läggs bredvid repliken, och manuset ändras först när någon trycker Lägg in i manus.',
      start: r.kropp, rad: r, nyckel, knapp: 'Lägg förslaget',
      krav: (k) => (k === r.kropp ? 'Förslaget är samma som texten som står.' : true),
      spara: (k) => S.lager.foresla(nr, ankare, k),
    });
  }
  if (typ === 'ny') {
    return ordForm({
      rubrik: 'Ny replik, som ett eget stycke efter det här', start: '', rad: null, nyckel, knapp: 'Lägg till i manus',
      spara: (k) => S.lager.nyRad(nr, { efter: ankare }, k),
      efter: (m) => { if (m) S.oppen = { nyI: m.i }; },
    });
  }
  if (typ === 'kommentera') {
    return kommentarForm({
      rubrik: 'Kommentar till repliken', nyckel, knapp: 'Spara kommentaren', medTill: true,
      spara: (text, galler, till) => S.lager.kommentera(nr, ankare, text, galler, { till }),
    });
  }
  return bekrafta({
    text: 'Stryka repliken ur manuset? Den läggs under Struket sist i scenen och går att lägga tillbaka.',
    ja: 'Stryk', fara: true,
    gor: (fel) => gora(() => S.lager.strykRad(nr, ankare), { fel, efter: () => { S.oppen = null; } }),
  });
}

const SLAG = [['vega', 'Vega talar'], ['regi', 'Regi och ljud'], ['annan', 'En annan röst']];
const HJALP = {
  vega: 'Det Vega säger. Inom parentes blir det regi eller ljud, inom citattecken en annan röst.',
  regi: 'Hur något sägs, eller det som hörs runt henne. Rummet sätter parenteserna.',
  annan: 'Vems röst, och vad den säger. Rummet sätter parentesen och citattecknen.',
};

// A line's words. The room keeps the format (the "> ", a variant's tag, the
// parentheses of a direction); the person writes the words, and they are
// saved exactly as typed.
function ordForm({ rubrik, start, rad, nyckel, knapp, spara, efter = null, vidFel = null, krav = null, jamfor = false }) {
  const utkast = lasUtkast(nyckel);
  const d = utkast
    ? { slag: utkast.slag || 'vega', ord: utkast.ord || '', vem: utkast.vem || '' }
    : { vem: '', ...kroppDelar(start || '') };
  let slag = d.slag;
  const ordId = nyttFaltId();
  const vemId = nyttFaltId();
  const ordFalt = h('textarea', { class: 'falt manusfalt', id: ordId, rows: '2', value: d.ord, enterkeyhint: 'done', 'aria-describedby': `${ordId}-hjalp` });
  const vemFalt = h('input', { class: 'falt', id: vemId, type: 'text', value: d.vem || '', autocomplete: 'off', placeholder: 'till exempel lojalisten' });
  const vemRad = h('div', null, h('label', { class: 'etikett-falt', for: vemId }, 'Vems röst'), vemFalt);
  const ordEtikett = h('label', { class: 'etikett-falt', for: ordId });
  const hjalp = h('p', { class: 'hjalp', id: `${ordId}-hjalp` });
  const fel = h('div', { class: 'fel', role: 'alert' });
  const kropp = () => byggKropp({ slag, ord: ordFalt.value, vem: vemFalt.value });
  const minns = () => {
    if (!ordFalt.value && !vemFalt.value) slangUtkast(nyckel);
    else if (start && kropp() === start) slangUtkast(nyckel);
    else skrivUtkast(nyckel, { slag, ord: ordFalt.value, vem: vemFalt.value });
  };
  const val = SLAG.map(([s, t]) => h('button', {
    type: 'button',
    onclick: () => { slag = s; uppdatera(); minns(); ordFalt.focus(); },
  }, t));
  function uppdatera() {
    val.forEach((b, n) => b.setAttribute('aria-pressed', String(SLAG[n][0] === slag)));
    vemRad.hidden = slag !== 'annan';
    hjalp.textContent = HJALP[slag];
    ordEtikett.textContent = { vega: 'Det hon säger', regi: 'Regin', annan: 'Det rösten säger' }[slag];
    ordFalt.classList.toggle('regi', slag === 'regi');
  }
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'form-rubrik' }, rubrik),
    utkast ? h('p', { class: 'utkast-not' }, 'Här är texten du skrev förra gången men inte sparade.') : null,
    h('div', { class: 'val', role: 'group', 'aria-label': 'Vad raden är' }, val),
    vemRad,
    ordEtikett,
    ordFalt, hjalp, fel,
    h('div', { class: 'knappar' },
      h('button', { class: 'knapp huvud', type: 'submit' }, knapp),
      h('button', { class: 'knapp', type: 'button', onclick: () => { slangUtkast(nyckel); stangForm(); } }, 'Avbryt')));
  form.addEventListener('input', minns);
  ordFalt.addEventListener('input', () => autosize(ordFalt));
  // A line is one line in the file: Enter saves instead of breaking it.
  ordFalt.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing) return;
    ev.preventDefault();
    if (ev.shiftKey) fel.replaceChildren(h('p', null, 'En replik är en rad. Ska det bli två, spara den här och lägg till en ny efter.'));
    else form.requestSubmit();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    fel.replaceChildren();
    const sag = (t) => fel.replaceChildren(h('p', null, t));
    if (!ordFalt.value.trim()) { sag('Det finns ingen text än.'); return; }
    if (slag === 'annan' && !vemFalt.value.trim()) { sag('Skriv vems röst det är.'); vemFalt.focus(); return; }
    const k = kropp();
    try {
      provaKropp(k, rad || {});
    } catch (e) {
      sag(e.message);
      return;
    }
    if (krav) {
      const svar = krav(k);
      if (svar !== true) { sag(svar); return; }
    }
    if (jamfor && rad && k === rad.kropp) {
      slangUtkast(nyckel);
      stangForm();
      status('Ingen ändring att spara.');
      return;
    }
    await gora(() => spara(k), { fel, nyckel, efter, vidFel: vidFel ? (e) => vidFel(e, k) : null });
  });
  uppdatera();
  return form;
}

// Asking Demi is offered to people who see Demi's posts.
const kanFragaDemi = () => !!(S.jag && !arAI(S.jag.id) && !S.inst.doljDemi);

// A comment, a reply, or a proposal for a whole scene: free text, kept exactly.
function kommentarForm({ rubrik, nyckel, knapp, spara, medGaller = true, hjalpText = null, etikett = null, medTill = false, tillForval = false }) {
  const utkast = lasUtkast(nyckel);
  let galler = utkast ? utkast.galler || null : null;
  const visaTill = medTill && kanFragaDemi();
  let till = visaTill && (utkast ? utkast.till === 'demi' : tillForval) ? 'demi' : null;
  const id = nyttFaltId();
  const falt = h('textarea', { class: 'falt', id, rows: '3', value: utkast ? utkast.text || '' : '' });
  const fel = h('div', { class: 'fel', role: 'alert' });
  const minns = () => {
    if (!falt.value) slangUtkast(nyckel);
    else skrivUtkast(nyckel, { text: falt.value, galler, till });
  };
  const tillHjalp = h('p', { class: 'hjalp' });
  const tillKnapp = h('button', {
    type: 'button', class: 'till-knapp',
    onclick: () => { till = till ? null : 'demi'; visaTillLage(); minns(); },
  }, 'Fråga Demi');
  function visaTillLage() {
    tillKnapp.setAttribute('aria-pressed', String(till === 'demi'));
    tillHjalp.textContent = till
      ? 'Demi svarar här i tråden nästa gång Demi läser rummet. Demi är en AI.'
      : 'Tryck om du vill ha svar från Demi.';
  }
  const nycklar = Object.keys(GALLER);
  const val = nycklar.map((g) => h('button', {
    type: 'button', 'aria-pressed': String(g === galler),
    onclick: () => {
      galler = galler === g ? null : g;
      val.forEach((b, n) => b.setAttribute('aria-pressed', String(nycklar[n] === galler)));
      minns();
    },
  }, storBokstav(GALLER[g])));
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'form-rubrik' }, rubrik),
    utkast ? h('p', { class: 'utkast-not' }, 'Här är texten du skrev förra gången men inte sparade.') : null,
    medGaller ? h('p', { class: 'hjalp' }, 'Gäller det något särskilt? Välj om du vill.') : null,
    medGaller ? h('div', { class: 'val', role: 'group', 'aria-label': 'Vad kommentaren gäller' }, val) : null,
    h('label', { class: 'etikett-falt', for: id }, etikett || (medGaller ? 'Kommentaren' : 'Förslaget')),
    falt,
    hjalpText ? h('p', { class: 'hjalp' }, hjalpText) : null,
    visaTill ? h('div', { class: 'val till' }, tillKnapp) : null,
    visaTill ? tillHjalp : null,
    fel,
    h('div', { class: 'knappar' },
      h('button', { class: 'knapp huvud', type: 'submit' }, knapp),
      h('button', { class: 'knapp', type: 'button', onclick: () => { slangUtkast(nyckel); stangForm(); } }, 'Avbryt')));
  form.addEventListener('input', minns);
  falt.addEventListener('input', () => autosize(falt));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    fel.replaceChildren();
    if (!falt.value.trim()) { fel.replaceChildren(h('p', null, 'Skriv något först.')); return; }
    await gora(() => spara(falt.value, galler, visaTill ? till : null), { fel, nyckel });
  });
  if (visaTill) visaTillLage();
  return form;
}

function bekrafta({ text, ja, fara = false, gor, avbryt = stangForm }) {
  const fel = h('div', { class: 'fel', role: 'alert' });
  return h('div', { class: `bekrafta${fara ? '' : ' lugn'}` },
    h('p', null, text), fel,
    h('div', { class: 'knappar' },
      h('button', { class: `knapp ${fara ? 'fara' : 'huvud'}`, type: 'button', onclick: () => gor(fel) }, ja),
      h('button', { class: 'knapp', type: 'button', onclick: () => avbryt() }, 'Avbryt')));
}

// --- Proposals and comments --------------------------------------------------------------

// Open proposals, and decided ones that people talked about: their thread
// stays readable after the proposal was laid in or withdrawn.
const visaForslag = (f) => f.lage === 'oppet' || synliga(S.v.svar.get(f.id) || []).length > 0;

function forslagKort(f, { rad = null, scen = null, galde = null } = {}) {
  const nr = S.ep.nr;
  const scenNiva = f.mal.text == null;
  if (f.lage !== 'oppet') {
    return h('div', { class: `kort forslag stangd${arAI(f.skrev) ? ' fran-ai' : ''}` },
      h('p', { class: 'kort-huvud' }, h('span', { class: 'slag' }, 'Förslag'), ' ', avsandare(f.skrev), tid(f.nar),
        h('span', { class: 'lage' }, f.lage === 'inlagt' ? `inlagt i manus av ${namn(f.inlagt && f.inlagt.av)}` : 'draget undan')),
      galde,
      scenNiva ? h('div', { class: 'kort-text' }, renderText(f.kropp)) : h('p', { class: 'kort-manus' }, radText(f.kropp)),
      trad(f, { rad, scen }));
  }
  const kort = h('div', { class: `kort forslag${arAI(f.skrev) ? ' fran-ai' : ''}` },
    h('p', { class: 'kort-huvud' }, h('span', { class: 'slag' }, scenNiva ? 'Förslag för scenen' : 'Förslag'), ' ', avsandare(f.skrev), tid(f.nar)),
    galde,
    scenNiva ? h('div', { class: 'kort-text' }, renderText(f.kropp)) : h('p', { class: 'kort-manus' }, radText(f.kropp)));
  const ja = (f.ja || []).map((j) => namn(j.vem));
  kort.append(h('p', { class: 'ja' }, ja.length ? `Ja från ${lista(ja)}.` : 'Ingen har sagt ja än.'));
  if (f.togsTillbaka) {
    kort.append(h('p', { class: 'meta' }, `Har legat i manus. ${namn(f.togsTillbaka.av)} tog tillbaka den tidigare texten${tid(f.togsTillbaka.nar)}.`));
  }
  if (!kan()) {
    kort.append(trad(f, { rad, scen, galde }));
    return kort;
  }
  if (S.form && S.form.typ === 'lagg-in' && S.form.id === f.id) {
    kort.append(bekrafta({
      text: scenNiva
        ? 'Markera förslaget som inlagt? Rummet ändrar inget i manuset; det här är för när ni har gjort ändringen själva.'
        : `Byta repliken mot ${gen(namn(f.skrev))} förslag? Det loggas att du gjorde det, och texten som står nu går att ta tillbaka.`,
      ja: scenNiva ? 'Markera som inlagt' : 'Lägg in i manus',
      gor: (fel) => gora(() => S.lager.laggInForslag(nr, f.id), { fel, efter: (m) => { if (m && m.i != null) S.oppen = { nyI: m.i }; } }),
    }));
    return kort;
  }
  const harJa = !!(S.jag && (f.ja || []).some((j) => j.vem === S.jag.id));
  kort.append(h('div', { class: 'knappar' },
    h('button', { class: 'knapp liten', type: 'button', onclick: () => gora(() => S.lager.sagJa(nr, f.id, !harJa)) }, harJa ? 'Ta tillbaka mitt ja' : 'Säg ja'),
    galde ? null : h('button', {
      class: 'knapp liten', type: 'button',
      onclick: () => oppna(ctxOppen(rad, scen), { typ: 'lagg-in', id: f.id }),
    }, scenNiva ? 'Markera som inlagt' : 'Lägg in i manus'),
    mitt(f)
      ? h('button', { class: 'knapp liten', type: 'button', onclick: () => gora(() => S.lager.draUndanForslag(nr, f.id)) }, 'Dra undan')
      : null));
  kort.append(trad(f, { rad, scen, galde }));
  return kort;
}

function kommentarer(alla, ctx) {
  const oppna = alla.filter((k) => !k.klar);
  const klara = alla.filter((k) => k.klar);
  const ut = oppna.map((k) => kommentarKort(k, ctx));
  if (klara.length) {
    ut.push(h('details', { class: 'klara' },
      h('summary', null, klara.length === 1 ? '1 klar kommentar' : `${klara.length} klara kommentarer`),
      klara.map((k) => kommentarKort(k, ctx))));
  }
  return ut;
}

function kommentarKort(k, { rad = null, scen = null, galde = null } = {}) {
  const nr = S.ep.nr;
  const kort = h('div', { class: `kort kommentar${k.klar ? ' klar' : ''}${arAI(k.skrev) ? ' fran-ai' : ''}` },
    h('p', { class: 'kort-huvud' }, h('span', { class: 'slag' }, 'Kommentar'), ' ', avsandare(k.skrev), tid(k.nar),
      k.galler ? h('span', { class: 'galler' }, GALLER[k.galler] || k.galler) : null,
      tillText(k)),
    galde,
    h('div', { class: 'kort-text' }, renderText(k.text)),
    k.klar ? h('p', { class: 'meta' }, `Klar, sa ${namn(k.klar.av)}${tid(k.klar.nar)}.`) : null);
  if (!kan()) {
    kort.append(trad(k, { rad, scen, galde }));
    return kort;
  }
  if (S.form && S.form.typ === 'ta-bort' && S.form.id === k.id) {
    kort.append(bekrafta({
      text: 'Ta bort kommentaren? Den försvinner ur rummet men står kvar i anteckningsfilen.',
      ja: 'Ta bort', fara: true,
      gor: (fel) => gora(() => S.lager.taBortKommentar(nr, k.id), { fel }),
    }));
    return kort;
  }
  // A first post others have answered stays: removing it would hide their replies.
  const andraSvar = (S.v.svar.get(k.id) || []).some((x) => x.skrev !== k.skrev);
  kort.append(h('div', { class: 'knappar' },
    h('button', { class: 'knapp liten', type: 'button', onclick: () => gora(() => S.lager.kommentarKlar(nr, k.id, !k.klar)) }, k.klar ? 'Inte klar' : 'Klar'),
    mitt(k) && !andraSvar
      ? h('button', { class: 'knapp liten', type: 'button', onclick: () => oppna(ctxOppen(rad, scen), { typ: 'ta-bort', id: k.id }) }, 'Ta bort')
      : null));
  kort.append(trad(k, { rad, scen, galde }));
  return kort;
}

const tillText = (post) => (post.till ? h('span', { class: `till-text${arAI(post.till) ? ' ai' : ''}` }, `till ${namn(post.till)}`) : null);

// The replies under a comment or a proposal, whether Demi has been asked and
// not answered yet, and a way to answer.
function trad(rot, { rad = null, scen = null } = {}) {
  const nr = S.ep.nr;
  const alla = (S.v.svar.get(rot.id) || []);
  const svar = synliga(alla);
  const ut = h('div', { class: `trad${svar.length ? '' : ' utan-svar'}` });
  for (const k of svar) {
    const el = h('div', { class: `svar${arAI(k.skrev) ? ' fran-ai' : ''}`, id: `svar-${k.id}` },
      h('p', { class: 'kort-huvud' }, avsandare(k.skrev), tid(k.nar), tillText(k)),
      h('div', { class: 'kort-text' }, renderText(k.text)));
    if (kan() && mitt(k)) {
      if (S.form && S.form.typ === 'ta-bort' && S.form.id === k.id) {
        el.append(bekrafta({
          text: 'Ta bort svaret? Det försvinner ur tråden men står kvar i anteckningsfilen.',
          ja: 'Ta bort', fara: true,
          gor: (fel) => gora(() => S.lager.taBortKommentar(nr, k.id), { fel }),
        }));
      } else {
        el.append(h('div', { class: 'knappar' }, h('button', {
          class: 'knapp liten tyst', type: 'button',
          onclick: () => oppna(ctxOppen(rad, scen), { typ: 'ta-bort', id: k.id }),
        }, 'Ta bort')));
      }
    }
    ut.append(el);
  }
  if (!S.inst.doljDemi && [rot, ...alla].some((x) => S.v.vantar.has(x.id))) {
    ut.append(h('p', { class: 'vantar' }, 'Väntar på svar från Demi.'));
  }
  if (kan() && !rot.borta && !rot.klar && (rot.lage == null || rot.lage === 'oppet')) {
    const nyckel = utkastNyckel(`e${nr}`, 'svar', `svar-${rot.id}`);
    if (S.form && S.form.typ === 'svara' && S.form.id === rot.id) {
      const sista = svar.length ? svar[svar.length - 1] : rot;
      ut.append(kommentarForm({
        rubrik: `Svar till ${namn(sista.skrev)}`, nyckel, knapp: 'Svara', medGaller: false, etikett: 'Svaret',
        medTill: true, tillForval: arAI(sista.skrev),
        spara: (text, _g, till) => S.lager.svara(nr, rot.id, text, { till }),
      }));
    } else {
      ut.append(h('div', { class: 'knappar' }, h('button', {
        class: 'knapp liten tyst', type: 'button',
        onclick: () => oppna(ctxOppen(rad, scen), { typ: 'svara', id: rot.id }),
      }, S.utkast.has(nyckel) ? 'Svara · osparat' : 'Svara')));
    }
  }
  return ut.childNodes.length ? ut : null;
}

// --- The end of a scene: notes on the whole scene, notes whose line is gone,
// struck lines, and the scene's own tools.

const SCENFORMER = ['kommentera-scen', 'foresla-scen', 'ny-forst'];

function ritaFot(s) {
  const nr = S.ep.nr;
  const sv = S.v.scener.get(s.nr) || { forslag: [], kommentarer: [], losa: [], strukna: [] };
  const oppen = !!(S.oppen && S.oppen.i == null && S.oppen.scen === s.nr);
  const fot = h('div', { class: 'scenfot', id: `fot-${s.nr}` });

  const forslag = synliga(sv.forslag).filter(visaForslag);
  const scenKommentarer = synliga(sv.kommentarer);
  if (forslag.length || scenKommentarer.length) {
    fot.append(h('h4', null, 'Om hela scenen'));
    for (const f of forslag) fot.append(forslagKort(f, { scen: s.nr }));
    fot.append(...kommentarer(scenKommentarer, { scen: s.nr }));
  }
  const losa = sv.losa.filter((x) => !dold(x.post.skrev) && (x.slag === 'kommentarer' || visaForslag(x.post)));
  if (losa.length) {
    fot.append(h('h4', null, 'Gällde en replik som inte står så längre'));
    for (const { slag, post } of losa) {
      const galde = h('p', { class: 'galde' }, post.mal.struken ? 'Gällde den strukna repliken ' : 'Gällde ', h('q', null, post.mal.text));
      fot.append(slag === 'forslag' ? forslagKort(post, { scen: s.nr, galde }) : kommentarKort(post, { scen: s.nr, galde }));
    }
  }
  if (sv.strukna.length) {
    fot.append(h('h4', null, 'Struket'));
    for (const st of sv.strukna) {
      fot.append(h('div', { class: 'kort struken' },
        h('p', { class: 'tidigare-text' }, radText(st.innehall)),
        h('p', { class: 'meta' }, `Struken av ${namn(st.strok && st.strok.av)}${tid(st.strok && st.strok.nar)}.${st.skrev ? ` Skriven av ${namn(st.skrev)}.` : ''}`),
        kan() ? h('div', { class: 'knappar' }, h('button', {
          class: 'knapp liten', type: 'button',
          onclick: () => gora(() => S.lager.laggTillbakaRad(nr, st.id), { efter: (m) => { if (m) S.oppen = { nyI: m.i }; } }),
        }, 'Lägg tillbaka')) : null));
    }
  }
  if (kan()) {
    if (oppen && S.form && SCENFORMER.includes(S.form.typ)) {
      fot.append(h('div', { class: 'verktyg' }, scenForm(s)));
    } else {
      const knapp = (text, typ) => h('button', {
        class: 'knapp liten', type: 'button',
        onclick: () => oppna({ scen: s.nr }, { typ }),
      }, S.utkast.has(utkastNyckel(`e${nr}`, typ, `scen-${s.nr}`)) ? `${text} · osparat` : text);
      fot.append(h('div', { class: 'knappar scenverktyg', role: 'group', 'aria-label': `Scen ${s.nr}` },
        knapp('Kommentera scenen', 'kommentera-scen'),
        knapp('Förslag för scenen', 'foresla-scen'),
        s.delar.some((d) => d.typ === 'citat') ? knapp('Ny replik först i scenen', 'ny-forst') : null));
    }
  }
  return fot;
}

function scenForm(s) {
  const nr = S.ep.nr;
  const nyckel = utkastNyckel(`e${nr}`, S.form.typ, `scen-${s.nr}`);
  if (S.form.typ === 'kommentera-scen') {
    return kommentarForm({
      rubrik: `Kommentar till scen ${s.nr}, ${s.titel}`, nyckel, knapp: 'Spara kommentaren', medTill: true,
      spara: (text, galler, till) => S.lager.kommentera(nr, { scen: s.nr }, text, galler, { till }),
    });
  }
  if (S.form.typ === 'foresla-scen') {
    return kommentarForm({
      rubrik: `Förslag för scen ${s.nr}, ${s.titel}`, nyckel, knapp: 'Lägg förslaget', medGaller: false,
      hjalpText: 'Ett förslag om scenen som helhet. Det läggs här och ändrar inget i manuset.',
      spara: (text) => S.lager.foresla(nr, { scen: s.nr }, text),
    });
  }
  return ordForm({
    rubrik: 'Ny replik, först i scenen', start: '', rad: null, nyckel, knapp: 'Lägg till i manus',
    spara: (k) => S.lager.nyRad(nr, { forst: { scen: s.nr, block: 0 } }, k),
    efter: (m) => { if (m) S.oppen = { nyI: m.i }; },
  });
}

// --- The world: the world book, HELD's lore, and pages people write ----------------------------

const senast = (s) => (s.andrad && s.andrad.nar) || s.skapad || '';
const metaSida = (s) => [avsandare(s.skrev), tid(s.skapad),
  s.andrad ? `, ändrad${s.andrad.av !== s.skrev ? ` av ${namn(s.andrad.av)}` : ''}${tid(s.andrad.nar)}` : ''];

async function visaVarlden(r, { tyst = false, hamta = true } = {}) {
  if (!tyst) main.replaceChildren(h('p', { class: 'laddar' }, 'Läser …'));
  const y = window.scrollY;
  const flikar = h('nav', { class: 'underflikar', 'aria-label': 'Världen' },
    [['varld', 'Världsboken', '#varlden'], ['held', 'HELD', '#varlden/held'], ['sidor', 'Våra sidor', '#varlden/sidor']].map(([f, t, href]) => {
      const aktiv = r.flik === f || (f === 'sidor' && (r.flik === 'sida' || r.flik === 'ny'));
      return h('a', { href, 'aria-current': aktiv ? 'page' : null }, t);
    }));
  let inne;
  try {
    if (r.flik === 'varld' || r.flik === 'held') {
      inne = await loreDokument(r.flik);
    } else {
      if (hamta || !S.lore) S.lore = await S.lager.lasLore();
      inne = r.flik === 'sida' ? loreSida(r.id) : loreLista(r.flik === 'ny');
    }
  } catch (e) {
    inne = h('div', { class: 'band varning' }, felText(e));
  }
  if (S.rutt !== r) return;
  ritad();
  main.replaceChildren(h('h2', null, 'Världen'), flikar, inne);
  if (tyst) window.scrollTo(0, y);
  if (S.form || r.flik === 'ny') {
    requestAnimationFrame(() => {
      for (const t of main.querySelectorAll('textarea')) autosize(t);
      const f = main.querySelector('form input, form textarea, .bekrafta .knapp');
      if (f) f.focus({ preventScroll: true });
    });
  }
}

const ritaVarldenIgen = () => visaVarlden(S.rutt, { tyst: true, hamta: false });

async function loreDokument(flik) {
  const text = await S.lager.lasText(flik === 'varld' ? 'varld' : 'held');
  if (text == null) {
    return h('p', { class: 'dov smal' }, flik === 'held' ? 'HELD:s lore går bara att läsa i portalen.' : 'Världsboken gick inte att hitta.');
  }
  return h('div', { class: 'smal' },
    h('p', { class: 'kalla' }, flik === 'varld'
      ? 'Glimts världsbok (varld.md). Den läses här; egna tillägg skriver ni under Våra sidor.'
      : 'HELD:s gemensamma lore (LORE.md i HELD-projektet). Den läses här; egna tillägg skriver ni under Våra sidor.'),
    h('article', { class: 'md' }, renderMd(text)));
}

function loreLista(nySida) {
  const sidor = S.lore.sidor;
  const doldaSidor = sidor.filter((s) => !s.borta && dold(s.skrev)).length;
  const aktiva = synliga(sidor.filter((s) => !s.borta)).sort((a, b) => String(senast(b)).localeCompare(String(senast(a))));
  // Only the one who wrote a page can bring it back, so only theirs are listed.
  const borta = sidor.filter((s) => s.borta && mitt(s));
  const ut = h('div', { class: 'smal' },
    h('p', { class: 'kalla' }, 'Lore ni skriver själva: personer, platser, regler, sådant som inte står i världsboken än.'));
  if (kanSkriva()) {
    if (nySida) ut.append(loreForm({}));
    else ut.append(h('p', null, h('a', { class: 'knapp huvud', href: '#varlden/ny' }, 'Skriv en ny sida')));
  }
  if (aktiva.length) {
    ut.append(h('ul', { class: 'sidlista' }, aktiva.map((s) => {
      const forsta = loreText(s).split('\n').find((x) => x.trim()) || '';
      return h('li', { class: arAI(s.skrev) ? 'fran-ai' : null }, h('a', { href: `#varlden/sida/${s.id}` },
        h('span', { class: 'titel' }, s.titel),
        h('span', { class: 'meta' }, metaSida(s)),
        forsta ? h('span', { class: 'utdrag' }, forsta) : null));
    })));
  } else if (!nySida) {
    ut.append(h('p', { class: 'dov' }, 'Inga sidor än.'));
  }
  if (doldaSidor) {
    ut.append(h('p', { class: 'dov liten' }, `${doldaSidor === 1 ? 'En sida' : `${doldaSidor} sidor`} av Demi är dolda för dig.`));
  }
  if (borta.length) {
    ut.append(h('details', { class: 'versioner' },
      h('summary', null, `Dina borttagna sidor (${borta.length})`),
      borta.map((s) => h('div', { class: 'version' },
        h('p', { class: 'tidigare-text' }, s.titel),
        h('p', { class: 'meta' }, `Borttagen av ${namn(s.borta.av)}${tid(s.borta.nar)}.`),
        kanSkriva() ? h('button', { class: 'knapp liten', type: 'button', onclick: () => gora(() => S.lager.hamtaTillbakaLoresida(s.id)) }, 'Hämta tillbaka') : null))));
  }
  return ut;
}

function loreSida(id) {
  const s = S.lore.sidor.find((x) => x.id === id);
  const ut = h('div', { class: 'smal' }, h('p', null, h('a', { href: '#varlden/sidor' }, 'Alla sidor')));
  if (!s) {
    ut.append(h('p', { class: 'dov' }, 'Sidan finns inte.'));
    return ut;
  }
  if (dold(s.skrev)) {
    ut.append(h('p', { class: 'dov' }, 'Sidan är skriven av Demi, och Demis inlägg är dolda för dig. Du kan visa dem igen med knappen Demis inlägg högst upp.'));
    return ut;
  }
  if (s.borta) {
    ut.append(h('div', { class: 'band varning' }, `Sidan är borttagen av ${namn(s.borta.av)}${tid(s.borta.nar)}. `,
      kanSkriva() && mitt(s) ? h('button', { class: 'knapp liten', type: 'button', onclick: () => gora(() => S.lager.hamtaTillbakaLoresida(s.id)) }, 'Hämta tillbaka') : null));
  }
  if (S.form && S.form.typ === 'andra-sida' && S.form.id === id) {
    ut.append(loreForm({ sida: s, sedd: S.form.sedd }));
    return ut;
  }
  ut.append(h('article', { class: `lore-sida${arAI(s.skrev) ? ' fran-ai' : ''}` },
    h('h3', { class: 'sida-titel' }, s.titel),
    h('p', { class: 'meta' }, metaSida(s)),
    h('div', { class: 'sida-text' }, renderText(loreText(s)))));
  if (kanSkriva() && !s.borta && !mitt(s)) {
    ut.append(h('p', { class: 'dov liten' }, `Bara ${namn(s.skrev)} kan ändra sidan. Har du något att lägga till, skriv en egen sida.`));
  }
  if (kanSkriva() && !s.borta && mitt(s)) {
    if (S.form && S.form.typ === 'ta-bort-sida') {
      ut.append(bekrafta({
        text: 'Ta bort sidan? Den går att hämta tillbaka under Borttagna sidor.',
        ja: 'Ta bort', fara: true,
        avbryt: () => { S.form = null; ritaVarldenIgen(); },
        gor: (fel) => gora(() => S.lager.taBortLoresida(id), { fel, efter: () => { location.hash = '#varlden/sidor'; S.rutt = lasRutt(); } }),
      }));
    } else {
      ut.append(h('div', { class: 'knappar' },
        h('button', { class: 'knapp', type: 'button', onclick: () => { S.form = { typ: 'andra-sida', id, sedd: senast(s) }; ritaVarldenIgen(); } }, 'Ändra'),
        h('button', { class: 'knapp', type: 'button', onclick: () => { S.form = { typ: 'ta-bort-sida' }; ritaVarldenIgen(); } }, 'Ta bort')));
    }
  }
  if (s.versioner && s.versioner.length) {
    ut.append(h('details', { class: 'versioner' },
      h('summary', null, `Tidigare versioner (${s.versioner.length})`),
      [...s.versioner].reverse().map((v) => h('div', { class: 'version' },
        h('p', { class: 'tidigare-text' }, v.titel),
        h('p', { class: 'meta' }, `${namn(v.av)}${tid(v.nar)}`),
        h('div', null, renderText((v.text || []).join('\n')))))));
  }
  return ut;
}

function loreForm({ sida = null, sedd = null }) {
  const nyckel = utkastNyckel('lore', 'sida', sida ? sida.id : 'ny');
  const utkast = lasUtkast(nyckel);
  const titelId = nyttFaltId();
  const textId = nyttFaltId();
  const titel = h('input', { class: 'falt titelfalt', id: titelId, type: 'text', value: utkast ? utkast.titel || '' : sida ? sida.titel : '', autocomplete: 'off' });
  const text = h('textarea', { class: 'falt lorefalt', id: textId, value: utkast ? utkast.text || '' : sida ? loreText(sida) : '' });
  const fel = h('div', { class: 'fel', role: 'alert' });
  const minns = () => {
    if (!titel.value && !text.value) slangUtkast(nyckel);
    else skrivUtkast(nyckel, { titel: titel.value, text: text.value });
  };
  const avbryt = () => {
    slangUtkast(nyckel);
    S.form = null;
    if (sida) ritaVarldenIgen();
    else location.hash = '#varlden/sidor';
  };
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'form-rubrik' }, sida ? 'Ändra sidan' : 'Ny sida'),
    utkast ? h('p', { class: 'utkast-not' }, 'Här är texten du skrev förra gången men inte sparade.') : null,
    h('label', { class: 'etikett-falt', for: titelId }, 'Titel'), titel,
    h('label', { class: 'etikett-falt', for: textId }, 'Text'), text,
    h('p', { class: 'hjalp' }, 'Skriv fritt. En tom rad blir ett nytt stycke. Texten sparas precis som du skriver den.'),
    fel,
    h('div', { class: 'knappar' },
      h('button', { class: 'knapp huvud', type: 'submit' }, 'Spara sidan'),
      h('button', { class: 'knapp', type: 'button', onclick: avbryt }, 'Avbryt')));
  form.addEventListener('input', minns);
  text.addEventListener('input', () => autosize(text));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    fel.replaceChildren();
    if (!titel.value.trim()) { fel.replaceChildren(h('p', null, 'Sidan behöver en titel.')); titel.focus(); return; }
    if (sida) {
      await gora(() => S.lager.andraLoresida(sida.id, titel.value, text.value, sedd), {
        fel, nyckel,
        klart: (ut) => (ut && ut.krockade
          ? 'Sparat. Någon annan sparade sidan medan du skrev; deras text ligger under Tidigare versioner.'
          : null),
      });
    } else {
      await gora(() => S.lager.nyLoresida(titel.value, text.value), {
        fel, nyckel,
        efter: (nyId) => { if (nyId) { location.hash = `#varlden/sida/${nyId}`; S.rutt = lasRutt(); } },
      });
    }
  });
  return form;
}

// --- Start ----------------------------------------------------------------------------------

const lasTider = () => fetch(new URL('./ljudtider.json', import.meta.url)).then((r) => (r.ok ? r.json() : null));

function visaInloggning() {
  main.replaceChildren(h('section', { class: 'smal' },
    h('h2', null, 'Logga in först'),
    h('p', null, 'Manusrummet läser och sparar genom portalen, och portalen känner inte igen dig just nu.'),
    h('p', null, h('a', { class: 'knapp huvud', href: '/' }, 'Öppna portalen')),
    h('p', { class: 'dov' }, 'Logga in där och kom sedan tillbaka hit.')));
}

function ritaJag() {
  const jag = $('jag');
  if (!S.jag) {
    jag.replaceChildren('Bara läsning');
    return;
  }
  const visas = !S.inst.doljDemi;
  jag.replaceChildren(
    h('span', { class: 'du' }, `Du är ${S.jag.namn}`),
    arAI(S.jag.id) ? null : h('button', {
      type: 'button', class: 'brytare', role: 'switch', 'aria-checked': String(visas),
      title: visas ? 'Demis inlägg visas. Tryck för att dölja dem, bara för dig.' : 'Demis inlägg är dolda för dig. Tryck för att visa dem.',
      onclick: vaxlaDemi,
    }, h('span', { class: 'spar', 'aria-hidden': 'true' }), 'Demis inlägg'));
}

let sparInst = false;
async function vaxlaDemi() {
  if (sparInst) return;
  sparInst = true;
  const fore = S.inst.doljDemi;
  S.inst = { ...S.inst, doljDemi: !fore };
  ritaJag();
  ritaVyIgen();
  try {
    S.inst = await S.lager.sattInstallning('doljDemi', !fore);
    status(S.inst.doljDemi ? 'Demis inlägg är dolda för dig.' : 'Demis inlägg visas.', 'ok');
  } catch (e) {
    S.inst = { ...S.inst, doljDemi: fore };
    status(`Inställningen sparades inte. ${felText(e)}`, 'fel');
  }
  sparInst = false;
  ritaJag();
  ritaVyIgen();
}

function ritaVyIgen() {
  if (!S.rutt) return;
  const y = window.scrollY;
  if (S.rutt.vy === 'episod') {
    if (!S.ep) return;
    S.form = null;
    ritaEpisod();
    window.scrollTo(0, y);
  } else {
    ritaVarldenIgen();
  }
}

function ritaRam() {
  const iPortalen = location.pathname.includes('/uploads/');
  $('tillbaka').hidden = !iPortalen;
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

async function start() {
  const sida = location.href;
  let adapter;
  if (location.pathname.includes('/uploads/')) {
    // Inside the portal the files are always the portal's; without a login
    // there is nothing to fall back to.
    adapter = portalAdapter({ rot: new URL(sida).searchParams.get('rot') === 'prov' ? 'prov' : 'skarp' });
    if (!(await adapter.finns())) {
      visaInloggning();
      return;
    }
  } else {
    adapter = await valjAdapter({ sida });
  }
  S.adapter = adapter;
  // Notes that wait for a manuscript change are kept in the browser, so a
  // reload does not lose them.
  const koNyckel = `${UTKAST}|${adapter.rot || adapter.namn}|vantar`;
  const ko = {
    las: () => JSON.parse(localStorage.getItem(koNyckel) || '[]'),
    skriv: (lista) => {
      if (lista.length) localStorage.setItem(koNyckel, JSON.stringify(lista));
      else localStorage.removeItem(koNyckel);
    },
  };
  S.lager = skapaLager(adapter, { lasTider, ko });
  S.jag = await S.lager.vem();
  try {
    S.inst = await S.lager.lasInstallningar();
  } catch {
    S.inst = { doljDemi: !!(S.jag && PERSONER[S.jag.id] && PERSONER[S.jag.id].doljDemi) };
  }
  ritaRam();
  window.addEventListener('hashchange', () => { visa(); });
  // Back in the tab: read the manuscript again, unless someone is mid-sentence.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || S.upptagen || S.form || spelar) return;
    if (S.rutt && S.rutt.vy === 'episod' && S.ep) laddaEpisod({ behallPlats: true });
  });
  await visa();
}

start().catch((e) => {
  main.replaceChildren(h('div', { class: 'band varning' }, felText(e)));
});
