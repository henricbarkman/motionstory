// Reading and saving, on top of an adapter (data.js).
//
// Henric can have a file open in the portal's file panel, Demi can be writing
// a new draft into it, and two people can type in the room at once. So the
// room never writes from memory. A save reads the file as it is now, finds
// every paragraph in it again, merges per paragraph (dok.js: sammanfoga) and
// writes with the version it just read. If the file moved in between, the
// adapter says Krock and the save starts over.
//
// A save is two writes: the text, then the notes (who wrote it, what it said
// before). If the notes do not get through they wait in the browser as plain
// data and are sent first next time; applying them twice changes nothing.
// What someone typed and the room has not saved yet is kept in the browser
// too, so a reload or a closed window never loses it.
//
// The page gives each open document a view of its editor:
//   stycken()      -> the paragraphs as they stand, [{ id, typ, attrs, text, raw, orig, sep }]
//   tillampa(ops)  changes from outside, never into the undo history:
//                  { op: 'ersatt', id, p } | { op: 'infoga', efter, p } | { op: 'ta-bort', id }
//                  | { op: 'attrs', id, raw, orig, sep } | { op: 'byt-id', id, till }
//                  | { op: 'ordning', ids } (the paragraphs in this order)
//   laser()        -> the id of the paragraph the cursor is in, or null

import { Krock, DataFel, EPISODER, textPlats } from './data.js';
import * as D from './dok.js';
import * as A from './anteckn.js';
import { tolkaKatalog } from './katalog.js';
import { tolkaLjud } from './ljud.js';

export class SparFel extends Error {
  constructor(kod, text, extra = {}) {
    super(text);
    this.name = 'SparFel';
    this.kod = kod;
    Object.assign(this, extra);
  }
}

const FORSOK = 8;
export const slagFor = (dok) => (EPISODER.includes(dok) ? D.SLAG_EPISOD : D.SLAG_FRI);

// --- Where a document's text and notes are ---------------------------------------

function filKalla(adapter, dok) {
  const slag = slagFor(dok);
  return {
    dok,
    slag,
    async lasText() {
      const r = await adapter.las(textPlats(dok));
      if (!r) throw new SparFel('saknas', 'Texten går inte att hitta.');
      return r;
    },
    skrivText: async (text, version) => (await adapter.skriv(textPlats(dok), text, version)).version,
    async lasNot(filtext) {
      if (!adapter.kanSkriva) return { not: A.tomAnteckning(dok), version: null };
      const r = await adapter.las(`rum:${dok}`);
      return { not: A.oppna(r ? r.text : null, dok, filtext, slag), version: r ? r.version : null };
    },
    skrivNot: async (not, version) => (await adapter.skriv(`rum:${dok}`, A.skrivAnteckning(not), version)).version,
    async lasGrund() {
      if (!adapter.kanSkriva) return null;
      try {
        const r = await adapter.las(`grund:${dok}`);
        return r ? A.lasGrund(r.text) : null;
      } catch {
        return null;
      }
    },
  };
}

// A lore page: its text and its notes both live in lore.json. The text's
// version is the text itself: a write goes through only if the page still
// says what was read, whatever else changed in the file.
function loreKalla(adapter, sidId) {
  const dok = `lore:${sidId}`;
  const lasFil = async () => {
    const r = await adapter.las('lore');
    return { lore: A.lasLore(r ? r.text : null), version: r ? r.version : null };
  };
  async function byt(andring) {
    for (let n = 0; n < FORSOK; n++) {
      const { lore, version } = await lasFil();
      const ut = andring(lore, A.loreSida(lore, sidId));
      try {
        const v = await adapter.skriv('lore', A.skrivLore(lore), version);
        return { ut, version: v };
      } catch (e) {
        if (!(e instanceof Krock)) throw e;
      }
    }
    throw new SparFel('krock', 'Loresidorna ändrades hela tiden medan rummet försökte spara. Försök igen om en stund.');
  }
  // The text's version is the text, which says nothing about which of two
  // is newer. The page counts its writes (rev) for that.
  let rev = 0;
  return {
    dok,
    slag: D.SLAG_FRI,
    async lasText() {
      const { lore } = await lasFil();
      const s = A.loreSida(lore, sidId);
      const text = A.loreText(s);
      rev = Number(s.rev) || 0;
      return { text, version: text, sida: s };
    },
    async skrivText(text, version) {
      await byt((lore, s) => {
        if (A.loreText(s) !== version) throw new Krock();
        s.text = text.split('\n');
        s.rev = (Number(s.rev) || 0) + 1;
        rev = s.rev;
      });
      return text;
    },
    skuggaVersion: () => rev,
    async lasNot() {
      const r = await adapter.las('lore');
      const lore = A.lasLore(r ? r.text : null);
      const s = A.loreSida(lore, sidId);
      return { not: s.rum ? A.lasAnteckning(JSON.stringify(s.rum), dok) : A.tomAnteckning(dok), version: JSON.stringify(s.rum || null) };
    },
    // Notes on a lore page are changed in place, by function, in one write.
    async andraNot(fn) {
      const { ut } = await byt((lore, s) => {
        const fore = s.rum ? A.lasAnteckning(JSON.stringify(s.rum), dok) : A.tomAnteckning(dok);
        const ny = fn(fore);
        s.rum = ny;
        return ny;
      });
      return ut;
    },
    lasGrund: async () => null,
  };
}

// --- Things waiting in the browser ------------------------------------------------
// lagring: localStorage, or something with getItem/setItem/removeItem.
// Every window of the room shares it. Notes waiting to be written are one
// shared list per document; each item has an id and applying it twice does
// nothing, so two windows can both send it. Unsaved text is per window.

const las = (lagring, nyckel, forval) => {
  try {
    const v = lagring && lagring.getItem(nyckel);
    return v ? JSON.parse(v) : forval;
  } catch {
    return forval;
  }
};
const lagra = (lagring, nyckel, varde) => {
  if (!lagring) return true;
  try {
    if (varde == null) lagring.removeItem(nyckel); else lagring.setItem(nyckel, JSON.stringify(varde));
    return true;
  } catch {
    return false;
  }
};

// A note operation, as data, so it can wait in the browser.
const OPS = {
  delta: (not, x, grund) => A.tillampa(not, { ...x.delta, grund }),
  kommentar: (not, x) => A.nyKommentar(not, x.args),
  'andra-kommentar': (not, x) => A.andraKommentar(not, x.args),
  klar: (not, x) => A.kommentarKlar(not, x.args),
  'ta-bort': (not, x) => A.taBortKommentar(not, x.args),
  forslag: (not, x) => A.nyttForslag(not, x.args),
  'forslag-lage': (not, x) => A.forslagLage(not, x.args),
  'krock-lage': (not, x) => A.krockLage(not, x.args),
  byten: (not, x) => A.bytStycken(not, x.par),
};

// --- One open document ---------------------------------------------------------------

export class Dokument {
  constructor({ kalla, vem, nu, nyttId, lagring, prefix, flik, klocka, ritad }) {
    this.kalla = kalla;
    this.dok = kalla.dok;
    this.slag = kalla.slag;
    this.vem = vem;
    this.nu = nu;
    this.nyttId = nyttId;
    this.lagring = lagring;
    this.prefix = prefix;
    this.flik = flik;
    this.klocka = klocka;
    this.ritad = ritad || (() => {});
    this.bas = [];
    this.not = A.tomAnteckning(this.dok);
    this.notFel = null;
    this.grund = null;
    this.version = null;
    this.text = null;
    this.slut = [''];
    this.ed = null;
    this.avsikter = new Map();
    this.hallna = new Map();
    this.pagar = null;
    this.sparNr = 0;
    this.hamtar = false;
    this.efterslap = false;
    this.igen = false;
    this.lage = 'sparat';
    this.felet = null;
    this.timer = null;
    this.forstaOsparat = 0;
    this.forsok = 0;
    this.koMinne = [];
  }

  get nyckelOsparat() { return `${this.prefix}|osparat|${this.dok}|${this.flik}`; }
  get nyckelKo() { return `${this.prefix}|ko|${this.dok}`; }

  // Reads the document. -> the paragraphs to start the editor with. If this
  // window (or one that was closed) left unsaved text, that is what comes
  // back; koppla() then saves it, merged with what the file says now.
  async ladda() {
    const t = await this.kalla.lasText();
    const parsed = D.tolka(t.text, this.slag);
    let not = A.tomAnteckning(this.dok);
    let notVersion = null;
    try {
      const n = await this.kalla.lasNot(t.text);
      not = n.not;
      notVersion = n.version;
      this.notFel = null;
    } catch (e) {
      this.notFel = e;
    }
    this.grund = await this.kalla.lasGrund();
    const paras = D.justera(parsed.paras, not.stycken);
    this.not = not;
    this.notVersion = notVersion;
    this.version = t.version;
    this.text = t.text;
    this.slut = parsed.slut;
    this.bas = paras.map(rensa);
    const vantande = this.hittaVantande();
    if (vantande) {
      this.bas = vantande.bas.map(rensa);
      for (const [id, a] of vantande.avsikter || []) this.avsikter.set(id, a);
      // The file may have moved on since: the next save merges with it.
      this.version = null;
      return { paras: vantande.lokal.map(rensa), vantande: true };
    }
    return { paras: paras.map(rensa), vantande: false };
  }

  koppla(ed) {
    this.ed = ed;
    if (this.harOsparat() || this.ko().length) {
      this.satt('osparat');
      this.planera(0);
    }
  }

  // --- Unsaved text in the browser ---

  hittaVantande() {
    const egen = las(this.lagring, this.nyckelOsparat, null);
    if (egen && Array.isArray(egen.lokal) && Array.isArray(egen.bas)) return egen;
    // A window that was closed with unsaved text: take it over.
    if (!this.lagring || typeof this.lagring.length !== 'number') return null;
    const start = `${this.prefix}|osparat|${this.dok}|`;
    let basta = null;
    for (let k = 0; k < this.lagring.length; k++) {
      const n = this.lagring.key(k);
      if (!n || !n.startsWith(start) || n === this.nyckelOsparat) continue;
      const v = las(this.lagring, n, null);
      if (!v || !Array.isArray(v.lokal) || !Array.isArray(v.bas)) continue;
      if (Date.now() - Date.parse(v.levde || v.nar || 0) < 2 * 60 * 1000) continue; // still open somewhere
      if (!basta || String(v.nar) > String(basta.v.nar)) basta = { n, v };
    }
    if (!basta) return null;
    lagra(this.lagring, this.nyckelOsparat, basta.v);
    lagra(this.lagring, basta.n, null);
    return basta.v;
  }

  harOsparat() {
    if (!this.ed) return false;
    const nu = this.ed.stycken();
    if (nu.length !== this.bas.length) return true;
    return nu.some((p, k) => p.id !== this.bas[k].id || D.nyckel(p) !== D.nyckel(this.bas[k]));
  }

  // Called by the page on every change in the editor.
  andrat() {
    this.minns();
    if (this.lage !== 'sparar' && this.lage !== 'fel') this.satt('osparat');
    if (!this.forstaOsparat) this.forstaOsparat = Date.now();
    // Save after a pause in the typing, and at least every eight seconds.
    const vantat = Date.now() - this.forstaOsparat;
    this.planera(Math.max(0, Math.min(1200, 8000 - vantat)));
  }

  minns() {
    if (!this.ed) return;
    if (!this.harOsparat() && !this.avsikter.size) {
      lagra(this.lagring, this.nyckelOsparat, null);
      return;
    }
    const nu = this.nu();
    lagra(this.lagring, this.nyckelOsparat, {
      nar: nu, levde: nu, bas: this.bas, lokal: this.ed.stycken().map(rensa), avsikter: [...this.avsikter],
    });
  }

  // While the window is open its unsaved text is marked as alive, so no
  // other window takes it over.
  lever() {
    const v = las(this.lagring, this.nyckelOsparat, null);
    if (v) { v.levde = this.nu(); lagra(this.lagring, this.nyckelOsparat, v); }
  }

  planera(ms) {
    if (!this.klocka) return;
    if (this.timer) this.klocka.clearTimeout(this.timer);
    this.timer = this.klocka.setTimeout(() => { this.timer = null; this.spara().catch(() => {}); }, ms);
  }

  satt(lage, felet = null) {
    this.lage = lage;
    this.felet = felet;
    this.ritad({ lage, felet });
  }

  // Something to record with the next save of a paragraph: whose words they
  // are (a proposal laid in, an earlier version taken back, a krock chosen).
  // a: { nyckel (the paragraph as it will be saved), hur, vem, forslag?, krock? }
  avsikt(id, a) {
    this.avsikter.set(id, a);
    this.minns();
  }

  // --- Saving ---

  spara() {
    if (!this.ed) return Promise.resolve();
    if (this.pagar) { this.igen = true; return this.pagar; }
    this.sparNr += 1;
    this.pagar = (async () => {
      try {
        do {
          this.igen = false;
          await this.sparaEnGang();
        } while (this.igen);
        this.forsok = 0;
      } catch (e) {
        this.forsok += 1;
        this.satt('fel', e);
        // Try again by itself, slower each time.
        this.planera([2000, 5000, 15000, 30000][Math.min(this.forsok - 1, 3)]);
        throw e;
      } finally {
        this.pagar = null;
      }
    })();
    return this.pagar;
  }

  // What can be written: a paragraph that would not read back as itself is
  // held in the browser, and the file keeps its earlier version.
  forbered(lokal) {
    const basM = new Map(this.bas.map((p) => [p.id, p]));
    const omr = D.scenomrade(lokal.map((p) => p.typ), this.slag);
    const sanda = [];
    const hallna = new Map();
    lokal.forEach((p, k) => {
      const f = D.fel(p, omr[k]);
      if (!f) { sanda.push(p); return; }
      hallna.set(p.id, f);
      if (basM.has(p.id)) sanda.push(basM.get(p.id));
    });
    return { sanda, hallna };
  }

  async sparaEnGang() {
    const vantarNot = this.ko().length > 0;
    if (!this.harOsparat() && !this.avsikter.size && this.version != null) {
      if (vantarNot) await this.tommaKo();
      this.forstaOsparat = 0;
      if (this.ko().length) this.satt('fel', this.notFel);
      else this.satt('sparat');
      return;
    }
    this.satt('sparar');
    if (vantarNot) await this.tommaKo();
    for (let n = 0; n < FORSOK; n++) {
      const lokal = this.ed.stycken().map(rensa);
      let { sanda, hallna } = this.forbered(lokal);
      const t = await this.kalla.lasText();
      let not = this.not;
      try {
        not = (await this.kalla.lasNot(t.text)).not;
        this.notFel = null;
      } catch (e) {
        this.notFel = e;
      }
      const parsed = D.tolka(t.text, this.slag);
      const fjarr = D.justera(parsed.paras, not.stycken).map(rensa);
      sanda = this.byt(D.namnbyten(new Map(this.bas.map((p) => [p.id, p])), sanda, fjarr), sanda);
      let resultat = null;
      let felaktigt = null;
      // The last check: the whole file as it would be written must read back
      // as these very paragraphs. A paragraph of mine that breaks it is held.
      for (let k = 0; k < 6; k++) {
        const { paras, krockar } = D.sammanfoga(this.bas, sanda, fjarr);
        const text = D.skriv({ paras, slut: parsed.slut });
        const fel = forstaFel(text, paras, this.slag);
        if (fel < 0) { resultat = { paras, krockar, text }; break; }
        felaktigt = paras[fel];
        const id = paras[fel].id;
        const b = this.bas.find((p) => p.id === id);
        const egen = sanda.find((p) => p.id === id);
        if (!egen || (b && D.nyckel(b) === D.nyckel(egen))) break;
        hallna.set(id, 'form');
        sanda = sanda.flatMap((p) => (p.id !== id ? [p] : b ? [b] : []));
      }
      this.hallna = hallna;
      if (!resultat) {
        // Usually a line (---) or a scene heading was taken away, and the
        // paragraphs around it would read as something else in the file.
        const t0 = felaktigt && felaktigt.text ? felaktigt.text.trim() : '';
        const vilket = t0 ? `Stycket «${t0.length > 60 ? `${t0.slice(0, 59).trimEnd()}…` : t0}»` : 'Ett stycke';
        throw new SparFel('format', `${vilket} skulle läsas som något annat i filen om rummet sparade nu, så inget sparades. Det händer oftast när en avdelare (---) eller en scenrubrik har tagits bort. Ångra med Ctrl+Z eller ändra stycket. Det du skrev finns kvar här.`);
      }
      let version = t.version;
      if (resultat.text !== t.text) {
        try {
          version = await this.kalla.skrivText(resultat.text, t.version);
        } catch (e) {
          if (e instanceof Krock) continue;
          throw e;
        }
      }
      const q = D.tolka(resultat.text, this.slag);
      const filen = resultat.paras.map((p, k) => ({ ...rensa(q.paras[k]), id: p.id }));
      const delta = this.delta(sanda, filen, resultat.krockar, version, not);
      this.efter(sanda, filen, { sparad: true });
      this.version = version;
      this.text = resultat.text;
      this.slut = q.slut;
      if (delta.poster.length || delta.krockar.length || delta.forslag.length || delta.krockLagen.length
        || JSON.stringify(not.stycken) !== JSON.stringify(delta.skugga.stycken)) {
        this.laggIKo({ id: delta.id, slag: 'delta', delta });
      }
      if (this.ko().length) await this.tommaKo();
      this.minns();
      this.forstaOsparat = this.harOsparat() ? Date.now() : 0;
      if (this.ko().length) this.satt('fel', this.notFel || new SparFel('anteckningar', 'Texten är sparad, men anteckningen om vem som skrev väntar i webbläsaren.'));
      else this.satt(this.harOsparat() && !this.hallnaBara() ? 'osparat' : 'sparat');
      if (this.harOsparat() && !this.hallnaBara()) this.igen = true;
      return;
    }
    throw new SparFel('krock', 'Filen ändrades hela tiden medan rummet försökte spara. Rummet försöker igen strax.');
  }

  // Only held paragraphs differ from the file: nothing more to save now.
  hallnaBara() {
    const nu = this.ed.stycken();
    const B = new Map(this.bas.map((p) => [p.id, p]));
    const N = new Set(nu.map((p) => p.id));
    return nu.every((p) => this.hallna.has(p.id) || (B.has(p.id) && D.nyckel(B.get(p.id)) === D.nyckel(p)))
      && this.bas.every((b) => N.has(b.id))
      && sammaOrdning(nu.filter((p) => B.has(p.id)), this.bas.filter((b) => N.has(b.id)));
  }

  // Renames from namnbyten: in the base, the editor and what is being sent.
  byt(karta, sanda) {
    if (!karta.size) return sanda;
    this.bas = this.bas.map((p) => (karta.has(p.id) ? { ...p, id: karta.get(p.id) } : p));
    const ops = [];
    for (const [fran, till] of karta) {
      ops.push({ op: 'byt-id', id: fran, till });
      if (this.avsikter.has(fran)) { this.avsikter.set(till, this.avsikter.get(fran)); this.avsikter.delete(fran); }
    }
    this.ed.tillampa(ops);
    // What hangs on the old name in the notes (history, comments) moves too.
    this.laggIKo({ id: this.nyttId(), slag: 'byten', par: [...karta] });
    return sanda.map((p) => (karta.has(p.id) ? { ...p, id: karta.get(p.id) } : p));
  }

  // The history this save adds, and what it settles.
  delta(sanda, filen, krockar, version, notNu) {
    const vem = this.vem;
    const nar = this.nu();
    const B = new Map(this.bas.map((p) => [p.id, p]));
    const S = new Map(sanda.map((p) => [p.id, p]));
    const F = new Map(filen.map((p) => [p.id, p]));
    const poster = [];
    const forslag = [];
    const krockLagen = [];
    for (const p of sanda) {
      const f = F.get(p.id);
      const b = B.get(p.id);
      if (!f || D.nyckel(f) !== D.nyckel(p)) continue;
      if (b && D.nyckel(b) === D.nyckel(p)) continue;
      const a = this.avsikter.get(p.id);
      const galler = !!a && a.nyckel === D.nyckel(p);
      const post = { text: p.text, typ: p.typ, attrs: p.attrs, vem: galler && a.vem ? a.vem : vem, nar, hur: galler && a.hur ? a.hur : (b ? 'andrade' : 'skrev') };
      if (galler && (a.vem !== vem || ['tillbaka', 'krock', 'forslag'].includes(a.hur))) post.av = vem;
      poster.push({ id: p.id, post, fore: b ? version0(b) : null });
      if (galler && a.forslag) forslag.push({ id: a.forslag, lage: 'inlagt', av: vem, nar });
      if (galler && a.krock) krockLagen.push({ id: a.krock, lage: 'vald' });
      if (a) this.avsikter.delete(p.id);
    }
    this.bas.forEach((b, k) => {
      if (S.has(b.id) || F.has(b.id)) return;
      let efter = null;
      for (let x = k - 1; x >= 0; x--) if (F.has(this.bas[x].id)) { efter = this.bas[x].id; break; }
      poster.push({ id: b.id, post: { borta: true, efter, vem, nar }, fore: version0(b) });
    });
    const kr = [];
    for (const k of krockar) {
      if (k.slag !== 'text') continue;
      const v = A.vemSkrev(notNu, k.id, k.fjarr, this.grund);
      kr.push({ id: this.nyttId(), stycke: k.id, ...version0(k.fjarr), vem: v.vem, nar });
    }
    // An avsikt for a paragraph that is gone, or was typed over, is dropped.
    for (const [id, a] of this.avsikter) {
      const p = S.get(id);
      if (!p || a.nyckel !== D.nyckel(p)) this.avsikter.delete(id);
    }
    return {
      id: this.nyttId(), vem, nar, skugga: { version: this.kalla.skuggaVersion ? this.kalla.skuggaVersion() : version, stycken: D.skuggaFor(filen) }, poster, krockar: kr, forslag, krockLagen,
    };
  }

  // After a save (filen: what the file now says) or a read (filen: the file
  // as read): bring the editor and the base up to date, without touching
  // what someone is typing. A paragraph is replaced in the editor only if
  // nobody changed it there since the base, and the cursor is not in it.
  efter(sanda, filen, { sparad = false } = {}) {
    const nu = this.ed.stycken();
    const N = new Map(nu.map((p) => [p.id, p]));
    const S = new Map(sanda.map((p) => [p.id, p]));
    const F = new Map(filen.map((p) => [p.id, p]));
    const B = new Map(this.bas.map((p) => [p.id, p]));
    const laser = this.ed.laser();
    const ops = [];
    const nyBas = new Map();
    const orord = (id) => B.has(id) && N.has(id) && D.nyckel(N.get(id)) === D.nyckel(B.get(id));
    // Left as it is only because the cursor is in it: the next read brings it.
    let slapar = false;
    // Moved here since the base? Then this window's order stands until it saves.
    const iAlla = (p) => N.has(p.id) && B.has(p.id) && F.has(p.id);
    const flyttatHar = !sammaOrdning(nu.filter(iAlla), this.bas.filter(iAlla));
    const harFatt = new Set(nu.map((p) => p.id));
    let foreId = null;
    for (const f of filen) {
      const e = N.get(f.id);
      const s = S.get(f.id);
      if (e) {
        if (D.nyckel(e) === D.nyckel(f)) {
          nyBas.set(f.id, f);
          if (e.raw !== f.raw || e.orig !== f.orig || JSON.stringify(e.sep) !== JSON.stringify(f.sep)) ops.push({ op: 'attrs', id: f.id, raw: f.raw, orig: f.orig, sep: f.sep });
        } else if (orord(f.id) && f.id !== laser && !this.hallna.has(f.id)) {
          ops.push({ op: 'ersatt', id: f.id, p: f });
          nyBas.set(f.id, f);
        } else if (sparad && s && D.nyckel(s) === D.nyckel(f)) {
          nyBas.set(f.id, f);
        } else if (B.has(f.id)) {
          if (orord(f.id) && f.id === laser) slapar = true;
          nyBas.set(f.id, B.get(f.id));
        }
      } else if (!S.has(f.id) && !(B.has(f.id) && D.nyckel(B.get(f.id)) === D.nyckel(f))) {
        // New in the file, or changed there after it was removed here.
        ops.push({ op: 'infoga', efter: foreId, p: f });
        harFatt.add(f.id);
        nyBas.set(f.id, f);
      } else if (sparad && s && D.nyckel(s) === D.nyckel(f)) {
        nyBas.set(f.id, f);
      } else if (B.has(f.id)) {
        nyBas.set(f.id, B.get(f.id));
      }
      if (harFatt.has(f.id)) foreId = f.id;
    }
    for (const e of nu) {
      if (F.has(e.id) || !B.has(e.id)) continue;
      // Gone from the file: removed by someone else.
      if (orord(e.id) && e.id !== laser && !this.hallna.has(e.id)) ops.push({ op: 'ta-bort', id: e.id });
      else {
        if (orord(e.id) && e.id === laser) slapar = true;
        nyBas.set(e.id, B.get(e.id));
      }
    }
    this.efterslap = slapar;
    if (ops.length) this.ed.tillampa(ops);
    // The order: the file's, when someone else moved paragraphs. What only
    // the editor has stays after the paragraph it follows there.
    if (sparad || !flyttatHar) {
      const har = this.ed.stycken().map((p) => p.id);
      const H = new Set(har);
      const mal = filen.map((p) => p.id).filter((id) => H.has(id));
      if (!lika(mal, har.filter((id) => F.has(id)))) {
        let index = new Map(mal.map((id, k) => [id, k]));
        har.forEach((id, k) => {
          if (index.has(id)) return;
          let plats = 0;
          for (let x = k - 1; x >= 0; x--) if (index.has(har[x])) { plats = index.get(har[x]) + 1; break; }
          mal.splice(plats, 0, id);
          index = new Map(mal.map((i, n) => [i, n]));
        });
        this.ed.tillampa([{ op: 'ordning', ids: mal }]);
      }
    }
    // The base in the file's order; what only the editor still has keeps its
    // place after the paragraph it followed.
    const lista = filen.filter((p) => nyBas.has(p.id)).map((p) => nyBas.get(p.id));
    const fore = this.bas;
    fore.forEach((b, k) => {
      if (F.has(b.id) || !nyBas.has(b.id)) return;
      let plats = 0;
      for (let x = k - 1; x >= 0; x--) {
        const i = lista.findIndex((p) => p.id === fore[x].id);
        if (i >= 0) { plats = i + 1; break; }
      }
      lista.splice(plats, 0, nyBas.get(b.id));
    });
    this.bas = lista.map(rensa);
  }

  // --- Reading what others did ---

  // -> true when something changed. Never during a save: the save brings it.
  async hamta() {
    if (!this.ed || this.pagar || this.hamtar) return false;
    this.hamtar = true;
    const nr = this.sparNr;
    let t;
    let n = null;
    try {
      t = await this.kalla.lasText();
      try {
        n = await this.kalla.lasNot(t.text);
        this.notFel = null;
      } catch (e) {
        this.notFel = e;
      }
    } finally {
      this.hamtar = false;
    }
    // A save that ran meanwhile has already brought the file in, and what
    // was read here is older than that.
    if (this.pagar || this.sparNr !== nr) return false;
    const notAndrad = !!n && n.version !== this.notVersion;
    if (t.version === this.version && !notAndrad && !this.efterslap) return false;
    if (n) { this.not = n.not; this.notVersion = n.version; }
    if (t.version !== this.version || this.efterslap) {
      const parsed = D.tolka(t.text, this.slag);
      const fjarr = D.justera(parsed.paras, this.not.stycken).map(rensa);
      const { sanda: s0, hallna } = this.forbered(this.ed.stycken().map(rensa));
      this.hallna = hallna;
      const sanda = this.byt(D.namnbyten(new Map(this.bas.map((p) => [p.id, p])), s0, fjarr), s0);
      this.efter(sanda, fjarr);
      this.version = t.version;
      this.text = t.text;
      this.slut = parsed.slut;
      this.minns();
      if (this.harOsparat() && !this.hallnaBara()) this.andrat();
    }
    if (this.ko().length && !this.pagar) this.tommaKo().catch(() => {});
    return true;
  }

  // --- Notes ---

  ko() { return this.lagring ? las(this.lagring, this.nyckelKo, []) : this.koMinne; }

  laggIKo(x) {
    const lista = this.ko().slice();
    if (!lista.some((y) => y.id === x.id)) lista.push(x);
    this.koMinne = lista;
    lagra(this.lagring, this.nyckelKo, lista);
  }

  taUrKo(id) {
    const lista = this.ko().filter((y) => y.id !== id);
    this.koMinne = lista;
    lagra(this.lagring, this.nyckelKo, lista.length ? lista : null);
  }

  // Sends what waits, oldest first. -> true when nothing waits any more.
  async tommaKo() {
    for (;;) {
      const lista = this.ko();
      if (!lista.length) return true;
      const x = lista[0];
      try {
        await this.andraNot((not) => (OPS[x.slag] ? OPS[x.slag](not, x, this.grund) : not));
      } catch (e) {
        this.notFel = e;
        // A note that can never go in (its comment is gone, say) must not
        // block everything after it. A broken or unreachable file waits.
        if (!(e instanceof A.RumFel) || e.kod === 'trasig') return false;
      }
      this.taUrKo(x.id);
    }
  }

  // Read fresh, change, write with the version just read.
  async andraNot(fn) {
    if (this.kalla.andraNot) {
      this.not = await this.kalla.andraNot(fn);
      return this.not;
    }
    for (let n = 0; n < 20; n++) {
      const t = this.text != null ? this.text : (await this.kalla.lasText()).text;
      const r = await this.kalla.lasNot(t);
      const ny = fn(r.not);
      if (ny === r.not) { this.not = r.not; this.notVersion = r.version; return r.not; }
      try {
        this.notVersion = await this.kalla.skrivNot(ny, r.version);
        this.not = ny;
        return ny;
      } catch (e) {
        if (!(e instanceof Krock)) throw e;
      }
    }
    throw new SparFel('krock', 'Anteckningarna ändrades hela tiden medan rummet försökte spara. Försök igen om en stund.');
  }

  // A comment, a proposal, done, removed: waits in the browser until it is in.
  // -> true when it is written.
  async anteckna(slag, args) {
    const x = { id: this.nyttId(), slag, args };
    this.not = OPS[slag](this.not, x, this.grund);
    this.laggIKo(x);
    const ok = await this.tommaKo();
    if (!ok) this.satt('fel', this.notFel);
    return ok;
  }

  // --- What the page shows ---

  vemSkrev(p) {
    if (this.hallna.has(p.id) || !this.bas.some((b) => b.id === p.id && D.nyckel(b) === D.nyckel(p))) {
      return { vem: this.vem, nar: null, hur: 'osparat' };
    }
    return A.vemSkrev(this.not, p.id, p, this.grund);
  }
}

const lika = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
const sammaOrdning = (a, b) => lika(a.map((p) => p.id), b.map((p) => p.id));

function rensa(p) {
  return {
    id: p.id,
    typ: p.typ,
    attrs: D.rensaAttrs(p.typ, p.attrs),
    text: p.text,
    raw: p.raw == null ? null : p.raw,
    orig: p.orig == null ? null : p.orig,
    sep: Array.isArray(p.sep) ? p.sep.slice() : null,
  };
}

const version0 = (p) => ({ text: p.text, typ: p.typ, attrs: D.rensaAttrs(p.typ, p.attrs) });

function forstaFel(text, paras, slag) {
  const q = D.tolka(text, slag).paras;
  const n = Math.min(q.length, paras.length);
  for (let k = 0; k < n; k++) if (D.nyckel(q[k]) !== D.nyckel(paras[k])) return k;
  return q.length === paras.length ? -1 : Math.max(0, n - 1);
}

// --- The store ----------------------------------------------------------------------

// A text file with Windows line endings is read as if it had ours, and
// written back with its own.
const AR_TEXT = /^(manus:|varld$|mekaniker$|held$)/;
function utanCR(adapter) {
  const crlf = new Set();
  return {
    ...adapter,
    async las(plats) {
      const r = await adapter.las(plats);
      if (!r || !AR_TEXT.test(plats) || typeof r.text !== 'string' || !r.text.includes('\r')) { crlf.delete(plats); return r; }
      crlf.add(plats);
      return { ...r, text: r.text.replace(/\r\n?/g, '\n') };
    },
    skriv: (plats, text, version) => adapter.skriv(plats, crlf.has(plats) ? text.replace(/\n/g, '\r\n') : text, version),
    vem: () => adapter.vem(),
  };
}

export function skapaLager(adapter0, {
  nu = () => new Date().toISOString(),
  nyttId = D.nyttId,
  lasTider = async () => null,
  lagring = null,
  flik = 'f',
  klocka = null,
} = {}) {
  const adapter = utanCR(adapter0);
  let jag = null;
  const prefix = `glimt-rummet|${adapter.rot || adapter.namn}`;

  async function vem() {
    if (!jag) jag = await adapter.vem();
    return jag;
  }

  async function skribent() {
    const p = adapter.kanSkriva ? await vem() : null;
    if (!p) throw new SparFel('laslage', 'Här går det bara att läsa.');
    return p.id;
  }

  // An open document. dok: '1', '2', 'varld', 'mekaniker' or 'lore:<id>'.
  async function dokument(dok, { ritad } = {}) {
    const p = adapter.kanSkriva ? await vem() : null;
    const kalla = dok.startsWith('lore:') ? loreKalla(adapter, dok.slice(5)) : filKalla(adapter, dok);
    return new Dokument({ kalla, vem: p ? p.id : null, nu, nyttId, lagring, prefix, flik, klocka, ritad });
  }

  async function lasText(plats) {
    const r = await adapter.las(plats);
    return r ? r.text : null;
  }

  async function katalog() {
    return tolkaKatalog((await lasText('mekaniker')) || '');
  }

  async function ljud(nr) {
    const [l, tider] = await Promise.all([adapter.las(`ljud:${nr}`), lasTider().catch(() => null)]);
    try {
      return l ? tolkaLjud(l.text, tider) : null;
    } catch {
      return null;
    }
  }

  async function bytJson(plats, lasa, skriva, andring) {
    for (let n = 0; n < 20; n++) {
      const fil = await adapter.las(plats);
      const ny = andring(lasa(fil ? fil.text : null));
      try {
        await adapter.skriv(plats, skriva(ny), fil ? fil.version : null);
        return ny;
      } catch (e) {
        if (!(e instanceof Krock)) throw e;
      }
    }
    throw new SparFel('krock', 'Filen ändrades hela tiden medan rummet försökte spara. Försök igen om en stund.');
  }

  async function lasInstallningar() {
    const p = await vem();
    const fil = adapter.kanSkriva ? await adapter.las('installningar') : null;
    return A.installningFor(A.lasInstallningar(fil ? fil.text : null), p && p.id);
  }

  async function sattInstallning(nyckel, varde) {
    const p = await skribent();
    const inst = await bytJson('installningar', A.lasInstallningar, (x) => `${JSON.stringify(x, null, 2)}\n`,
      (i) => A.sattInstallning(i, { vem: p, nyckel, varde, nar: nu() }));
    return A.installningFor(inst, p);
  }

  async function lasLore() {
    if (!adapter.kanSkriva) return A.tomLore();
    const fil = await adapter.las('lore');
    return A.lasLore(fil ? fil.text : null);
  }

  const byttLore = (andring) => bytJson('lore', A.lasLore, A.skrivLore, andring);

  async function nyLoresida(titel, text = '') {
    const p = await skribent();
    const id = nyttId();
    await byttLore((l) => A.nyLoresida(l, { id, titel, text, vem: p, nar: nu() }));
    return id;
  }

  async function loreTitel(id, titel) {
    const p = await skribent();
    return byttLore((l) => A.loreTitel(l, { id, titel, vem: p, nar: nu() }));
  }

  async function taBortLoresida(id, tillbaka = false) {
    const p = await skribent();
    return byttLore((l) => A.taBortLoresida(l, { id, vem: p, nar: nu(), tillbaka }));
  }

  // The notes and text of several documents, for "where is this mechanic used".
  async function lasDokument(dok) {
    const t = await adapter.las(textPlats(dok));
    if (!t) return null;
    let not = A.tomAnteckning(dok);
    try {
      const r = adapter.kanSkriva ? await adapter.las(`rum:${dok}`) : null;
      not = A.oppna(r ? r.text : null, dok, t.text, slagFor(dok));
    } catch {
      // the text is enough
    }
    return { text: t.text, paras: D.justera(D.tolka(t.text, slagFor(dok)).paras, not.stycken), not };
  }

  return {
    adapter,
    kanSkriva: !!adapter.kanSkriva,
    vem,
    dokument,
    lasText,
    lasDokument,
    katalog,
    ljud,
    lasInstallningar,
    sattInstallning,
    lasLore,
    nyLoresida,
    loreTitel,
    taBortLoresida,
  };
}

export { DataFel };
