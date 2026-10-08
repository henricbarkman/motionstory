// The pure half of scripts/rummet.py: one step on the room's files, done with
// the room's own code (rummet/manus.js and rum.js), so what Demi writes from
// a session is exactly what the page would have written. Reads one JSON
// object on stdin and writes one on stdout. Reads and writes no files itself;
// rummet.py does that, with the portal's write_file.
//
// Every post made here is Demi's. Demi never changes the manuscript, says yes
// or lays anything in, so there is no step for that.

import { tolka, ankareFor, provaKropp, hitta } from '../rummet/manus.js';
import * as R from '../rummet/rum.js';

const DEMI = 'demi';

class CliFel extends Error {
  constructor(kod, text, extra = {}) {
    super(text);
    this.kod = kod;
    Object.assign(this, extra);
  }
}

const repliker = (manus, scen) => manus.rader.filter((r) => r.typ === 'replik' && r.scen === scen);

// A line named by its text: the whole quote line content ("[tag] text") or
// just the words. n picks among identical lines in the scene, counted from 0.
function ankare(manus, scen, rad, n) {
  if (!manus.scener.some((s) => s.nr === scen)) {
    throw new CliFel('scen', `Det finns ingen scen ${scen}. Scenerna är ${manus.scener.map((s) => s.nr).join(', ')}.`);
  }
  if (rad == null) return { scen, text: null };
  const har = repliker(manus, scen).filter((r) => r.innehall === rad || r.kropp === rad);
  if (!har.length) {
    const nara = repliker(manus, scen).filter((r) => r.kropp.includes(rad.slice(0, 20)) || rad.includes(r.kropp.slice(0, 20))).slice(0, 3);
    throw new CliFel('hittas-inte', `Repliken står inte så i scen ${scen}.`, { nara: nara.map((r) => r.innehall) });
  }
  if (har.length > 1 && n == null) {
    throw new CliFel('flera', `Repliken står ${har.length} gånger i scen ${scen}. Säg vilken med --n (0 är den första).`);
  }
  const r = har[n || 0];
  if (!r) throw new CliFel('hittas-inte', `Det finns bara ${har.length} sådana repliker i scen ${scen}.`);
  return ankareFor(manus, r.i);
}

function rader(manusText) {
  const m = tolka(manusText);
  return m.scener.map((s) => {
    const sett = new Map();
    return {
      scen: s.nr,
      titel: s.titel,
      rader: repliker(m, s.nr).map((r) => {
        const n = sett.get(r.innehall) || 0;
        sett.set(r.innehall, n + 1);
        return { text: r.innehall, kropp: r.kropp, n, variant: r.variant, etikett: r.etikett };
      }),
    };
  });
}

// Where a note sits now, for reading: the scene and the line's text, or
// "struken" when its line has been struck.
function plats(manus, mal) {
  if (!mal) return null;
  if (mal.struken) return { scen: mal.scen, rad: mal.text, struken: true };
  if (mal.text == null) return { scen: mal.scen, rad: null };
  const i = manus ? hitta(manus, mal) : -1;
  return { scen: mal.scen, rad: mal.text, finns: i >= 0 && manus.rader[i].innehall === mal.text };
}

const efter = (nar, sedan) => nar != null && String(nar) > sedan;

function nytt({ episoder, lore, sedan, sedda = [] }) {
  const vantar = [];
  const handelser = [];
  for (const [nr, { rum: rumText, manus: manusText }] of Object.entries(episoder)) {
    if (rumText == null) continue;
    const rum = R.lasRum(rumText, nr);
    const manus = manusText == null ? null : tolka(manusText);
    const poster = new Map([...rum.forslag, ...rum.kommentarer].map((x) => [x.id, x]));
    for (const k of R.vantarPa(rum, DEMI)) {
      const rotId = k.svarPa || k.id;
      const rot = poster.get(rotId);
      vantar.push({
        episod: nr,
        id: k.id,
        svaraPa: rotId,
        fran: k.skrev,
        nar: k.nar,
        text: k.text,
        plats: plats(manus, k.mal),
        trad: [rot, ...R.trad(rum, rotId)].filter(Boolean).map((x) => ({
          id: x.id, skrev: x.skrev, nar: x.nar, text: x.text != null ? x.text : x.kropp, forslag: x.kropp != null,
        })),
      });
    }
    const lagg = (h) => handelser.push({ episod: nr, ...h });
    for (const k of rum.kommentarer) {
      if (k.skrev !== DEMI && efter(k.nar, sedan) && !k.borta) {
        lagg({ nar: k.nar, vem: k.skrev, typ: k.svarPa ? 'svar' : 'kommentar', id: k.id, svarPa: k.svarPa || null, text: k.text, galler: k.galler || null, till: k.till || null, plats: plats(manus, k.mal) });
      }
      if (k.klar && k.klar.av !== DEMI && efter(k.klar.nar, sedan)) lagg({ nar: k.klar.nar, vem: k.klar.av, typ: 'klar', id: k.id, text: k.text });
    }
    for (const f of rum.forslag) {
      if (f.skrev !== DEMI && efter(f.nar, sedan)) lagg({ nar: f.nar, vem: f.skrev, typ: 'forslag', id: f.id, text: f.kropp, plats: plats(manus, f.mal) });
      for (const j of f.ja || []) if (efter(j.nar, sedan)) lagg({ nar: j.nar, vem: j.vem, typ: 'ja', id: f.id, text: f.kropp, av: f.skrev });
      if (f.undan && f.undan.av !== DEMI && efter(f.undan.nar, sedan)) lagg({ nar: f.undan.nar, vem: f.undan.av, typ: 'undan', id: f.id, text: f.kropp });
    }
    for (const l of rum.logg) {
      if (!l || l.vad === 'avsikt') continue; // the room's own bookkeeping
      if (l.vem !== DEMI && efter(l.nar, sedan)) lagg({ nar: l.nar, vem: l.vem, typ: `manus:${l.vad}`, scen: l.scen, fore: l.fore || null, efter: l.efter || null, av: l.av || null });
    }
  }
  if (lore != null) {
    for (const s of R.lasLore(lore).sidor) {
      if (s.skrev !== DEMI && efter(s.skapad, sedan)) handelser.push({ nar: s.skapad, vem: s.skrev, typ: 'lore', id: s.id, titel: s.titel, text: R.loreText(s) });
      if (s.andrad && s.andrad.av !== DEMI && efter(s.andrad.nar, sedan)) {
        handelser.push({ nar: s.andrad.nar, vem: s.andrad.av, typ: 'lore-andrad', id: s.id, titel: s.titel, text: R.loreText(s) });
      }
    }
  }
  // What was shown last time is known by its key, not by its time: the times
  // come from different clocks.
  const nyckel = (h) => [h.typ, h.id || '', h.vem || '', h.nar || ''].join('|');
  const sett = new Set(sedda || []);
  const nycklar = handelser.map(nyckel);
  const nya = handelser.filter((h) => !sett.has(nyckel(h)));
  nya.sort((a, b) => String(a.nar).localeCompare(String(b.nar)));
  vantar.sort((a, b) => String(a.nar).localeCompare(String(b.nar)));
  return { vantar, handelser: nya, nycklar };
}

function steg(in_) {
  const { op, id, nar } = in_;
  if (op === 'rader') return { scener: rader(in_.manus) };
  if (op === 'nytt') return nytt(in_);
  if (op === 'kommentera') {
    const manus = tolka(in_.manus);
    const mal = ankare(manus, in_.scen, in_.rad, in_.n);
    const rum = R.nyKommentar(R.lasRum(in_.rum, in_.episod), { id, mal, text: in_.text, galler: in_.galler || null, vem: DEMI, nar });
    return { text: R.skrivRum(rum), id, mal };
  }
  if (op === 'svara') {
    const rum = R.nyKommentar(R.lasRum(in_.rum, in_.episod), { id, mal: null, text: in_.text, vem: DEMI, nar, svarPa: in_.svarPa });
    const post = rum.kommentarer.at(-1);
    // The thread as it stands now, so anything that landed in it after Demi
    // last read it is seen at once.
    const rot = [...rum.kommentarer, ...rum.forslag].find((x) => x.id === post.svarPa);
    const trad = [rot, ...R.trad(rum, post.svarPa)].filter(Boolean)
      .map((x) => ({ id: x.id, skrev: x.skrev, text: x.text != null ? x.text : x.kropp, till: x.till || null }));
    return { text: R.skrivRum(rum), id, svarPa: post.svarPa, mal: post.mal, trad };
  }
  if (op === 'foresla') {
    const manus = tolka(in_.manus);
    const mal = ankare(manus, in_.scen, in_.rad, in_.n);
    if (typeof in_.text !== 'string' || !in_.text.trim()) throw new CliFel('tom', 'Förslaget är tomt.');
    if (mal.text != null) provaKropp(in_.text, manus.rader[hitta(manus, mal, { strikt: true })]);
    const rum = R.nyttForslag(R.lasRum(in_.rum, in_.episod), { id, mal, kropp: in_.text, vem: DEMI, nar });
    return { text: R.skrivRum(rum), id, mal };
  }
  if (op === 'lore-ny') {
    if (!in_.titel || !in_.titel.trim()) throw new CliFel('tom', 'Sidan behöver en titel.');
    return { text: R.skrivRum(R.nyLoresida(R.lasLore(in_.lore), { id, titel: in_.titel, text: in_.text, vem: DEMI, nar })), id };
  }
  if (op === 'lore-andra') {
    return { text: R.skrivRum(R.andraLoresida(R.lasLore(in_.lore), { id: in_.sida, titel: in_.titel, text: in_.text, vem: DEMI, nar })), id: in_.sida };
  }
  throw new CliFel('op', `Okänt steg: ${op}`);
}

let indata = '';
process.stdin.setEncoding('utf8');
for await (const bit of process.stdin) indata += bit;
try {
  process.stdout.write(JSON.stringify({ ok: true, ...steg(JSON.parse(indata)) }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, kod: e.kod || e.name || 'fel', fel: e.message, nara: e.nara || null }));
}
