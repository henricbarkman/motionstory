# PROGRESS — Motionstory

## 2026-09-10
- Henric: vill plocka upp projektet igen. Bytte ElevenLabs-abonnemang (Creator) och bad om ElevenLabs-röst före första fälttestet.
- Demi: `render_audio.py` omskrivet mot ElevenLabs (Louise, `eleven_multilingual_v2`), alla fyra scener omrenderade och verifierade via STT-transkription. Service worker fixad: absoluta sökvägar gjorde att inget cachades på GitHub Pages, cache-namn bumpat till v2 med städning av gamla cachar. Klonen flyttad till `projects/motionstory/`.
- → Nästa: Henric fälttestar Pilgrimsvägen (1 km, lurar, telefon i fickan). Frågan toyet ska besvara: är det roligt nog att vilja gå ut igen? Kolla i praktiken om GPS fortsätter i bakgrunden med släckt skärm.

## 2026-05-30
- Demi: toy v0 byggt och live på https://henricbarkman.github.io/motionstory/ (OpenAI tts-1 eftersom ElevenLabs-krediterna var slut).
- → Nästa: fälttest. Gjordes aldrig.
