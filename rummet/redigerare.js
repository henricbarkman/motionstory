// The editor: one document, typed into like a word processor. ProseMirror
// (pm.js, MIT licence, built by scripts/rummet_pm.py) does the typing, the
// selection, undo and the clipboard. Each paragraph is one node carrying the
// paragraph's kind and attributes from dok.js; the text in it is the words,
// never the marks the file writes around them. Enter makes a new paragraph,
// Backspace at the start joins two, and the toolbar changes a paragraph's kind
// the way a style does in Word.
//
// What the page draws beside the words (who wrote, listen, comments, the
// warning under a mechanic) sits in parts of each paragraph that ProseMirror
// leaves alone (contenteditable=false). The page fills them through the rita
// option, only for paragraphs that changed.
//
// lager.js sees the editor through three functions: stycken(), tillampa(ops)
// and laser(). Changes from outside never enter the undo history.

import {
  Schema, Fragment, Slice, EditorState, TextSelection, NodeSelection, Selection, Plugin, PluginKey, EditorView,
  Decoration, DecorationSet, history, undo, redo, keymap, baseKeymap, chainCommands, deleteSelection, joinBackward,
} from './pm.js';
import * as D from './dok.js';
import { hittaNamn, klassFor } from './katalog.js';

const NYCKEL = new PluginKey('rummet');
const UTIFRAN = 'utifran';

const tolkaA = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    stycke: {
      group: 'block',
      content: 'text*',
      marks: '',
      attrs: {
        id: { default: null }, typ: { default: null }, a: { default: null }, raw: { default: null }, orig: { default: null }, sep: { default: null },
      },
      // The room's own copy and paste carries everything; text from elsewhere
      // comes in with no kind (typ null) and gets the kind of where it lands.
      parseDOM: [
        {
          tag: 'p[data-typ]',
          getAttrs: (el) => ({
            id: el.getAttribute('data-id') || null,
            typ: el.getAttribute('data-typ'),
            a: tolkaA(el.getAttribute('data-a')),
            raw: el.hasAttribute('data-raw') ? el.getAttribute('data-raw') : null,
            orig: el.hasAttribute('data-orig') ? el.getAttribute('data-orig') : null,
            sep: tolkaA(el.getAttribute('data-sep')),
          }),
        },
        { tag: 'p' }, { tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'h4' }, { tag: 'h5' }, { tag: 'h6' },
        { tag: 'li' }, { tag: 'blockquote' }, { tag: 'pre', preserveWhitespace: 'full' },
      ],
      toDOM: (n) => ['p', {
        'data-id': n.attrs.id || '',
        'data-typ': n.attrs.typ || 'stycke',
        'data-a': JSON.stringify(n.attrs.a || {}),
        ...(n.attrs.raw != null ? { 'data-raw': n.attrs.raw } : {}),
        ...(n.attrs.orig != null ? { 'data-orig': n.attrs.orig } : {}),
        ...(n.attrs.sep != null ? { 'data-sep': JSON.stringify(n.attrs.sep) } : {}),
      }, 0],
    },
    linje: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: { id: { default: null }, raw: { default: null }, orig: { default: null }, sep: { default: null } },
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },
    text: {},
  },
});

const S = schema.nodes;

// --- Paragraphs and nodes ------------------------------------------------------------

export function tillNod(p) {
  if (p.typ === 'linje') return S.linje.create({ id: p.id || null, raw: p.raw ?? null, orig: p.orig ?? null, sep: p.sep ?? null });
  return S.stycke.create({
    id: p.id || null, typ: p.typ, a: D.rensaAttrs(p.typ, p.attrs), raw: p.raw ?? null, orig: p.orig ?? null, sep: p.sep ?? null,
  }, p.text ? schema.text(p.text) : null);
}

export function franNod(n) {
  const x = n.attrs;
  if (n.type === S.linje) return { id: x.id, typ: 'linje', attrs: {}, text: '', raw: x.raw, orig: x.orig, sep: x.sep };
  const typ = x.typ || 'stycke';
  return { id: x.id, typ, attrs: D.rensaAttrs(typ, x.a), text: n.textContent, raw: x.raw, orig: x.orig, sep: x.sep };
}

function hitta(doc, id) {
  let ut = null;
  doc.forEach((n, pos, k) => {
    if (!ut && n.attrs.id === id) ut = { node: n, pos, k };
  });
  return ut;
}

// The paragraph the selection's head is in: { node, pos, k } or null.
function aktuell(state) {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.isBlock) {
    const $p = state.doc.resolve(sel.from);
    return { node: sel.node, pos: sel.from, k: $p.index(0) };
  }
  const $h = sel.$head;
  if ($h.depth < 1) return null;
  return { node: $h.node(1), pos: $h.before(1), k: $h.index(0) };
}

// --- What each paragraph is part of, per document ---------------------------------------

const PLATSHALLARE = {
  rubrik: 'Rubrik', scen: 'Scenens nummer och namn, till exempel 4. Himlen', mekanik: 'Hur scenen spelas: vad vandraren gör, och vilka mekaniker den bygger på',
  replik: 'Det Vega säger', regi: 'Regi eller ljud', variant: 'Raden telefonen väljer i den här varianten', gren: 'Vad som hände, till exempel Vandraren stannar:',
  stycke: 'Skriv här', punkt: 'Punkt', tabell: '| | |',
};

// The kinds the toolbar offers. In a scene they are the manuscript's own;
// elsewhere (the intro, the appendix, the world book, the catalogue, a lore
// page) they are a text's.
export const STILAR_SCEN = [
  { namn: 'Scenrubrik', typ: 'scen' },
  { namn: 'Mekanik', typ: 'mekanik' },
  { namn: 'Replik', typ: 'replik' },
  { namn: 'Regi och ljud', typ: 'regi' },
  { namn: 'Variant', typ: 'variant' },
  { namn: 'Gren', typ: 'gren' },
  { namn: 'Anteckning', typ: 'stycke', a: { form: 'kursiv' } },
];
export const STILAR_TEXT = [
  { namn: 'Rubrik 1', typ: 'rubrik', a: { niva: 1 } },
  { namn: 'Rubrik 2', typ: 'rubrik', a: { niva: 2 } },
  { namn: 'Rubrik 3', typ: 'rubrik', a: { niva: 3 } },
  { namn: 'Text', typ: 'stycke', a: { form: 'fri' } },
  { namn: 'Citat', typ: 'stycke', a: { form: 'citat' } },
  { namn: 'Punktlista', typ: 'punkt', a: { markor: '- ' } },
  { namn: 'Numrerad lista', typ: 'punkt', a: { markor: '1. ' } },
];

// The name of a paragraph's kind, as the toolbar says it.
export function stilnamn(p, iScen) {
  const a = D.rensaAttrs(p.typ, p.attrs);
  if (p.typ === 'rubrik') return a.niva === 1 && a.prefix ? 'Titel' : `Rubrik ${Math.min(a.niva, 6)}`;
  if (p.typ === 'stycke') {
    if (iScen) return 'Anteckning';
    return a.form === 'citat' || a.form === 'citat-kursiv' ? 'Citat' : 'Text';
  }
  if (p.typ === 'punkt') return /\d/.test(a.markor) ? 'Numrerad lista' : 'Punktlista';
  if (p.typ === 'tabell') return 'Tabellrad';
  if (p.typ === 'linje') return 'Linje';
  return D.NAMN[p.typ] || p.typ;
}

export const arStil = (stil, p) => stil.typ === p.typ && Object.entries(stil.a || {}).every(([k, v]) => {
  const a = D.rensaAttrs(p.typ, p.attrs);
  if (k === 'markor') return /\d/.test(a.markor) === /\d/.test(v);
  if (k === 'form' && p.typ === 'stycke') return true;
  return a[k] === v;
});

// Parentheses that close: [{ fran, till }] for each direction in a line.
function parenteser(text) {
  const ut = [];
  let djup = 0;
  let start = -1;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '(') { if (djup === 0) start = k; djup++; } else if (c === ')' && djup > 0) {
      djup--;
      if (djup === 0) ut.push({ fran: start, till: k + 1 });
    }
  }
  return ut;
}

// Inline marks in a paragraph's words, as ranges with a class: the md marks
// themselves are dimmed, never hidden, so what is in the file is what is on
// the page.
function inline(p, iScen, katalog) {
  const t = p.text;
  const ut = [];
  if (!t) return ut;
  const mk = (fran, till) => ut.push({ fran, till, klass: 'mk' });
  if (p.typ === 'tabell') {
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(t)) ut.push({ fran: 0, till: t.length, klass: 'tabell-skilje' });
    else for (const m of t.matchAll(/\|/g)) mk(m.index, m.index + 1);
    return ut;
  }
  if (p.typ === 'scen') {
    const m = /^\d+\.\s?/.exec(t);
    if (m) ut.push({ fran: 0, till: m[0].length, klass: 'nr' });
  }
  if (p.typ === 'mekanik' && katalog) {
    for (const x of hittaNamn(t, katalog)) {
      ut.push({ fran: x.fran, till: x.till, klass: `bricka ${klassFor(x.mekanik.omdome)}`, attrs: { 'data-mek': x.mekanik.id, title: `${x.mekanik.namn}${x.mekanik.omdome ? `: ${x.mekanik.omdome}` : ''}` } });
    }
  }
  const fet = [];
  for (const m of t.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    mk(m.index, m.index + 2);
    ut.push({ fran: m.index + 2, till: m.index + m[0].length - 2, klass: 'fet' });
    mk(m.index + m[0].length - 2, m.index + m[0].length);
    fet.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g)) {
    if (fet.some(([a, b]) => m.index >= a && m.index < b)) continue;
    mk(m.index, m.index + 1);
    ut.push({ fran: m.index + 1, till: m.index + m[0].length - 1, klass: 'kursiv' });
    mk(m.index + m[0].length - 1, m.index + m[0].length);
  }
  for (const m of t.matchAll(/`([^`\n]+)`/g)) {
    mk(m.index, m.index + 1);
    ut.push({ fran: m.index + 1, till: m.index + m[0].length - 1, klass: 'kod' });
    mk(m.index + m[0].length - 1, m.index + m[0].length);
  }
  if (iScen && ['replik', 'variant', 'gren', 'stycke'].includes(p.typ)) {
    for (const r of parenteser(t)) ut.push({ ...r, klass: 'regi' });
    for (const m of t.matchAll(/"[^"\n]*"/g)) ut.push({ fran: m.index, till: m.index + m[0].length, klass: 'annan' });
  }
  return ut.filter((x) => x.till > x.fran);
}

// --- The view of one paragraph ----------------------------------------------------------------

const el = (tag, props = {}, ...barn) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const b of barn) if (b != null) e.append(b);
  return e;
};

const AV = { contenteditable: 'false' };

class StyckeVy {
  constructor(node, view, getPos, red) {
    this.node = node;
    this.getPos = getPos;
    this.red = red;
    const typ = node.attrs.typ || 'stycke';
    this.typ = typ;
    this.niva = typ === 'rubrik' ? D.rensaAttrs('rubrik', node.attrs.a).niva : null;
    this.dom = el('div', { class: `st ${typ}` });
    this.marg = el('div', { class: 'marg', ...AV });
    const tagg = typ === 'scen' ? 'h2' : typ === 'rubrik' ? `h${Math.min(6, Math.max(1, this.niva))}` : 'p';
    this.contentDOM = el(tagg, { class: 'text' });
    let kropp = this.contentDOM;
    if (typ === 'mekanik') {
      this.extra = el('div', { class: 'ruta-extra', ...AV });
      kropp = el('div', { class: 'ruta' }, this.contentDOM, this.extra);
    } else if (typ === 'variant') {
      this.etikett = el('button', { class: 'etikett', type: 'button', ...AV, 'data-gor': 'etikett' });
      kropp = el('div', { class: 'rad' }, this.etikett, this.contentDOM);
    } else if (typ === 'gren') {
      kropp = el('div', { class: 'grenrad' }, el('span', { class: 'trad', ...AV, 'aria-hidden': 'true' }), this.contentDOM);
    } else if (typ === 'punkt') {
      this.markor = el('span', { class: 'punktmarkor', ...AV, 'aria-hidden': 'true' });
      kropp = el('div', { class: 'punktrad' }, this.markor, this.contentDOM);
    } else if (typ === 'rubrik' && this.niva === 1) {
      this.extra = el('p', { class: 'under', ...AV });
      kropp = el('div', { class: 'huvud' }, this.contentDOM, this.extra);
    } else {
      // Every paragraph's words sit in a wrapper of their own, so the
      // cursor's glow and the text's own marks never share an element.
      kropp = el('div', { class: 'kropp' }, this.contentDOM);
    }
    this.kropp = kropp;
    this.kom = el('aside', { class: 'kom', ...AV });
    this.under = el('div', { class: 'under-st', ...AV });
    this.dom.append(this.marg, kropp, this.kom, this.under);
    this.satt(node);
    red.vyer.add(this);
  }

  satt(node) {
    this.node = node;
    const x = node.attrs;
    this.dom.dataset.id = x.id || '';
    const a = D.rensaAttrs(this.typ, x.a);
    if (this.etikett) {
      this.etikett.textContent = a.etikett || 'välj';
      this.etikett.classList.toggle('saknas', !a.etikett);
      this.etikett.title = a.etikett ? `Variant: ${a.etikett}. Tryck för att byta.` : 'Välj när telefonen ska välja raden';
    }
    if (this.markor) this.markor.textContent = /\d/.test(a.markor) ? a.markor.trim() : '•';
    if (this.typ === 'rubrik' && this.niva === 1) this.contentDOM.dataset.text = node.textContent;
    this.contentDOM.dataset.tom = PLATSHALLARE[this.typ] || '';
    this.dom.classList.toggle('tom', node.content.size === 0);
    if (this.typ === 'stycke') this.dom.dataset.form = a.form;
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    const typ = node.attrs.typ || 'stycke';
    if (typ !== this.typ) return false;
    if (typ === 'rubrik' && D.rensaAttrs('rubrik', node.attrs.a).niva !== this.niva) return false;
    this.satt(node);
    return true;
  }

  // Only the words are ProseMirror's; the margin, the comments and the
  // label are the page's.
  ignoreMutation(m) {
    if (m.type === 'selection') return !this.contentDOM.contains(m.target) && m.target !== this.contentDOM;
    if (m.type === 'attributes') return true;
    return !this.contentDOM.contains(m.target);
  }

  stopEvent(e) {
    const t = e.target;
    return !!(t && t.nodeType === 1 && !this.contentDOM.contains(t) && t.closest && t.closest('[contenteditable="false"]'));
  }

  destroy() { this.red.vyer.delete(this); }
}

class LinjeVy {
  constructor(node, view, getPos, red) {
    this.node = node;
    this.getPos = getPos;
    this.red = red;
    this.typ = 'linje';
    this.dom = el('div', { class: 'st linje' });
    this.marg = el('div', { class: 'marg' });
    this.kom = el('aside', { class: 'kom' });
    this.under = el('div', { class: 'under-st' });
    this.dom.append(this.marg, el('hr'), this.kom, this.under);
    this.dom.dataset.id = node.attrs.id || '';
    red.vyer.add(this);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.dataset.id = node.attrs.id || '';
    return true;
  }

  ignoreMutation() { return true; }

  stopEvent(e) {
    const t = e.target;
    return !!(t && t.closest && t.closest('button, a, input, textarea'));
  }

  destroy() { this.red.vyer.delete(this); }
}

// --- The editor --------------------------------------------------------------------------------

// opts:
//   plats        the element to put it in
//   paras        the paragraphs to start with
//   slag         D.SLAG_EPISOD or D.SLAG_FRI
//   kanSkriva    false: read only
//   katalog      the mechanics catalogue, for chips
//   nyttId       -> a new paragraph id
//   andrat()     the person changed something
//   flyttat()    the cursor moved, or the text changed (the toolbar follows)
//   rita(vy, p, info)  fill a paragraph's margin, comments and notes
//   klick(e, vy) a click outside the words, in a paragraph's own parts
export function skapaRedigerare(opts) {
  const red = new Redigerare(opts);
  return red;
}

class Redigerare {
  constructor(opts) {
    this.opts = opts;
    this.slag = opts.slag;
    this.katalog = opts.katalog || null;
    this.nyttId = opts.nyttId || D.nyttId;
    this.vyer = new Set();
    this.ver = 1;
    this.senast = 0;
    this.dod = false;
    this.cache = { doc: null, stycken: null, info: null };
    this.inlineCache = new WeakMap();
    this.decoCache = { doc: null, ver: 0, set: null };
    const paras = opts.paras && opts.paras.length ? opts.paras : [{ id: this.nyttId(), typ: 'stycke', attrs: {}, text: '' }];
    const doc = S.doc.create(null, paras.map(tillNod));
    const red = this;
    const plugin = new Plugin({
      key: NYCKEL,
      appendTransaction: (trs, gammal, state) => red.unikaId(trs, state),
      props: {
        decorations: (state) => red.dekorationer(state),
      },
      view: () => ({ update: () => red.ritaYtor() }),
    });
    const tangenter = {
      Enter: (st, d) => red.enter(st, d),
      'Shift-Enter': (st, d) => red.enter(st, d),
      'Mod-z': undo,
      'Mod-y': redo,
      'Mod-Shift-z': redo,
      'Mod-b': (st, d) => red.omslut(st, d, '**'),
      'Mod-i': (st, d) => red.omslut(st, d, '*'),
      Backspace: chainCommands(deleteSelection, (st, d) => red.tomtStyckeTillbaka(st, d), (st, d) => red.valjLinje(st, d, -1), joinBackward),
      Delete: chainCommands(deleteSelection, (st, d) => red.valjLinje(st, d, 1)),
    };
    // Ctrl+Shift+1..7, not Ctrl+Alt: on a Swedish keyboard Ctrl+Alt is AltGr,
    // and AltGr+2 is @.
    for (let k = 1; k <= 7; k++) tangenter[`Mod-Shift-${k}`] = (st, d) => red.stilNr(k - 1, st, d);
    this.state = EditorState.create({
      doc,
      plugins: [history({ newGroupDelay: 700 }), keymap(tangenter), keymap(baseKeymap), plugin],
    });
    this.view = new EditorView(opts.plats, {
      state: this.state,
      editable: () => !!opts.kanSkriva && !red.dod,
      attributes: { class: 'manus', spellcheck: 'true', lang: 'sv', 'aria-label': opts.etikett || 'Manus', role: 'textbox', 'aria-multiline': 'true' },
      nodeViews: {
        stycke: (n, v, g) => new StyckeVy(n, v, g, red),
        linje: (n, v, g) => new LinjeVy(n, v, g, red),
      },
      dispatchTransaction: (tr) => red.ta(tr),
      transformPasted: (slice, view) => red.inklistrat(slice, view),
      clipboardTextParser: (text, $ctx) => red.textIn(text, $ctx),
      clipboardTextSerializer: (slice) => {
        const rader = [];
        slice.content.forEach((n) => rader.push(n.isTextblock ? n.textContent : n.type === S.linje ? '---' : n.textContent));
        return rader.join('\n');
      },
      handleDOMEvents: {
        click: (v, e) => {
          const t = e.target;
          const vy = [...red.vyer].find((x) => x.dom.contains(t));
          if (opts.klick && vy && t.closest && (t.closest('[contenteditable="false"]') || t.closest('.bricka'))) return opts.klick(e, vy) || false;
          return false;
        },
      },
    });
    this.ritaYtor();
  }

  // --- Transactions ---

  ta(tr) {
    if (this.dod) return;
    const fore = this.view.state;
    const nu = fore.apply(tr);
    this.view.updateState(nu);
    if (nu.doc !== fore.doc && tr.getMeta(NYCKEL) !== UTIFRAN) {
      this.senast = Date.now();
      if (this.opts.andrat) this.opts.andrat();
    }
    if (this.opts.flyttat && (nu.doc !== fore.doc || !nu.selection.eq(fore.selection))) this.opts.flyttat();
  }

  // Two paragraphs never share an id, and every paragraph has one. A copy
  // gets a new id; the first one in the document keeps the old.
  unikaId(trs, state) {
    if (!trs.some((t) => t.docChanged)) return null;
    if (trs.every((t) => t.getMeta(NYCKEL) === UTIFRAN)) return null;
    const sett = new Set();
    let tr = null;
    state.doc.forEach((n, pos) => {
      const id = n.attrs.id;
      let typ = n.type === S.stycke ? n.attrs.typ : 'linje';
      if (id && !sett.has(id) && typ) { sett.add(id); return; }
      const nytt = id && !sett.has(id) ? id : this.nyttId();
      sett.add(nytt);
      if (!typ) typ = 'stycke';
      tr = tr || state.tr;
      const attrs = { ...n.attrs, id: nytt };
      if (nytt !== id) Object.assign(attrs, { raw: null, orig: null, sep: null });
      if (n.type === S.stycke) { attrs.typ = typ; attrs.a = D.rensaAttrs(typ, n.attrs.a); }
      tr.setNodeMarkup(pos, null, attrs);
    });
    return tr;
  }

  // --- For lager.js ---

  // doc: the one being drawn, while the view is still being built.
  stycken(doc = this.view.state.doc) {
    if (this.cache.doc !== doc) {
      const ut = [];
      doc.forEach((n) => ut.push(franNod(n)));
      this.cache = { doc, stycken: ut, info: null };
    }
    return this.cache.stycken;
  }

  // Where each paragraph stands: in a scene or not, which scene, under a branch.
  info(doc) {
    this.stycken(doc);
    if (!this.cache.info) {
      const p = this.cache.stycken;
      const omr = D.scenomrade(p.map((x) => x.typ), this.slag);
      const scener = D.scenerFor(p, this.slag);
      let igren = false;
      const ut = new Map();
      p.forEach((x, k) => {
        if (!omr[k] || ['scen', 'mekanik', 'linje'].includes(x.typ)) igren = false;
        if (omr[k] && x.typ === 'gren') igren = true;
        ut.set(x.id, { k, iScen: omr[k], scen: scener[k], igren: igren && omr[k] });
      });
      this.cache.info = ut;
    }
    return this.cache.info;
  }

  laser() {
    if (this.dod || !this.view.hasFocus() || Date.now() - this.senast > 5000) return null;
    const a = aktuell(this.view.state);
    return a ? a.node.attrs.id : null;
  }

  tillampa(ops) {
    if (this.dod || !ops.length) return;
    const tr = this.view.state.tr;
    for (const op of ops) {
      const hit = op.id ? hitta(tr.doc, op.id) : null;
      if (op.op === 'ersatt' && hit) this.ersattI(tr, hit, op.p);
      else if (op.op === 'infoga') {
        let pos = 0;
        if (op.efter) {
          const e = hitta(tr.doc, op.efter);
          pos = e ? e.pos + e.node.nodeSize : tr.doc.content.size;
        }
        tr.insert(pos, tillNod(op.p));
      } else if (op.op === 'ta-bort' && hit) {
        if (tr.doc.childCount === 1) tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, tillNod({ id: this.nyttId(), typ: 'stycke', attrs: {}, text: '' }));
        else tr.delete(hit.pos, hit.pos + hit.node.nodeSize);
      } else if (op.op === 'attrs' && hit) {
        tr.setNodeMarkup(hit.pos, null, { ...hit.node.attrs, raw: op.raw ?? null, orig: op.orig ?? null, sep: op.sep ?? null });
      } else if (op.op === 'byt-id' && hit) {
        tr.setNodeMarkup(hit.pos, null, { ...hit.node.attrs, id: op.till });
      }
    }
    if (!tr.docChanged) return;
    tr.setMeta('addToHistory', false).setMeta(NYCKEL, UTIFRAN);
    this.view.dispatch(tr);
  }

  // Replaces a paragraph's text by changing only what differs, so a cursor
  // in it stays where it was.
  ersattI(tr, hit, p) {
    const n = hit.node;
    if (n.type !== S.stycke || p.typ === 'linje' || (n.attrs.typ || 'stycke') !== p.typ) {
      tr.replaceWith(hit.pos, hit.pos + n.nodeSize, tillNod(p));
      return;
    }
    tr.setNodeMarkup(hit.pos, null, {
      ...n.attrs, id: p.id || n.attrs.id, a: D.rensaAttrs(p.typ, p.attrs), raw: p.raw ?? null, orig: p.orig ?? null, sep: p.sep ?? null,
    });
    const g = n.textContent;
    const y = p.text;
    let a = 0;
    while (a < g.length && a < y.length && g[a] === y[a]) a++;
    let b = 0;
    while (b < g.length - a && b < y.length - a && g[g.length - 1 - b] === y[y.length - 1 - b]) b++;
    const start = hit.pos + 1;
    const mitt = y.slice(a, y.length - b);
    if (a === g.length - b && !mitt) return;
    if (mitt) tr.replaceWith(start + a, start + g.length - b, schema.text(mitt));
    else tr.delete(start + a, start + g.length - b);
  }

  // --- Commands ---

  // Enter: a new paragraph. At the end of one, the next kind follows the
  // manuscript (a scene heading is followed by its mechanic, a mechanic by
  // a line); at the start, an empty one of the same kind goes in above; in
  // the middle, the paragraph is split in two of the same kind.
  enter(state, dispatch) {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
      if (!dispatch) return true;
      const pos = sel.to;
      const tr = state.tr.insert(pos, tillNod({ id: this.nyttId(), typ: 'stycke', attrs: {}, text: '' }));
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      dispatch(tr.scrollIntoView());
      return true;
    }
    if (!dispatch) return true;
    const tr = state.tr;
    if (!sel.empty) tr.deleteSelection();
    const $p = tr.selection.$from;
    if ($p.depth < 1) return false;
    const node = $p.node(1);
    const pos = $p.before(1);
    const typ = node.attrs.typ || 'stycke';
    const a = D.rensaAttrs(typ, node.attrs.a);
    const info = this.info().get(node.attrs.id);
    const iScen = !!(info && info.iScen);
    const off = $p.parentOffset;
    if (off === node.content.size && node.content.size === 0 && ['variant', 'punkt', 'gren', 'mekanik', 'scen'].includes(typ)) {
      // Enter on an empty list item or variant leaves the list, as in Word.
      const ny = iScen ? { typ: 'replik', a: {} } : { typ: 'stycke', a: { form: 'fri' } };
      tr.setNodeMarkup(pos, null, { ...node.attrs, typ: ny.typ, a: D.rensaAttrs(ny.typ, ny.a) });
      dispatch(tr.scrollIntoView());
      return true;
    }
    if (off === node.content.size) {
      const n = this.nasta(node, iScen, pos);
      const ny = tillNod({ id: this.nyttId(), typ: n.typ, attrs: n.a, text: n.text || '' });
      const efter = pos + node.nodeSize;
      tr.insert(efter, ny);
      tr.setSelection(TextSelection.create(tr.doc, efter + 1 + (n.markor || 0)));
    } else if (off === 0) {
      const ny = tillNod({ id: this.nyttId(), typ, attrs: typ === 'variant' ? { etikett: '' } : a, text: '' });
      tr.insert(pos, ny);
      tr.setSelection(TextSelection.create(tr.doc, pos + ny.nodeSize + 1));
    } else {
      tr.split($p.pos, 1, [{ type: S.stycke, attrs: { id: this.nyttId(), typ, a: typ === 'variant' ? { etikett: a.etikett } : a, raw: null, orig: null, sep: null } }]);
    }
    dispatch(tr.scrollIntoView());
    return true;
  }

  nasta(node, iScen, pos) {
    const typ = node.attrs.typ || 'stycke';
    const a = D.rensaAttrs(typ, node.attrs.a);
    if (typ === 'scen') {
      const har = this.scenHar(pos, 'mekanik');
      return har ? { typ: 'replik', a: {} } : { typ: 'mekanik', a: {} };
    }
    if (['mekanik', 'gren', 'regi', 'replik'].includes(typ)) return { typ: 'replik', a: {} };
    if (typ === 'variant') return { typ: 'variant', a: { etikett: '' } };
    if (typ === 'rubrik') return iScen ? { typ: 'replik', a: {} } : { typ: 'stycke', a: { form: 'fri' } };
    if (typ === 'punkt') {
      const m = /^(\s*)(\d+)([.)] )$/.exec(a.markor);
      return { typ: 'punkt', a: { markor: m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : a.markor } };
    }
    if (typ === 'tabell') {
      const celler = Math.max(1, node.textContent.split('|').length - 2);
      return { typ: 'tabell', a: {}, text: `|${'  |'.repeat(celler)}`, markor: 2 };
    }
    if (typ === 'stycke') return { typ: 'stycke', a: { form: a.form === 'citat-kursiv' ? 'citat' : a.form } };
    return { typ: iScen ? 'replik' : 'stycke', a: {} };
  }

  // The paragraphs of the scene a position is in: { start, slut } indexes
  // (slut exclusive), or null outside the scenes.
  scenVid(k) {
    const p = this.stycken();
    const inf = this.info();
    if (!p[k] || !inf.get(p[k].id).iScen) return null;
    let start = k;
    while (start >= 0 && p[start].typ !== 'scen') start--;
    if (start < 0) return null;
    let slut = start + 1;
    while (slut < p.length && inf.get(p[slut].id).iScen && p[slut].typ !== 'scen') slut++;
    return { start, slut };
  }

  scenHar(pos, typ) {
    const k = this.view.state.doc.resolve(pos).index(0);
    const s = this.scenVid(k);
    if (!s) return false;
    return this.stycken().slice(s.start + 1, s.slut).some((x) => x.typ === typ);
  }

  // Backspace in an empty paragraph of a kind that has a default (a list
  // item, a variant) first makes it the default, as in Word.
  tomtStyckeTillbaka(state, dispatch) {
    const sel = state.selection;
    if (!sel.empty || sel.$from.parentOffset !== 0 || sel.$from.depth < 1) return false;
    const node = sel.$from.node(1);
    if (node.content.size !== 0 || !['punkt', 'variant'].includes(node.attrs.typ)) return false;
    const info = this.info().get(node.attrs.id);
    const ny = info && info.iScen ? { typ: 'replik', a: {} } : { typ: 'stycke', a: { form: 'fri' } };
    if (dispatch) dispatch(state.tr.setNodeMarkup(sel.$from.before(1), null, { ...node.attrs, typ: ny.typ, a: D.rensaAttrs(ny.typ, ny.a) }));
    return true;
  }

  // Backspace at the start of a paragraph right after a line (---), or
  // Delete at the end of one right before it: the line is selected first,
  // and goes with the next press. A line marks where the scenes end, so it
  // never goes by accident.
  valjLinje(state, dispatch, riktning) {
    const sel = state.selection;
    if (!sel.empty || sel.$from.depth < 1) return false;
    const $p = sel.$from;
    if (riktning < 0 ? $p.parentOffset !== 0 : $p.parentOffset !== $p.parent.content.size) return false;
    const k = $p.index(0) + riktning;
    if (k < 0 || k >= state.doc.childCount || state.doc.child(k).type !== S.linje) return false;
    if (dispatch) {
      let pos = 0;
      for (let x = 0; x < k; x++) pos += state.doc.child(x).nodeSize;
      dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView());
    }
    return true;
  }

  // Ctrl+B, Ctrl+I: the md marks around the selection.
  omslut(state, dispatch, mark) {
    const { from, to, empty, $from, $to } = state.selection;
    if (empty || !$from.sameParent($to) || !$from.parent.isTextblock) return false;
    if (dispatch) {
      const tr = state.tr.insertText(mark, to).insertText(mark, from);
      tr.setSelection(TextSelection.create(tr.doc, from + mark.length, to + mark.length));
      dispatch(tr);
    }
    return true;
  }

  stilar() {
    const a = aktuell(this.view.state);
    const info = a && this.info().get(a.node.attrs.id);
    return info && info.iScen ? STILAR_SCEN : STILAR_TEXT;
  }

  stilNr(n, state, dispatch) {
    const stil = this.stilar()[n];
    if (!stil) return false;
    if (dispatch) this.sattStil(stil);
    return true;
  }

  // The paragraph the cursor is in, for the toolbar.
  markor() {
    const a = aktuell(this.view.state);
    if (!a) return null;
    const p = franNod(a.node);
    const info = this.info().get(p.id) || {};
    return { p, iScen: !!info.iScen, scen: info.scen, k: a.k, stil: stilnamn(p, info.iScen) };
  }

  // Changes the kind of every paragraph in the selection.
  sattStil(stil) {
    const state = this.view.state;
    const { from, to } = state.selection;
    const tr = state.tr;
    const inf = this.info();
    const stycken = this.stycken();
    const nodes = [];
    state.doc.nodesBetween(from, Math.max(from, to), (n, pos) => {
      if (n.type === S.stycke) nodes.push({ n, pos });
      return false;
    });
    for (const { n, pos } of nodes) {
      const p = franNod(n);
      const info = inf.get(p.id) || {};
      let a = { ...(stil.a || {}) };
      if (stil.typ === p.typ && p.typ !== 'stycke' && p.typ !== 'punkt' && p.typ !== 'rubrik') a = { ...p.attrs, ...a };
      if (stil.typ === 'stycke' && info.iScen) a.form = p.text.includes('*') ? 'fri' : 'kursiv';
      if (stil.typ === 'rubrik' && p.typ === 'rubrik') a.prefix = p.attrs.prefix;
      if (stil.typ === 'variant' && p.typ !== 'variant') a.etikett = '';
      const ny = { ...n.attrs, typ: stil.typ, a: D.rensaAttrs(stil.typ, a) };
      const m = tr.mapping.map(pos);
      tr.setNodeMarkup(m, null, ny);
      if (stil.typ === 'scen' && !/^\d+\.\s/.test(p.text)) {
        let nr = 0;
        for (let k = info.k - 1; k >= 0; k--) {
          const x = stycken[k];
          const t = x.typ === 'scen' && /^(\d+)\./.exec(x.text);
          if (t) { nr = Number(t[1]) + 1; break; }
        }
        tr.insertText(`${nr}. `, m + 1);
      }
    }
    if (tr.docChanged) this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
  }

  sattEtikett(id, etikett) {
    const hit = hitta(this.view.state.doc, id);
    if (!hit) return;
    const a = { ...D.rensaAttrs('variant', hit.node.attrs.a), etikett };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(hit.pos, null, { ...hit.node.attrs, typ: 'variant', a }));
  }

  // A person's own change to a whole paragraph (a proposal laid in, an
  // earlier version taken back): in the undo history like typing.
  ersattStycke(id, p) {
    const hit = hitta(this.view.state.doc, id);
    if (!hit) return null;
    const tr = this.view.state.tr;
    this.ersattI(tr, hit, { ...p, id, raw: null, orig: null, sep: null });
    if (tr.docChanged) this.view.dispatch(tr);
    return franNod(hitta(this.view.state.doc, id).node);
  }

  infogaStycke(efterId, p) {
    const tr = this.view.state.tr;
    let pos = 0;
    if (efterId) {
      const e = hitta(tr.doc, efterId);
      if (e) pos = e.pos + e.node.nodeSize;
    }
    tr.insert(pos, tillNod({ ...p, raw: null, orig: null, sep: null }));
    this.view.dispatch(tr.scrollIntoView());
    return p.id;
  }

  // Adds a mechanic from the catalogue to the scene the cursor is in: its
  // name at the end of the scene's Mekanik paragraph (a new one under the
  // heading if there is none), and two empty branches at the end of the
  // scene if it has none. Nothing that is there is overwritten.
  // -> { ok, fel?, grenar? }
  infogaMekanik(namn) {
    const a = aktuell(this.view.state);
    if (!a) return { ok: false, fel: 'Ställ markören i en scen först.' };
    const s = this.scenVid(a.k);
    if (!s) return { ok: false, fel: 'Ställ markören i en scen först. Mekaniker hör till scenerna.' };
    const p = this.stycken();
    const tr = this.view.state.tr;
    const doc = this.view.state.doc;
    const posAv = (k) => {
      let pos = 0;
      for (let x = 0; x < k; x++) pos += doc.child(x).nodeSize;
      return pos;
    };
    let mk = -1;
    for (let k = s.start + 1; k < s.slut; k++) if (p[k].typ === 'mekanik') { mk = k; break; }
    let markor = null;
    if (mk >= 0) {
      const n = doc.child(mk);
      const t = n.textContent.replace(/\s+$/, '');
      const tillagg = t ? `${/[.!?:]$/.test(t) ? '' : '.'} ${namn}.` : `${namn}.`;
      const slut = posAv(mk) + 1 + n.content.size;
      if (t.length !== n.textContent.length) tr.delete(posAv(mk) + 1 + t.length, slut);
      tr.insertText(tillagg, posAv(mk) + 1 + t.length);
      markor = tr.mapping.map(slut);
    } else {
      const efter = posAv(s.start) + doc.child(s.start).nodeSize;
      tr.insert(efter, tillNod({ id: this.nyttId(), typ: 'mekanik', attrs: {}, text: `${namn}.` }));
      markor = efter + 1 + namn.length + 1;
    }
    let grenar = false;
    if (!p.slice(s.start + 1, s.slut).some((x) => x.typ === 'gren')) {
      const slutPos = tr.mapping.map(posAv(s.slut - 1) + doc.child(s.slut - 1).nodeSize);
      const g1 = tillNod({ id: this.nyttId(), typ: 'gren', attrs: { form: 'fet' }, text: '' });
      const g2 = tillNod({ id: this.nyttId(), typ: 'gren', attrs: { form: 'fet' }, text: '' });
      tr.insert(slutPos, [g1, g2]);
      markor = slutPos + 1;
      grenar = true;
    }
    tr.setSelection(TextSelection.create(tr.doc, Math.min(markor, tr.doc.content.size)));
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    return { ok: true, grenar };
  }

  // --- Paste ---

  // What comes in from the clipboard: the room's own paragraphs keep what
  // they are (a copy gets new ids, a cut keeps its own); text from elsewhere
  // gets the kind of the paragraph it lands in.
  inklistrat(slice, view) {
    const finns = new Set(this.stycken().map((p) => p.id));
    const flytt = !!(view.dragging && view.dragging.move);
    const a = aktuell(view.state);
    const info = a && this.info().get(a.node.attrs.id);
    const iScen = !!(info && info.iScen);
    const har = a && a.node.type === S.stycke ? (a.node.attrs.typ || 'stycke') : 'stycke';
    const forval = iScen ? (['scen', 'mekanik', 'gren'].includes(har) ? 'replik' : har) : (['scen', 'mekanik', 'replik', 'regi', 'variant', 'gren'].includes(har) ? 'stycke' : har);
    const ut = [];
    slice.content.forEach((n) => {
      if (!n.isBlock) { ut.push(n); return; }
      let attrs = { ...n.attrs };
      if (attrs.id && finns.has(attrs.id) && !flytt) attrs = { ...attrs, id: null, raw: null, orig: null, sep: null };
      if (n.type === S.stycke && !attrs.typ) {
        attrs.typ = forval;
        attrs.a = D.rensaAttrs(forval, forval === har && a ? a.node.attrs.a : {});
        attrs.id = null;
      }
      ut.push(n.type.create(attrs, n.content, n.marks));
    });
    return new Slice(Fragment.from(ut), slice.openStart, slice.openEnd);
  }

  // Plain text: one paragraph per line. A line written in the file's own
  // form ("> ...", "## 3. ...", "*Trigger: ...*") becomes that kind; plain
  // words become the kind of the paragraph they land in.
  textIn(text, $ctx) {
    const rader = text.replace(/\r\n?/g, '\n').split('\n').filter((r) => !D.arSeparator(r));
    if (rader.length <= 1) return new Slice(Fragment.from(rader[0] ? schema.text(rader[0]) : []), 0, 0);
    const node = $ctx.depth >= 1 ? $ctx.node(1) : null;
    const info = node && this.info().get(node.attrs.id);
    const iScen = !!(info && info.iScen);
    const har = node && node.type === S.stycke ? (node.attrs.typ || 'stycke') : 'stycke';
    const nodes = rader.map((ra) => {
      const q = D.tolkaRad(ra, iScen);
      // A whole line in parentheses, in a scene, is direction.
      const regi = iScen && q.typ === 'stycke' && q.attrs.form === 'fri' && /^\(([^()]+)\)$/.exec(ra.trim());
      if (regi) return tillNod({ id: null, typ: 'regi', attrs: {}, text: regi[1] });
      if (q.typ === 'stycke' && q.attrs.form === 'fri') {
        const typ = iScen ? (['scen', 'mekanik', 'gren', 'stycke'].includes(har) ? 'replik' : har) : (['punkt', 'tabell', 'rubrik'].includes(har) ? 'stycke' : har);
        const ok = iScen || !D.SCENTYPER.has(typ);
        const t = ok ? typ : 'stycke';
        return tillNod({ id: null, typ: t, attrs: t === 'variant' ? { etikett: '' } : {}, text: ra });
      }
      return tillNod({ id: null, typ: q.typ, attrs: q.attrs, text: q.text });
    });
    return new Slice(Fragment.from(nodes), 1, 1);
  }

  // --- Decorations ---

  dekorationer(state) {
    const doc = state.doc;
    if (this.decoCache.doc !== doc || this.decoCache.ver !== this.ver) {
      const decos = [];
      const inf = this.info(doc);
      doc.forEach((n, pos) => {
        if (n.type !== S.stycke) return;
        const id = n.attrs.id;
        const info = inf.get(id) || {};
        let c = this.inlineCache.get(n);
        if (!c || c.ver !== this.ver || c.iScen !== !!info.iScen) {
          c = { ver: this.ver, iScen: !!info.iScen, delar: inline(franNod(n), !!info.iScen, this.katalog) };
          this.inlineCache.set(n, c);
        }
        for (const d of c.delar) decos.push(Decoration.inline(pos + 1 + d.fran, pos + 1 + d.till, { class: d.klass, ...(d.attrs || {}) }));
        if (info.igren) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'igren' }));
      });
      this.decoCache = { doc, ver: this.ver, set: DecorationSet.create(doc, decos) };
    }
    const a = aktuell(state);
    if (!a || !this.opts.kanSkriva) return this.decoCache.set;
    return this.decoCache.set.add(doc, [Decoration.node(a.pos, a.pos + a.node.nodeSize, { class: 'har' })]);
  }

  // --- The page's parts of each paragraph ---

  ritaYtor() {
    if (this.dod || !this.opts.rita || !this.view) return;
    const inf = this.info();
    for (const vy of this.vyer) {
      const info = inf.get(vy.node.attrs.id);
      if (!info) continue;
      if (vy._nod === vy.node && vy._ver === this.ver && vy._iScen === info.iScen && vy._igren === info.igren && vy._scen === info.scen) continue;
      vy._nod = vy.node;
      vy._ver = this.ver;
      vy._iScen = info.iScen;
      vy._igren = info.igren;
      vy._scen = info.scen;
      this.opts.rita(vy, franNod(vy.node), info);
    }
    if (this.opts.ritat) this.opts.ritat();
  }

  // Something beside the text changed (notes, the catalogue, a setting):
  // draw again.
  ritaOm({ katalog } = {}) {
    if (katalog !== undefined) this.katalog = katalog;
    this.ver += 1;
    if (this.dod) return;
    this.view.dispatch(this.view.state.tr.setMeta(NYCKEL, 'rita'));
    this.ritaYtor();
  }

  vyFor(id) {
    for (const vy of this.vyer) if (vy.node.attrs.id === id) return vy;
    return null;
  }

  // Puts the cursor at the end of a paragraph and shows it.
  ga(id, { fokus = true, borjan = false } = {}) {
    const hit = hitta(this.view.state.doc, id);
    if (!hit) return false;
    const pos = hit.node.type === S.linje ? hit.pos : hit.pos + 1 + (borjan ? 0 : hit.node.content.size);
    const sel = hit.node.type === S.linje ? NodeSelection.create(this.view.state.doc, hit.pos) : TextSelection.create(this.view.state.doc, pos);
    this.view.dispatch(this.view.state.tr.setSelection(sel));
    const vy = this.vyFor(id);
    if (vy) vy.dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (fokus && this.opts.kanSkriva) this.view.focus();
    return true;
  }

  fokus() { if (!this.dod) this.view.focus(); }

  angra() { undo(this.view.state, (tr) => this.view.dispatch(tr)); this.view.focus(); }

  gorOm() { redo(this.view.state, (tr) => this.view.dispatch(tr)); this.view.focus(); }

  forstor() {
    if (this.dod) return;
    // Keeps answering stycken() with what it had: a save that is under way
    // finishes with it.
    this.stycken();
    this.dod = true;
    this.view.destroy();
  }
}

export { Selection };
