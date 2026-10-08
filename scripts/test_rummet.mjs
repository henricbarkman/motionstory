#!/usr/bin/env node
// Checks the room (rummet/), version 2: every file read and written back byte
// for byte, the paragraph kinds and what may be saved, finding paragraphs
// again after others changed the file, the merge per paragraph, the history,
// comments and proposals, the mechanics catalogue and its chips, recorded
// sound per paragraph, and saving through the store: two windows, a file
// changed in between, a lost write, unsaved text kept in the browser. The
// last part runs the portal's own file code (scripts/dashboard/files.py)
// behind scripts/rummet_provserver.py.
//
//   node scripts/test_rummet.mjs
//   RUMMET_DIR=/some/copy/ node scripts/test_rummet.mjs    # a mutated copy, for mutation tests
//
// Never writes to stories/: every write goes to memory or to a temp folder.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.RUMMET_DIR || join(REPO, 'rummet');
const imp = (f) => import(pathToFileURL(join(DIR, f)).href);
const Dk = await imp('dok.js');
const K = await imp('katalog.js');
const A = await imp('anteckn.js');
const L = await imp('ljud.js');
const M = await imp('manus.js');
const D = await imp('data.js');
const S = await imp('lager.js');

let failures = 0;
let checks = 0;
const ok = (cond, what) => {
  checks++;
  if (!cond || process.env.VERBOSE) console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
};
const throwsKod = (fn, kod) => { try { fn(); return false; } catch (e) { return e.kod === kod; } };

const las = (f) => readFileSync(join(REPO, f), 'utf8');
const FIL = {
  1: las('stories/glimt/episod-1.md'),
  2: las('stories/glimt/episod-2.md'),
  varld: las('stories/glimt/varld.md'),
  mekaniker: las('stories/glimt/mekaniker.md'),
};
const SLAG = { 1: 'episod', 2: 'episod', varld: 'fri', mekaniker: 'fri' };
// Episode 1 as it was recorded (the text episod-1.json was made from).
const INSPELAD = execFileSync('git', ['-C', REPO, 'show', 'ece9bb0:stories/glimt/episod-1.md'], { encoding: 'utf8' });
const JSON1 = las('stories/glimt/episod-1.json');
const TIDER = JSON.parse(las('rummet/ljudtider.json'));

const rader = (t) => t.split('\n');
const diffRader = (a, b) => {
  const x = rader(a);
  const y = rader(b);
  const ut = [];
  for (let k = 0; k < Math.max(x.length, y.length); k++) if (x[k] !== y[k]) ut.push(k);
  return ut;
};

// --- 1. Every file back byte for byte -----------------------------------------------

for (const [namn, text] of Object.entries(FIL)) {
  const d = Dk.tolka(text, SLAG[namn]);
  ok(Dk.skriv(d) === text, `${namn}: read and written back without a change, byte for byte`);
  ok(d.paras.every((p) => Dk.skrivRad(p) === p.raw), `${namn}: every line would be written exactly so even if it had been retyped`);
  const omr = Dk.scenomrade(d.paras.map((p) => p.typ), SLAG[namn]);
  ok(d.paras.every((p, k) => Dk.fel(p, omr[k]) === null), `${namn}: every paragraph as it stands can be saved`);
  const j = Dk.justera(d.paras, null);
  const igen = Dk.justera(Dk.tolka(text, SLAG[namn]).paras, null);
  ok(j.every((p, k) => p.id === igen[k].id) && new Set(j.map((p) => p.id)).size === j.length, `${namn}: two windows give the same paragraphs the same ids`);
  ok(Dk.lasesSom(text, d.paras, SLAG[namn]), `${namn}: the whole-file check accepts the file as it is`);
}
{
  const d = Dk.tolka('rad ett\nrad två', 'fri');
  ok(Dk.skriv(d) === 'rad ett\nrad två', 'a text without a last newline stays without one');
}

// --- 2. Paragraph kinds --------------------------------------------------------------

{
  const d = Dk.tolka(FIL[1], 'episod');
  const typer = (t) => d.paras.filter((p) => p.typ === t);
  ok(typer('scen').length === 6 && typer('mekanik').length === 6, 'episode 1: six scenes, six Mekanik paragraphs');
  ok(typer('variant').every((p) => p.attrs.etikett) && typer('variant').length === 15, 'episode 1: fifteen variants, each with its label');
  const t = d.paras[0];
  ok(t.typ === 'rubrik' && t.attrs.prefix === 'Glimt, episod 1: ' && !t.text.startsWith('Glimt'), 'the title is written without its "Glimt, episod 1:" prefix, which stays');
  const ja = typer('gren').find((p) => p.raw.startsWith('> **'));
  ok(ja && Dk.skrivRad({ ...ja, text: 'Ny gren:' }) === '> **Ny gren:**', 'a branch keeps its marks: people write only the words');
  const v = typer('variant')[0];
  ok(Dk.skrivRad({ ...v, text: 'Ny text.' }) === `> [${v.attrs.etikett}] Ny text.`, 'a variant keeps its label');
  const m = typer('mekanik')[0];
  ok(Dk.skrivRad({ ...m, text: 'Stanna för ja.' }) === '*Trigger: Stanna för ja.*', 'a Mekanik paragraph is a Trigger line in the file');
  ok(Dk.skrivRad({ typ: 'regi', attrs: {}, text: 'dovt' }) === '> (dovt)', 'direction: the room writes the parentheses');
  // Things that would read back as something else are held, not written.
  const fel = (p, iScen = true) => Dk.fel({ attrs: {}, ...p }, iScen);
  ok(fel({ typ: 'replik', text: '[mörkt] smyger' }) === 'form', 'a line typed as "[x] ..." in a Replik is held: it would turn into a variant');
  ok(fel({ typ: 'replik', text: '(hela repliken i parentes)' }) === 'form', 'a Replik in parentheses is held: it would read as direction');
  ok(fel({ typ: 'regi', text: 'a) och (b' }) === 'regi', 'direction whose parenthesis closes in the middle is held');
  ok(fel({ typ: 'variant', attrs: { etikett: '' }, text: 'x' }) === 'utan-etikett', 'a variant without a label is held');
  ok(fel({ typ: 'scen', text: 'Trädet' }) === 'scen', 'a scene heading without its number is held');
  ok(fel({ typ: 'replik', text: 'x' }, false) === 'utanfor-scen', 'a Replik outside the scenes is held');
  ok(fel({ typ: 'stycke', attrs: { form: 'fri' }, text: '   ' }) === 'tom', 'an empty paragraph is not saved');
  ok(fel({ typ: 'stycke', attrs: { form: 'fri' }, text: '## inte en rubrik' }) === 'form', 'text that starts like a heading is held in a plain paragraph');
  ok(fel({ typ: 'replik', text: 'Helt vanlig replik, med (regi) i mitten.' }) === null, 'an ordinary Replik with direction inside is fine');
}

// --- 3. Finding paragraphs again ---------------------------------------------------------

{
  const fore = Dk.justera(Dk.tolka(FIL[1], 'episod').paras, null);
  const skugga = Dk.skuggaFor(fore);
  const raa = rader(FIL[1]);
  const i = raa.findIndex((r) => r.startsWith('> Jag vet inte vem du är'));
  raa[i] = '> Jag vet inte vem du är. Jag vet inte om du hör mig.';
  raa.splice(i - 1, 0, '> En helt ny rad.', '>');
  raa.splice(3, 1);
  const efter = Dk.justera(Dk.tolka(raa.join('\n'), 'episod').paras, skugga);
  const id = fore.find((p) => p.raw.startsWith('> Jag vet inte vem du är')).id;
  ok(efter.find((p) => p.text.startsWith('Jag vet inte vem du är. Jag vet inte om du hör mig.')).id === id, 'a rewritten line keeps its id when others moved around it');
  const kvar = fore.filter((p) => efter.some((q) => q.raw === p.raw));
  ok(kvar.every((p) => efter.find((q) => q.raw === p.raw && q.id === p.id)), 'every untouched line keeps its id');
  ok(!fore.some((p) => p.id === efter.find((q) => q.text === 'En helt ny rad.').id), 'a new line gets a new id');
}

// --- 4. Merging per paragraph ----------------------------------------------------------------

{
  const P = (id, text, typ = 'replik') => ({ id, typ, attrs: {}, text });
  const bas = [P('a', 'Ett.'), P('b', 'Två.'), P('c', 'Tre.')];
  let r = Dk.sammanfoga(bas, [P('a', 'Ett!'), P('b', 'Två.'), P('c', 'Tre.')], [P('a', 'Ett.'), P('b', 'Två?'), P('c', 'Tre.')]);
  ok(r.paras.map((p) => p.text).join(' ') === 'Ett! Två? Tre.' && !r.krockar.length, 'two people changing different paragraphs: both changes stay');
  r = Dk.sammanfoga(bas, [P('a', 'Min.'), P('b', 'Två.'), P('c', 'Tre.')], [P('a', 'Din.'), P('b', 'Två.'), P('c', 'Tre.')]);
  ok(r.paras[0].text === 'Min.' && r.krockar.length === 1 && r.krockar[0].fjarr.text === 'Din.', 'the same paragraph changed by two: the one saving now goes in the text, the other is kept as a krock');
  r = Dk.sammanfoga(bas, [P('a', 'Ett.'), P('c', 'Tre.')], [P('a', 'Ett.'), P('b', 'Två, ändrad.'), P('c', 'Tre.')]);
  ok(r.paras.map((p) => p.text).join(' ') === 'Ett. Två, ändrad. Tre.', 'removed here while changed there: it stays');
  r = Dk.sammanfoga(bas, [P('a', 'Ett.'), P('b', 'Två, min.'), P('c', 'Tre.')], [P('a', 'Ett.'), P('c', 'Tre.')]);
  ok(r.paras.map((p) => p.text).join(' ') === 'Ett. Två, min. Tre.', 'changed here while removed there: it stays');
  r = Dk.sammanfoga(bas, [P('a', 'Ett.'), P('c', 'Tre.')], [P('a', 'Ett.'), P('b', 'Två.'), P('c', 'Tre.')]);
  ok(r.paras.map((p) => p.text).join(' ') === 'Ett. Tre.', 'removed here, untouched there: removed');
  r = Dk.sammanfoga(bas, [P('a', 'Ett.'), P('n', 'Ny.'), P('b', 'Två.'), P('c', 'Tre.')], [P('x', 'Först.'), P('a', 'Ett.'), P('b', 'Två.'), P('c', 'Tre.')]);
  ok(r.paras.map((p) => p.id).join('') === 'xanbc', 'new paragraphs from both sides land where they were written');
  r = Dk.sammanfoga(bas, [P('c', 'Tre.'), P('a', 'Ett.'), P('b', 'Två.')], [P('a', 'Ett.'), P('b', 'Två!'), P('c', 'Tre.')]);
  ok(r.paras.map((p) => p.id + p.text).join(' ') === 'cTre. aEtt. bTvå!', 'a paragraph moved here keeps its new place, and the other change comes along');
  // A race between two windows that both named the same new line.
  const byt = Dk.namnbyten(new Map([['f1', P('f1', 'Samma.')]]), [P('f1', 'Samma.')], [P('f2', 'Samma.')]);
  ok(byt.get('f1') === 'f2', 'two ids for the same line: the editor takes the file\'s');
}

// --- 5. The mechanics catalogue ---------------------------------------------------------------

const KAT = K.tolkaKatalog(FIL.mekaniker);
{
  const namn = (n) => KAT.mekaniker.find((k) => k.namn === n);
  ok(KAT.mekaniker.filter((k) => !k.ide).length === (FIL.mekaniker.match(/^### /gm) || []).length, `every "###" in the file is a mechanic (${KAT.mekaniker.length} with the two ideas)`);
  ok(namn('Stanna för ja').omdome === 'Osäker' && namn('Kontakten').omdome === 'Håller' && namn('Tjuvlyssning').omdome === 'Idé', 'verdicts read from the file');
  ok(namn('Minnet mellan episoderna').omdome === null, 'a mechanic whose verdict is no verdict word gets none (not a guess)');
  const v = K.varianter(KAT).map((x) => x.etikett).sort().join(',');
  ok(v === ['bro', 'berg', 'gång', 'kyrkogård', 'ljust', 'löpning', 'mörkt', 'regn', 'skog', 'torrt', 'vatten'].sort().join(','), 'the variant labels come from the catalogue');
  // Hand count of the chips (2026-10-08): the catalogue's names in the Mekanik paragraphs.
  //   episode 1: Kontakten at lines 29, 44, 60, 77, 130; lampan at 77, 156 = 7
  //   episode 2: Kontakten at 33, 51 (twice), 121; fortare at 121, 283 (twice); lampan at 89 = 8
  const brickor = (t) => Dk.tolka(t, 'episod').paras.filter((p) => p.typ === 'mekanik').flatMap((p) => K.hittaNamn(p.text, KAT).map((h) => `${p.rad + 1}:${h.mekanik.namn}`));
  ok(brickor(FIL[1]).join(' ') === '29:Kontakten 44:Kontakten 60:Kontakten 77:Kontakten 77:Farligt stopp (lampan) 130:Kontakten 156:Farligt stopp (lampan)', 'episode 1: the chips are exactly the hand count');
  ok(brickor(FIL[2]).join(' ') === '33:Kontakten 51:Kontakten 51:Kontakten 89:Farligt stopp (lampan) 121:Kontakten 121:Fortare 283:Fortare 283:Fortare', 'episode 2: the chips are exactly the hand count');
  ok(!K.hittaNamn('vandraren går i sin egen takt och hittar hem', KAT).some((h) => h.mekanik.namn === 'Takten'), 'no chip for "takt" (not the name Takten)');
  ok(K.hittaNamn('Hon knackar två gånger', KAT).map((h) => h.mekanik.namn).join() === 'Hon knackar', 'the longest name wins');
  ok(K.hittaNamn('Kontaktens styrka', KAT).length === 1 && K.hittaNamn('kontaktlös', KAT).length === 0, 'simple inflection, never a word that only starts like a name');
  const w = K.varsel(namn('Stanna för ja'), KAT);
  ok(w && w[0].ord === 'Osäker' && /lätta följder/.test(w[0].text), 'Osäker gets the quiet line from the catalogue\'s own rule');
  ok(K.varsel(namn('Kontakten'), KAT) === null, 'Håller gets no line');
  ok(K.arNyMekanik('**Ny mekanik:** hoppa') && K.arNyMekanik('Ny mekanik: hoppa') && !K.arNyMekanik('runt minut två'), '"Ny mekanik:" first in a Mekanik paragraph is a request to Demi');
  const egen = K.tolkaKatalog('## Grupp\n\n### Hoppet\n**Du gör:** hoppar.\n**Omdöme:** Oprövad. Ny.\n');
  ok(egen.mekaniker.length === 1 && egen.mekaniker[0].omdome === 'Oprövad', 'a new "###" in the file is a new mechanic: nothing is hardcoded');
}

// --- 6. Recorded sound per paragraph -------------------------------------------------------------

{
  const ljud = L.tolkaLjud(JSON1, TIDER);
  const d = Dk.tolka(INSPELAD, 'episod');
  const kropp = (p) => (p.typ === 'regi' ? `(${p.text})` : p.typ === 'variant' ? p.text : M.tolkaInnehall(p.text).kropp);
  const talade = d.paras.filter((p) => ['replik', 'variant', 'regi'].includes(p.typ));
  const lagen = { tyst: 0, inspelad: 0, ej: 0 };
  for (const p of talade) lagen[L.ljudFor(kropp(p), ljud).lage]++;
  ok(lagen.ej === 0 && lagen.inspelad >= 70, `episode 1 as recorded: every spoken paragraph has its recording (${lagen.inspelad} recorded, ${lagen.tyst} silent)`);
  const p = talade.find((x) => x.text.startsWith('Jag vet inte vem du är.'));
  ok(L.ljudFor(kropp({ ...p, text: p.text.replace('vem du är', 'vad du är') }), ljud).lage === 'ej', 'change one word and it is not recorded any more');
}

// --- 7. The first version's notes move over ----------------------------------------------------

{
  const m1 = M.tolka(FIL[1]);
  const i = m1.rader.findIndex((r) => r.typ === 'replik' && r.scen != null);
  const j = m1.rader.findIndex((r, k) => k > i + 4 && r.typ === 'replik' && r.scen != null);
  const v1 = {
    format: 1, episod: '1',
    rader: [{ mal: M.ankareFor(m1, i), skrev: 'henric', nar: '2026-10-08T07:00:00Z', hur: 'andrade', tidigare: [{ kropp: 'Förut.', skrev: 'demi', nar: null }] }],
    forslag: [{ id: 'f1', mal: M.ankareFor(m1, j), kropp: 'Ett förslag.', skrev: 'liv', nar: '2026-10-08T07:01:00Z', ja: [], lage: 'oppet' },
      { id: 'f2', mal: { scen: '1' }, kropp: 'Om hela scenen.', skrev: 'henric', nar: '2026-10-08T07:02:00Z', ja: [], lage: 'oppet' }],
    kommentarer: [{ id: 'k1', mal: M.ankareFor(m1, j), text: 'Tempot?', galler: 'tempo', skrev: 'henric', nar: '2026-10-08T07:03:00Z', till: 'demi' },
      { id: 'k2', mal: M.ankareFor(m1, j), text: 'Svar.', skrev: 'demi', nar: '2026-10-08T07:04:00Z', svarPa: 'k1' }],
    strukna: [{ id: 's1', scen: '1', innehall: 'En struken rad.', granne: M.ankareFor(m1, i), skrev: 'liv', skrevNar: '2026-10-08T06:00:00Z', tidigare: [], strok: { av: 'henric', nar: '2026-10-08T07:05:00Z' } }],
    logg: [],
  };
  const not = A.oppna(JSON.stringify(v1), '1', FIL[1], 'episod');
  const paras = Dk.justera(Dk.tolka(FIL[1], 'episod').paras, not.stycken);
  const pi = paras.find((p) => p.rad === i);
  const pj = paras.find((p) => p.rad === j);
  ok(not.format === 2 && not.fore && not.fore.format === 1, 'a first-version file is moved over, and kept whole under "fore"');
  ok(A.vemSkrev(not, pi.id, pi, null).vem === 'henric', 'who wrote a line follows it to its paragraph');
  ok(A.historikFor(not, pi.id)[0].text === 'Förut.' && A.historikFor(not, pi.id)[0].vem === 'demi', 'the earlier text is in the paragraph\'s history');
  const f1 = not.forslag.find((f) => f.id === 'f1');
  ok(f1.stycke === pj.id && f1.text.endsWith('Ett förslag.') && f1.galde === pj.text, 'a proposal lands on its paragraph, as a whole new version of it');
  ok(not.forslag.find((f) => f.id === 'f2').fri && not.forslag.find((f) => f.id === 'f2').stycke, 'a proposal on a whole scene lands on the scene heading');
  ok(not.kommentarer.every((k) => k.stycke === pj.id) && A.vantarPa(not, 'demi').length === 0, 'comments and replies land on their paragraph; Demi\'s answer counts');
  const borta = A.borttagna(not, (id) => paras.some((p) => p.id === id));
  ok(borta.length === 1 && borta[0].sista.text === 'En struken rad.' && borta[0].borta.efter === pi.id, 'a struck line is a removed paragraph in the history, with its place');
  ok(throwsKod(() => A.lasAnteckning('{ trasig', '1'), 'trasig'), 'a broken notes file is an error, never an empty room');
}

// --- 8. Comments and proposals: anyone can do anything, nobody's words are rewritten ------------

{
  let not = A.tomAnteckning('1');
  not = A.nyKommentar(not, { id: 'k', stycke: 'p', galde: 'x', text: 'Hej.', vem: 'liv', nar: 't1' });
  ok(A.nyKommentar(not, { id: 'k', stycke: 'p', text: 'Hej.', vem: 'liv', nar: 't1' }) === not, 'the same comment sent twice goes in once');
  not = A.kommentarKlar(not, { id: 'k', vem: 'henric', nar: 't2' });
  ok(not.kommentarer[0].klar.av === 'henric', 'anyone can mark someone else\'s comment done');
  not = A.taBortKommentar(not, { id: 'k', vem: 'demi', nar: 't3' });
  ok(not.kommentarer.length === 1 && not.kommentarer[0].borta.av === 'demi', 'anyone can remove a comment, and it stays in the file');
  ok(throwsKod(() => A.andraKommentar(not, { id: 'k', text: 'Ändrad.', vem: 'henric', nar: 't4' }), 'inte-din'), 'nobody rewrites someone else\'s comment');
  not = A.nyttForslag(not, { id: 'f', stycke: 'p', galde: 'x', text: 'Y', typ: 'replik', attrs: {}, vem: 'demi', nar: 't5' });
  not = A.forslagLage(not, { id: 'f', lage: 'avfard', vem: 'liv', nar: 't6' });
  ok(not.forslag[0].lage === 'avfard' && not.forslag[0].avfard.av === 'liv', 'anyone can dismiss a proposal');
  const s1 = '**Ny mekanik:** hoppa';
  ok(!A.demiHarSvarat(not, 'm', s1), 'a new-mechanic request waits for Demi');
  not = A.nyKommentar(not, { id: 'd', stycke: 'm', galde: s1, text: 'Går att bygga.', vem: 'demi', nar: 't7' });
  ok(A.demiHarSvarat(not, 'm', s1) && !A.demiHarSvarat(not, 'm', '**Ny mekanik:** något annat'), 'Demi\'s comment answers it, until the request changes');
}

// --- 9. Saving through the store -------------------------------------------------------------------

const NU = (() => { let t = Date.parse('2026-10-08T08:00:00Z'); return () => new Date((t += 60000)).toISOString(); })();
let idn = 0;
const ID = () => `n${++idn}`;

// Files in memory. Two adapters on the same files are two people.
function minne(filer) {
  let klocka = 1;
  return { klocka: () => ++klocka, store: new Map(Object.entries(filer).map(([k, t]) => [k, { text: t, version: 1 }])) };
}
function adapterFor(m, vem = 'henric') {
  const a = {
    namn: 'minne', rot: 'test', kanSkriva: true, skrivningar: [], fore: null, efterSkriv: null, efterLas: null,
    async vem() { return { id: vem, namn: vem }; },
    async las(p) {
      const f = m.store.get(p);
      const ut = f ? { text: f.text, version: f.version } : null;
      if (a.efterLas) await a.efterLas(p);
      return ut;
    },
    async skriv(p, text, version) {
      if (a.fore) await a.fore(p);
      const f = m.store.get(p);
      if ((f ? f.version : 0) !== (version == null ? 0 : version)) throw new D.Krock(f ? f.version : null);
      const v = m.klocka();
      m.store.set(p, { text, version: v });
      a.skrivningar.push(p);
      if (a.efterSkriv) await a.efterSkriv(p);
      return { version: v };
    },
  };
  return a;
}
const utifran = (m, p, text) => m.store.set(p, { text, version: m.klocka() });
const text = (m, p) => (m.store.get(p) || {}).text;

// An editor that is only a list.
function redigerare(paras) {
  let lista = paras.map((p) => ({ ...p }));
  let pin = null;
  return {
    stycken: () => lista.map((p) => ({ ...p, attrs: { ...p.attrs } })),
    laser: () => pin,
    tillampa(ops) {
      for (const o of ops) {
        const k = lista.findIndex((p) => p.id === o.id);
        if (o.op === 'ersatt' && k >= 0) lista[k] = { ...o.p, id: o.id };
        else if (o.op === 'infoga') {
          const e = o.efter == null ? -1 : lista.findIndex((p) => p.id === o.efter);
          lista.splice(e + 1, 0, { ...o.p });
        } else if (o.op === 'ta-bort' && k >= 0) lista.splice(k, 1);
        else if (o.op === 'attrs' && k >= 0) Object.assign(lista[k], { raw: o.raw, orig: o.orig, sep: o.sep });
        else if (o.op === 'byt-id' && k >= 0) lista[k].id = o.till;
      }
    },
    // What a person does:
    skriv(id, nyText) { lista.find((p) => p.id === id).text = nyText; },
    typ(id, typ, attrs = {}) { Object.assign(lista.find((p) => p.id === id), { typ, attrs }); },
    ny(efterId, p) { const e = lista.findIndex((x) => x.id === efterId); lista.splice(e + 1, 0, { id: ID(), attrs: {}, raw: null, orig: null, sep: null, ...p }); return lista[e + 1].id; },
    bort(id) { lista = lista.filter((p) => p.id !== id); },
    pinna(id) { pin = id; },
    hitta: (f) => lista.find(f),
  };
}

function lagring() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (n) => [...m.keys()][n] || null, get length() { return m.size; }, m,
  };
}

async function oppna(adapter, dok, { lager = null, flik = 'f1' } = {}) {
  const l = S.skapaLager(adapter, { nu: NU, nyttId: ID, lagring: lager, flik });
  const d = await l.dokument(dok);
  const { paras } = await d.ladda();
  const ed = redigerare(paras);
  d.koppla(ed);
  return { d, ed, l };
}

const GRUND1 = JSON.stringify({ stycken: rader(FIL[1]).filter((r) => r.startsWith('> ')) });
const replik = (ed, borjan) => ed.hitta((p) => p.typ === 'replik' && p.text.startsWith(borjan));

{
  // One person, one paragraph.
  const m = minne({ 'manus:1': FIL[1], 'grund:1': GRUND1 });
  const a = adapterFor(m);
  const { d, ed } = await oppna(a, '1');
  await d.spara();
  ok(a.skrivningar.length === 0, 'nothing changed, nothing written');
  const p = replik(ed, 'Jag vet inte vem du är');
  const radNr = rader(FIL[1]).indexOf(p.raw);
  ed.skriv(p.id, 'Jag vet inte vem du är. Nu ändrad.');
  await d.spara();
  ok(JSON.stringify(diffRader(FIL[1], text(m, 'manus:1'))) === JSON.stringify([radNr]), 'one paragraph changed: exactly that line changed in the file');
  const not = JSON.parse(text(m, 'rum:1'));
  const h = not.historik[p.id];
  ok(h.length === 2 && h[0].vem === 'demi' && h[0].hur === 'utkast' && h[1].vem === 'henric', 'the history: Demi\'s draft, then Henric\'s change');
  ok(d.vemSkrev(ed.hitta((x) => x.id === p.id)).vem === 'henric' && d.lage === 'sparat', 'the margin says Henric, and the status says saved');
  ed.skriv(p.id, 'Jag vet inte vem du är. Ändrad igen.');
  await d.spara();
  ok(JSON.parse(text(m, 'rum:1')).historik[p.id].length === 2, 'typing on for a while is one version in the history, not one per save');

  // Enter: a new paragraph; then removed.
  const ny = ed.ny(p.id, { typ: 'replik', text: 'En ny replik.' });
  await d.spara();
  const efter = rader(text(m, 'manus:1'));
  const k = efter.indexOf('> Jag vet inte vem du är. Ändrad igen.');
  ok(efter[k + 1] === '>' && efter[k + 2] === '> En ny replik.', 'a new Replik is written as a quote line with the separator the file uses');
  ed.bort(ny);
  await d.spara();
  ok(!text(m, 'manus:1').includes('En ny replik.') && JSON.parse(text(m, 'rum:1')).historik[ny].at(-1).borta, 'a removed paragraph leaves the file, and its history says so');
  ok(diffRader(FIL[1], text(m, 'manus:1')).length === 1, 'and the file around it is as before');

  // Held: a variant without a label is not written.
  const v = ed.hitta((x) => x.typ === 'variant');
  ed.typ(v.id, 'variant', { etikett: '' });
  await d.spara();
  ok(text(m, 'manus:1').includes(v.raw) && d.hallna.get(v.id) === 'utan-etikett', 'a paragraph that would break the format is held, the file keeps the old line');
}

{
  // Two windows, different paragraphs.
  const m = minne({ 'manus:1': FIL[1], 'grund:1': GRUND1 });
  const h = await oppna(adapterFor(m, 'henric'), '1');
  const l = await oppna(adapterFor(m, 'liv'), '1');
  const ph = replik(h.ed, 'Jag vet inte vem du är');
  const pl = replik(l.ed, 'Fortsätt gå');
  h.ed.skriv(ph.id, 'Henrics rad.');
  l.ed.skriv(pl.id, 'Livs rad.');
  await h.d.spara();
  await l.d.spara();
  const t = text(m, 'manus:1');
  ok(t.includes('> Henrics rad.') && t.includes('> Livs rad.') && diffRader(FIL[1], t).length === 2, 'two windows, different paragraphs: both changes in the file, nothing else');
  await h.d.hamta();
  ok(h.ed.hitta((p) => p.id === pl.id).text === 'Livs rad.', 'the other window brings in the change when it reads again');
  const not = JSON.parse(text(m, 'rum:1'));
  ok(not.historik[ph.id].at(-1).vem === 'henric' && not.historik[pl.id].at(-1).vem === 'liv', 'each change is in the history under the one who made it');

  // The same paragraph.
  h.ed.skriv(ph.id, 'Henric igen.');
  l.ed.skriv(ph.id, 'Liv här.');
  await h.d.spara();
  await l.d.spara();
  const t2 = text(m, 'manus:1');
  const not2 = JSON.parse(text(m, 'rum:1'));
  const kr = not2.krockar.find((k) => k.stycke === ph.id);
  ok(t2.includes('> Liv här.') && kr && kr.text === 'Henric igen.' && kr.vem === 'henric', 'the same paragraph: Liv\'s save is in the text, Henric\'s version is kept at the paragraph');
  ok(not2.historik[ph.id].some((e) => e.text === 'Henric igen.') && not2.historik[ph.id].some((e) => e.text === 'Liv här.'), 'and both versions are in the history');
  await h.d.hamta();
  ok(h.ed.hitta((p) => p.id === ph.id).text === 'Liv här.', 'Henric\'s window shows the text as it is in the file');
}

{
  // The file changed outside the room while someone types.
  const m = minne({ 'manus:1': FIL[1] });
  const h = await oppna(adapterFor(m), '1');
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'I rummet.');
  const raa = rader(FIL[1]);
  const i = raa.findIndex((r) => r.startsWith('> Fortsätt gå'));
  raa[i] = '> Ändrad i filpanelen.';
  utifran(m, 'manus:1', raa.join('\n'));
  await h.d.spara();
  const t = text(m, 'manus:1');
  ok(t.includes('> I rummet.') && t.includes('> Ändrad i filpanelen.') && diffRader(FIL[1], t).length === 2, 'a change in the file panel meanwhile: both are kept');
  ok(h.ed.stycken().some((x) => x.text === 'Ändrad i filpanelen.'), 'and the room shows the file panel\'s change');

  // The cursor is in a paragraph that changes in the file: it is left alone until the cursor leaves.
  const q = replik(h.ed, 'I rummet.');
  h.ed.pinna(q.id);
  const r2 = rader(text(m, 'manus:1'));
  r2[r2.indexOf('> I rummet.')] = '> Utifrån igen.';
  utifran(m, 'manus:1', r2.join('\n'));
  await h.d.hamta();
  ok(h.ed.hitta((x) => x.id === q.id).text === 'I rummet.', 'the paragraph with the cursor is not changed under it');
  h.ed.pinna(null);
  utifran(m, 'manus:1', r2.join('\n'));
  await h.d.hamta();
  ok(h.ed.hitta((x) => x.text === 'Utifrån igen.'), 'when the cursor has left, the change comes in');
}

{
  // A write meets a Krock: someone saved between the read and the write.
  const m = minne({ 'manus:1': FIL[1] });
  const a = adapterFor(m);
  const h = await oppna(a, '1');
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'Min ändring.');
  let gang = 0;
  a.fore = async (plats) => {
    if (plats !== 'manus:1' || gang++) return;
    const raa = rader(text(m, 'manus:1'));
    raa[raa.findIndex((r) => r.startsWith('> Fortsätt gå'))] = '> Emellan.';
    utifran(m, 'manus:1', raa.join('\n'));
  };
  await h.d.spara();
  const t = text(m, 'manus:1');
  ok(gang >= 2 && t.includes('> Min ändring.') && t.includes('> Emellan.'), 'a file changed between read and write: the save starts over and both are kept');
}

{
  // Someone saved right after this window read the file: the write must go
  // with the version that was read, never with a fresher one.
  const m = minne({ 'manus:1': FIL[1] });
  const a = adapterFor(m);
  const h = await oppna(a, '1');
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'Min ändring.');
  let gang = 0;
  a.efterLas = async (plats) => {
    if (plats !== 'manus:1' || gang++) return;
    const raa = rader(text(m, 'manus:1'));
    raa[raa.findIndex((r) => r.startsWith('> Fortsätt gå'))] = '> Strax efter läsningen.';
    utifran(m, 'manus:1', raa.join('\n'));
  };
  await h.d.spara();
  a.efterLas = null;
  const t = text(m, 'manus:1');
  ok(t.includes('> Min ändring.') && t.includes('> Strax efter läsningen.') && diffRader(FIL[1], t).length === 2, 'a file changed right after it was read: the write goes with the version read, and both are kept');
}

{
  // The same paragraph changed here (not saved yet) and in the file: reading
  // never takes away what is typed, and the save keeps the other version.
  const m = minne({ 'manus:1': FIL[1] });
  const h = await oppna(adapterFor(m), '1');
  // A first save, so the room's notes know the paragraphs by name.
  h.ed.skriv(replik(h.ed, 'Fortsätt gå').id, 'Fortsätt gå, du.');
  await h.d.spara();
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'Skrivet här, inte sparat.');
  const raa = rader(text(m, 'manus:1'));
  raa[raa.indexOf(p.raw)] = `${p.raw} Ändrat i filen under tiden.`;
  utifran(m, 'manus:1', raa.join('\n'));
  await h.d.hamta();
  ok(h.ed.hitta((x) => x.id === p.id).text === 'Skrivet här, inte sparat.', 'reading the file never replaces a paragraph that was changed here');
  await h.d.spara();
  const not = JSON.parse(text(m, 'rum:1'));
  const kr = (not.krockar || []).find((k) => k.stycke === p.id);
  ok(text(m, 'manus:1').includes('> Skrivet här, inte sparat.') && kr && kr.text.endsWith('Ändrat i filen under tiden.') && !kr.vem,
    'and the save puts it in the text, with the file\'s version kept as a krock from outside the room');
}

{
  // Taking away the first scene heading would make every line after it read
  // as something else: nothing is written, and the save says why.
  const m = minne({ 'manus:1': FIL[1] });
  const a = adapterFor(m);
  const h = await oppna(a, '1');
  const scen = h.ed.hitta((x) => x.typ === 'scen');
  h.ed.bort(scen.id);
  let fel = null;
  try { await h.d.spara(); } catch (e) { fel = e; }
  ok(fel && fel.kod === 'format' && text(m, 'manus:1') === FIL[1] && a.skrivningar.length === 0, 'a file that would read back as something else is never written');
}

{
  // The portal: a file believed missing is written with 0 as its version,
  // so one that appeared in between is a Krock and not overwritten.
  const sant = [];
  const f = async (url, o) => { sant.push(JSON.parse(o.body)); return { status: 200, ok: true, json: async () => ({ mtime: 5 }) }; };
  const pa = D.portalAdapter({ fetch: f });
  await pa.skriv('rum:1', '{}', null);
  await pa.skriv('rum:1', '{}', 7.5);
  ok(sant[0].expected_mtime === 0 && sant[1].expected_mtime === 7.5, 'the portal adapter sends 0 for a file it believes is missing, and the version read otherwise');
}

{
  // The answer to a write is lost after the file was written.
  const m = minne({ 'manus:1': FIL[1] });
  const a = adapterFor(m);
  const h = await oppna(a, '1');
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'Svaret försvann.');
  let forsta = true;
  a.efterSkriv = async (plats) => { if (plats === 'manus:1' && forsta) { forsta = false; throw new Error('nätet'); } };
  let fel = null;
  try { await h.d.spara(); } catch (e) { fel = e; }
  a.efterSkriv = null;
  await h.d.spara();
  const t = text(m, 'manus:1');
  if (process.env.DBG) console.log('lost', String(fel), t.split('Svaret försvann.').length, diffRader(FIL[1], t));
  ok(fel && t.split('Svaret försvann.').length === 2 && diffRader(FIL[1], t).length === 1, 'a lost answer: the next save sees the line is in, and writes it once');
}

{
  // The notes do not get through: they wait in the browser, and go in once.
  const m = minne({ 'manus:1': FIL[1] });
  const a = adapterFor(m);
  const lg = lagring();
  const h = await oppna(a, '1', { lager: lg });
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'Anteckningen väntar.');
  const skriv = a.skriv;
  a.skriv = async (plats, t, v) => { if (plats === 'rum:1') throw new Error('nere'); return skriv(plats, t, v); };
  await h.d.spara();
  ok(text(m, 'manus:1').includes('Anteckningen väntar.') && !text(m, 'rum:1') && h.d.ko().length === 1 && h.d.lage === 'fel', 'text saved, the note about it waits in the browser and the status says so');
  a.skriv = skriv;
  await h.d.spara();
  const not = JSON.parse(text(m, 'rum:1'));
  ok(h.d.ko().length === 0 && not.historik[p.id].at(-1).text === 'Anteckningen väntar.', 'next time it goes in');
  const igen = A.tillampa(not, { id: not.gjort[0], poster: [{ id: p.id, post: { text: 'x', typ: 'replik', attrs: {}, vem: 'henric', nar: 'z' } }] });
  ok(igen === not, 'the same save applied twice changes nothing');
}

{
  // Unsaved text survives a reload.
  const m = minne({ 'manus:1': FIL[1] });
  const a = adapterFor(m);
  const lg = lagring();
  const h = await oppna(a, '1', { lager: lg });
  const p = replik(h.ed, 'Jag vet inte vem du är');
  h.ed.skriv(p.id, 'Inte sparad än.');
  h.d.andrat();
  ok(!text(m, 'manus:1').includes('Inte sparad än.'), 'typed, not yet saved');
  const raa = rader(FIL[1]);
  raa[raa.findIndex((r) => r.startsWith('> Fortsätt gå'))] = '> Medan fönstret var stängt.';
  utifran(m, 'manus:1', raa.join('\n'));
  const h2 = await oppna(a, '1', { lager: lg });
  ok(h2.ed.hitta((x) => x.text === 'Inte sparad än.'), 'after a reload the unsaved text is there');
  await h2.d.spara();
  const t = text(m, 'manus:1');
  ok(t.includes('> Inte sparad än.') && t.includes('> Medan fönstret var stängt.') && diffRader(FIL[1], t).length === 2, 'and it is saved together with what happened in the file meanwhile');
  ok(!lg.m.has(h2.d.nyckelOsparat), 'once saved, nothing waits in the browser');
}

{
  // Proposals laid in, an earlier version taken back.
  const m = minne({ 'manus:1': FIL[1], 'grund:1': GRUND1 });
  const h = await oppna(adapterFor(m), '1');
  const p = { ...replik(h.ed, 'Jag vet inte vem du är') };
  await h.d.anteckna('forslag', { id: 'f1', stycke: p.id, galde: p.text, text: 'Demis förslag.', typ: 'replik', attrs: {}, vem: 'demi', nar: NU() });
  h.ed.skriv(p.id, 'Demis förslag.');
  h.d.avsikt(p.id, { nyckel: Dk.nyckel({ ...p, text: 'Demis förslag.' }), hur: 'forslag', vem: 'demi', forslag: 'f1' });
  await h.d.spara();
  const not = JSON.parse(text(m, 'rum:1'));
  const sista = not.historik[p.id].at(-1);
  ok(sista.vem === 'demi' && sista.av === 'henric' && sista.hur === 'forslag' && not.forslag[0].lage === 'inlagt', 'a proposal laid in: Demi\'s words, laid in by Henric, the proposal marked');
  h.ed.skriv(p.id, p.text);
  h.d.avsikt(p.id, { nyckel: Dk.nyckel(p), hur: 'tillbaka', vem: 'demi' });
  await h.d.spara();
  ok(text(m, 'manus:1') === FIL[1], 'taking back the earlier version gives the file exactly as it was');
}

{
  // A lore page: the same kind of document, inside lore.json.
  const lore = { format: 1, sidor: [{ id: 's1', titel: 'Vega', text: ['# Vega', '', 'Hon är arbetare.', 'Tredje raden.'], skrev: 'liv', skapad: 't' }] };
  const m = minne({ lore: JSON.stringify(lore) });
  const h = await oppna(adapterFor(m), 'lore:s1');
  const p = h.ed.hitta((x) => x.text === 'Hon är arbetare.');
  h.ed.skriv(p.id, 'Hon är arbetare på slingan.');
  await h.d.spara();
  const ut = JSON.parse(text(m, 'lore'));
  ok(ut.sidor[0].text.join('\n') === '# Vega\n\nHon är arbetare på slingan.\nTredje raden.', 'a lore page: one line changed, the rest as it was');
  ok(ut.sidor[0].rum.historik[p.id].at(-1).vem === 'henric', 'and its history is on the page');
}

// --- 10. The portal's real file code -----------------------------------------------------------------

async function provserver(rot) {
  const p = spawn('python3', [join(REPO, 'scripts/rummet_provserver.py'), '--rot', rot], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    p.stdout.once('data', (b) => res(String(b).trim()));
    p.once('exit', (c) => rej(new Error(`provserver exited ${c}`)));
  });
  return { p, url };
}

{
  const rot = mkdtempSync(join(tmpdir(), 'rummet-'));
  const glimt = join(rot, 'projects/motionstory/stories/glimt');
  mkdirSync(glimt, { recursive: true });
  mkdirSync(join(rot, 'data/glimt-rummet'), { recursive: true });
  for (const f of ['episod-1.json', 'varld.md', 'mekaniker.md', 'episod-1.md', 'episod-2.md']) copyFileSync(join(REPO, 'stories/glimt', f), join(glimt, f));
  const { p, url } = await provserver(rot);
  try {
    const fetch2 = (u, o = {}) => fetch(new URL(u, url), { ...o, headers: { ...(o.headers || {}), Origin: url.replace(/\/$/, '') } });
    const filen = join(glimt, 'episod-1.md');
    let forsta = true;
    // Henric saves in the file panel between our read and our write.
    const mellan = async (u, o = {}) => {
      if (forsta && o.method === 'POST' && JSON.parse(o.body).path.endsWith('episod-1.md')) {
        forsta = false;
        const raa = readFileSync(filen, 'utf8').split('\n');
        raa[raa.findIndex((r) => r.startsWith('> Fortsätt gå'))] = '> Ändrad i filpanelen.';
        writeFileSync(filen, raa.join('\n'));
        const s = statSync(filen);
        utimesSync(filen, s.atime, new Date(s.mtimeMs + 2000));
      }
      return fetch2(u, o);
    };
    const adapter = D.portalAdapter({ fetch: mellan });
    ok(await adapter.finns(), 'portal: the file API answers');
    const h = await oppna(adapter, '1');
    const q = replik(h.ed, 'Jag vet inte vem du är');
    h.ed.skriv(q.id, 'Ändrad i rummet.');
    await h.d.spara();
    const disk = readFileSync(filen, 'utf8');
    ok(!forsta && disk.includes('> Ändrad i rummet.') && disk.includes('> Ändrad i filpanelen.') && diffRader(FIL[1], disk).length === 2,
      'portal: after a 409 both texts are in the file, and nothing else changed');
    const rumDisk = JSON.parse(readFileSync(join(rot, 'data/glimt-rummet/episod-1.json'), 'utf8'));
    ok(rumDisk.format === 2 && rumDisk.historik[q.id].at(-1).vem === 'henric', 'portal: the notes are written as readable JSON, format 2');
    const k = await oppna(D.portalAdapter({ fetch: fetch2 }), 'mekaniker');
    await k.d.spara();
    ok(readFileSync(join(glimt, 'mekaniker.md'), 'utf8') === FIL.mekaniker, 'portal: the catalogue opened and saved without a change is the same file');
    const fel = await fetch2(`/api/files/read?path=${encodeURIComponent('/etc/passwd')}`);
    ok(fel.status === 403, 'portal: a path outside the sandbox is refused');
  } finally {
    p.kill();
    rmSync(rot, { recursive: true, force: true });
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
