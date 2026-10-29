#!/usr/bin/env node
// The map lookup for landmarks (world.js, fetchLandmarks) and the weather
// (fetchWeather), with a fake network. Until 2026-10-06 its backup server had stopped answering and five
// walks of six got a made-up landmark; the log named only the last error.
//
//   node scripts/test_world.mjs

import { fetchLandmarks, fetchWeather, chooseWorld, defaultWorld, orGuess, landmarksNear, lookAgain, REACH, PEAK_REACH, FIX_FRESH, LANDMARKS } from '../glimt/world.js';
import { Bag, STORIES, pickStory } from '../glimt/bag.js';
import { readKlarhet } from '../glimt/audio.js';
import { readLuft, withAir, LUFT_MAX, EN, SV } from '../glimt/episod1.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const A = 'https://a.example/api/interpreter', B = 'https://b.example/api/interpreter';
const bridge = { elements: [{ type: 'way', tags: { bridge: 'yes' }, center: { lat: 59.38, lon: 13.5 } }] };
const answer = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const never = () => new Promise(() => {});

// The first server hangs: the second answers in its place.
{
  const asked = [];
  const found = await fetchLandmarks(59.38, 13.5, {
    endpoints: [A, B], timeout: 50,
    fetchImpl: url => { asked.push(url); return url === A ? never() : answer(bridge); },
  });
  check(asked.join(' ') === `${A} ${B}`, `the second server is asked when the first hangs (${asked.length} asked)`);
  check(found.some(x => x.name === 'bro'), `and its answer is used (${found.map(x => x.name).join(', ') || 'nothing'})`);
}

// A body that never arrives counts as a hang too, not only the headers.
{
  const found = await fetchLandmarks(59.38, 13.5, {
    endpoints: [A, B], timeout: 50,
    fetchImpl: url => url === A
      ? Promise.resolve({ ok: true, status: 200, json: never })
      : answer(bridge),
  });
  check(found.some(x => x.name === 'bro'), 'a first answer whose body never comes falls through to the second');
}

// Both fail: the error names each server and what went wrong there.
{
  let msg = '';
  try {
    await fetchLandmarks(59.38, 13.5, {
      endpoints: [A, B], timeout: 50,
      fetchImpl: url => url === A ? Promise.resolve({ ok: false, status: 406 }) : never(),
    });
  } catch (err) { msg = err.message; }
  check(msg === 'a.example: overpass 406; b.example: timeout 50 ms', `the log names both failures (${msg})`);
}

// The weather asks for the cloud too, and every start logs it (Klar himmel).
{
  const urls = [];
  const w = await fetchWeather(59.38, 13.5, {
    fetchImpl: url => { urls.push(url); return answer({ current: { precipitation: 0, weather_code: 1, cloud_cover: 12 } }); },
  });
  check(urls[0].includes('cloud_cover'), 'open-meteo is asked for cloud_cover');
  check(w.rain === false && w.cloud === 12, `dry, 12 % cloud (${JSON.stringify(w)})`);
  const none = await fetchWeather(59.38, 13.5, { fetchImpl: () => answer({ current: { precipitation: 0.4 } }) });
  check(none.rain === true && none.cloud === null, `an answer without cloud says unknown (${JSON.stringify(none)})`);

  const lines = [];
  const world = defaultWorld(new Date('2026-10-18T20:00:00Z'));
  await chooseWorld(world, {
    lat: 59.38, lon: 13.5, date: new Date('2026-10-18T20:00:00Z'), log: m => lines.push(m),
    landmark: { name: 'bro', lat: 59.38, lon: 13.5 },
    fetchImpl: () => answer({ current: { precipitation: 0, weather_code: 0, cloud_cover: 23.6 } }),
  });
  check(world.cloud === 23.6, `the world keeps the cloud (${world.cloud})`);
  check(lines.some(l => l === 'väder: torrt, molnigt 24 % (open-meteo)'), `the start logs it (${lines.find(l => l.startsWith('väder')) || 'no weather line'})`);

  const failed = [];
  await chooseWorld(defaultWorld(), {
    lat: 59.38, lon: 13.5, log: m => failed.push(m), landmark: { name: 'bro', lat: 59.38, lon: 13.5 },
    fetchImpl: () => Promise.resolve({ ok: false, status: 500 }),
  });
  check(failed.some(l => l.startsWith('väder: okänt, molnigt okänt')), 'without an answer the log says the weather and the cloud are unknown');
}

// What the phone has not read is null, never a guess (v52, Henric 29/10:
// "Inte hitta på något"). The guesses stay for the frozen Swedish chapters.
{
  const w = defaultWorld(new Date('2026-10-18T20:00:00Z'));
  check(w.light === null && w.rain === null && w.landmark === null, `before any reading: light, rain and landmark are null (${w.light}, ${w.rain}, ${w.landmark})`);
  check(LANDMARKS.includes(w.guess.landmark) && ['light', 'dark'].includes(w.guess.light) && w.guess.rain === false, 'the Swedish guesses are kept apart');
  check(orGuess(w, 'landmark') === w.guess.landmark && orGuess(w, 'rain') === false, 'orGuess gives them to the Swedish chapters');
  const read = { ...w, rain: true, light: 'dark' };
  check(orGuess(read, 'rain') === true && orGuess(read, 'light') === 'dark', 'and what was read wins over them');
  check(orGuess({ ...w, rain: false }, 'rain') === false && orGuess({ ...w, guess: { rain: true } , rain: false }, 'rain') === false, 'a read "dry" is not taken for nothing');

  // The map does not answer: no landmark, not one at random.
  const lines = [];
  const failed = defaultWorld();
  await chooseWorld(failed, {
    lat: 59.38, lon: 13.5, log: m => lines.push(m),
    fetchImpl: url => url.includes('open-meteo') ? answer({ current: { precipitation: 0, weather_code: 3, cloud_cover: 90 } }) : Promise.resolve({ ok: false, status: 504 }),
  });
  check(failed.landmark === null && failed.landmarkAnswered === 'fel' && failed.found.length === 0, `the map failing gives no landmark (${failed.landmark}, ${failed.landmarkAnswered})`);
  check(lines.some(l => l.startsWith('landmärke: inget, kartan svarade inte')), `the log says so (${lines.find(l => l.startsWith('landmärke')) || 'no line'})`);
  check(failed.rain === false && failed.light !== null, 'the weather and the light it did read are kept');

  // It answers with nothing near: no landmark either.
  const empty = defaultWorld();
  await chooseWorld(empty, {
    lat: 59.38, lon: 13.5, log: () => {},
    fetchImpl: url => url.includes('open-meteo') ? Promise.resolve({ ok: false, status: 500 }) : answer({ elements: [] }),
  });
  check(empty.landmark === null && empty.landmarkAnswered === 'karta', `an empty answer gives no landmark (${empty.landmark})`);
  check(empty.rain === null, `nor does a weather lookup that failed give "dry" (${empty.rain})`);

  // An answer that says nothing about rain is no reading.
  let msg = '';
  try { await fetchWeather(59.38, 13.5, { fetchImpl: () => answer({ current: { cloud_cover: 40 } }) }); } catch (err) { msg = err.message; }
  check(msg.startsWith('open-meteo'), `an answer without precipitation or weather code is an error, not dry (${msg || 'no error'})`);
  const noCurrent = defaultWorld();
  await chooseWorld(noCurrent, { lat: 59.38, lon: 13.5, log: () => {}, fetchImpl: url => url.includes('open-meteo') ? answer({}) : answer({ elements: [] }) });
  check(noCurrent.rain === null, `an answer with no current weather leaves rain unread (${noCurrent.rain})`);

  // The map's answer is kept whole, for landmarksNear.
  const town = defaultWorld();
  await chooseWorld(town, {
    lat: 59.38, lon: 13.5, log: () => {},
    fetchImpl: url => url.includes('open-meteo') ? answer({ current: { precipitation: 0 } })
      : answer({ elements: [bridge.elements[0], { type: 'way', tags: { natural: 'wood' }, center: { lat: 59.383, lon: 13.5 } }] }),
  });
  check(town.found.length === 2 && ['bro', 'skog'].includes(town.landmark), `every element is kept (${town.found.length}), and the Swedish landmark is one of them (${town.landmark})`);
}

// What is near the walker as she says it, not where the walk began.
{
  const north = m => 59.38 + m / 111320;
  const at = (m, t = 100, accuracy = 8) => ({ t, latitude: north(m), longitude: 13.5, accuracy });
  const world = { found: [
    { name: 'bro', lat: north(0), lon: 13.5 },          // at the start
    { name: 'skog', lat: north(700), lon: 13.5 },       // 700 m on
    { name: 'vatten', lat: null, lon: null },           // no geometry
    { name: 'berg', lat: north(1150), lon: 13.5 },      // a hill further on
    { name: 'kyrkogard', lat: north(950), lon: 13.5 },
  ] };
  const names = list => list.map(n => n.name).join(', ');
  check(names(landmarksNear(world, at(0), 100)) === 'bro', `at the start: the bridge (${names(landmarksNear(world, at(0), 100))})`);
  check(names(landmarksNear(world, at(600), 100)) === 'skog, kyrkogard, berg', `600 m on: nearest first, the hill within its ${PEAK_REACH} m (${names(landmarksNear(world, at(600), 100))})`);
  check(!landmarksNear(world, at(450), 100).some(n => n.name === 'bro'), 'the bridge at the start is not near a walker 450 m on');
  check(!landmarksNear(world, at(300), 100).some(n => n.name === 'vatten'), 'an element without a position is never near');
  check(landmarksNear(world, at(0), 100 + FIX_FRESH + 1).length === 0, `a fix older than ${FIX_FRESH} s says nothing`);
  check(landmarksNear(world, null, 100).length === 0, 'nor does no fix');
  // From the fix's far edge: 360 m away is near at ±8 m, not at ±45.
  const edge = { found: [{ name: 'bro', lat: north(360), lon: 13.5 }] };
  check(landmarksNear(edge, at(0, 100, 8), 100).length === 1 && landmarksNear(edge, at(0, 100, 8), 100)[0].dist <= REACH, 'within reach counted with the fix\'s accuracy (±8 m)');
  check(landmarksNear(edge, at(0, 100, 45), 100).length === 0, 'and out of reach when the fix could be 45 m off');
  check(landmarksNear({}, at(0), 100).length === 0, 'a world the map never answered has nothing near');
}

// The map once more, from where the walker is.
{
  const world = { found: [{ name: 'bro', lat: 59.38, lon: 13.5 }] };
  const lines = [];
  const added = await lookAgain(world, 59.385, 13.5, {
    log: m => lines.push(m),
    fetchImpl: () => answer({ elements: [bridge.elements[0], { type: 'node', tags: { natural: 'peak' }, lat: 59.39, lon: 13.5 }] }),
  });
  check(added === 1 && world.found.length === 2, `what it finds is added, what was known is not added twice (${added} new, ${world.found.length} known)`);
  check(lines[0] === 'kartan igen: bro, berg, 1 nya', `the log says what it found (${lines[0]})`);
  const none = await lookAgain(world, 59.385, 13.5, { log: m => lines.push(m), fetchImpl: () => Promise.resolve({ ok: false, status: 504 }) });
  check(none === 0 && world.found.length === 2 && lines.at(-1).startsWith('kartan igen: svarade inte'), 'a map that does not answer adds nothing, and says so');
}

// The carrier bag: a story waits until its place is near, and is told once.
{
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
  const ids = STORIES.map(st => st.id);
  check(new Set(ids).size === ids.length && STORIES.every(st => LANDMARKS.includes(st.near) && st.line === `s3-${st.near}`), 'five stories, one per kind of place, each its scene 3 clip');
  const st = store();
  const bag = new Bag(st, 'glimt-bag-en');
  const near = [{ name: 'bro', dist: 120 }, { name: 'vatten', dist: 300 }];
  check(pickStory(STORIES, near, bag).id === 'bridge', 'the nearest place has its story told');
  bag.add('bridge', { episode: 'episode1en', version: 52 });
  check(pickStory(STORIES, near, bag).id === 'water', 'once heard, the next place near has its told instead');
  const again = new Bag(st, 'glimt-bag-en');
  check(again.has('bridge') && again.heard.bridge.version === 52 && !again.has('water'), 'the bag is kept on the phone, with when and where');
  check(!new Bag(st, 'glimt-bag-en-lyssna').has('bridge'), 'a listen keeps its own bag');
  again.add('water');
  check(pickStory(STORIES, near, again) === null, 'every story near heard: none is told');
  check(pickStory(STORIES, [], new Bag()) === null, 'nothing near: none is told');
  check(pickStory(STORIES, [{ name: 'skog', dist: 50 }], null).id === 'woods', 'no bag is an empty bag');
  again.empty();
  check(!new Bag(st, 'glimt-bag-en').has('bridge'), '?kasse=tom empties it');
  st.setItem('glimt-bag-en', '{not json');
  check(Object.keys(new Bag(st, 'glimt-bag-en').heard).length === 0, 'a bag that cannot be read is empty, not an error');
  st.setItem('glimt-bag-en', JSON.stringify({ heard: ['bridge'] }));
  check(Object.keys(new Bag(st, 'glimt-bag-en').heard).length === 0, 'a record that is a list, not a map, is an empty bag');
  // Two windows on the same page, each telling one: both stories are kept.
  const two = store();
  const a = new Bag(two, 'glimt-bag-en'), b = new Bag(two, 'glimt-bag-en');
  a.add('bridge');
  b.add('water');
  const both = new Bag(two, 'glimt-bag-en');
  check(both.has('bridge') && both.has('water'), `two windows: neither overwrites the other's story (${Object.keys(both.heard)})`);
  const failing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const full = new Bag(failing, 'glimt-bag-en');
  full.add('hill');
  check(full.has('hill'), 'a storage that refuses to write: the walk still knows it told the story');
}

// ?klarhet= reads a decimal comma as a point and clamps to 0-1.
{
  const cases = [['0,5', 0.5], ['0.5', 0.5], [' 0,25 ', 0.25], ['1,7', 1], ['-0,2', 0], ['x', null], [null, null], ['1', 1], ['1,2,3', null], ['', null], ['0,5x', null]];
  for (const [raw, want] of cases) check(readKlarhet(raw) === want, `klarhet ${JSON.stringify(raw)} reads ${readKlarhet(raw)}, wanted ${want}`);
}

// ?luft= the same way, a factor from 0 to LUFT_MAX (v48).
{
  const cases = [['1,5', 1.5], ['2', 2], [' 0,5 ', 0.5], ['0', 0], ['9', LUFT_MAX], ['-1', 0], ['x', null], [null, null], ['', null], ['1,5,2', null]];
  for (const [raw, want] of cases) check(readLuft(raw) === want, `luft ${JSON.stringify(raw)} reads ${readLuft(raw)}, wanted ${want}`);
}

// withAir: every pause of the English episode at luft times its length, but
// her breath before her Now, which the answer is read from.
{
  check(withAir(EN, 1) === EN, 'luft 1 is the episode as it is');
  const before = JSON.stringify(EN);
  const a = withAir(EN, 2);
  const off = Object.entries(EN.gaps).filter(([k, v]) => a.gaps[k] !== (k === EN.now ? v : 2 * v)).map(([k]) => k);
  check(!off.length && Object.keys(a.gaps).length === Object.keys(EN.gaps).length, `luft 2: every breath twice as long, her Now's as it was${off.length ? ` (wrong: ${off.join(', ')})` : ''}`);
  check(a.gaps[EN.now] === EN.gaps[EN.now] && EN.gaps[EN.now] > 0, `her Now keeps its ${EN.gaps[EN.now]} s`);
  check(['tree', 'sky', 'bell'].every(k => a.after[k] === 2 * EN.after[k]) && a.end.soon === 2 * EN.end.soon && a.end.gap === 2 * EN.end.gap,
    'the scenes open twice as long after each other, and the end waits twice as long');
  check(a.words === EN.words && a.at === EN.at && a.now === EN.now && a.luft === 2, 'and nothing else changes');
  check(JSON.stringify(EN) === before, 'the episode itself is left as it was');
  check(Object.keys(SV.gaps).length === 0, 'the Swedish episode has no breaths of its own, as in v40');
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nworld ok');
