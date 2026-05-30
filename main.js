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

function onPosition(pos) {
  const coord = pos.coords;
  if (!lastCoord) {
    lastCoord = coord;
    playScene(scenes[0], 0);
    triggered.add(0);
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
  setStatus('Väntar på GPS-position...');
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000
  });
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}
