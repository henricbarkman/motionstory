// A phone in a trouser pocket, for the gyro's simulated walkers
// (scripts/test_lab.mjs): what its accelerometer and gyroscope give as the
// walker walks, turns, stands, and takes it out of the pocket.
//
// The phone's orientation is built, and both sensors are read off it, so
// they agree with each other the way a real phone's do:
//   phone -> world = yaw(heading + hips' twist) · swing(thigh) · pocket
// World axes east, north, up. The body's: forward, left, up. The thigh swings
// about the body's left axis, ±25 degrees a stride while walking; the hips
// twist about up, ±7 degrees a stride. The pocket is any orientation with the
// phone's long side within 20 degrees of the thigh, top up or down, screen
// facing any way round. Rotation rate is the change of orientation between
// two samples, in the phone's own axes, right-handed, so it is consistent
// with the accelerometer by construction.
//
// accelerationIncludingGravity points up (a phone flat on a table reads
// +9.8 on z), with some sway of direction while walking, and is scaled to the
// magnitude the step model gives, so the step and knock detectors see exactly
// what they saw before the gyro.
//
// How the browser hands the rotation over, `kind`:
//   chrome   alpha, beta, gamma = rotation about x, y, z in deg/s (Chromium)
//   rad      the same in rad/s (Chrome m66)
//   flip     the other hand of rotation: every rate negated
//   oldspec  alpha about z, beta about x, gamma about y (the spec before)
//   none     rotationRate null: no gyro in the phone
//   flipy    one axis mirrored: beta negated, the axis nearest up in a pocket
//   gravdown accelerationIncludingGravity pointing down instead of up
//   noorient no deviceorientation events
// A sensor fault (`quiet`) is the caller's: it passes no rate.
//
// The orientation, as deviceorientation gives it: alpha, beta, gamma such
// that Rz(alpha)·Rx(beta)·Ry(gamma) is the phone's orientation, worked out
// from the same quaternion, with a hundredth of a degree of noise (Android's
// fused orientation is smooth).
//
// The model is mine, not a recording: no gyro has been recorded in a pocket
// yet (2026-10-12). It shares the code's reading of the spec, so it tests the
// logic and the checks, not whether the spec was read right.

const D = Math.PI / 180;

// Quaternions [w, x, y, z].
const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qconj = q => [q[0], -q[1], -q[2], -q[3]];
const axis = (v, ang) => {
  const n = Math.hypot(...v), s = Math.sin(ang / 2) / n;
  return [Math.cos(ang / 2), v[0] * s, v[1] * s, v[2] * s];
};
// v rotated by q.
const rot = (q, v) => qmul(qmul(q, [0, ...v]), qconj(q)).slice(1);
function slerp(a, b, k) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map(x => -x); d = -d; }
  if (d > 0.9995) return norm4(a.map((x, i) => x + (b[i] - x) * k));
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((x, i) => (x * Math.sin((1 - k) * th) + b[i] * Math.sin(k * th)) / s);
}
const norm4 = q => { const n = Math.hypot(...q); return q.map(x => x / n); };
const smooth = k => k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);

export function makePocketPhone(kind, random) {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  // The pocket: long side along the thigh (top up or down), screen facing
  // any way round it, tilted up to 20 degrees.
  const upright = axis([1, 0, 0], (random() < 0.5 ? 1 : -1) * 90 * D);
  const round = axis([0, 0, 1], random() * 360 * D);
  const tiltAxis = random() * 2 * Math.PI;
  const tilt = axis([Math.cos(tiltAxis), Math.sin(tiltAxis), 0], random() * 20 * D);
  const pocket = qmul(tilt, qmul(round, upright));
  // In the hand: screen up, tilted 40 degrees towards the walker.
  const hand = qmul(axis([0, 0, 1], (random() * 60 - 30) * D), axis([1, 0, 0], 40 * D));
  const bias = [0, 1, 2].map(() => (random() - 0.5) * 1.0);   // deg/s
  const twistPhase = random() * 2 * Math.PI;

  let place = { from: hand, to: pocket, start: 0, len: 2.5 };   // put in the pocket at the start
  let handling = null;
  let swing = 0;              // amplitude, eases in and out with the gait
  let prev = null, prevT = null;

  const phone = {
    pocket,
    // Out of the pocket at `at`, looked at, turned about for `hold` seconds,
    // and put back turned `back` degrees about the thigh.
    handle(at, { hold = 4, back = 180 } = {}) {
      const now = phone.placeAt(at);
      const again = qmul(axis([0, 0, 1], back * D), now);
      handling = { at, hold, out: now, back: again };
    },
    // Into the pocket at `at` instead of at the start, held in the hand
    // until then.
    pocketAt(at) { place = { from: hand, to: pocket, start: at, len: 2.5 }; },
    placeAt(t) {
      if (handling && t >= handling.at) {
        const h = handling, k = t - h.at;
        if (k < 1) return slerp(h.out, hand, smooth(k));
        if (k < 1 + h.hold) return qmul(axis([0, 0, 1], 40 * D * Math.sin((k - 1) * 1.3)), hand);
        if (k < 2 + h.hold) return slerp(hand, h.back, smooth(k - 1 - h.hold));
        return h.back;
      }
      return slerp(place.from, place.to, smooth((t - place.start) / place.len));
    },
    // One sample at t. `heading` compass radians (clockwise from north),
    // `phase` steps taken (fractional), `walking` the feet going, `mag` the
    // step model's |a|. Returns {acc, rate, orient} as the page would get them.
    sample(t, { heading, phase, walking, mag }) {
      const dt = prevT === null ? 0.02 : t - prevT;
      swing += ((walking ? 25 * D : 0) - swing) * Math.min(1, dt / 0.4);
      const twist = (walking ? 7 * D : 0) * Math.sin(Math.PI * phase + twistPhase);
      const yaw = axis([0, 0, 1], Math.PI / 2 - heading + twist);
      const thigh = axis([0, 1, 0], swing * Math.sin(Math.PI * phase));
      const q = qmul(yaw, qmul(thigh, phone.placeAt(t)));
      // Up in the phone's axes, with the gait's sway of direction.
      const up = rot(qconj(q), [0, 0, 1]);
      const n = walking ? 0.08 : 0.01;
      const dir = up.map(v => v + n * gauss());
      const len = Math.hypot(...dir);
      const sign = kind === 'gravdown' ? -1 : 1;
      const acc = { x: sign * mag * dir[0] / len, y: sign * mag * dir[1] / len, z: sign * mag * dir[2] / len };
      // The matrix's columns are the phone's axes in the earth's.
      const [c0, c1, c2] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(e => rot(q, e));
      const R = [[c0[0], c1[0], c2[0]], [c0[1], c1[1], c2[1]], [c0[2], c1[2], c2[2]]];
      const n2 = () => 0.01 * gauss();
      const orient = kind === 'noorient' ? null : {
        alpha: Math.atan2(-R[0][1], R[1][1]) / D + n2(),
        beta: Math.atan2(R[2][1], Math.hypot(R[2][0], R[2][2])) / D + n2(),
        gamma: Math.atan2(-R[2][0], R[2][2]) / D + n2(),
      };
      // Rotation between samples, in the phone's axes: q_prev⁻¹ q.
      let w = [0, 0, 0];
      if (prev) {
        let d = qmul(qconj(prev), q);
        if (d[0] < 0) d = d.map(x => -x);
        const s = Math.hypot(d[1], d[2], d[3]);
        const ang = 2 * Math.atan2(s, d[0]);
        if (s > 1e-12) w = [d[1], d[2], d[3]].map(v => v / s * ang / dt);
      }
      prev = q; prevT = t;
      const deg = w.map((v, i) => v / D + bias[i] + 1.5 * gauss());
      let rate;
      if (kind === 'none') rate = null;
      else if (kind === 'rad') rate = { alpha: deg[0] * D, beta: deg[1] * D, gamma: deg[2] * D };
      else if (kind === 'flip') rate = { alpha: -deg[0], beta: -deg[1], gamma: -deg[2] };
      else if (kind === 'oldspec') rate = { alpha: deg[2], beta: deg[0], gamma: deg[1] };
      else if (kind === 'flipy') rate = { alpha: deg[0], beta: -deg[1], gamma: deg[2] };
      else rate = { alpha: deg[0], beta: deg[1], gamma: deg[2] };
      return { acc, rate, orient };
    },
  };
  return phone;
}
