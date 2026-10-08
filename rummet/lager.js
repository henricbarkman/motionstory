// Reading and saving, on top of an adapter (data.js).
//
// Henric can have the manuscript open in the portal's file panel, and Demi
// can be writing a draft in the same file, while someone types here. So the
// room never writes from memory. Every save reads the file as it is now,
// finds its line again by anchor in that fresh text, changes only that, and
// writes with the version it just read. If the file moved in between, the
// adapter says Krock and the save starts over. If the line is no longer there
// the save stops and the words stay with the person who typed them.

import { tolka, andra, laggTill, stryk, laggTillbaka, hitta } from './manus.js';
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
} = {}) {
  let jag = null;
  // Notes that should follow a manuscript change but could not be saved.
  const vantar = [];

  async function vem() {
    if (!jag) jag = await adapter.vem();
    return jag;
  }

  async function skribent() {
    const p = adapter.kanSkriva ? await vem() : null;
    if (!p) throw new SparFel('laslage', 'Här går det bara att läsa.');
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
        if (!(e instanceof Krock)) throw e;
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

  // The manuscript is saved first. If the note about it cannot be saved the
  // text is still safe; the line just shows as changed outside the room until
  // the note gets through.
  async function rumEfter(nr, mutera) {
    try {
      await bytRum(nr, mutera);
    } catch (e) {
      if (e instanceof R.RumFel) throw e;
      vantar.push({ nr, mutera });
      throw new SparFel(
        'halvt',
        'Texten är sparad i manuset, men anteckningen om vem som skrev den kom inte fram. Den sparas när du försöker igen.',
        { orsak: e },
      );
    }
  }

  async function forsokIgen() {
    while (vantar.length) {
      const { nr, mutera } = vantar[0];
      await bytRum(nr, mutera);
      vantar.shift();
    }
  }

  // --- Reading ---------------------------------------------------------------

  async function lasEpisod(nr) {
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

  async function andraRad(nr, ankare, kropp, extra = {}) {
    const vemId = await skribent();
    const nar = nu();
    await lasbartRum(nr);
    const m = await bytText(`manus:${nr}`, (text) => andra(text, ankare, kropp));
    if (m.oforandrad) return m;
    const g = await grund(nr);
    await rumEfter(nr, (rum) => {
      let ut = R.efterAndrad(rum, {
        manusFore: tolka(m.fore), manusEfter: tolka(m.text), i: m.i, vem: vemId, nar, grund: g, ...extra.post,
      });
      if (extra.efter) ut = extra.efter(ut, m, { vem: vemId, nar });
      return ut;
    });
    return m;
  }

  async function nyRad(nr, plats, kropp) {
    const vemId = await skribent();
    const nar = nu();
    await lasbartRum(nr);
    const m = await bytText(`manus:${nr}`, (text) => laggTill(text, plats, kropp));
    await rumEfter(nr, (rum) => R.efterTillagd(rum, {
      manusFore: tolka(m.fore), manusEfter: tolka(m.text), karta: m.karta, i: m.i, vem: vemId, nar,
    }));
    return m;
  }

  async function strykRad(nr, ankare) {
    const vemId = await skribent();
    const nar = nu();
    await lasbartRum(nr);
    const m = await bytText(`manus:${nr}`, (text) => stryk(text, ankare));
    const g = await grund(nr);
    const id = nyttId();
    await rumEfter(nr, (rum) => {
      const fore = tolka(m.fore);
      return R.efterStruken(rum, {
        manusFore: fore, manusEfter: tolka(m.text), karta: m.karta, i: hitta(fore, ankare, { strikt: true }),
        struken: m.struken, id, vem: vemId, nar, grund: g,
      });
    });
    return m;
  }

  async function laggTillbakaRad(nr, id) {
    const vemId = await skribent();
    const nar = nu();
    const rum = await lasbartRum(nr);
    const s = rum.strukna.find((x) => x.id === id);
    if (!s) throw new SparFel('saknas', 'Den strukna repliken finns inte kvar i listan.');
    const m = await bytText(`manus:${nr}`, (text) => laggTillbaka(text, s));
    await rumEfter(nr, (r) => R.efterTillbakalagd(r, {
      manusFore: tolka(m.fore), manusEfter: tolka(m.text), karta: m.karta, i: m.i, id, vem: vemId, nar,
    }));
    return m;
  }

  // Puts an earlier text back on a line. tidigare is the entry the person
  // pointed at: { kropp, skrev, nar }. The text becomes its first writer's
  // again, and a proposal that had replaced it lies open beside the line.
  async function taTillbakaText(nr, ankare, tidigare) {
    return andraRad(nr, ankare, tidigare.kropp, {
      post: { hur: 'tillbaka', skrev: tidigare.skrev || null, skrevNar: tidigare.nar || null, utanTidigare: tidigare },
      efter: (rum, m, { vem: v, nar }) => {
        let ut = rum;
        const efter = tolka(m.text);
        for (const f of rum.forslag) {
          if (f.lage === 'inlagt' && f.mal.text != null && f.kropp === m.foreKropp && hitta(efter, f.mal) === m.i) {
            ut = R.forslagOppnatIgen(ut, { id: f.id, vem: v, nar });
          }
        }
        return ut;
      },
    });
  }

  async function sattNamn(nr, ankare, skrev) {
    const vemId = await skribent();
    const nar = nu();
    const [fil, g] = await Promise.all([adapter.las(`manus:${nr}`), grund(nr)]);
    const manus = tolka(fil.text);
    const i = hitta(manus, ankare, { strikt: true });
    if (i < 0) throw new SparFel('hittas-inte', 'Repliken står inte längre så i manuset.');
    return bytRum(nr, (rum) => R.sattNamn(rum, { manus, i, skrev, vem: vemId, nar, grund: g }));
  }

  // --- Proposals and comments ----------------------------------------------------

  async function foresla(nr, mal, kropp) {
    const vemId = await skribent();
    return bytRum(nr, (rum) => R.nyttForslag(rum, { id: nyttId(), mal, kropp, vem: vemId, nar: nu() }));
  }

  async function sagJa(nr, id, ja = true) {
    const vemId = await skribent();
    return bytRum(nr, (rum) => (ja ? R.sagJa(rum, { id, vem: vemId, nar: nu() }) : R.taTillbakaJa(rum, { id, vem: vemId })));
  }

  async function draUndanForslag(nr, id) {
    const vemId = await skribent();
    return bytRum(nr, (rum) => R.draUndanForslag(rum, { id, vem: vemId, nar: nu() }));
  }

  // "Lägg in i manus": the one way a proposal becomes manuscript text, and
  // always because a person pressed it. The line becomes the proposer's
  // words; the log says who laid it in and when; the old text is kept.
  async function laggInForslag(nr, id) {
    const rum = await lasbartRum(nr);
    const f = rum.forslag.find((x) => x.id === id);
    if (!f || f.lage !== 'oppet') throw new SparFel('saknas', 'Förslaget är inte öppet längre.');
    if (f.mal.struken) throw new SparFel('hittas-inte', 'Repliken som förslaget gäller är struken. Lägg tillbaka den först.');
    if (f.mal.text == null) {
      const vemId = await skribent();
      return bytRum(nr, (r) => R.forslagInlagt(r, { id, vem: vemId, nar: nu() }));
    }
    return andraRad(nr, f.mal, f.kropp, {
      post: { hur: 'forslag', skrev: f.skrev, skrevNar: f.nar },
      efter: (r, m, { vem: v, nar }) => R.forslagInlagt(r, { id, vem: v, nar, ersatte: { kropp: m.foreKropp } }),
    });
  }

  async function kommentera(nr, mal, text, galler = null) {
    const vemId = await skribent();
    return bytRum(nr, (rum) => R.nyKommentar(rum, { id: nyttId(), mal, text, galler, vem: vemId, nar: nu() }));
  }

  async function kommentarKlar(nr, id, klar = true) {
    const vemId = await skribent();
    return bytRum(nr, (rum) => R.kommentarKlar(rum, { id, vem: vemId, nar: nu(), klar }));
  }

  async function taBortKommentar(nr, id) {
    const vemId = await skribent();
    return bytRum(nr, (rum) => R.taBortKommentar(rum, { id, vem: vemId, nar: nu() }));
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
    await skribent();
    return bytLore((lore) => ({ lore: R.hamtaTillbakaLoresida(lore, { id }) }));
  }

  return {
    adapter, vem, vantar, forsokIgen,
    lasEpisod, lasText,
    andraRad, nyRad, strykRad, laggTillbakaRad, taTillbakaText, sattNamn,
    foresla, sagJa, draUndanForslag, laggInForslag,
    kommentera, kommentarKlar, taBortKommentar,
    lasLore, nyLoresida, andraLoresida, taBortLoresida, hamtaTillbakaLoresida,
  };
}
