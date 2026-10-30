// The app's pauses, for the manuscript room's directing desk.
//
// The app plays a few seconds of silence before some clips ("gaps" in the
// language settings SV and EN in glimt/episod1.js). The desk shows them as the
// pause before a line, so Henric sees what the app does today next to what he
// wants. An episode the app does not play yet gets a standard pause (STANDARD). This reads them from the app's own code and writes
// rummet/apptider.json, keyed by the recordings' chapter id. rummet_deploy.py
// runs it before every deploy, and test_regi.mjs checks the file is current.
//
//     node scripts/rummet_apptider.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const UT = join(REPO, 'rummet', 'apptider.json');

// Which settings belong to which recordings (the "id" in episod-1.json and
// episode-1.json).
const SPRAK = { SV: 'stories/glimt/episod-1.json', EN: 'stories/glimt/episode-1.json' };
// Episodes the app does not play yet: one clip per manuscript line, and the
// same pause before every clip until the desk says otherwise. 0.5 s is about
// the breath between lines inside episode 1's clips (silences there: median
// 0.47 s, measured 30/10), on top of each clip's own lead-in and tail.
const STANDARD = { 'stories/glimt/episode-2.json': 0.5 };

export async function apptider() {
  const app = await import(pathToFileURL(join(REPO, 'glimt', 'episod1.js')).href);
  const ut = {};
  for (const [namn, fil] of Object.entries(SPRAK)) {
    const story = JSON.parse(readFileSync(join(REPO, fil), 'utf8'));
    // Only the pauses before a clip: not the one before her name is said
    // (`name`) or before she goes on after the lamp (`lamp-tree`).
    const gaps = Object.entries((app[namn] && app[namn].gaps) || {}).filter(([line]) => line in story.lines);
    ut[story.id] = Object.fromEntries(gaps);
  }
  for (const [fil, sek] of Object.entries(STANDARD)) {
    const story = JSON.parse(readFileSync(join(REPO, fil), 'utf8'));
    ut[story.id] = Object.fromEntries(Object.keys(story.lines).map((line) => [line, sek]));
  }
  return ut;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = `${JSON.stringify(await apptider(), null, 1)}\n`;
  if (process.argv.includes('--check')) {
    let nu = '';
    try { nu = readFileSync(UT, 'utf8'); } catch { /* missing */ }
    if (nu !== text) { console.error('rummet/apptider.json is out of date: run node scripts/rummet_apptider.mjs'); process.exit(1); }
    console.log('rummet/apptider.json is current');
  } else {
    writeFileSync(UT, text);
    console.log('wrote rummet/apptider.json');
  }
}
