// What the world is like where the walker is: light, rain, and landmarks
// nearby. Read once at the start of a walk (the map once more later, for an
// episode that asks: lookAgain).
//
// `light`, `rain` and `landmark` are what the phone has read, or null when
// it has not: Vega never makes up what she sees (Henric 29/10, "Inte hitta på
// något"). Until v52 every lookup fell back on a guess, and five walks of six
// got a landmark at random. The guesses are kept in `guess` for the Swedish
// chapters, the Swedish episode and the lab, which are frozen as they were
// and still read them (orGuess); nothing English reads them.

import { haversine } from './engine.js';

export const LANDMARKS = ['vatten', 'skog', 'berg', 'bro', 'kyrkogard'];

// Solar altitude in degrees. USNO low-precision algorithm, good to ~0.01°.
export function sunAltitude(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = (gmst * 15 + lon) % 360;
  const ha = (lst - ra) * rad;
  const alt = Math.asin(
    Math.sin(lat * rad) * Math.sin(dec) +
    Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)
  );
  return alt / rad;
}

// "Ljust" down to a few degrees below the horizon: dusk still has light.
export function lightFromSun(date, lat, lon) {
  return sunAltitude(date, lat, lon) > -4 ? 'light' : 'dark';
}

// Without a position: guess from the local clock.
export function lightFromClock(date) {
  const h = date.getHours();
  return h >= 6 && h < 21 ? 'light' : 'dark';
}

const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
]);

// Rain now, and the share of the sky under cloud (0-100 %, null if the
// answer had none). No scene reads the cloud yet: it is logged at every start
// so walks build up a record of when the sky was clear ("Klar himmel" in
// the catalogue). An answer with neither precipitation nor a weather code
// says nothing about rain, and is an error: until v52 it read as dry.
export async function fetchWeather(lat, lon, { fetchImpl = fetch, timeout = 6000 } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=precipitation,weather_code,cloud_cover`;
  const res = await withTimeout(fetchImpl(url), timeout);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const cur = data.current || {};
  if (!Number.isFinite(cur.precipitation) && !Number.isFinite(cur.weather_code)) throw new Error('open-meteo: inget väder i svaret');
  return {
    rain: (cur.precipitation ?? 0) > 0.05 || RAIN_CODES.has(cur.weather_code),
    cloud: Number.isFinite(cur.cloud_cover) ? cur.cloud_cover : null,
  };
}

// Landmarks OpenStreetMap maps reliably, within a few hundred metres.
export function overpassQuery(lat, lon, radius = 400) {
  const a = `(around:${radius},${lat.toFixed(5)},${lon.toFixed(5)})`;
  return `[out:json][timeout:8];(
nwr["natural"="water"]${a};
way["waterway"~"^(river|stream|canal)$"]${a};
nwr["natural"="wood"]${a};
nwr["landuse"="forest"]${a};
node["natural"="peak"](around:${radius + 200},${lat.toFixed(5)},${lon.toFixed(5)});
way["bridge"="yes"]${a};
nwr["landuse"="cemetery"]${a};
nwr["amenity"="grave_yard"]${a};
);out center tags 60;`;
}

// One entry per matching element: {name, lat, lon}. Nodes carry lat/lon,
// ways and relations a `center` (asked for with `out center`). Elements
// without either still count, with null coordinates, so the Swedish chapters'
// landmark is never lost just because the server left the geometry out.
// landmarksNear, which says only what has a place, leaves them out.
export function classifyElements(elements) {
  const found = [];
  for (const el of elements) {
    const t = el.tags || {};
    const names = [];
    if (t.natural === 'water' || /^(river|stream|canal)$/.test(t.waterway || '')) names.push('vatten');
    if (t.natural === 'wood' || t.landuse === 'forest') names.push('skog');
    if (t.natural === 'peak') names.push('berg');
    if (t.bridge === 'yes') names.push('bro');
    if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') names.push('kyrkogard');
    const lat = el.lat ?? (el.center && el.center.lat) ?? null;
    const lon = el.lon ?? (el.center && el.center.lon) ?? null;
    for (const name of names) found.push({ name, lat, lon });
  }
  return found;
}

// The nearest element of each kind, keyed by name. Elements without
// coordinates are kept only when nothing with coordinates has the same name.
export function nearestByName(found, origin) {
  const best = {};
  const o = { latitude: origin.lat, longitude: origin.lon };
  for (const f of found) {
    const dist = f.lat === null ? Infinity : haversine(o, { latitude: f.lat, longitude: f.lon });
    const cur = best[f.name];
    if (!cur || dist < cur.dist) best[f.name] = { lat: f.lat, lon: f.lon, dist };
  }
  return best;
}

// Public Overpass servers time out under load, so try two in turn. The
// landmark is not needed until scene 6, eight minutes in, and nothing waits
// for it, so each gets 20 s, the answer's body included.
//
// The second was overpass.kumi.systems until 2026-10-06. It no longer
// answered at all, and five walks of six fell back on a made-up landmark,
// most with "timeout 12000 ms". The log named only the last server's error,
// so which failed how is not known; it names both now. openstreetmap.fr gave
// the same 17 elements around Karlstad in under two seconds. overpass-api.de
// refuses a request without a Referer (406); a browser sends one.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

export async function fetchLandmarks(lat, lon, { fetchImpl = fetch, timeout = 20000, endpoints = OVERPASS } = {}) {
  const errors = [];
  for (const url of endpoints) {
    try {
      const data = await withTimeout(fetchImpl(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(overpassQuery(lat, lon)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }).then(res => {
        if (!res.ok) throw new Error(`overpass ${res.status}`);
        return res.json();
      }), timeout);
      return classifyElements(data.elements || []);
    } catch (err) {
      errors.push(`${new URL(url).hostname}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; ') || 'no server to ask');
}

export function pick(list, random = Math.random) {
  return list[Math.floor(random() * list.length)];
}

// What the phone read, or else the old guess. Only for the Swedish chapters,
// the Swedish episode and the lab, frozen as they were: they still guess.
export const orGuess = (world, key) => world[key] ?? (world.guess || {})[key] ?? null;

// What Vega may say is near the walker, now: the kinds the map has found
// within reach of where the walker is when she says it, nearest first, as
// [{name, dist}]. Empty when she cannot see anything. What counts (v52):
//   - an element the map found, with a position. One the server sent without
//     geometry cannot be placed, so it is not near anyone.
//   - within REACH of the walker's newest decent fix (accuracy at most 50 m,
//     as the engine keeps them), counted from the far edge of that fix: the
//     distance plus its accuracy. A hill within PEAK_REACH, as the query asks
//     (seen from further off).
//   - a fix no older than FIX_FRESH: over that the GPS has gone quiet, five
//     of Firefox's fixes (one every 6.2 s) and sixty of Chrome's.
// Not from the start: the map was asked where the walk began, and scene 3 is
// six or seven minutes on. On 23/10 it named a bridge 160 m from the start,
// eight minutes before she said it; where the walker was then nobody checked.
// REACH is the query's own radius ("a few hundred metres" in the manuscript),
// not a measured line of sight. Measured to the element's one point: a node's
// own, a way's or an area's centre (`out center`). A wood or a lake whose
// centre is beyond reach reads as far even with the walker at its edge, which
// is silence, not a place she cannot see; only a long bent way can have its
// centre nearer than its line, and that is rare.
export const REACH = 400;
export const PEAK_REACH = 600;
export const FIX_FRESH = 30;
export function landmarksNear(world, here, t) {
  if (!here || !(t - here.t <= FIX_FRESH)) return [];
  const slack = here.accuracy ?? 0;
  const best = {};
  for (const f of (world && world.found) || []) {
    if (f.lat === null || f.lon === null) continue;
    const d = haversine(here, { latitude: f.lat, longitude: f.lon }) + slack;
    if (d > (f.name === 'berg' ? PEAK_REACH : REACH)) continue;
    if (!(f.name in best) || d < best[f.name]) best[f.name] = d;
  }
  return Object.entries(best).map(([name, dist]) => ({ name, dist })).sort((a, b) => a.dist - b.dist);
}

// Adds what the map finds around (lat, lon) to `world.found`, once more in a
// walk: the first answer was for where it began. Elements already known are
// not added twice. Resolves the number added; a map that does not answer
// adds nothing.
export async function lookAgain(world, lat, lon, { fetchImpl = fetch, log = () => {} } = {}) {
  try {
    const found = await fetchLandmarks(lat, lon, { fetchImpl });
    const key = f => `${f.name} ${f.lat} ${f.lon}`;
    const known = new Set((world.found || []).map(key));
    const fresh = found.filter(f => !known.has(key(f)));
    world.found = [...(world.found || []), ...fresh];
    const kinds = [...new Set(found.map(f => f.name))];
    log(`kartan igen: ${kinds.length ? kinds.join(', ') : 'inget inom 400 m'}, ${fresh.length} nya`);
    return fresh.length;
  } catch (err) {
    log(`kartan igen: svarade inte (${err.message})`);
    return 0;
  }
}

// Fills `world` in place as answers arrive, so the chapter script can read it
// whenever scene 3 or 6 comes around. Returns when every lookup has settled.
//
// `landmark` (optional) is a saved {name, lat, lon} from an earlier chapter:
// then the map is not asked and Vega talks about the same place as last time.
export async function chooseWorld(world, { lat, lon, date = new Date(), log = () => {}, landmark: saved = null, fetchImpl = fetch } = {}) {
  world.light = lightFromSun(date, lat, lon);
  // Degrees above the horizon, not a temperature: the log line was read as
  // Celsius once.
  world.sources.light = `solen ${sunAltitude(date, lat, lon).toFixed(1).replace('.', ',')}° över horisonten`;
  log(`ljus: ${world.light} (${world.sources.light})`);

  const rain = fetchWeather(lat, lon, { fetchImpl }).then(w => {
    world.rain = w.rain; world.sources.rain = 'open-meteo';
    world.cloud = w.cloud;
    log(`väder: ${w.rain ? 'regn' : 'torrt'}, molnigt ${w.cloud === null ? 'okänt' : `${Math.round(w.cloud)} %`} (open-meteo)`);
  }).catch(err => {
    world.sources.rain = `okänt (${err.message})`;
    log(`väder: okänt, molnigt okänt (${err.message}); de svenska kapitlen gissar torrt`);
  });

  let landmark;
  if (saved && LANDMARKS.includes(saved.name)) {
    world.landmark = saved.name;
    world.landmarkCoord = typeof saved.lat === 'number' && typeof saved.lon === 'number'
      ? { lat: saved.lat, lon: saved.lon } : null;
    world.sources.landmark = `från förra kapitlet${world.landmarkCoord ? '' : ', utan position'}`;
    world.landmarkAnswered = 'sparat';
    log(`landmärke: ${world.landmark} (${world.sources.landmark})`);
    landmark = Promise.resolve();
  } else {
    landmark = fetchLandmarks(lat, lon, { fetchImpl }).then(found => {
      const nearest = nearestByName(found, { lat, lon });
      const names = Object.keys(nearest);
      // Every kind the map found, for a station that wants a real place to
      // walk to (Ljudkompassen's test walk) rather than the one picked here.
      world.nearby = nearest;
      // Every element, for an episode that asks what is near the walker
      // when she speaks (landmarksNear), not where the walk began.
      world.found = [...(world.found || []), ...found];
      world.landmarkAnswered = 'karta';
      if (names.length) {
        world.landmark = pick(names);
        const c = nearest[world.landmark];
        world.landmarkCoord = c.lat === null ? null : { lat: c.lat, lon: c.lon };
        world.sources.landmark = `karta: ${names.join(', ')}` +
          (world.landmarkCoord ? `, ${Math.round(c.dist)} m bort` : ', utan position');
        log(`landmärke: ${world.landmark} (${world.sources.landmark})`);
      } else {
        world.sources.landmark = 'karta: inget inom 400 m';
        log(`landmärke: inget (${world.sources.landmark}); de svenska kapitlen gissar ${world.guess.landmark}`);
      }
    }).catch(err => {
      world.landmarkAnswered = 'fel';
      world.sources.landmark = err.message;
      log(`landmärke: inget, kartan svarade inte (${err.message}); de svenska kapitlen gissar ${world.guess.landmark}`);
    });
  }

  await Promise.all([rain, landmark]);
  return world;
}

export function defaultWorld(date = new Date()) {
  // The guesses first, in the order the Swedish chapters have always drawn
  // them (the landmark's pick is the walk's first random number).
  const guess = { light: lightFromClock(date), rain: false, landmark: pick(LANDMARKS) };
  return {
    light: null,          // 'light' | 'dark' from the sun, null until a position
    rain: null,           // true | false from open-meteo, null until it answers
    cloud: null,          // % of the sky under cloud, null until open-meteo answers
    landmark: null,       // a kind the map found near the start, null if none
    landmarkCoord: null,
    // Every element the map has found this walk: {name, lat, lon}.
    found: [],
    guess,
    // How the map lookup ended: null until it has, then 'karta' (it
    // answered, maybe with nothing), 'fel' (no server did) or 'sparat'
    // (not asked: the landmark came from the chapter before). `nearby` is
    // what it found, nearest of each kind: {name: {lat, lon, dist}}.
    landmarkAnswered: null,
    nearby: {},
    sources: { light: 'okänt (ingen position)', rain: 'okänt', landmark: 'okänt' },
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
    promise.then(v => { clearTimeout(id); resolve(v); }, e => { clearTimeout(id); reject(e); });
  });
}
