#!/usr/bin/env node
// The map lookup for landmarks (world.js, fetchLandmarks) and the weather
// (fetchWeather), with a fake network. Until 2026-10-06 its backup server had stopped answering and five
// walks of six got a made-up landmark; the log named only the last error.
//
//   node scripts/test_world.mjs

import { fetchLandmarks, fetchWeather, chooseWorld, defaultWorld } from '../glimt/world.js';
import { readKlarhet } from '../glimt/audio.js';

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
  check(failed.some(l => l.startsWith('väder: gissar torrt, molnigt okänt')), 'without an answer the log says the cloud is unknown');
}

// ?klarhet= reads a decimal comma as a point and clamps to 0-1.
{
  const cases = [['0,5', 0.5], ['0.5', 0.5], [' 0,25 ', 0.25], ['1,7', 1], ['-0,2', 0], ['x', null], [null, null], ['1', 1]];
  for (const [raw, want] of cases) check(readKlarhet(raw) === want, `klarhet ${JSON.stringify(raw)} reads ${readKlarhet(raw)}, wanted ${want}`);
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nworld ok');
