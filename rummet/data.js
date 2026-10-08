// The one door between the room and where things are kept. The room asks for
// places by name ("manus:1", "rum:1", "lore") and an adapter knows where each
// lives and who is sitting there. Version 1 has two adapters: the portal's
// file API behind Henric's login, and a read-only one for the public site.
// Letting Liv in later is a third adapter, not a rebuild.
//
// An adapter is:
//   namn, kanSkriva
//   vem()                        -> { id, namn } | null   who is sitting here
//   las(plats)                   -> { text, version } | null when it is missing
//   skriv(plats, text, version)  -> { version }; throws Krock when the file
//                                   changed since `version` was read
//   ljudUrl(ljudId, klippId)     -> where a recorded clip can be fetched

export class Krock extends Error {
  constructor(version = null) {
    super('Filen har ändrats sedan den lästes.');
    this.name = 'Krock';
    this.version = version;
  }
}

export class DataFel extends Error {
  constructor(kod, text) {
    super(text);
    this.name = 'DataFel';
    this.kod = kod;
  }
}

export const EPISODER = ['1', '2'];
// Every document the room edits as text: the episodes, the world book and
// the mechanics catalogue. Lore pages are documents too, inside lore.json.
export const DOKUMENT = [...EPISODER, 'varld', 'mekaniker'];

// The people in the room. Demi is an AI (ai: true), marked as one everywhere.
// Everyone can change everything; Demi's own rule (in the README, not in the
// code) is to comment and propose, and to change text only when Henric or Liv
// asked. doljDemi is whether a person sees Demi's comments and proposals
// before they have chosen themselves.
export const PERSONER = {
  henric: { namn: 'Henric', doljDemi: false },
  liv: { namn: 'Liv', doljDemi: true },
  demi: { namn: 'Demi', ai: true },
};

const GA = '/home/henric/generalassistant';
const PUBLIK = 'https://henricbarkman.github.io/motionstory';

// rot 'prov' is a sandbox with copies, for trying the room against the real
// portal without touching the manuscript.
function sokvagar(rot) {
  if (rot === 'prov') {
    const p = `${GA}/data/glimt-rummet/prov`;
    return {
      manus: (n) => `${p}/manus/episod-${n}.md`,
      ljud: (n) => `${p}/manus/episod-${n}.json`,
      varld: () => `${p}/manus/varld.md`,
      mekaniker: () => `${p}/manus/mekaniker.md`,
      held: () => `${p}/manus/held-lore.md`,
      rum: (n) => `${p}/${filnamn(n)}.json`,
      grund: (n) => `${p}/grund/${filnamn(n)}.json`,
      lore: () => `${p}/lore.json`,
      installningar: () => `${p}/installningar.json`,
    };
  }
  const glimt = `${GA}/projects/motionstory/stories/glimt`;
  const rum = `${GA}/data/glimt-rummet`;
  return {
    manus: (n) => `${glimt}/episod-${n}.md`,
    ljud: (n) => `${glimt}/episod-${n}.json`,
    varld: () => `${glimt}/varld.md`,
    mekaniker: () => `${glimt}/mekaniker.md`,
    held: () => `${GA}/projects/held/universe/LORE.md`,
    rum: (n) => `${rum}/${filnamn(n)}.json`,
    grund: (n) => `${rum}/grund/${filnamn(n)}.json`,
    lore: () => `${rum}/lore.json`,
    installningar: () => `${rum}/installningar.json`,
  };
}

// An episode's notes are episod-N.json (as in the first version); the world
// book's and the catalogue's are varld.json and mekaniker.json.
const filnamn = (n) => (EPISODER.includes(n) ? `episod-${n}` : n);

// Where a document's text is.
export const textPlats = (dok) => (EPISODER.includes(dok) ? `manus:${dok}` : dok);

function uppslag(vagar, plats) {
  const [slag, n] = plats.split(':');
  if (!vagar[slag]) throw new DataFel('plats', `Okänd plats: ${plats}`);
  if (n != null && !((slag === 'rum' || slag === 'grund') ? DOKUMENT : EPISODER).includes(n)) {
    throw new DataFel('plats', `Okänt dokument: ${n}`);
  }
  return vagar[slag](n);
}

// The portal (demi.henricbarkman.se) already has a file API behind Henric's
// login: read gives {content, mtime}, write takes expected_mtime and answers
// 409 when the file changed in between. A page under /uploads/ is same-origin
// with it.
export function portalAdapter({ rot = 'skarp', fetch = globalThis.fetch.bind(globalThis), bas = '' } = {}) {
  const vagar = sokvagar(rot);
  const svar = async (r) => {
    try {
      return await r.json();
    } catch {
      throw new DataFel(
        'inloggning',
        'Portalen svarade inte som väntat. Inloggningen kan ha gått ut: öppna portalen i en annan flik, logga in och försök igen.',
      );
    }
  };
  return {
    namn: 'portal',
    rot,
    kanSkriva: true,
    // The portal's login is Henric's alone, so whoever is here is Henric.
    async vem() {
      return { id: 'henric', namn: PERSONER.henric.namn };
    },
    // True when the file API answers at all (also for a file that is missing).
    async finns() {
      try {
        const r = await fetch(`${bas}/api/files/read?path=${encodeURIComponent(uppslag(vagar, 'manus:1'))}`, { credentials: 'same-origin', cache: 'no-store' });
        const d = await r.json();
        return typeof d.content === 'string' || d.error === 'not found';
      } catch {
        return false;
      }
    },
    async las(plats) {
      const r = await fetch(`${bas}/api/files/read?path=${encodeURIComponent(uppslag(vagar, plats))}`, { credentials: 'same-origin', cache: 'no-store' });
      const d = await svar(r);
      if (r.status === 404 && d.error === 'not found') return null;
      if (!r.ok) throw new DataFel('las', `Det gick inte att läsa (${r.status}).`);
      if (d.binary || d.too_large || typeof d.content !== 'string') throw new DataFel('las', 'Filen går inte att läsa som text.');
      return { text: d.content, version: d.mtime };
    },
    async skriv(plats, text, version) {
      const r = await fetch(`${bas}/api/files/write`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        // version null means "I believe it does not exist yet": 0 never
        // matches a real file, so a file that appeared in between is a Krock
        // instead of being overwritten.
        body: JSON.stringify({ path: uppslag(vagar, plats), content: text, expected_mtime: version == null ? 0 : version }),
      });
      const d = await svar(r);
      if (r.status === 409) throw new Krock(d.current_mtime == null ? null : d.current_mtime);
      if (!r.ok) throw new DataFel('skriv', `Det gick inte att spara (${r.status}${d.error ? `: ${d.error}` : ''}).`);
      return { version: d.mtime };
    },
    ljudUrl: (ljudId, klippId) => `${PUBLIK}/audio/glimt/vega/${ljudId}/${klippId}.mp3`,
  };
}

// Without the portal (on the public site, say) the room can show the
// manuscript and play the sound, and nothing else. sida is the address of
// rummet/index.html; the manuscript lies beside it in the same repo.
export function lasAdapter({ fetch = globalThis.fetch.bind(globalThis), sida }) {
  const url = {
    manus: (n) => new URL(`../stories/glimt/episod-${n}.md`, sida),
    ljud: (n) => new URL(`../stories/glimt/episod-${n}.json`, sida),
    varld: () => new URL('../stories/glimt/varld.md', sida),
    mekaniker: () => new URL('../stories/glimt/mekaniker.md', sida),
  };
  return {
    namn: 'las',
    kanSkriva: false,
    async vem() {
      return null;
    },
    async las(plats) {
      const [slag, n] = plats.split(':');
      if (!url[slag]) return null; // the room's own notes are not public
      const r = await fetch(url[slag](n), { cache: 'no-cache' });
      if (r.status === 404) return null;
      if (!r.ok) throw new DataFel('las', `Det gick inte att läsa (${r.status}).`);
      return { text: await r.text(), version: null };
    },
    async skriv() {
      throw new DataFel('laslage', 'Här går det bara att läsa.');
    },
    ljudUrl: (ljudId, klippId) => new URL(`../audio/glimt/vega/${ljudId}/${klippId}.mp3`, sida).href,
  };
}

export async function valjAdapter({ fetch = globalThis.fetch.bind(globalThis), sida }) {
  const rot = new URL(sida).searchParams.get('rot') === 'prov' ? 'prov' : 'skarp';
  const portal = portalAdapter({ rot, fetch });
  if (await portal.finns()) return portal;
  return lasAdapter({ fetch, sida });
}
