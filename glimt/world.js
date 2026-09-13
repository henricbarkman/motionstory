// What the world is like where the walker is: light, rain, and a landmark
// nearby. Chosen once at the start of a walk. Every lookup has a fallback so
// a phone without network still gets a chapter, just one where Vega guesses.

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

export async function fetchRain(lat, lon, { fetchImpl = fetch, timeout = 6000 } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=precipitation,weather_code`;
  const res = await withTimeout(fetchImpl(url), timeout);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const cur = data.current || {};
  return (cur.precipitation ?? 0) > 0.05 || RAIN_CODES.has(cur.weather_code);
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
// without either still count, with null coordinates, so a landmark is never
// lost just because the server left the geometry out.
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
// landmark is not needed until scene 6, eight minutes in.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function fetchLandmarks(lat, lon, { fetchImpl = fetch, timeout = 12000, endpoints = OVERPASS } = {}) {
  let lastErr = null;
  for (const url of endpoints) {
    try {
      const res = await withTimeout(fetchImpl(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(overpassQuery(lat, lon)),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }), timeout);
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const data = await res.json();
      return classifyElements(data.elements || []);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function pick(list, random = Math.random) {
  return list[Math.floor(random() * list.length)];
}

// Fills `world` in place as answers arrive, so the chapter script can read it
// whenever scene 3 or 6 comes around. Returns when every lookup has settled.
//
// `landmark` (optional) is a saved {name, lat, lon} from an earlier chapter:
// then the map is not asked and Vega talks about the same place as last time.
export async function chooseWorld(world, { lat, lon, date = new Date(), log = () => {}, landmark: saved = null } = {}) {
  world.light = lightFromSun(date, lat, lon);
  // Degrees above the horizon, not a temperature: the log line was read as
  // Celsius once.
  world.sources.light = `solen ${sunAltitude(date, lat, lon).toFixed(1).replace('.', ',')}° över horisonten`;
  log(`ljus: ${world.light} (${world.sources.light})`);

  const rain = fetchRain(lat, lon).then(r => {
    world.rain = r; world.sources.rain = 'open-meteo';
    log(`väder: ${r ? 'regn' : 'torrt'} (open-meteo)`);
  }).catch(err => {
    world.sources.rain = `gissning (${err.message})`;
    log(`väder: gissar torrt (${err.message})`);
  });

  let landmark;
  if (saved && LANDMARKS.includes(saved.name)) {
    world.landmark = saved.name;
    world.landmarkCoord = typeof saved.lat === 'number' && typeof saved.lon === 'number'
      ? { lat: saved.lat, lon: saved.lon } : null;
    world.sources.landmark = `från förra kapitlet${world.landmarkCoord ? '' : ', utan position'}`;
    log(`landmärke: ${world.landmark} (${world.sources.landmark})`);
    landmark = Promise.resolve();
  } else {
    landmark = fetchLandmarks(lat, lon).then(found => {
      const nearest = nearestByName(found, { lat, lon });
      const names = Object.keys(nearest);
      if (names.length) {
        world.landmark = pick(names);
        const c = nearest[world.landmark];
        world.landmarkCoord = c.lat === null ? null : { lat: c.lat, lon: c.lon };
        world.sources.landmark = `karta: ${names.join(', ')}` +
          (world.landmarkCoord ? `, ${Math.round(c.dist)} m bort` : ', utan position');
      } else {
        world.sources.landmark = 'karta: inget inom 400 m, slumpat';
      }
      log(`landmärke: ${world.landmark} (${world.sources.landmark})`);
    }).catch(err => {
      world.sources.landmark = `slumpat (${err.message})`;
      log(`landmärke: ${world.landmark} slumpat (${err.message})`);
    });
  }

  await Promise.all([rain, landmark]);
  return world;
}

export function defaultWorld(date = new Date()) {
  return {
    light: lightFromClock(date),
    rain: false,
    landmark: pick(LANDMARKS),
    landmarkCoord: null,
    sources: { light: 'klocka', rain: 'gissning', landmark: 'slumpat' },
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
    promise.then(v => { clearTimeout(id); resolve(v); }, e => { clearTimeout(id); reject(e); });
  });
}
