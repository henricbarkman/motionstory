# Motionstory

Arbetsnamn. Narrativt fitness-system där motionsformen styr berättelse-genren.

Detta repo är **toy v0** — testar kärnloopen "kroppen driver berättelsen". Mer ambition kommer ovanpå när vi vet att kärnan är rolig.

## Toyet: Pilgrimsvägen

En 1 km kontemplativ promenad. Berättelsen utvecklas i fyra scener vid distans-milstolpar:

| Distans | Scen |
|--------:|------|
| 0 m | Vägen börjar |
| 333 m | Den första stenen |
| 666 m | Skogens röst |
| 1000 m | Källan |

Du startar appen, stoppar telefonen i fickan, börjar gå. GPS spårar din distans. Vid varje milstolpe spelas nästa scen i lurarna. Inga val att göra än. Bara berättelsen som rullar medan kroppen rör sig.

**Testfråga toyet ska besvara**: är det roligt nog att vilja gå ut igen?

## Lokalt dev

```bash
python3 -m http.server 8080
```

Öppna `http://localhost:8080` i Chrome. För test på Android-telefon utan HTTPS: anslut telefonen till samma WiFi och öppna `http://<din-LAN-IP>:8080`. Geolocation kräver HTTPS *eller* localhost — i LAN funkar det på localhost-undantaget i de flesta webbläsare, men inte alla.

För extern access (Pages eller tunnel): GitHub Pages räcker när repot är publikt. Cloudflared eller ngrok funkar också för dev.

## Rendera om audio

Audio-filerna är pre-renderade via ElevenLabs och committade till repot. Om scen-texten ändras:

```bash
cd scripts
pip install -r requirements.txt
cd ..
python3 scripts/render_audio.py
```

Skriptet är idempotent — bara saknade audiofiler renderas. För att tvinga om-rendering: `rm audio/pilgrimsvagen/scene-N.mp3`.

Kräver `ELEVENLABS_API_KEY` i `~/generalassistant/.env`.

Default-röst: Charlotte (varm narrator-röst, multilingual_v2). Byt `VOICE_ID` i scriptet för att testa andra.

## Struktur

```
.
├── index.html          PWA-skelett
├── main.js             GPS + scen-trigger + audio
├── styles.css          
├── manifest.json       PWA-installerbar
├── service-worker.js   Offline-cache
├── stories/
│   └── pilgrimsvagen/
│       └── scenes.json text + distance-triggers
├── audio/
│   └── pilgrimsvagen/
│       └── scene-{1..4}.mp3
└── scripts/
    ├── render_audio.py TTS via ElevenLabs
    └── requirements.txt
```

## Toy-status

Toy v0 testar **bara** distans-driven scen-trigger med pre-renderad audio. Inget av följande är byggt än — vi bygger när toyet visat sig roligt:

- STT för förgreningsval ("ja"/"nej")
- On-demand LLM för dynamiska grenar (mix scripted + generated)
- Karaktärsbygge / meta-game i hemskärm
- Andra berättelser eller motionsformer (löpning, intervaller, orientering)
- Multi-modal LLM med Street View (immersion i din verkliga gata)
- Multiplayer
- AR

## Stack

- Geolocation API + HTMLAudioElement (toy-räcker, Web Audio kommer för v1)
- Service Worker för offline + installerbar PWA
- Python + ElevenLabs TTS för audio-rendering (engångsjobb)
- Ingen backend än — pre-renderad audio funkar utan server

## Vem gjorde detta

Henric (idé, design, författare på iteration 2+). Demi (programmerare, första utkast på text).
