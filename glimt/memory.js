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
// that keep the width near 100 m. The width is set per whole degree of
// latitude, not per row: per row, the columns slid a fifth of a square each
// row and a walk straight north was drawn as a staircase (2026-09-25).
export function cellOf(lat, lon) {
  const i = Math.floor(lat / 0.0009);
  const width = 0.0009 / Math.max(0.2, Math.cos(Math.round(lat) * Math.PI / 180));
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

  // The squares the last saved walk added. Cells are stored in the order
  // they were first walked, so they are the last ones in the list.
  lastWalkCells() {
    const w = this.data.walks[this.data.walks.length - 1];
    const n = w && Number.isFinite(w.fresh) ? w.fresh : 0;
    return new Set(n > 0 ? this.data.cells.slice(-n) : []);
  }
}

// Draws the known squares on a canvas: the world as far as she has heard
// it, north up, no map underneath. `recent` (a set of cell keys) glows; the
// rest is faint. Sized to the canvas's CSS box at the screen's pixel density.
export function drawWorld(canvas, memory, recent = memory.fresh) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const W = Math.max(1, Math.round((canvas.clientWidth || canvas.width) * dpr));
  const H = Math.max(1, Math.round((canvas.clientHeight || canvas.height) * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  const cells = memory.grid();
  if (!cells.length) return;
  const is = cells.map(c => c[0]), js = cells.map(c => c[1]);
  const minI = Math.min(...is), maxI = Math.max(...is), minJ = Math.min(...js), maxJ = Math.max(...js);
  const rows = maxI - minI + 1, cols = maxJ - minJ + 1;
  const pad = 12 * dpr;
  const size = Math.max(2 * dpr, Math.min(18 * dpr, Math.floor(Math.min((W - pad * 2) / cols, (H - pad * 2) / rows))));
  const gap = size >= 6 * dpr ? Math.round(size * 0.22) : 0;
  const offX = (W - cols * size) / 2, offY = (H - rows * size) / 2;
  const at = (i, j) => [offX + (j - minJ) * size, offY + (maxI - i) * size];
  // Faint squares first, then the glowing ones on top.
  ctx.fillStyle = 'rgba(200, 210, 255, 0.32)';
  for (const [i, j] of cells) {
    if (recent.has(`${i},${j}`)) continue;
    const [x, y] = at(i, j);
    ctx.fillRect(x, y, size - gap, size - gap);
  }
  ctx.fillStyle = '#c8d2ff';
  ctx.shadowColor = 'rgba(200, 210, 255, 0.7)';
  ctx.shadowBlur = Math.max(4, size * 0.8);
  for (const [i, j] of cells) {
    if (!recent.has(`${i},${j}`)) continue;
    const [x, y] = at(i, j);
    ctx.fillRect(x, y, size - gap, size - gap);
  }
  ctx.shadowBlur = 0;
}
