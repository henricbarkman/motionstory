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

## Toy v1: Glimt

Live: https://henricbarkman.github.io/motionstory/glimt/

En röst från andra sidan, Vega, som bara hör vandraren när vandraren rör sig. Kapitel 1 är ungefär tio minuter. Manus: `stories/glimt/kapitel-1.md`, maskinläsbart i `kapitel-1.json`. Två varianter väljs på startskärmen: **A** där hon är bunden till vandrarens steg, **B** där hon rör sig fritt men tappar vandraren vid stillhet.

Motorn (`glimt/`):

| Fil | Gör |
|---|---|
| `engine.js` | Tempoband (stilla, gång, löpning över 7 km/h), tempoökning, kontaktmätare, avstånd till start. Ren logik, körs i node. |
| `chapter1.js` | Kapitlet som rak asynkron kod: varje scen väntar på ett villkor med klockan som reserv. |
| `audio.js` | Web Audio: bädd i loop, riser, Vegas röst genom lågpassfilter och gain som följer kontakten. |
| `world.js` | Ljus (solhöjd), regn (open-meteo), landmärke inom 400 m (Overpass/OSM), alla med fallback. |
| `app.js` | GPS, klocka, wake lock, logg. `?sim` i adressen ersätter GPS med ett fartreglage. |

**Kontakt** är den enda mätaren. Rörelse höjer den, stillhet sänker den (om inte en hållscen pågår), dålig GPS-noggrannhet tar den ner till hälften. Den hörs: vid full kontakt är rösten ren och nära, vid noll är den en dov, avlägsen mumling. Samma inspelning, olika filter.

Simulerad genomkörning av hela kapitlet, fyra vandrarprofiler i båda varianterna:

```bash
node scripts/test_glimt.mjs
```

Rendera Vegas repliker (v3, en mp3 per replik, hoppar över befintliga):

```bash
python3 scripts/render_glimt.py stories/glimt/kapitel-1.json [--force] [--only s3-1]
```

Bädd och riser är Splice-samples och ligger i `audio/glimt/bed/` och `audio/glimt/fx/`, som är gitignorade tills licensfrågan för det publika repot är avgjord. Appen fungerar utan dem, rösten spelas ändå.

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

Kräver `ELEVENLABS_API_KEY` i `~/generalassistant/.env`. Tvinga om-rendering av allt med `--force`.

Default-röst: Louise (lugn svensk berättarröst, Stockholm, modell `eleven_multilingual_v2`). Testa en annan röst med `--voice <voice_id>`; svenska alternativ i kontot är "Adam Composer Stockholm" och "Hans O. Karlsson".

Toy v0 (maj 2026) renderades med OpenAI tts-1 eftersom ElevenLabs-krediterna var slut just då. Sedan 2026-09-10 är det ElevenLabs igen.

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
