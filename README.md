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

En röst från andra sidan, Vega, som bara hör vandraren när vandraren rör sig. Världen och kopplingen till HELD: `stories/glimt/varld.md`. Kapitel väljs på startskärmen (eller `?kapitel=2`, `?kapitel=episod1`):

| Kapitel | Manus | Vad det gör |
|---|---|---|
| Episod 1. Det är när du går | `stories/glimt/episod-1.md` + `.json` | Ungefär tolv minuter. Vega är arbetare åt Företaget och går sin slinga. Vandrarens steg gömmer henne: står vandraren still blir rösten dov och hennes sida hörs i stället, och rör hon sig då där hon inte får vara tänds lampan. Minns till episod 2 om vandraren stannat på hennes begäran och om lampan tändes när lojalisten kom (`localStorage`, nyckeln `glimt-episod-1`). |
| 1. Det är när du går jag hör dig | `stories/glimt/kapitel-1.md` + `.json` | Ungefär tio minuter. Två varianter: **A** där hon är bunden till vandrarens steg, **B** där hon rör sig fritt men tappar vandraren vid stillhet. |
| 2. Stanna för ja | `stories/glimt/kapitel-2.md` + `.json` | Ungefär tolv minuter. Hon inför en kod: stanna kort för ja, gå vidare för nej. Ber vandraren gå till landmärket från kapitel 1, som telefonen minns (`localStorage`). |

Motorn (`glimt/`):

| Fil | Gör |
|---|---|
| `engine.js` | Tempoband (stilla, gång, löpning över 7 km/h), tempoökning, kontaktmätare, avstånd till start och till ett mål. Ren logik, körs i node. |
| `chapter1.js`, `chapter2.js` | Kapitlen som rak asynkron kod: varje scen väntar på ett villkor med klockan som reserv. Kapitel 2 har frågor med hållscen och svarsfönster. |
| `episod1.js` | Episod 1, samma form. Manusets avsnitt Logiken är regelboken: `her.exposed` säger när hennes egna steg skulle avslöja henne, och `lit` är det enda ställe där ett stopp blir lampan. Reserven (båda stilla en halv minut, snäckan frågar) gäller där hon står eller sitter. |
| `herside.js` | Hennes sida, ljudet som hörs när rösten blir dov: slingans surr, lampans ton och klockan görs i Web Audio; hennes steg, lojalistens steg och handen mot trädet är ljudeffekter klippta i enskilda steg, så att koden bestämmer takten. Snäckans röst går genom ett filter som gör den tunn och ihålig. |
| `audio.js` | Web Audio: bädd i loop, riser, Vegas röst genom lågpassfilter och gain som följer kontakten. |
| `world.js` | Ljus (solhöjd), regn (open-meteo), landmärke inom 400 m med position (Overpass/OSM), alla med fallback. |
| `app.js` | GPS, klocka, wake lock, logg, kapitelval. `?sim` i adressen ersätter GPS med ett fartreglage. |

**Kontakt** är den enda mätaren. Rörelse höjer den, stillhet sänker den (om inte en hållscen pågår), dålig GPS-noggrannhet tar den ner till hälften. Den hörs: vid full kontakt är rösten ren och nära, vid noll är den en dov, avlägsen mumling. Samma inspelning, olika filter.

Simulerad genomkörning av båda kapitlen, fyra vandrarprofiler var, och av episod 1 med femton vandrare som svarar på det hon säger (stannar aldrig, stannar på begäran, stannar självmant, springer, står still genom hennes räkning och så vidare). För episoden kollas vilka grenar som hörs, att lampan bara tänds där den ska, och att det går en halv minut från hennes sista steg till "trettio":

```bash
node scripts/test_glimt.mjs            # allt
node scripts/test_glimt.mjs 2 stubborn # ett kapitel, en profil
node scripts/test_glimt.mjs e1 own     # episod 1, en vandrare
node scripts/test_herside.mjs          # hennes sida: vad som startar, och att allt tystnar
```

Labbens banor, detektorerna och inspelade promenader, och startskärmen i en riktig webbläsare (Playwright, Chromium):

```bash
node scripts/test_lab.mjs              # båda labben, alla gåarprofiler (ett par minuter)
node scripts/test_knocks.mjs           # knack, gungning, motorns surr
node scripts/test_steps.mjs && node scripts/test_recordings.mjs
python3 scripts/test_browser.py        # vibrationsprovet, Hon knackar, testpromenaderna och episod 1, drygt tjugo minuter
python3 scripts/test_browser.py episodstart,episod   # bara episoden: startskärmen, och två vandrare hela vägen
```

Rendera Vegas repliker (v3, en mp3 per replik, hoppar över befintliga):

```bash
python3 scripts/render_glimt.py stories/glimt/kapitel-2.json [--force] [--only s3-1]
```

Episod 1 har fyra röster (`voices` i json-filen, `lineVoices` säger vem som har vilken replik): Vega, den andra rösten, snäckan (Karin, renderad på stabilitet 1,0 för att bli platt) och lojalisten (Elin). Efter en rendering mäts längderna och orden kontrolleras mot manuset med taligenkänning, och ljuden till hennes sida görs och klipps:

```bash
python3 scripts/check_glimt_audio.py stories/glimt/episod-1.json --listen   # längder, ord, och var "trettio" faller
python3 scripts/render_side.py stories/glimt/episod-1.json [--force] [--only grus]
```

Båda skriver tillbaka i json-filen (`seconds`, `cues`, `sfx.*.slices`), och testerna läser därifrån.

Bädd och riser är Splice-samples som Henric har betalat för, och de är tillfälliga: berättelsen ska ha HELD:s musik som bädd (`stories/glimt/varld.md`). De ligger i `audio/glimt/bed/` och `audio/glimt/fx/`, som är gitignorade eftersom råfilerna inte ska ligga öppet i ett publikt repo. Appen fungerar utan dem, rösten spelas ändå.

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
