// What Vega remembers between walks: when you last came, which kinds of
// walk you have taken her on (dark, rain, full moon), and which squares of
// the map you have walked through. Pure logic plus a storage object, so node
// can test it with a stand-in for localStorage.
//
// Three meta layers from the 2026-09-25 list, all small on purpose:
//   Frånvaron   a line about the time since the last walk, never guilt
//   Nycklar     the first walk in the dark, in rain, under a full moon
//   Hennes värld  squares of about 100 m; new ground makes her world bigger

const KEY = 'glimt-memory';
const MAX_CELLS = 5000;

// A new moon on 2000-01-06 18:14 UTC and the mean synodic month. Good to
// well under a day, which is all "is it full moon tonight" needs.
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_DAYS = 29.530588853;

// 0 new moon, 0.5 full.
export function moonPhase(date) {
  const days = (date.getTime() - NEW_MOON_MS) / 86400000;
  return (((days / SYNODIC_DAYS) % 1) + 1) % 1;
}

// Within a day of full.
export function isFullMoon(date) {
  return Math.abs(moonPhase(date) - 0.5) * SYNODIC_DAYS <= 1;
}

// Hours since the last walk → a line, or null for the first walk ever.
export function absenceLine(lastAt, now) {
  if (!Number.isFinite(lastAt)) return null;
  const hours = (now - lastAt) / 3600000;
  if (hours < 16) return 'franvaro-samma';
  if (hours < 24 * 7) return 'franvaro-dagar';
  return 'franvaro-lange';
}

// Squares of about 100 m: latitude in steps of 0.0009°, longitude in steps
// that keep the width near 100 m at the square's own latitude band.
export function cellOf(lat, lon) {
  const i = Math.floor(lat / 0.0009);
  const width = 0.0009 / Math.max(0.2, Math.cos((i + 0.5) * 0.0009 * Math.PI / 180));
  const j = Math.floor(lon / width);
  return `${i},${j}`;
}

const KEY_LINES = { morker: 'nyckel-morker', regn: 'nyckel-regn', fullmane: 'nyckel-fullmane' };
export const KEY_NAMES = { morker: 'mörker', regn: 'regn', fullmane: 'fullmåne' };

export class Memory {
  constructor(storage) {
    this.storage = storage;
    this.data = { walks: [], keys: {}, cells: [] };
    try {
      const raw = storage && storage.getItem(KEY);
      const d = raw ? JSON.parse(raw) : null;
      if (d && Array.isArray(d.walks) && Array.isArray(d.cells) && d.keys && typeof d.keys === 'object') this.data = d;
    } catch (_) { /* a broken entry starts her memory over, it does not stop the walk */ }
    this.known = new Set(this.data.cells);
    this.fresh = new Set();          // squares first walked this walk
    this.newKeys = [];
  }

  save() {
    try { this.storage && this.storage.setItem(KEY, JSON.stringify(this.data)); } catch (_) {}
  }

  lastWalkAt() {
    const w = this.data.walks[this.data.walks.length - 1];
    return w ? w.at : NaN;
  }

  // Line ids to play before the first station.
  opening(now) {
    const line = absenceLine(this.lastWalkAt(), now);
    return line ? [line] : [];
  }

  visit(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const c = cellOf(lat, lon);
    if (this.known.has(c)) return;
    this.known.add(c);
    this.fresh.add(c);
  }

  // Keys this walk earns for the first time. Recorded, so each is said once.
  unlock(world, date) {
    const earned = [];
    if (world.light === 'dark') earned.push('morker');
    if (world.rain) earned.push('regn');
    if (world.light === 'dark' && isFullMoon(date)) earned.push('fullmane');
    for (const k of earned) {
      if (this.data.keys[k]) continue;
      this.data.keys[k] = date.toISOString();
      this.newKeys.push(k);
    }
    return this.newKeys;
  }

  // Line ids to play after the last station: new keys, then how much new
  // ground the walk covered.
  closing(world, date) {
    const lines = this.unlock(world, date).map(k => KEY_LINES[k]);
    const n = this.fresh.size;
    if (n >= 5) lines.push('varld-ny');
    else if (n > 0) lines.push('varld-lite');
    else if (this.known.size > 0) lines.push('varld-samma');
    return lines;
  }

  // Called once when the walk ends, however it ends.
  endWalk(now, kind) {
    this.data.walks.push({ at: now, kind, fresh: this.fresh.size });
    this.data.walks = this.data.walks.slice(-200);
    this.data.cells = [...this.known].slice(-MAX_CELLS);
    this.save();
  }

  summary() {
    return {
      walks: this.data.walks.length,
      cells: this.known.size,
      keys: Object.keys(this.data.keys).filter(k => KEY_NAMES[k]),
    };
  }

  // Squares as integer grid positions, for drawing her world.
  grid() {
    return [...this.known].map(c => c.split(',').map(Number));
  }
}

// Draws the known squares on a canvas: the world as far as she has heard
// it, the newest walk brighter. Nothing but squares; no map underneath.
export function drawWorld(canvas, memory) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  const cells = memory.grid();
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!cells.length) return;
  const is = cells.map(c => c[0]), js = cells.map(c => c[1]);
  const minI = Math.min(...is), maxI = Math.max(...is), minJ = Math.min(...js), maxJ = Math.max(...js);
  const rows = maxI - minI + 1, cols = maxJ - minJ + 1;
  const size = Math.max(2, Math.min(24, Math.floor(Math.min((W - 8) / cols, (H - 8) / rows))));
  const offX = (W - cols * size) / 2, offY = (H - rows * size) / 2;
  for (const [i, j] of cells) {
    const fresh = memory.fresh.has(`${i},${j}`);
    ctx.fillStyle = fresh ? 'rgba(200, 210, 255, 0.9)' : 'rgba(200, 210, 255, 0.35)';
    // North up: larger i is further north, so it goes higher on the canvas.
    ctx.fillRect(offX + (j - minJ) * size, offY + (maxI - i) * size, size - 1, size - 1);
  }
}
