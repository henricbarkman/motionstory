// A small markdown reader for the room: the world book, HELD's lore, and the
// notes and tables around the scenes. It builds elements and text nodes only.
// Nothing here ever hands text to the browser as HTML, so a "<" in someone's
// words stays a "<".
//
// Covers what those files use: headings, paragraphs, lists, block quotes,
// tables, rules, **bold**, *italic*, `code` and [links](https://...).

const SAKER_LANK = /^(https?:\/\/|#|\.{0,2}\/)/i;

function el(tag, klass, ...barn) {
  const e = document.createElement(tag);
  if (klass) e.className = klass;
  for (const b of barn) if (b != null) e.append(b);
  return e;
}

// Inline marks, left to right. Unclosed marks are plain text.
export function inline(text) {
  const ut = document.createDocumentFragment();
  let k = 0;
  let buf = '';
  const flush = () => { if (buf) { ut.append(document.createTextNode(buf)); buf = ''; } };
  while (k < text.length) {
    const c = text[k];
    if (c === '`') {
      const slut = text.indexOf('`', k + 1);
      if (slut > k) { flush(); ut.append(el('code', null, text.slice(k + 1, slut))); k = slut + 1; continue; }
    }
    if (c === '*' && text[k + 1] === '*') {
      const slut = text.indexOf('**', k + 2);
      if (slut > k + 2) { flush(); ut.append(el('strong', null, inline(text.slice(k + 2, slut)))); k = slut + 2; continue; }
    }
    if (c === '*' && text[k + 1] !== ' ') {
      const slut = text.indexOf('*', k + 1);
      if (slut > k + 1 && text[slut - 1] !== ' ') { flush(); ut.append(el('em', null, inline(text.slice(k + 1, slut)))); k = slut + 1; continue; }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(k));
      if (m) {
        flush();
        if (SAKER_LANK.test(m[2])) {
          const a = el('a', null, inline(m[1]));
          a.href = m[2];
          if (/^https?:/i.test(m[2])) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          ut.append(a);
        } else {
          ut.append(inline(m[1]));
        }
        k += m[0].length;
        continue;
      }
    }
    buf += c;
    k++;
  }
  flush();
  return ut;
}

const celler = (rad) => rad.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function renderMd(text) {
  const ut = document.createDocumentFragment();
  const rader = String(text || '').split('\n');
  let k = 0;
  while (k < rader.length) {
    const rad = rader[k];
    if (rad.trim() === '') { k++; continue; }
    let m = /^(#{1,4})\s+(.*)$/.exec(rad);
    if (m) {
      ut.append(el(`h${Math.min(6, m[1].length + 2)}`, 'md-rubrik', inline(m[2])));
      k++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(rad)) { ut.append(el('hr')); k++; continue; }
    if (rad.startsWith('>')) {
      const inne = [];
      while (k < rader.length && rader[k].startsWith('>')) { inne.push(rader[k].replace(/^>\s?/, '')); k++; }
      ut.append(el('blockquote', null, renderMd(inne.join('\n'))));
      continue;
    }
    if (rad.trim().startsWith('|') && k + 1 < rader.length && /^\s*\|?\s*:?-{2,}/.test(rader[k + 1])) {
      const tabell = el('table');
      const huvud = el('tr');
      for (const c of celler(rad)) huvud.append(el('th', null, inline(c)));
      tabell.append(el('thead', null, huvud));
      const kropp = el('tbody');
      k += 2;
      while (k < rader.length && rader[k].trim().startsWith('|')) {
        const tr = el('tr');
        for (const c of celler(rader[k])) tr.append(el('td', null, inline(c)));
        kropp.append(tr);
        k++;
      }
      tabell.append(kropp);
      ut.append(el('div', 'tabell', tabell));
      continue;
    }
    m = /^(\s*)([-*]|\d+\.)\s+/.exec(rad);
    if (m) {
      const ordnad = /\d/.test(m[2]);
      const lista = el(ordnad ? 'ol' : 'ul');
      while (k < rader.length) {
        const p = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(rader[k]);
        if (!p) {
          // A continuation line belongs to the item above.
          if (rader[k].trim() && /^\s{2,}/.test(rader[k]) && lista.lastChild) {
            lista.lastChild.append(document.createTextNode(' '), inline(rader[k].trim()));
            k++;
            continue;
          }
          break;
        }
        lista.append(el('li', null, inline(p[3])));
        k++;
      }
      ut.append(lista);
      continue;
    }
    const stycke = [];
    while (k < rader.length && rader[k].trim() !== '' && !/^(#{1,4}\s|>|\s*\||\s*([-*]|\d+\.)\s|\s*---\s*$)/.test(rader[k])) {
      stycke.push(rader[k]);
      k++;
    }
    const p = el('p');
    stycke.forEach((s, n) => { if (n) p.append(document.createTextNode(' ')); p.append(inline(s.trim())); });
    ut.append(p);
  }
  return ut;
}

// A person's own text (lore pages, comments): no markup at all, paragraphs on
// blank lines and line breaks kept.
export function renderText(text) {
  const ut = document.createDocumentFragment();
  for (const stycke of String(text || '').split(/\n\s*\n/)) {
    if (!stycke.trim()) continue;
    const p = el('p');
    stycke.split('\n').forEach((rad, n) => { if (n) p.append(el('br')); p.append(document.createTextNode(rad)); });
    ut.append(p);
  }
  return ut;
}
