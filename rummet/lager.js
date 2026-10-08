// Reading and saving, on top of an adapter (data.js).
//
// Henric can have the manuscript open in the portal's file panel, and Demi
// can be writing a draft in the same file, while someone types here. So the
// room never writes from memory. Every save reads the file as it is now,
// finds its line again by anchor in that fresh text, changes only that, and
// writes with the version it just read. If the file moved in between, the
// adapter says Krock and the save starts over. If the line is no longer there
// the save stops and the words stay with the person who typed them.
//
// A change to the manuscript is two writes: the text, then the note in the
// room's file about who wrote it. If the second one does not get through, the
// note waits as plain data (an avsikt) in the browser, survives a reload, and
// is sent before anything else is saved in the room.

import { tolka, andra, laggTill, stryk, laggTillbaka, hitta, kartaFran } from './manus.js';
import { tolkaLjud } from './ljud.js';
import * as R from './rum.js';
import { Krock } from './data.js';

export class SparFel extends Error {
  constructor(kod, text, extra = {}) {
    super(text);
    this.name = 'SparFel';
    this.kod = kod;
    Object.assign(this, extra);
  }
}

const FORSOK = 6;

export function skapaLager(adapter, {
  nu = () => new Date().toISOString(),
  nyttId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  lasTider = async () => null, // measured paragraph times for the clips, if any
  ko = null, // { las() -> [avsikt], skriv([avsikt]) }: where waiting notes are kept
} = {}) {
  let jag = null;
  // Notes that should follow a manuscript change but could not be saved.
  // The browser keeps them (ko), and every window of the room shares that
  // list: it is read again before it changes, and each note has its own id
  // (aid), so one window never undoes another's and none is applied twice.
  const vantar = [];
  const TYPER = ['andrad', 'tillagd', 'struken', 'tillbakalagd', 'steg'];
  // A note from before ids gets one from its content: the same in every
  // window and on every read.
  const innehallsId = (a) => {
    let h = 5381;
    const t = JSON.stringify(a);
    for (let k = 0; k < t.length; k++) h = ((h * 33) ^ t.charCodeAt(k)) >>> 0;
    return `k${h.toString(36)}${t.length.toString(36)}`;
  };
  const giltig = (a) => !!a && typeof a === 'object' && TYPER.includes(a.typ) && typeof a.nr === 'string'
    && typeof a.fore === 'string' && typeof a.efter === 'string' && typeof a.vem === 'string';
  // false while the last write to the browser's list failed: then what this
  // window holds is newer than the list, and a read must not throw it away.
  let lagrat = true;
  const synka = () => {
    if (!ko) return;
    let sparade;
    try {
      sparade = ko.las();
    } catch {
      return; // unreadable: keep what this window holds
    }
    const raa = Array.isArray(sparade) ? sparade : [];
    const lista = raa.filter(giltig).map((a) => (a.aid ? a : { ...a, aid: innehallsId(a) }));
    if (!lagrat) {
      let fler = false;
      for (const a of vantar) if (!lista.some((x) => x.aid === a.aid)) { lista.push(a); fler = true; }
      // Oldest first, so a change is never applied over a later one.
      if (fler) lista.sort((x, y) => String(x.nar || '').localeCompare(String(y.nar || '')));
    }
    vantar.splice(0, vantar.length, ...lista);
    // A note from before ids, junk in the list, or notes only this window had.
    if (!lagrat || lista.length !== raa.length || raa.some((a) => giltig(a) && !a.aid)) sparaKo();
  };
  const sparaKo = () => {
    if (!ko) return;
    try {
      ko.skriv(vantar.slice());
      lagrat = true;
    } catch {
      lagrat = false; // the note still waits in memory
    }
  };
  synka();

  async function vem() {
    if (!jag) jag = await adapter.vem();
    return jag;
  }

  // manniska: the step decides something (the manuscript, a yes, whose a
  // line is), and Demi never does.
  async function skribent({ manniska = false } = {}) {
    const p = adapter.kanSkriva ? await vem() : null;
    if (!p) throw new SparFel('laslage', 'Här går det bara att läsa.');
    if (manniska && R.arAI(p.id)) {
      throw new SparFel('bara-manniskor', 'Det här gör bara en människa i rummet: Henric eller Liv.');
    }
    return p.id;
  }

  // Read fresh, change, write with the version just read. andring gets the
  // text (null when the file is missing) and returns { text, ... }. If it
  // throws, nothing is written.
  async function bytText(plats, andring, { saknasOk = false } = {}) {
    for (let n = 0; n < FORSOK; n++) {
      const fil = await adapter.las(plats);
      if (!fil && !saknasOk) throw new SparFel('saknas', 'Filen som skulle ändras finns inte.');
      const ut = andring(fil ? fil.text : null);
      if (fil && ut.text === fil.text) return { ...ut, fore: fil.text, version: fil.version, oforandrad: true };
      try {
        const svar = await adapter.skriv(plats, ut.text, fil ? fil.version : null);
        return { ...ut, fore: fil ? fil.text : null, version: svar.version };
      } catch (e) {
        if (!(e instanceof Krock)) {
          // The answer can be lost after the file was written. If the file
          // now says exactly what was sent, the write went through.
          let efter = null;
          try {
            efter = await adapter.las(plats);
          } catch {
            // Still out of reach: report the first error.
          }
          if (efter && efter.text === ut.text) return { ...ut, fore: fil ? fil.text : null, version: efter.version };
          throw e;
        }
      }
    }
    throw new SparFel('upptagen', 'Filen ändras av någon annan just nu, gång på gång. Försök igen om en stund.');
  }

  const bytRum = (nr, mutera) => bytText(`rum:${nr}`, (text) => ({ text: R.skrivRum(mutera(R.lasRum(text, nr))) }), { saknasOk: true });

  async function lasbartRum(nr) {
    const fil = await adapter.las(`rum:${nr}`);
    return R.lasRum(fil ? fil.text : null, nr); // throws when the file is broken
  }

  async function grund(nr) {
    const fil = await adapter.las(`grund:${nr}`);
    return R.lasGrund(fil ? fil.text : null);
  }

  // What a manuscript change means for the room's notes, from an avsikt:
  // { typ, nr, fore, efter (the manuscript before and after), i, skift, vem,
  // nar, ... }. Plain data, so it can wait in the browser.
  function tillampa(rum, a, g) {
    let ut;
    try {
      // Already in the file (another window sent it, or an answer was lost
      // after the write went through): nothing to do.
      if (a.aid && rum.logg.some((l) => l && l.avsikt === a.aid)) return rum;
      ut = tillampaEn(rum, a, g);
    } catch (e) {
      if (e instanceof R.RumFel) throw e;
      // The note itself cannot be applied; trying again would fail the same way.
      throw new R.RumFel('avsikt', 'Anteckningen om vem som skrev repliken gick inte att lägga in.');
    }
    if (ut === rum) return rum;
    for (let k = rum.logg.length; k < ut.logg.length; k++) ut.logg[k].avsikt = a.aid;
    // Every applied note leaves its id in the log, also one that logged nothing.
    if (ut.logg.length === rum.logg.length) ut.logg.push({ nar: a.nar, vem: a.vem, vad: 'avsikt', avsikt: a.aid });
    return ut;
  }

  function tillampaEn(rum, a, g) {
    const manusFore = tolka(a.fore);
    const manusEfter = tolka(a.efter);
    const karta = kartaFran(a.skift);
    const bas = { manusFore, manusEfter, karta, i: a.i, vem: a.vem, nar: a.nar };
    let ut = rum;
    if (a.typ === 'andrad') ut = R.efterAndrad(rum, { ...bas, grund: g, ...a.post });
    else if (a.typ === 'tillagd') ut = R.efterTillagd(rum, bas);
    else if (a.typ === 'struken') ut = R.efterStruken(rum, { ...bas, i: a.iFore, struken: a.struken, id: a.id, grund: g });
    else if (a.typ === 'tillbakalagd') ut = R.efterTillbakalagd(rum, { ...bas, id: a.id });
    for (const steg of a.steg || []) {
      if (steg.typ === 'inlagt') {
        ut = R.forslagInlagt(ut, { id: steg.id, vem: a.vem, nar: a.nar, ersatte: { kropp: a.foreKropp } });
      } else if (steg.typ === 'oppna-igen') {
        // A proposal that had replaced the text lies open beside the line again.
        for (const f of ut.forslag) {
          if (f.lage === 'inlagt' && f.mal.text != null && f.kropp === a.foreKropp && hitta(manusEfter, f.mal) === a.i) {
            ut = R.forslagOppnatIgen(ut, { id: f.id, vem: a.vem, nar: a.nar });
          }
        }
      }
    }
    return ut;
  }

  // The manuscript is saved first. If the note about it cannot be saved the
  // text is still safe; the line just shows as changed outside the room until
  // the note gets through.
  async function rumEfter(avsikt0) {
    const avsikt = { ...avsikt0, aid: nyttId() };
    try {
      const g = await grund(avsikt.nr);
      await bytRum(avsikt.nr, (rum) => tillampa(rum, avsikt, g));
    } catch (e) {
      if (e instanceof R.RumFel) throw e;
      synka();
      vantar.push(avsikt);
      sparaKo();
      throw new SparFel(
        'halvt',
        'Texten är sparad i manuset, men anteckningen om vem som skrev den kom inte fram. Den sparas när du försöker igen.',
        { orsak: e },
      );
    }
  }

  // Sends the waiting notes, oldest first. A note the room's file can no
  // longer take (the proposal it marks is gone, say) is dropped; one that
  // fails for any other reason stays, and so do the ones after it.
  async function forsokIgen() {
    synka();
    const gjorda = new Set();
    while (vantar.length && !gjorda.has(vantar[0].aid)) {
      const a = vantar[0];
      gjorda.add(a.aid);
      try {
        const g = await grund(a.nr);
        await bytRum(a.nr, (rum) => tillampa(rum, a, g));
      } catch (e) {
        if (!(e instanceof R.RumFel) || e.kod === 'trasig') throw e;
      }
      synka();
      const k = vantar.findIndex((x) => x.aid === a.aid);
      if (k >= 0) vantar.splice(k, 1);
      sparaKo();
    }
  }

  // Gives up on the waiting notes: the ones whose ids are given (those the
  // page showed), so a note another window left meanwhile is not thrown away
  // unseen; all of them without ids. The lines they were about show as
  // changed outside the room, and a person can say whose they are.
  function slangVantande(aids) {
    synka();
    const kasta = Array.isArray(aids) ? new Set(aids) : null;
    const kvar = kasta ? vantar.filter((a) => !kasta.has(a.aid)) : [];
    vantar.splice(0, vantar.length, ...kvar);
    sparaKo();
  }

  // Before anything new is saved in an episode, the notes that wait go first,
  // so they are never overtaken. If they still do not get through, nothing
  // new is saved; the form keeps its text.
  async function iFas() {
    synka(); // another window may have left a note since this one loaded
    if (!vantar.length) return;
    try {
      await forsokIgen();
    } catch (e) {
      throw new SparFel(
        'efterslapar',
        'En tidigare anteckning om vem som skrev en replik har inte kommit fram än, så inget nytt sparas förrän den gjort det. Din text finns kvar; försök igen om en stund.',
        { orsak: e },
      );
    }
  }

  // --- Reading ---------------------------------------------------------------

  async function lasEpisod(nr) {
    synka();
    const [manus, rum, grundFil, ljud, tider] = await Promise.all([
      adapter.las(`manus:${nr}`),
      adapter.kanSkriva ? adapter.las(`rum:${nr}`) : null,
      adapter.kanSkriva ? adapter.las(`grund:${nr}`) : null,
      adapter.las(`ljud:${nr}`),
      lasTider().catch(() => null),
    ]);
    if (!manus) throw new SparFel('saknas', `Manuset för episod ${nr} går inte att hitta.`);
    let rumFel = null;
    let rumObj = R.tomtRum(nr);
    try {
      rumObj = R.lasRum(rum ? rum.text : null, nr);
    } catch (e) {
      rumFel = e;
    }
    let ljudObj = null;
    try {
      ljudObj = ljud ? tolkaLjud(ljud.text, tider) : null;
    } catch {
      ljudObj = null;
    }
    return {
      nr,
      text: manus.text,
      manus: tolka(manus.text),
      rum: rumObj,
      rumFel,
      grund: R.lasGrund(grundFil ? grundFil.text : null),
      ljud: ljudObj,
    };
  }

  async function lasText(plats) {
    const fil = await adapter.las(plats);
    return fil ? fil.text : null;
  }

  // --- The manuscript ---------------------------------------------------------
  // Only people change the manuscript.

  // steg: what else the note should say, as data ({ typ: 'inlagt', id } or
  // { typ: 'oppna-igen' }). post: how the line's writer is recorded.
  async function andraRad(nr, ankare, kropp, { post = {}, steg = [] } = {}) {
    const vemId = await skribent({ manniska: true });
    const nar = nu();
    await iFas();
    await lasbartRum(nr);
    const m = await bytText(`manus:${nr}`, (text) => andra(text, ankare, kropp));
    const avsikt = {
      typ: 'andrad', nr, fore: m.fore, efter: m.text, i: m.i, skift: m.skift, vem: vemId, nar, foreKropp: m.foreKropp, post, steg,
    };
    if (m.oforandrad) {
      // The text was already this. Nothing to record about the line, but a
      // proposal laid in is still marked and logged.
      if (steg.length) await rumEfter({ ...avsikt, typ: 'steg' });
      return m;
    }
    await rumEfter(avsikt);
    return m;
  }

  async function nyRad(nr, plats, kropp) {
    const vemId = await skribent({ manniska: true });
    const nar = nu();
    await iFas();
    await lasbartRum(nr);
    const m = await bytText(`manus:${nr}`, (text) => laggTill(text, plats, kropp));
    await rumEfter({ typ: 'tillagd', nr, fore: m.fore, efter: m.text, i: m.i, skift: m.skift, vem: vemId, nar });
    return m;
  }

  async function strykRad(nr, ankare) {
    const vemId = await skribent({ manniska: true });
    const nar = nu();
    await iFas();
    await lasbartRum(nr);
    const m = await bytText(`manus:${nr}`, (text) => stryk(text, ankare));
    await rumEfter({
      typ: 'struken', nr, fore: m.fore, efter: m.text, iFore: m.iFore, skift: m.skift, struken: m.struken, id: nyttId(), vem: vemId, nar,
    });
    return m;
  }

  async function laggTillbakaRad(nr, id) {
    const vemId = await skribent({ manniska: true });
    const nar = nu();
    await iFas();
    const rum = await lasbartRum(nr);
    const s = rum.strukna.find((x) => x.id === id);
    if (!s) throw new SparFel('saknas', 'Den strukna repliken finns inte kvar i listan.');
    const m = await bytText(`manus:${nr}`, (text) => laggTillbaka(text, s));
    await rumEfter({ typ: 'tillbakalagd', nr, fore: m.fore, efter: m.text, i: m.i, skift: m.skift, id, vem: vemId, nar });
    return m;
  }

  // Puts an earlier text back on a line. tidigare is the entry the person
  // pointed at: { kropp, skrev, nar }. The text becomes its first writer's
  // again, and a proposal that had replaced it lies open beside the line.
  async function taTillbakaText(nr, ankare, tidigare) {
    return andraRad(nr, ankare, tidigare.kropp, {
      post: { hur: 'tillbaka', skrev: tidigare.skrev || null, skrevNar: tidigare.nar || null, utanTidigare: tidigare },
      steg: [{ typ: 'oppna-igen' }],
    });
  }

  async function sattNamn(nr, ankare, skrev) {
    const vemId = await skribent({ manniska: true });
    const nar = nu();
    await iFas();
    const [fil, g] = await Promise.all([adapter.las(`manus:${nr}`), grund(nr)]);
    if (!fil) throw new SparFel('saknas', `Manuset för episod ${nr} går inte att hitta.`);
    const manus = tolka(fil.text);
    const i = hitta(manus, ankare, { strikt: true });
    if (i < 0) throw new SparFel('hittas-inte', 'Repliken står inte längre så i manuset.');
    return bytRum(nr, (rum) => R.sattNamn(rum, { manus, i, skrev, vem: vemId, nar, grund: g }));
  }

  // --- Proposals, comments and replies -------------------------------------------
  // Everyone, Demi included, writes their own; nobody changes someone else's.

  async function foresla(nr, mal, kropp) {
    const vemId = await skribent();
    await iFas();
    return bytRum(nr, (rum) => R.nyttForslag(rum, { id: nyttId(), mal, kropp, vem: vemId, nar: nu() }));
  }

  async function sagJa(nr, id, ja = true) {
    const vemId = await skribent({ manniska: true });
    await iFas();
    return bytRum(nr, (rum) => (ja ? R.sagJa(rum, { id, vem: vemId, nar: nu() }) : R.taTillbakaJa(rum, { id, vem: vemId })));
  }

  async function draUndanForslag(nr, id) {
    const vemId = await skribent();
    await iFas();
    return bytRum(nr, (rum) => R.draUndanForslag(rum, { id, vem: vemId, nar: nu() }));
  }

  // "Lägg in i manus": the one way a proposal becomes manuscript text, and
  // always because a person pressed it. The line becomes the proposer's
  // words; the log says who laid it in and when; the old text is kept.
  async function laggInForslag(nr, id) {
    const vemId = await skribent({ manniska: true });
    await iFas();
    const rum = await lasbartRum(nr);
    const f = rum.forslag.find((x) => x.id === id);
    if (!f || f.lage !== 'oppet') throw new SparFel('saknas', 'Förslaget är inte öppet längre.');
    if (f.mal.struken) throw new SparFel('hittas-inte', 'Repliken som förslaget gäller är struken. Lägg tillbaka den först.');
    if (f.mal.text == null) {
      return bytRum(nr, (r) => R.forslagInlagt(r, { id, vem: vemId, nar: nu() }));
    }
    return andraRad(nr, f.mal, f.kropp, {
      post: { hur: 'forslag', skrev: f.skrev, skrevNar: f.nar },
      steg: [{ typ: 'inlagt', id }],
    });
  }

  // svar: { svarPa: id of the comment or proposal } for a reply.
  // till: 'demi' to ask Demi.
  async function kommentera(nr, mal, text, galler = null, { svarPa = null, till = null } = {}) {
    const vemId = await skribent();
    await iFas();
    const id = nyttId();
    await bytRum(nr, (rum) => R.nyKommentar(rum, { id, mal, text, galler, vem: vemId, nar: nu(), svarPa, till }));
    return id;
  }

  async function svara(nr, svarPa, text, { till = null } = {}) {
    return kommentera(nr, null, text, null, { svarPa, till });
  }

  async function kommentarKlar(nr, id, klar = true) {
    const vemId = await skribent();
    await iFas();
    return bytRum(nr, (rum) => R.kommentarKlar(rum, { id, vem: vemId, nar: nu(), klar }));
  }

  async function taBortKommentar(nr, id) {
    const vemId = await skribent();
    await iFas();
    return bytRum(nr, (rum) => R.taBortKommentar(rum, { id, vem: vemId, nar: nu() }));
  }

  // --- Settings ------------------------------------------------------------------
  // Per person, in one small file: { format, personer: { henric: { doljDemi } } }.

  async function lasInstallningar() {
    const p = adapter.kanSkriva ? await vem() : null;
    if (!p) return R.installningFor(R.tomaInstallningar(), null);
    const fil = await adapter.las('installningar');
    let inst = R.tomaInstallningar();
    try {
      inst = R.lasInstallningar(fil ? fil.text : null);
    } catch {
      // A broken settings file shows the defaults; it is never written over
      // until someone changes a setting (and then only after a fresh read).
    }
    return R.installningFor(inst, p.id);
  }

  async function sattInstallning(nyckel, varde) {
    const vemId = await skribent();
    await bytText('installningar', (text) => ({
      text: R.skrivRum(R.sattInstallning(R.lasInstallningar(text), { vem: vemId, nyckel, varde, nar: nu() })),
    }), { saknasOk: true });
    return lasInstallningar();
  }

  // --- Lore ----------------------------------------------------------------------

  async function lasLore() {
    const fil = adapter.kanSkriva ? await adapter.las('lore') : null;
    return R.lasLore(fil ? fil.text : null);
  }

  const bytLore = (mutera) => bytText('lore', (text) => {
    const ut = mutera(R.lasLore(text));
    return { text: R.skrivRum(ut.lore), ...ut };
  }, { saknasOk: true });

  async function nyLoresida(titel, text) {
    const vemId = await skribent();
    const id = nyttId();
    await bytLore((lore) => ({ lore: R.nyLoresida(lore, { id, titel, text, vem: vemId, nar: nu() }) }));
    return id;
  }

  // sedd: when the page was last changed, as the writer saw it on opening.
  // If someone saved in between, their text is kept among the versions and
  // the caller gets krockade so it can say so.
  async function andraLoresida(id, titel, text, sedd = null) {
    const vemId = await skribent();
    return bytLore((lore) => {
      const s = lore.sidor.find((x) => x.id === id);
      const senast = s ? ((s.andrad && s.andrad.nar) || s.skapad) : null;
      return { lore: R.andraLoresida(lore, { id, titel, text, vem: vemId, nar: nu() }), krockade: sedd != null && senast !== sedd };
    });
  }

  async function taBortLoresida(id) {
    const vemId = await skribent();
    return bytLore((lore) => ({ lore: R.taBortLoresida(lore, { id, vem: vemId, nar: nu() }) }));
  }

  async function hamtaTillbakaLoresida(id) {
    const vemId = await skribent();
    return bytLore((lore) => ({ lore: R.hamtaTillbakaLoresida(lore, { id, vem: vemId }) }));
  }

  return {
    adapter, vem, vantar, forsokIgen, slangVantande,
    lasEpisod, lasText,
    andraRad, nyRad, strykRad, laggTillbakaRad, taTillbakaText, sattNamn,
    foresla, sagJa, draUndanForslag, laggInForslag,
    kommentera, svara, kommentarKlar, taBortKommentar,
    lasInstallningar, sattInstallning,
    lasLore, nyLoresida, andraLoresida, taBortLoresida, hamtaTillbakaLoresida,
  };
}
