# PROGRESS — Motionstory

## 2026-09-12
- Henric: riktning vald för toy v1. **Semi-parallell dimension** (samma värld, fast inte; Upside Down som referens men magisk realism, inte fantasy). **Perspektiv: Glimt-rösten**, en person på andra sidan som inte syns men ser glimtar av vad vandraren ser, och som själv bara hamnat där. "Platsen själv" och "Tjuvlyssnandet" som sidoelement. Ton: mystik och äventyr med inslag av skräck, skräcken inte dominerande. Senare i storyn råkar hon ut för något och vandraren måste hjälpa henne.
- Demi: designprincip som bär allt: **du ser den här världen, du hör den andra.** Berättelsen beskriver aldrig det vandraren ser, bara det hen hör. Osäker data (kartunderlag, dålig GPS) blir rösten som ser fel eller tappar kontakten, alltså karaktär i stället för bugg. Röstens säkerhet ska följa datans säkerhet.
- Henric, senare samma dag: beteckning **vandraren**. Mekanik-prio fastslagen: tempo-band, tempoförändring, mörker, väder, gång/löpning, historik (1-6) byggs först. Sväng, platstyp och landmärken (8-10) behålls, osäkerheten är fiktion ("ser du en korsning? ta vänster"). **Knack på telefonen (7) hoppas över.** Ingen hörlursknapp som krav. Två varianter av "den andra" testas: bunden till vandrarens rörelser (A) och fri (B). Splice-samples finns för Platsen-lagret, Henric vill göra ljudet själv. Kapitel 1 kortare (12-15 min), senare 20-25. Både gång och löpning i v1.
- Demi: första utkast av kapitel 1 skrivet i båda varianterna: `stories/glimt/kapitel-1.md`. Åtta scener på villkor, "Vera" som platshållarnamn, ett medvetet opålitligt påstående (vattnet) i scen 6.
- Henric, eftermiddag: manuset duger för v1. Namn: **Vega** (ersätter Vera). Kapitlet kortat till ~10 min så tomrummet krymper. Scen 6 fick landmärkesvarianter (vatten, skog, berg, bro, kyrkogård; först misstolkat som de fyra elementen, rättat samma dag). "Hem" blev "tillbaka", läst ur avståndet till startpunkten. Skickade en Splice-loop (MA_SWM_95 Atmosphere Loop Steep Dm, 20 s, -18 LUFS, sömlös) som bädd.
- Demi: utkast 2 committat. Loopen konverterad till `audio/glimt/bed/steep-dm.opus` men **gitignorad** tills licensfrågan (publikt repo) är avgjord. Fyra röstprov för Vega renderade på v3 med kvinnliga svenska röster utan stockholmska, sida: `rostprov/`.
- Henric: föreslog röst `87k5z55REKK0AXyOShss` (en av Demi-rösterna i kontot) för Vega, och skickade en noise-riser (Sunbeams, 11,3 s) att lägga före första repliken, rösten in vid ca 70 % av risern.
- Demi: rösten renderad på v3 (`rostprov/demi2.mp3`), intro-demo komponerad (bädd in, riser, Vega vid 7,9 s: `rostprov/intro-demi2.mp3`). Risern konverterad till `audio/glimt/fx/`, hela `audio/glimt/` gitignorad tills licensfrågan är avgjord.
- Henric: "Låter jättebra! Wow." Rösten `87k5z55REKK0AXyOShss` går som förval för Vega.
- Demi: **toy v1 byggt**, `glimt/`. Manus i JSON, alla 33 repliker renderade på v3 (4 851 tecken). Motorn i fyra moduler: `engine.js` (tempoband, tempoökning, kontakt, avstånd till start), `chapter1.js` (kapitlet som rak asynkron kod med villkor och klockreserv), `audio.js` (Web Audio: bädd, riser, röst genom lågpass och gain som följer kontakten), `world.js` (solhöjd, open-meteo, Overpass). Simulerad genomkörning i node med fyra vandrarprofiler (idealisk, envis, löpare, dimma) i båda varianterna: alla åtta går genom scen 0–7 i rätt ordning. Två fynd ur simuleringen fixade: kort stopp missades av fartutjämningen (fönster 8 s → 4 s), och dålig GPS nollade tempot i stället för att bara sänka kontakten. Browserkörning i simläge: scen 1 vid 0:45, open-meteo svarar, overpass-api.de gav 504 så en andra spegel lades till.
- Kvar öppet: Splice-filerna (bädd, riser) är fortfarande gitignorade, så **Pages-versionen spelar bara rösten** tills Henric bestämt hosting. Vegas repliker committas (våra egna).
- → Nästa: Henric fälttestar Glimt kapitel 1 i variant A och B, gång och löpning. Loggen på slutskärmen kan kopieras och klistras in här. Frågor testet ska svara på: känns kontakten i stället för att synas, fungerar hållscenen, lurar landmärket.

## 2026-09-11
- Henric: fälttestade Pilgrimsvägen. Upplevelsen var **meditativ**, inte vad han var ute efter, men han ser att grundidén kan ge olika sorters upplevelser. Tre konkreta fynd:
  1. **Glesheten.** Ungefär 40 sekunder ljud var femte minut. Kändes som en meditativ ljudbok med långa hål.
  2. **Ingen krok.** Inget som drog honom framåt till nästa scen.
  3. **Blev inte lurad.** Berättaren sa grus, han gick på asfalt. Texten påstår saker om platsen som den inte kan veta, så varje lyssnare utanför den tänkta skogen hör att den ljuger.
- Demi: tolkning. Fynd 1 till 3 är nästan helt manus och tempo, inte motorn. Men motorn har en egen lucka: kroppen styrde ingenting utom takten scenerna låstes upp i. Toyet var i praktiken en ljudbok på distanstimer, alltså testades aldrig kärnloopen "motionen som del av berättelsens utveckling". Meditativt är dessutom exakt vad pilgrimsgenren valdes för i maj, så det resultatet säger mer om genrevalet än om idén.
- Pausat: röstprov för v3 (script `scripts/render_voice_samples.py` och sida `rostprov/` skrivna, ej renderade, ej committade). Henrics önskan om "mer radioteater, inte stockholmska" pekar åt samma håll som fynden: drama, inte meditation.
- → Nästa: Henric väljer riktning för toy v1 (vilken upplevelse var han ute efter). Sedan en ny runda som testar en sak i taget.

## 2026-09-10
- Henric: vill plocka upp projektet igen. Bytte ElevenLabs-abonnemang (Creator) och bad om ElevenLabs-röst före första fälttestet.
- Demi: `render_audio.py` omskrivet mot ElevenLabs (Louise, `eleven_multilingual_v2`), alla fyra scener omrenderade och verifierade via STT-transkription. Service worker fixad: absoluta sökvägar gjorde att inget cachades på GitHub Pages, cache-namn bumpat till v2 med städning av gamla cachar. Klonen flyttad till `projects/motionstory/`.
- → Nästa: Henric fälttestar Pilgrimsvägen (1 km, lurar, telefon i fickan). Frågan toyet ska besvara: är det roligt nog att vilja gå ut igen? Kolla i praktiken om GPS fortsätter i bakgrunden med släckt skärm.

## 2026-05-30
- Demi: toy v0 byggt och live på https://henricbarkman.github.io/motionstory/ (OpenAI tts-1 eftersom ElevenLabs-krediterna var slut).
- → Nästa: fälttest. Gjordes aldrig.
