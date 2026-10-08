// The node half of scripts/rummet.py: Demi in the manuscript room, with the
// room's own code. Every read and write goes through the same layer the page
// uses (rummet/lager.js), so a change Demi makes is merged per paragraph
// against the file as it is now, written with the version just read, and
// recorded in the history as Demi's, exactly as the page would.
//
// Files are not touched from here. rummet.py starts this process, sends one
// line {"uppdrag": {...}} and then answers requests on stdin:
//   -> {"rpc": n, "las": plats}                    <- {"rpc": n, "text", "version"} | {"rpc": n, "saknas": true}
//   -> {"rpc": n, "skriv": plats, "text", "version"} <- {"rpc": n, "version"} | {"rpc": n, "krock": true}
// using the portal's read_file and write_file (the mtime check and the lock).
// The last line is {"klart": result} or {"fel": text, "kod", "nara"}.
//
// Everyone can change everything in the room. Demi's own rule (README) is to
// comment and propose by default, and to change text only when Henric or Liv
// asked; that is a rule for Demi, not a lock in the code.

import { createInterface } from 'node:readline';
import { Krock, EPISODER, DOKUMENT } from '../rummet/data.js';
import { skapaLager, slagFor } from '../rummet/lager.js';
import * as D from '../rummet/dok.js';
import * as A from '../rummet/anteckn.js';
import * as K from '../rummet/katalog.js';

const DEMI = 'demi';

class CliFel extends Error {
  constructor(kod, text, extra = {}) {
    super(text);
    this.kod = kod;
    Object.assign(this, extra);
  }
}

// --- The line protocol ----------------------------------------------------------

const vantar = new Map();
let nasta = 0;
let uppdrag = null;
const forstaRad = new Promise((res) => { uppdrag = res; });
const rl = createInterface({ input: process.stdin });
rl.on('line', (rad) => {
  if (!rad.trim()) return;
  const m = JSON.parse(rad);
  if (m.uppdrag) { uppdrag(m.uppdrag); return; }
  const f = vantar.get(m.rpc);
  if (f) { vantar.delete(m.rpc); f(m); }
});
const skicka = (x) => process.stdout.write(`${JSON.stringify(x)}\n`);
function rpc(fraga) {
  return new Promise((res) => {
    nasta += 1;
    vantar.set(nasta, res);
    skicka({ rpc: nasta, ...fraga });
  });
}

function adapterFor(prov) {
  return {
    namn: 'demi',
    rot: prov ? 'prov' : 'skarp',
    kanSkriva: true,
    vem: async () => ({ id: DEMI, namn: 'Demi' }),
    async las(plats) {
      const r = await rpc({ las: plats });
      if (r.fel) throw new CliFel('las', r.fel);
      return r.saknas ? null : { text: r.text, version: r.version };
    },
    async skriv(plats, text, version) {
      const r = await rpc({ skriv: plats, text, version });
      if (r.krock) throw new Krock(r.version == null ? null : r.version);
      if (r.fel) throw new CliFel('skriv', r.fel);
      return { version: r.version };
    },
    ljudUrl: () => '',
  };
}

// The page keeps notes that could not be written yet in localStorage; here
// rummet.py keeps them in a file and hands them over (lagring) both ways.
// Only notes wait: text that could not be saved is an error Demi sees and
// runs again, never something a later step writes on its own.
const arText = (k) => k.includes('|osparat|');
function minne(start) {
  const m = new Map(Object.entries(start || {}).filter(([k]) => !arText(k)));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (n) => [...m.keys()][n] ?? null,
    get length() { return m.size; },
    allt: () => Object.fromEntries([...m].filter(([k]) => !arText(k))),
  };
}

// The editor, without a page: a list of paragraphs Dokument can read and change.
function utanSida(paras) {
  let lista = paras.map((p) => ({ ...p }));
  const plats = (id) => lista.findIndex((p) => p.id === id);
  return {
    stycken: () => lista,
    laser: () => null,
    satt: (ny) => { lista = ny; },
    tillampa(ops) {
      for (const o of ops) {
        if (o.op === 'ersatt') { const k = plats(o.id); if (k >= 0) lista[k] = { ...o.p, id: o.id }; }
        if (o.op === 'infoga') { const k = o.efter == null ? -1 : plats(o.efter); lista.splice(k + 1, 0, { ...o.p }); }
        if (o.op === 'ta-bort') { const k = plats(o.id); if (k >= 0) lista.splice(k, 1); }
        if (o.op === 'attrs') { const k = plats(o.id); if (k >= 0) lista[k] = { ...lista[k], raw: o.raw, orig: o.orig, sep: o.sep }; }
        if (o.op === 'byt-id') { const k = plats(o.id); if (k >= 0) lista[k] = { ...lista[k], id: o.till }; }
        if (o.op === 'ordning') { const n = new Map(o.ids.map((id, i) => [id, i])); lista = lista.map((p, i) => [p, i]).sort((a, b) => (n.get(a[0].id) ?? a[1]) - (n.get(b[0].id) ?? b[1])).map((x) => x[0]); }
      }
    },
  };
}

// --- Naming a document and a paragraph -------------------------------------------

function dokFor(namn) {
  const d = String(namn || '');
  if (DOKUMENT.includes(d) || /^lore:[A-Za-z0-9_-]+$/.test(d)) return d;
  throw new CliFel('dok', `Okänt dokument: ${namn}. Använd 1, 2, varld, mekaniker eller lore:<id>.`);
}

const DOKNAMN = (d) => (EPISODER.includes(d) ? `episod ${d}` : d === 'varld' ? 'världsboken' : d === 'mekaniker' ? 'mekanikkatalogen' : `loresidan ${d.slice(5)}`);

// Where each paragraph stands: in a scene or not, and which.
function lage(paras, slag) {
  const omr = D.scenomrade(paras.map((p) => p.typ), slag);
  const scener = D.scenerFor(paras, slag);
  return paras.map((p, k) => ({ iScen: omr[k], scen: scener[k] || null }));
}

// A paragraph named by its id (from 'rader'), by its words (the text, or the
// whole line as it stands in the file), or a scene by its number (its heading).
// n picks among identical paragraphs, counted from 0.
function valj(paras, slag, { stycke, rad, scen, n }) {
  const L = lage(paras, slag);
  if (stycke) {
    const k = paras.findIndex((p) => p.id === stycke);
    if (k < 0) throw new CliFel('hittas-inte', `Det finns inget stycke med id ${stycke}. Se rummet.py rader.`);
    return k;
  }
  const iScenen = (k) => scen == null || L[k].scen === String(scen);
  if (rad != null) {
    const har = [];
    paras.forEach((p, k) => { if (iScenen(k) && (p.text === rad || D.skrivRad(p) === rad)) har.push(k); });
    if (!har.length) {
      const bit = rad.slice(0, 20);
      const nara = [];
      paras.forEach((p, k) => { if (iScenen(k) && p.text && (p.text.includes(bit) || rad.includes(p.text.slice(0, 20)))) nara.push(`[${p.id}] ${p.text}`); });
      throw new CliFel('hittas-inte', `Det står inget stycke så${scen != null ? ` i scen ${scen}` : ''}.`, { nara: nara.slice(0, 3) });
    }
    if (har.length > 1 && n == null) throw new CliFel('flera', `Stycket står ${har.length} gånger. Säg vilket med --n (0 är det första) eller med --stycke.`);
    if (har[n || 0] == null) throw new CliFel('hittas-inte', `Det finns bara ${har.length} sådana stycken.`);
    return har[n || 0];
  }
  if (scen != null) {
    const k = paras.findIndex((p, x) => p.typ === 'scen' && L[x].scen === String(scen));
    if (k < 0) {
      const finns = [...new Set(L.map((x) => x.scen).filter(Boolean))];
      throw new CliFel('scen', `Det finns ingen scen ${scen}. Scenerna är ${finns.join(', ') || 'inga'}.`);
    }
    return k;
  }
  throw new CliFel('vilket', 'Säg vilket stycke: --stycke, --rad eller --scen.');
}

// A new paragraph from Demi: the text as the room shows it, of a kind; or
// with md, a whole line as it stands in the file.
const TYPER = ['scen', 'mekanik', 'replik', 'regi', 'variant', 'gren', 'anteckning', 'stycke', 'rubrik', 'punkt'];
function nyttStycke({ text, typ, etikett, niva, md }, iScen, fore = null) {
  if (typeof text !== 'string') throw new CliFel('tom', 'Texten saknas.');
  if (/[\r\n]/.test(text)) throw new CliFel('flera-rader', D.FELTEXT['flera-rader']);
  if (md) {
    const q = D.tolkaRad(text, iScen);
    return { typ: q.typ, attrs: D.rensaAttrs(q.typ, q.attrs), text: q.text };
  }
  let t = typ || (fore ? fore.typ : iScen ? 'replik' : 'stycke');
  let attrs = fore && fore.typ === t ? { ...fore.attrs } : {};
  if (t === 'anteckning') { t = 'stycke'; attrs = { form: 'kursiv' }; }
  if (!TYPER.includes(t) && t !== 'tabell') throw new CliFel('typ', `Okänd typ: ${t}. Typerna är ${TYPER.join(', ')}.`);
  if (t === 'variant' && etikett != null) attrs.etikett = etikett;
  if (t === 'rubrik' && niva != null) attrs.niva = Number(niva);
  return { typ: t, attrs: D.rensaAttrs(t, attrs), text };
}

// --- Opening a document --------------------------------------------------------------

async function oppna(lager, dok) {
  const d = await lager.dokument(dok);
  const start = await d.ladda();
  if (d.ko().length) await d.tommaKo();
  return { d, paras: start.paras };
}

// --- The steps -------------------------------------------------------------------------

async function rader(lager, { dok }) {
  const { paras } = await oppna(lager, dok);
  const L = lage(paras, slagFor(dok));
  return {
    dok,
    stycken: paras.map((p, k) => ({
      id: p.id, typ: p.typ, scen: L[k].scen, iScen: L[k].iScen, text: p.text, etikett: p.attrs && p.attrs.etikett, rad: p.typ === 'linje' ? '---' : D.skrivRad(p),
    })),
  };
}

async function anteckna(lager, dok, slag, args) {
  const { d } = await oppna(lager, dok);
  const ok = await d.anteckna(slag, args);
  if (!ok) throw new CliFel('anteckningar', `Det gick inte att skriva anteckningen: ${d.notFel ? d.notFel.message : 'okänt fel'}. Den väntar och skickas nästa gång rummet.py körs.`);
  return d;
}

async function kommentera(lager, u) {
  const dok = dokFor(u.dok);
  const { paras } = await oppna(lager, dok);
  const p = paras[valj(paras, slagFor(dok), u)];
  if (u.galler && !Object.hasOwn(A.GALLER, u.galler)) throw new CliFel('galler', `Okänt: ${u.galler}. Välj ${Object.keys(A.GALLER).join(', ')}.`);
  await anteckna(lager, dok, 'kommentar', { id: u.id, stycke: p.id, galde: p.text, text: u.text, galler: u.galler || null, vem: DEMI, nar: u.nar });
  return { dok, id: u.id, stycke: p.id, text: p.text };
}

async function foresla(lager, u) {
  const dok = dokFor(u.dok);
  const slag = slagFor(dok);
  const { paras } = await oppna(lager, dok);
  const k = valj(paras, slag, u);
  const p = paras[k];
  const L = lage(paras, slag);
  const ny = nyttStycke({ ...u, typ: u.typ || p.typ, etikett: u.etikett != null ? u.etikett : p.attrs.etikett }, L[k].iScen, p);
  if (!ny.text.trim()) throw new CliFel('tom', 'Förslaget är tomt.');
  const f = D.fel(ny, L[k].iScen);
  if (f) throw new CliFel('form', `Förslaget går inte att spara så: ${D.FELTEXT[f]}`);
  if (D.nyckel(ny) === D.nyckel(p)) throw new CliFel('samma', 'Förslaget är samma som texten.');
  await anteckna(lager, dok, 'forslag', { id: u.id, stycke: p.id, galde: p.text, text: ny.text, typ: ny.typ, attrs: ny.attrs, vem: DEMI, nar: u.nar });
  return { dok, id: u.id, stycke: p.id, text: p.text };
}

// Every place a comment can be: the documents and each lore page.
async function allaDok(lager) {
  const lore = await lager.lasLore();
  return [...DOKUMENT, ...lore.sidor.filter((s) => !s.borta).map((s) => `lore:${s.id}`)];
}

async function svara(lager, u) {
  for (const dok of u.dok ? [dokFor(u.dok)] : await allaDok(lager)) {
    let d;
    try {
      ({ d } = await oppna(lager, dok));
    } catch (e) {
      if (e instanceof CliFel) throw e;
      continue;
    }
    const rot = [...d.not.kommentarer, ...d.not.forslag].find((x) => x.id === u.pa);
    if (!rot) continue;
    const ok = await d.anteckna('kommentar', { id: u.id, stycke: rot.stycke, text: u.text, vem: DEMI, nar: u.nar, svarPa: u.pa });
    if (!ok) throw new CliFel('anteckningar', `Det gick inte att skriva svaret: ${d.notFel ? d.notFel.message : 'okänt fel'}. Det väntar och skickas nästa gång rummet.py körs.`);
    const rotId = rot.svarPa || rot.id;
    const huvud = [...d.not.kommentarer, ...d.not.forslag].find((x) => x.id === rotId);
    const trad = [huvud, ...A.trad(d.not, rotId)].filter(Boolean).map((x) => ({ id: x.id, skrev: x.skrev, text: x.text, till: x.till || null }));
    return { dok, id: u.id, svarPa: rotId, trad };
  }
  throw new CliFel('hittas-inte', `Hittar ingen kommentar eller inget förslag med id ${u.pa}.`);
}

// A change to the text: andra, lagg-till, stryk. Saved as the page saves.
async function andraText(lager, u) {
  const dok = dokFor(u.dok);
  const slag = slagFor(dok);
  const { d, paras } = await oppna(lager, dok);
  const ed = utanSida(paras);
  d.koppla(ed);
  const lista = ed.stycken().map((p) => ({ ...p }));
  const L = lage(lista, slag);
  let id;
  let fore = null;
  if (u.op === 'andra') {
    const k = valj(lista, slag, u);
    const p = lista[k];
    fore = p.text;
    const ny = nyttStycke({ ...u, typ: u.typ || p.typ, etikett: u.etikett != null ? u.etikett : p.attrs.etikett }, L[k].iScen, p);
    if (D.nyckel(ny) === D.nyckel(p)) throw new CliFel('samma', 'Stycket står redan så.');
    lista[k] = { ...p, ...ny, raw: null, orig: null };
    id = p.id;
  } else if (u.op === 'lagg-till') {
    let k;
    if (u.efter || u.efterRad != null) k = valj(lista, slag, { stycke: u.efter, rad: u.efterRad, scen: u.scen, n: u.n });
    else if (u.scen != null) {
      // Last in the scene.
      k = -1;
      L.forEach((x, i) => { if (x.iScen && x.scen === String(u.scen)) k = i; });
      if (k < 0) valj(lista, slag, { scen: u.scen });
    } else k = lista.length - 1;
    const iScen = (L[k] && L[k].iScen && lista[k].typ !== 'linje') || false;
    const ny = nyttStycke(u, iScen);
    id = D.nyttId();
    lista.splice(k + 1, 0, { id, ...ny, raw: null, orig: null, sep: null });
  } else if (u.op === 'stryk') {
    const k = valj(lista, slag, u);
    if (lista.length < 2) throw new CliFel('sista', 'Det sista stycket går inte att ta bort.');
    fore = lista[k].text;
    id = lista[k].id;
    lista.splice(k, 1);
  } else throw new CliFel('op', `Okänt steg: ${u.op}`);

  // A paragraph that would not read back as itself is never sent.
  const omr = D.scenomrade(lista.map((p) => p.typ), slag);
  const k2 = lista.findIndex((p) => p.id === id);
  if (k2 >= 0) {
    const f = D.fel(lista[k2], omr[k2]);
    if (f) throw new CliFel('form', `Stycket går inte att spara så: ${D.FELTEXT[f]}`);
  }
  ed.satt(lista);
  try {
    await d.spara();
  } catch (e) {
    throw new CliFel(e.kod || 'spara', e.message);
  }
  if (d.hallna.has(id)) throw new CliFel('form', `Stycket sparades inte: ${D.FELTEXT[d.hallna.get(id)] || 'det skulle läsas som något annat i filen'}.`);
  const efter = ed.stycken().find((p) => p.id === id);
  if (u.op !== 'stryk' && (!efter || D.nyckel(efter) !== D.nyckel(lista[k2]))) {
    throw new CliFel('krock', 'Någon ändrade samma stycke samtidigt. Det ligger nu en krock vid stycket i rummet.');
  }
  // Someone changed the paragraph while it was being removed: it stands, with their words.
  if (u.op === 'stryk' && efter) {
    throw new CliFel('krock', `Stycket togs inte bort: någon ändrade det samtidigt. Det står nu «${efter.text}». Läs det och stryk igen om det fortfarande ska bort.`);
  }
  // Demi's words went in over someone else's change of the same paragraph:
  // theirs lies at the paragraph, and Demi is told.
  const trangde = d.not.krockar.find((x) => x.lage === 'oppen' && x.stycke === id && x.mot === DEMI && x.nar === u.nar);
  return {
    dok, op: u.op, id, fore, text: efter ? efter.text : null, notVantar: d.ko().length > 0, notFel: d.notFel ? d.notFel.message : null,
    trangde: trangde ? { vem: trangde.vem || null, text: trangde.text } : null,
  };
}

// --- What is new ----------------------------------------------------------------------------

async function nytt(lager, u) {
  const sedan = u.sedan || '';
  const sett = new Set(u.sedda || []);
  const vantarDemi = [];
  const handelser = [];
  const kat = K.tolkaKatalog((await lager.lasText('mekaniker')) || '');
  const lore = await lager.lasLore();
  const doks = [...DOKUMENT, ...lore.sidor.filter((s) => !s.borta).map((s) => `lore:${s.id}`)];
  for (const dok of doks) {
    let paras;
    let not;
    if (dok.startsWith('lore:')) {
      const s = lore.sidor.find((x) => x.id === dok.slice(5));
      paras = D.justera(D.tolka(A.loreText(s), D.SLAG_FRI).paras, null);
      not = s.rum ? A.lasAnteckning(JSON.stringify(s.rum), dok) : A.tomAnteckning(dok);
    } else {
      const x = await lager.lasDokument(dok);
      if (!x) continue;
      ({ paras, not } = x);
    }
    const L = lage(paras, slagFor(dok));
    const P = new Map(paras.map((p, k) => [p.id, { p, ...L[k] }]));
    const var_ = (id) => {
      const x = P.get(id);
      if (x) return { stycke: id, scen: x.scen, text: x.p.text };
      const hem = A.hem(not, id, (i) => P.has(i));
      return { stycke: id, scen: hem && P.get(hem) ? P.get(hem).scen : null, text: null, borta: true };
    };
    // A Mekanik row asking for a new mechanic, not answered by Demi yet.
    paras.forEach((p, k) => {
      if (p.typ === 'mekanik' && L[k].iScen && K.arNyMekanik(p.text) && !A.demiHarSvarat(not, p.id, p.text)) {
        vantarDemi.push({ slag: 'ny-mekanik', dok, ...var_(p.id), katalog: kat.mekaniker.length });
      }
    });
    for (const k of A.vantarPa(not, DEMI)) {
      const rotId = k.svarPa || k.id;
      const rot = [...not.kommentarer, ...not.forslag].find((x) => x.id === rotId);
      vantarDemi.push({
        slag: 'fraga', dok, id: k.id, svaraPa: rotId, fran: k.skrev, nar: k.nar, text: k.text, ...var_(k.stycke),
        trad: [rot, ...A.trad(not, rotId)].filter(Boolean).map((x) => ({ id: x.id, skrev: x.skrev, text: x.text, forslag: x.lage != null })),
      });
    }
    for (const h of A.handelser(not)) {
      if (h.vem === DEMI || !h.nar || String(h.nar) <= sedan) continue;
      handelser.push({ dok, ...h, plats: var_(h.stycke) });
    }
  }
  for (const s of lore.sidor) {
    if (s.skrev !== DEMI && s.skapad && String(s.skapad) > sedan) handelser.push({ dok: `lore:${s.id}`, nar: s.skapad, vem: s.skrev, slag: 'lore', id: s.id, titel: s.titel });
    if (s.titelAndrad && s.titelAndrad.av !== DEMI && String(s.titelAndrad.nar) > sedan) handelser.push({ dok: `lore:${s.id}`, nar: s.titelAndrad.nar, vem: s.titelAndrad.av, slag: 'lore-titel', id: s.id, titel: s.titel });
    if (s.borta && s.borta.av !== DEMI && String(s.borta.nar) > sedan) handelser.push({ dok: `lore:${s.id}`, nar: s.borta.nar, vem: s.borta.av, slag: 'lore-borta', id: s.id, titel: s.titel });
  }
  // What was shown last time is known by its key, not by its time: the
  // times come from different clocks.
  const nyckel = (h) => [h.dok, h.slag, h.id || h.stycke || '', h.vem || '', h.nar || ''].join('|');
  const nycklar = handelser.map(nyckel);
  const nya = handelser.filter((h) => !sett.has(nyckel(h))).sort((a, b) => String(a.nar).localeCompare(String(b.nar)));
  // New mechanics first, then questions, oldest first.
  vantarDemi.sort((a, b) => (a.slag === b.slag ? String(a.nar || '').localeCompare(String(b.nar || '')) : a.slag === 'ny-mekanik' ? -1 : 1));
  return { vantar: vantarDemi, handelser: nya, nycklar };
}

async function loreNy(lager, u) {
  if (!u.titel || !String(u.titel).trim()) throw new CliFel('tom', 'Sidan behöver en titel.');
  const id = await lager.nyLoresida(u.titel, u.text || '');
  return { id, titel: u.titel };
}

let lagring = null;
async function steg(u) {
  lagring = minne(u.lagring);
  const lager = skapaLager(adapterFor(!!u.prov), {
    nu: () => u.nar || new Date().toISOString(),
    lagring,
    flik: 'demi',
  });
  let ut;
  if (u.op === 'rader') ut = await rader(lager, { dok: dokFor(u.dok) });
  else if (u.op === 'nytt') ut = await nytt(lager, u);
  else if (u.op === 'kommentera') ut = await kommentera(lager, u);
  else if (u.op === 'foresla') ut = await foresla(lager, u);
  else if (u.op === 'svara') ut = await svara(lager, u);
  else if (['andra', 'lagg-till', 'stryk'].includes(u.op)) ut = await andraText(lager, u);
  else if (u.op === 'lore-ny') ut = await loreNy(lager, u);
  else throw new CliFel('op', `Okänt steg: ${u.op}`);
  return { ...ut, lagring: lagring.allt() };
}

try {
  const u = await forstaRad;
  skicka({ klart: await steg(u) });
} catch (e) {
  // What waits is handed back on an error too: a note that could not be
  // written is promised to be sent next time.
  skicka({ fel: e.message || String(e), kod: e.kod || e.name || 'fel', nara: e.nara || null, lagring: lagring ? lagring.allt() : null });
}
rl.close();
process.exit(0);
