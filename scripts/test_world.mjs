#!/usr/bin/env node
// The map lookup for landmarks (world.js, fetchLandmarks), with a fake
// network. Until 2026-10-06 its backup server had stopped answering and five
// walks of six got a made-up landmark; the log named only the last error.
//
//   node scripts/test_world.mjs

import { fetchLandmarks } from '../glimt/world.js';

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

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nworld ok');
