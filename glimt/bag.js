// The carrier bag (Ursula K. Le Guin; chosen for the book's structure on
// 27/10): small stories Vega tells about something the phone has read in the
// walker's world. We get to know her through how she reacts to Shape's world
// (Henric 29/10: "De ska ha en mening för den större storyn, men kan också
// vara 'Ma', och meningen kanske 'bara' är att vi ska lära känna henne bättre
// och stärka relationen."). A story waits in the bag until a walk gives it
// something real to hang on, in this episode or a later one, and is told
// once. When nothing it needs has been read, she says nothing about it
// (Henric 29/10: "Inte hitta på något. Om hon inte kan se så spara replikerna
// om landmärket till en gång när hon kan se.").
//
// A story: `id`, the same in every episode and in the walker's record of
// what was heard; `near`, the kind of place the map must have near the
// walker when she tells it (world.js, landmarksNear); `line`, the clip in the
// episode that tells it. The first five are the landmarks of episode 1's
// scene 3, in English only.

export const STORIES = [
  { id: 'bridge', near: 'bro', line: 's3-bro' },
  { id: 'water', near: 'vatten', line: 's3-vatten' },
  { id: 'woods', near: 'skog', line: 's3-skog' },
  { id: 'hill', near: 'berg', line: 's3-berg' },
  { id: 'graveyard', near: 'kyrkogard', line: 's3-kyrkogard' },
];

// The bag as the walker's phone keeps it: which stories have been heard, when,
// in which episode and version. `storage` is localStorage, or null for a walk
// that keeps nothing (the bag lives in memory for the walk). A key per page:
// the English bag is not the Swedish one, and a listen or a sim keeps its own,
// so an evening on the sofa does not use up the stories of the walks.
export class Bag {
  constructor(storage = null, key = 'glimt-bag') {
    this.storage = storage;
    this.key = key;
    this.heard = this.read();
  }

  // What the storage holds now: {} when there is none, or it cannot be read.
  read() {
    try {
      const raw = this.storage && this.storage.getItem(this.key);
      const v = raw ? JSON.parse(raw) : null;
      return v && v.heard && typeof v.heard === 'object' && !Array.isArray(v.heard) ? v.heard : {};
    } catch (_) { return {}; }
  }

  has(id) { return Object.hasOwn(this.heard, id); }

  // Marks story `id` heard. `info`: {episode, version}. Read again first, as
  // Memory.endWalk does: another window on the same page may have told one
  // since this one opened, and its story must not be written over.
  add(id, info = {}) {
    this.heard = { ...this.read(), ...this.heard, [id]: { at: new Date().toISOString(), ...info } };
    this.save();
  }

  // Forgets every story heard (?kasse=tom), so they can be heard again.
  empty() {
    this.heard = {};
    this.save();
  }

  save() {
    try { if (this.storage) this.storage.setItem(this.key, JSON.stringify({ heard: this.heard })); } catch (_) {}
  }
}

// The story to tell now: of the stories not heard yet, the one whose place
// is nearest the walker. `near`: landmarksNear's [{name, dist}], nearest
// first. Null when nothing near has a story left: then she tells none.
export function pickStory(stories, near, bag) {
  for (const { name, dist } of near) {
    const story = stories.find(s => s.near === name && !(bag && bag.has(s.id)));
    if (story) return { ...story, dist };
  }
  return null;
}
