// The walker of a listen (?lyssna). It walks at an ordinary pace and stops
// when the listener taps Stop, and at the questions below it stops by
// itself, so someone on the sofa hears her yes (Henric 29/10: "Anta att
// användaren stannar (dvs svarar ja) när Vega frågar om hen hör henne").
// Every other question is answered as before: the walker walks on, a no,
// unless the listener taps.
//
// It stops once the question has been said, and her now after it where the
// episode has one (EN.now in episod1.js), as she asks in English: "I will
// ask you a question and then say now". It walks again once her next line
// has ended, her go ("There! Yes. Go now, go."), heard whole. A tap is the
// listener's own answer: whatever it was going to do at that question, it
// leaves undone. Except just after it has stopped by itself: see TAP_HOLD.
//
// Plain logic, no DOM: app.js tells it each line of hers that ends and acts
// on the answer, and scripts/test_glimt.mjs runs the same class against the
// episode (walker `listen`).

// Per chapter: the questions a listen answers yes. "Can you hear me?" comes
// after a yes to "Can you see me?" (s0-yes1-b), after a no (s0-no1), and once
// more to a walker who stood through it (s0-again2). The Swedish episode has
// none: its private copy stays on version 40, untouched.
export const LISTEN_YES = {
  episode1en: ['s0-yes1-b', 's0-no1', 's0-again2'],
  // Episode 2: the walker stops when she says it is at the place, and walks
  // on after her "...oh. Go." (Henric 30/10: a listen is the whole episode,
  // heard from the sofa, the mechanics answered as a walker would).
  episode2en: ['s2-here', 's2-byyou'],
};

// Episode 2's listen does what a walker does besides stopping, after the
// line named, `in` seconds after it ended: knocks twice after her Now (the
// knock and her question in scene 5), turns left at the corner, walks faster
// down the lit stretch, and stops at a place of its own choosing when the map
// had nothing (a stop after half a minute of walking is yes there). In scene
// 4 it walks in time with the beats (app.js, ctx.beats), so the song comes
// whole. Nothing of this costs the carrier bag or episode 1's memory: a
// listen keeps its own (app.js, the -lyssna keys).
export const LISTEN_PLAN = {
  episode2en: {
    'x-now': [{ do: 'knock', in: 1.2 }],
    's3-choose': [{ do: 'turn', dir: 'left', in: 8 }],
    's3-fast': [{ do: 'faster', by: 1.3, for: 35, in: 0.5 }],
    's2-none2': [{ do: 'stop', in: 40 }],
  },
};

// s after a stop by itself in which a tap keeps the walker standing. A
// listener who taps Stop at her now, as she asks, finds the button already
// saying Walk; the walk that tap would start comes before the phone has seen
// the stop (FEET_STOP in episod1.js, two seconds after the last step), and
// she hears a no (review 29/10). After it a tap is a walk, as anywhere.
export const TAP_HOLD = 3;

export class Listener {
  constructor(yes = [], now = null, plan = {}) {
    this.yes = new Set(yes);
    this.now = now;
    this.planned = plan;
    this.asked = null;      // the yes question said, waiting for her now
    this.standing = false;  // stopped by itself, to walk on after her next line
    this.stoppedAt = -Infinity;
  }

  // Line `id` of hers has ended at `at` (s). 'stop', 'walk' or null: what
  // the walker does now.
  ended(id, at) {
    if (this.standing) {
      this.standing = false;
      return 'walk';
    }
    if (this.yes.has(id)) {
      if (this.now) { this.asked = id; return null; }
      return this.stop(at);
    }
    if (this.asked && id === this.now) return this.stop(at);
    this.asked = null;
    return null;
  }

  // What else the walker does after line `id` (LISTEN_PLAN): a list of
  // {do, in, ...}, empty for most lines.
  plan(id) { return this.planned[id] || []; }

  stop(at) {
    this.asked = null;
    this.standing = true;
    this.stoppedAt = at;
    return 'stop';
  }

  // The listener tapped Stop or Walk at `at` (s). False when the tap only
  // keeps the walker standing (TAP_HOLD); true when it is the listener's.
  tapped(at) {
    if (this.standing && at - this.stoppedAt < TAP_HOLD) return false;
    this.asked = null;
    this.standing = false;
    return true;
  }
}
