// The manuscript file (stories/glimt/episod-N.md) is the only truth for the
// text. This module reads it into lines and writes it back by replacing,
// inserting or removing whole lines. Nothing else in the file is touched:
// every line the room did not change comes back byte for byte.
//
// The format, as scripts/manus_sida.py reads it:
//   # Glimt, episod N: Titel
//   notes ... --- ... scenes ... --- ... appendix
//   ## N. Titel               a scene
//   *Trigger: ...*            when the scene opens (mechanics, read-only here)
//   > ...                     what is heard, one line per paragraph or variant
//   >                         separates paragraphs inside a block
//   > **Gren:**   > *Gren:*   the story branches (read-only here)
//   > [variant] text          a line the phone chooses between
//   > (regi) text "annan"     parentheses are direction and sound, quotes other voices
//
// People write words. The room keeps the format: the "> ", the tag, the label.

export class ManusFel extends Error {
  constructor(kod, text, extra = {}) {
    super(text);
    this.name = 'ManusFel';
    this.kod = kod;
    Object.assign(this, extra);
  }
}

const RE_TITEL = /^# Glimt, episod (\d+): (.+)$/;
const RE_SCEN = /^## (\d+)\. (.+)$/;
const RE_ETIKETT = /^\*([^*]+:)\* (.*)$/;
const RE_VARIANT = /^\[([^\]]+)\] (.*)$/;

// What a quote line's content is. A replik is the only kind people edit.
export function tolkaInnehall(innehall) {
  if (innehall.trim() === '') return { typ: 'q-tom' };
  let m = /^\*\*(.+)\*\*$/.exec(innehall);
  if (m) return { typ: 'gren', rubrik: m[1] };
  m = /^\*([^*]+:)\*$/.exec(innehall);
  if (m) return { typ: 'gren2', rubrik: m[1] };
  m = /^\*([^*]+)\*$/.exec(innehall);
  if (m) return { typ: 'q-not', text: m[1] };
  let rest = innehall;
  let etikett = null;
  let variant = null;
  m = RE_ETIKETT.exec(rest);
  if (m) { etikett = m[1]; rest = m[2]; }
  m = RE_VARIANT.exec(rest);
  if (m) { variant = m[1]; rest = m[2]; }
  return { typ: 'replik', etikett, variant, kropp: rest };
}

function huvud(r) {
  return (r.etikett ? `*${r.etikett}* ` : '') + (r.variant ? `[${r.variant}] ` : '');
}

function tolkaRad(ra, i, iScener) {
  if (ra.startsWith('>')) {
    const prefix = ra.startsWith('> ') ? '> ' : '>';
    const innehall = ra.slice(prefix.length);
    return { i, ra, citat: true, prefix, innehall, ...tolkaInnehall(innehall) };
  }
  if (!iScener) return { i, ra, typ: 'utanfor' };
  if (ra.trim() === '') return { i, ra, typ: 'tom' };
  let m = RE_SCEN.exec(ra);
  if (m) return { i, ra, typ: 'scen', nr: m[1], titel: m[2] };
  m = /^\*Trigger: (.+)\*$/.exec(ra);
  if (m) return { i, ra, typ: 'trigger', text: m[1] };
  m = /^\*\*(.+)\*\*$/.exec(ra);
  if (m) return { i, ra, typ: 'blockrubrik', text: m[1] };
  m = /^\*([^*]+)\*$/.exec(ra);
  if (m) return { i, ra, typ: 'not', text: m[1] };
  return { i, ra, typ: 'stycke', text: ra };
}

// Read the whole file. `skriv(tolka(text)) === text` always.
export function tolka(text) {
  const raa = text.split('\n');
  const t = RE_TITEL.exec(raa[0] || '');
  // The scenes run from the first "## N. Titel" to the next "---" line.
  let start = raa.findIndex((ra) => RE_SCEN.test(ra));
  if (start < 0) start = raa.length;
  let slut = raa.findIndex((ra, i) => i > start && ra.trim() === '---');
  if (slut < 0) slut = raa.length;

  const rader = raa.map((ra, i) => tolkaRad(ra, i, i >= start && i < slut));
  // Quote lines outside the scenes are not part of what the room edits.
  for (const r of rader) if (r.citat && (r.i < start || r.i >= slut)) r.typ = 'utanfor';

  const scener = [];
  let scen = null;
  let block = null;
  for (let i = start; i < slut; i++) {
    const r = rader[i];
    if (r.typ === 'scen') {
      scen = { nr: r.nr, titel: r.titel, i, slut, delar: [] };
      if (scener.length) scener[scener.length - 1].slut = i;
      scener.push(scen);
      block = null;
      continue;
    }
    if (!scen) continue;
    r.scen = scen.nr;
    if (r.citat) {
      if (!block) { block = { typ: 'citat', rader: [] }; scen.delar.push(block); }
      block.rader.push(r);
    } else {
      block = null;
      if (r.typ !== 'tom') scen.delar.push({ typ: r.typ, rad: r });
    }
  }

  let notSlut = start;
  while (notSlut > 1 && (raa[notSlut - 1].trim() === '' || raa[notSlut - 1].trim() === '---')) notSlut--;
  return {
    episod: t ? t[1] : null,
    titel: t ? t[2] : (raa[0] || '').replace(/^#\s*/, ''),
    rader,
    scener,
    anteckningar: raa.slice(1, notSlut).join('\n').trim(),
    bilagor: raa.slice(Math.min(slut + 1, raa.length)).join('\n').trim(),
  };
}

export function skriv(manus) {
  return manus.rader.map((r) => r.ra).join('\n');
}

// --- Anchors -------------------------------------------------------------
// The file carries no ids, so a line is known by its scene, its exact content,
// which one it is among identical lines in that scene (n), and the lines just
// before and after it (fore, efter). The neighbours tell two identical lines
// apart when one of them has come or gone since the anchor was taken.

function scenFor(manus, nr) {
  return manus.scener.find((s) => s.nr === nr) || null;
}

function citatIScen(manus, scen) {
  const ut = [];
  for (let i = scen.i + 1; i < scen.slut; i++) {
    const r = manus.rader[i];
    if (r.citat && r.typ !== 'q-tom' && r.typ !== 'utanfor') ut.push(r);
  }
  return ut;
}

// The content of the nearest quote line before (steg -1) or after (+1) in the
// same scene, skipping the lone ">" between paragraphs. null at the edge.
function granne(manus, i, steg) {
  for (let k = i + steg; k >= 0 && k < manus.rader.length; k += steg) {
    const r = manus.rader[k];
    if (r.typ === 'scen' || r.scen !== manus.rader[i].scen) return null;
    if (r.citat && r.typ !== 'q-tom') return r.innehall;
  }
  return null;
}

export function ankareFor(manus, i) {
  const r = manus.rader[i];
  if (!r || !r.citat || r.typ === 'q-tom' || r.scen == null) return null;
  const scen = scenFor(manus, r.scen);
  let n = 0;
  for (const x of citatIScen(manus, scen)) {
    if (x.i >= i) break;
    if (x.innehall === r.innehall) n++;
  }
  return { scen: r.scen, text: r.innehall, n, fore: granne(manus, i, -1), efter: granne(manus, i, 1) };
}

// Strict: this very line, or nothing. Loose (for showing notes): the best
// guess inside the same scene. Never a line in another scene.
//
// A text that stands once in the scene is that line. Among identical lines
// the one whose neighbours match the anchor wins; if the neighbours cannot
// tell them apart either, the position (n) decides.
export function hitta(manus, ankare, { strikt = false } = {}) {
  if (!ankare || ankare.text == null) return -1;
  const scen = scenFor(manus, ankare.scen);
  const har = scen ? citatIScen(manus, scen).filter((r) => r.innehall === ankare.text) : [];
  if (!har.length) return -1;
  const n = ankare.n || 0;
  const vidN = har[n] || null;
  // Anchors from before the neighbours were kept: position only.
  if (!('fore' in ankare) && !('efter' in ankare)) {
    if (vidN) return vidN.i;
    return strikt ? -1 : har[har.length - 1].i;
  }
  if (har.length === 1 && n === 0) return har[0].i;
  const poang = (r) => (granne(manus, r.i, -1) === ankare.fore) + (granne(manus, r.i, 1) === ankare.efter);
  const basta = Math.max(...har.map(poang));
  if (basta > 0) {
    const kandidater = har.filter((r) => poang(r) === basta);
    if (vidN && kandidater.includes(vidN)) return vidN.i;
    if (kandidater.length === 1) return kandidater[0].i;
    return strikt ? -1 : kandidater[0].i;
  }
  // Both neighbours changed for every candidate: nothing ties the anchor to
  // one of them.
  if (strikt) return -1;
  return (vidN || har[har.length - 1]).i;
}

// --- The words inside a line ----------------------------------------------

function slutparentes(s) {
  let djup = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '(') djup++;
    else if (s[k] === ')') { djup--; if (djup === 0) return k; }
  }
  return -1;
}

// How the room shows a line when someone edits it. Three lenses over the same
// text: Vega speaks, direction or sound, or another voice.
export function kroppDelar(kropp) {
  if (kropp.startsWith('(') && kropp.length > 2 && slutparentes(kropp) === kropp.length - 1) {
    return { slag: 'regi', ord: kropp.slice(1, -1) };
  }
  const m = /^\(([^()]+)\) "([^"]+)"$/.exec(kropp);
  if (m) return { slag: 'annan', vem: m[1], ord: m[2] };
  return { slag: 'vega', ord: kropp };
}

export function byggKropp({ slag, ord, vem }) {
  if (slag === 'regi') return `(${ord})`;
  if (slag === 'annan') return `(${vem}) "${ord}"`;
  return ord;
}

// For display: direction in parentheses, other voices in quotes, the rest is
// what Vega says. Returns [{typ: 'ord'|'regi'|'annan', text, delar?}].
export function tecken(kropp) {
  const ut = [];
  const citat = (s, till) => {
    const re = /"[^"]*"/g;
    let sist = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > sist) till.push({ typ: 'ord', text: s.slice(sist, m.index) });
      till.push({ typ: 'annan', text: m[0] });
      sist = m.index + m[0].length;
    }
    if (sist < s.length) till.push({ typ: 'ord', text: s.slice(sist) });
  };
  let k = 0;
  while (k < kropp.length) {
    const oppna = kropp.indexOf('(', k);
    if (oppna < 0) { citat(kropp.slice(k), ut); break; }
    const langd = slutparentes(kropp.slice(oppna));
    if (langd < 0) { citat(kropp.slice(k), ut); break; }
    if (oppna > k) citat(kropp.slice(k, oppna), ut);
    const delar = [];
    citat(kropp.slice(oppna, oppna + langd + 1), delar);
    ut.push({ typ: 'regi', text: kropp.slice(oppna, oppna + langd + 1), delar });
    k = oppna + langd + 1;
  }
  return ut;
}

// A new text for a line must still read as that same line afterwards. Text
// that the format would take for a tag, a label or a branch is refused, with
// the reason, instead of being saved as something its writer did not mean.
export function provaKropp(kropp, rad = {}) {
  if (typeof kropp !== 'string') throw new ManusFel('tom', 'Det finns ingen text att spara.');
  if (/[\n\r]/.test(kropp)) {
    throw new ManusFel('flera-rader', 'En replik är en rad. Dela upp texten i flera repliker.');
  }
  if (kropp.trim() === '') throw new ManusFel('tom', 'Repliken är tom. Stryk den i stället, om den ska bort.');
  // A space at either end is kept as typed: the room saves exactly what was
  // written, and a phone keyboard often leaves one after the last word.
  const tillbaka = tolkaInnehall(huvud(rad) + kropp);
  const samma = tillbaka.typ === 'replik'
    && (tillbaka.etikett || null) === (rad.etikett || null)
    && (tillbaka.variant || null) === (rad.variant || null)
    && tillbaka.kropp === kropp;
  if (!samma) {
    throw new ManusFel(
      'krock-format',
      'Så som texten börjar eller är inramad läser manuset den som en variant eller en gren, inte som en replik. '
      + 'Hakparentes först på raden och stjärnor runt texten är upptagna.',
    );
  }
}

// --- Writing ----------------------------------------------------------------
// Each of these takes the file as it is now and gives back the new file. They
// find their line by anchor in the text they were given, never by a line
// number remembered from an earlier read.
//
// skift says how the lines moved: from line vid, bort lines went and in lines
// came. It is plain data, so a note that still has to be saved can wait in
// the browser and be applied later; karta is the same as a function.

export function kartaFran(skift) {
  if (!skift) return (k) => k;
  const { vid, bort = 0, in: inn = 0 } = skift;
  return (k) => (k < vid ? k : k < vid + bort ? -1 : k - bort + inn);
}

const flyttat = (skift) => ({ skift, karta: kartaFran(skift) });

function replikVid(manus, ankare) {
  const i = hitta(manus, ankare, { strikt: true });
  if (i < 0) throw new ManusFel('hittas-inte', 'Repliken står inte längre så i manuset.');
  return manus.rader[i];
}

function grupp(manus, i) {
  const hel = (k) => manus.rader[k] && manus.rader[k].citat && manus.rader[k].typ !== 'q-tom'
    && manus.rader[k].scen === manus.rader[i].scen;
  let fran = i;
  let till = i;
  while (hel(fran - 1)) fran--;
  while (hel(till + 1)) till++;
  return [fran, till];
}

function iBlock(manus, k, scen) {
  const r = manus.rader[k];
  return !!r && r.citat && r.scen === scen;
}

export function andra(text, ankare, kropp) {
  const manus = tolka(text);
  const r = replikVid(manus, ankare);
  if (r.typ !== 'replik') throw new ManusFel('inte-replik', 'Den raden går inte att ändra i rummet.');
  provaKropp(kropp, r);
  const raa = manus.rader.map((x) => x.ra);
  raa[r.i] = r.prefix + huvud(r) + kropp;
  return { text: raa.join('\n'), i: r.i, fore: r.innehall, foreKropp: r.kropp, ...flyttat(null) };
}

// plats: { efter: ankare } puts the line as its own paragraph after the
// paragraph the anchor is in. { forst: { scen, block } } puts it first.
export function laggTill(text, plats, kropp) {
  const manus = tolka(text);
  provaKropp(kropp);
  const raa = manus.rader.map((x) => x.ra);
  if (plats.efter) {
    const r = replikVid(manus, plats.efter);
    const [, till] = grupp(manus, r.i);
    raa.splice(till + 1, 0, '>', `> ${kropp}`);
    return { text: raa.join('\n'), i: till + 2, ...flyttat({ vid: till + 1, in: 2 }) };
  }
  const scen = scenFor(manus, plats.forst.scen);
  const block = scen && scen.delar.filter((d) => d.typ === 'citat')[plats.forst.block || 0];
  if (!block) throw new ManusFel('hittas-inte', 'Scenen står inte längre så i manuset.');
  const b = block.rader[0].i;
  raa.splice(b, 0, `> ${kropp}`, '>');
  return { text: raa.join('\n'), i: b, ...flyttat({ vid: b, in: 2 }) };
}

export function stryk(text, ankare) {
  const manus = tolka(text);
  const r = replikVid(manus, ankare);
  if (r.typ !== 'replik') throw new ManusFel('inte-replik', 'Den raden går inte att stryka i rummet.');
  if (r.variant || r.etikett) {
    throw new ManusFel('variant', 'Raden hör till en variant eller en gren. Dem stryker man inte i rummet. Skriv en kommentar.');
  }
  const i = r.i;
  const [fran, till] = grupp(manus, i);
  const tom = (k) => iBlock(manus, k, r.scen) && manus.rader[k].typ === 'q-tom';
  const hel = (k) => iBlock(manus, k, r.scen) && manus.rader[k].typ !== 'q-tom';
  let bort;
  let lage;
  let granne;
  if (fran !== till) {
    bort = [i, i];
    if (i > fran) { lage = 'D-efter'; granne = i - 1; } else { lage = 'D-fore'; granne = i + 1; }
  } else if (tom(i - 1) && hel(i - 2)) {
    bort = [i - 1, i]; lage = 'A'; granne = i - 2;
  } else if (tom(i + 1) && hel(i + 2)) {
    bort = [i, i + 1]; lage = 'B'; granne = i + 2;
  } else {
    throw new ManusFel('sista-i-blocket', 'Det är den enda repliken i sitt stycke. Ändra den i stället, eller skriv en kommentar.');
  }
  const raa = manus.rader.map((x) => x.ra);
  raa.splice(bort[0], bort[1] - bort[0] + 1);
  const ut = raa.join('\n');
  const { skift, karta } = flyttat({ vid: bort[0], bort: bort[1] - bort[0] + 1 });
  return {
    text: ut,
    iFore: i,
    skift,
    karta,
    struken: {
      scen: r.scen, innehall: r.innehall, ra: r.ra, lage,
      granne: ankareFor(tolka(ut), karta(granne)),
    },
  };
}

// Puts a struck line back where it stood. If its neighbour is gone the line
// goes last in the scene, and the caller is told (reserv).
export function laggTillbaka(text, struken) {
  const manus = tolka(text);
  const hel = tolkaInnehall(struken.innehall);
  if (hel.typ !== 'replik') throw new ManusFel('inte-replik', 'Den raden går inte att lägga tillbaka.');
  const ra = struken.ra || `> ${struken.innehall}`;
  const raa = manus.rader.map((x) => x.ra);
  const j = hitta(manus, struken.granne, { strikt: true });
  if (j < 0) {
    const scen = scenFor(manus, struken.scen);
    const rader = scen ? citatIScen(manus, scen) : [];
    if (!rader.length) throw new ManusFel('hittas-inte', 'Scenen där repliken stod finns inte kvar.');
    const sist = rader[rader.length - 1].i;
    raa.splice(sist + 1, 0, '>', ra);
    return { text: raa.join('\n'), i: sist + 2, reserv: true, ...flyttat({ vid: sist + 1, in: 2 }) };
  }
  if (struken.lage === 'A') {
    raa.splice(j + 1, 0, '>', ra);
    return { text: raa.join('\n'), i: j + 2, ...flyttat({ vid: j + 1, in: 2 }) };
  }
  if (struken.lage === 'B') {
    raa.splice(j, 0, ra, '>');
    return { text: raa.join('\n'), i: j, ...flyttat({ vid: j, in: 2 }) };
  }
  if (struken.lage === 'D-efter') {
    raa.splice(j + 1, 0, ra);
    return { text: raa.join('\n'), i: j + 1, ...flyttat({ vid: j + 1, in: 1 }) };
  }
  raa.splice(j, 0, ra);
  return { text: raa.join('\n'), i: j, ...flyttat({ vid: j, in: 1 }) };
}
