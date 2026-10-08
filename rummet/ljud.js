// Which lines of the manuscript have recorded sound, and where in the
// recording they sit. The recordings are keyed by id in episod-N.json, and one
// clip often holds several manuscript lines. A line counts as recorded only
// when its spoken words are exactly the words in a clip. Change a word in the
// manuscript and the line reads "inte inspelad än" instead of playing old
// sound.

import { tecken, kroppDelar } from './manus.js';

const norm = (s) => s.normalize('NFC').replace(/"/g, '').replace(/\s+/g, ' ').trim();

// episod-N.json -> clips with their paragraphs, and an index from spoken text
// to the clip paragraphs that say it.
// tider: rummet/ljudtider.json, the measured paragraph starts per recording.
export function tolkaLjud(json, alla = null) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const tider = alla && data.id ? alla[data.id] || null : null;
  const klipp = new Map();
  const index = new Map();
  for (const [id, text] of Object.entries(data.lines || {})) {
    const stycken = String(text).split(/\n\s*\n/).map((p) => norm(p.replace(/\[[^\]]*\]/g, ' ')));
    const sek = Number((data.seconds || {})[id]) || null;
    const k = { id, stycken, sek, rost: (data.lineVoices || {})[id] || 'vega', tider: tider && tider[id] ? tider[id] : null };
    klipp.set(id, k);
    stycken.forEach((s, n) => {
      if (!s) return;
      if (!index.has(s)) index.set(s, []);
      index.get(s).push({ id, stycke: n });
    });
  }
  return { id: data.id || null, klipp, index };
}

// What is spoken in a line, in order: Vega's words outside the parentheses,
// and other voices in quotes (inside a direction, or the whole line when the
// line is another voice).
export function talat(kropp) {
  const ut = [];
  const annanRad = kroppDelar(kropp).slag === 'annan';
  let hon = null; // Vega's run of words, possibly split by directions
  const annan = (text) => { hon = null; if (norm(text)) ut.push({ rost: 'annan', text: norm(text) }); };
  for (const t of tecken(kropp)) {
    if (t.typ === 'regi') {
      // A bare direction breaks nothing: "(torrt) Vi är väldigt friska."
      // continues her paragraph. A voice heard inside it does.
      for (const d of t.delar || []) if (d.typ === 'annan') annan(d.text);
    } else if (t.typ === 'annan' && annanRad) {
      annan(t.text);
    } else if (norm(t.text)) {
      // Vega quoting someone is still Vega speaking.
      if (!hon) { hon = { rost: 'vega', bitar: [] }; ut.push(hon); }
      hon.bitar.push(norm(t.text));
    }
  }
  return ut;
}

// -> { lage: 'tyst' | 'inspelad' | 'ej', delar: [{ id, stycke }] }
// 'tyst': nothing in the line is spoken. 'ej': spoken, but not as recorded.
export function ljudFor(kropp, ljud) {
  const sagt = talat(kropp);
  if (!sagt.length) return { lage: 'tyst', delar: [] };
  if (!ljud) return { lage: 'ej', delar: [] };
  const delar = [];
  for (const s of sagt) {
    if (s.rost === 'annan') {
      const hit = ljud.index.get(s.text);
      if (!hit) return { lage: 'ej', delar: [] };
      delar.push(hit[0]);
      continue;
    }
    // Her words may be split by directions into pieces that are one recorded
    // paragraph together, or several paragraphs in a row. Take the longest
    // run that matches, then go on from there.
    let k = 0;
    while (k < s.bitar.length) {
      let traff = null;
      for (let j = s.bitar.length; j > k; j--) {
        const hit = ljud.index.get(norm(s.bitar.slice(k, j).join(' ')));
        if (hit) { traff = { hit: hit[0], j }; break; }
      }
      if (!traff) return { lage: 'ej', delar: [] };
      delar.push(traff.hit);
      k = traff.j;
    }
  }
  return { lage: 'inspelad', delar };
}

// Where a paragraph starts and ends inside its clip, in seconds. Measured
// times (rummet/ljudtider.json) when there are any, otherwise an estimate
// from the length of the text.
export function stycketid(ljud, del) {
  const k = ljud.klipp.get(del.id);
  if (!k) return null;
  const sista = del.stycke === k.stycken.length - 1;
  if (k.tider && k.tider.length === k.stycken.length) {
    return { fran: k.tider[del.stycke], till: sista ? null : k.tider[del.stycke + 1], matt: true };
  }
  if (k.stycken.length === 1 || !k.sek) return { fran: 0, till: null, matt: k.stycken.length === 1 };
  const langd = k.stycken.map((s) => s.length + 12);
  const summa = langd.reduce((a, b) => a + b, 0);
  const fore = langd.slice(0, del.stycke).reduce((a, b) => a + b, 0);
  const fran = Math.max(0, (k.sek * fore) / summa - 0.3);
  const till = sista ? null : (k.sek * (fore + langd[del.stycke])) / summa + 0.3;
  return { fran, till, matt: false };
}
