const scenes = [
  { triggerAtMeters: 0,    audioFile: 'audio/pilgrimsvagen/scene-1.mp3', label: 'Vägen börjar' },
  { triggerAtMeters: 333,  audioFile: 'audio/pilgrimsvagen/scene-2.mp3', label: 'Den första stenen' },
  { triggerAtMeters: 666,  audioFile: 'audio/pilgrimsvagen/scene-3.mp3', label: 'Skogens röst' },
  { triggerAtMeters: 1000, audioFile: 'audio/pilgrimsvagen/scene-4.mp3', label: 'Källan' }
];

let watchId = null;
let lastCoord = null;
let totalDistance = 0;
const triggered = new Set();
let currentAudio = null;
let wakeLock = null;

function haversine(c1, c2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(c2.latitude - c1.latitude);
  const dLon = toRad(c2.longitude - c1.longitude);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(c1.latitude)) * Math.cos(toRad(c2.latitude)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function playScene(scene, index) {
  if (currentAudio) {
    try { currentAudio.pause(); } catch (_) {}
  }
  currentAudio = new Audio(scene.audioFile);
  currentAudio.play().catch(err => {
    setStatus('Kunde inte spela ljud: ' + err.message);
  });
  document.getElementById('current-scene').textContent =
    `${index + 1}/${scenes.length} ${scene.label}`;
}

// Keeps the screen awake so Android does not throttle or pause the geolocation
// watch while the phone is in a pocket. Released when the walk ends.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('Wake lock failed:', err);
  }
}

// A wake lock is dropped whenever the page is hidden, so it has to be taken
// again on every return to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId !== null && !wakeLock) {
    acquireWakeLock();
  }
});

function onPosition(pos) {
  const coord = pos.coords;
  if (!lastCoord) {
    lastCoord = coord;
    setStatus('');
    return;
  }
  const inc = haversine(lastCoord, coord);
  if (inc > 50) {
    // GPS jitter — ignore single big jumps
    lastCoord = coord;
    return;
  }
  totalDistance += inc;
  lastCoord = coord;
  document.getElementById('distance').textContent =
    Math.round(totalDistance) + ' m';

  scenes.forEach((scene, i) => {
    if (!triggered.has(i) && totalDistance >= scene.triggerAtMeters) {
      playScene(scene, i);
      triggered.add(i);
    }
  });
}

function onError(err) {
  setStatus('GPS-fel: ' + err.message);
}

document.getElementById('start-btn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('GPS stöds inte i denna webbläsare');
    return;
  }
  document.getElementById('start-screen').hidden = true;
  document.getElementById('walking').hidden = false;

  // Scene 1 sits at 0 m, so it belongs to the button press, not to the first
  // GPS fix. Waiting for a fix meant up to half a minute of silence after
  // pressing start, and playing here also means playback begins inside the
  // user gesture rather than in an async callback.
  playScene(scenes[0], 0);
  triggered.add(0);

  setStatus('Väntar på GPS-position...');
  acquireWakeLock();
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000
  });
});

// Which build actually reached the phone. Read from the service worker cache
// that installed, not from a constant in this file, so it cannot claim to be
// newer than what is really running.
let buildAnswered = false;

function setBuild(text) {
  const el = document.getElementById('build');
  if (el) el.textContent = text;
}

// Ask the worker that is actually controlling this page. Listing cache names
// instead reports a transient during an update, when the old and new caches
// both exist for a moment.
function askBuild() {
  const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctrl) {
    setBuild('ingen (körs direkt från nätet)');
    return;
  }
  ctrl.postMessage('version');

  // Builds before 2026-09-10 have no message handler and never answer. Say so
  // rather than leaving the placeholder, which would read as a hung page.
  setTimeout(() => {
    if (!buildAnswered) setBuild('äldre version (svarar inte)');
  }, 2000);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.version) {
      buildAnswered = true;
      setBuild(e.data.version);
    }
  });

  navigator.serviceWorker.register('service-worker.js').catch(err => {
    console.warn('SW registration failed:', err);
  });

  // On an update `ready` resolves while the OLD worker still controls the page,
  // so the answer here can be the previous build. controllerchange fires when
  // the new worker claims the page and is the moment the reading becomes true.
  navigator.serviceWorker.ready.then(askBuild).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', askBuild);
} else {
  setBuild('service worker stöds inte');
}
