# Glimt, kapitel 2: Stanna för ja

Utkast 1, 2026-09-14. Relationens andra steg: **förtroendet.** Hon hittar ett sätt att få svar, och ber för första gången om något som inte handlar om att överleva. Skrivet i variant A (bunden). Variant B skrivs när utomhustestet av kapitel 1 sagt sitt.

Stil som kapitel 1: nära och talspråklig, en dålig telefonlinje. En regel från andra sidan i hela kapitlet, i scen 4. Tonen är lättare än kapitel 1: hon har haft en idé, och det gör henne nästan glad.

Riktlängd: **cirka tolv minuter.** Kapitlet vill ha en destination, så det är någon minut längre.

**Kapitlets mekanik:** vandraren kan bara svara med kroppen. Vega inför en kod: *stanna en gång för ja, fortsätt gå för nej.* Varje fråga är en hållscen (kontaktförlusten pausas i tjugo sekunder medan svaret väntas in). Ett stopp inom fönstret är ja. Inget stopp är nej. Det är samma stoppdetektion som i kapitel 1, bara med en mening.

**Landmärket** är det som valdes i kapitel 1 (vatten, skog, berg, bro, kyrkogård), sparat mellan kapitlen. Med kartdata vet appen var det ligger och kan mäta avståndet dit. Utan kartdata ber hon vandraren välja en plats själv och stanna där.

Den maskinläsbara versionen med rösttaggar blir `kapitel-2.json` när utkastet är godkänt.

---

## 0. Start
*Trigger: startknappen. Kontakten börjar lågt och bygger upp.*

> (brus, sedan hennes röst, närmare än förra gången)
>
> ...ja. Ja, det är du. Jag känner igen... nej, det kan jag ju inte. Steg låter som steg.
>
> Men det är du. Jag bestämmer att det är du.
>
> Gå på bara. Jag har haft en idé. Jag har tänkt på den hela tiden sen sist, och det är länge. Jag vet inte hur länge. Men länge.

## 1. Koden
*Trigger: kontakten stark första gången. Hållscen: hon väntar på svar i femton sekunder.*

> Så. Hör på nu.
>
> Jag hör dina steg. Bara dem. Du kan inte prata med mig, och om du gör det så hör jag det inte. Men du kan stanna. Det hör jag. Det hör jag så tydligt att det gör ont.
>
> Så vi gör så här. Stanna en gång för ja. Fortsätt gå för nej. Kort stopp, inte längre. Jag vill inte tappa dig.
>
> Okej. Första frågan. Hör du mig?
>
> (väntar)
>
> **Ja (stopp):** Ja! Ja. Okej. Okej, jag... vänta. Gå igen, gå igen. Det funkar. Det funkar!
>
> **Nej (inget stopp):** Nej? Eller så förstod du inte. Vi provar igen. Stanna nu om du hör mig. Bara ett steg.
>
> (väntar igen, sedan oavsett)
>
> Jag tar det som ett ja. Jag måste.

## 2. Kontrollfrågan
*Trigger: kontakten stark, runt minut tre. Hon testar koden mot något hon redan vet. Hållscen.*

> Nu en fråga som jag redan vet svaret på. Bara för att se att koden håller.
>
> [ljust] Det är ljust hos dig. Stanna om det stämmer.
> [mörkt] Det är mörkt hos dig. Stanna om det stämmer.
>
> (väntar)
>
> **Ja:** Där. Då litar jag på det. Då litar jag på dig.
>
> **Nej:** Du stannade inte. Antingen ljuger ljuset för mig, eller så... nej. Det stämmer. Jag vet att det stämmer. Du kanske inte ville stanna just där. Vi går vidare.

## 3. Frågan hon inte behöver ställa
*Trigger: kontakten stark, runt minut fyra och en halv. Hållscen.*

> En till. Sen slutar jag, jag lovar. Eller, jag slutar inte, men jag tar paus.
>
> Är du ensam?
>
> (väntar)
>
> **Ja:** Jag också. Alltså, det visste du. Men jag ville höra dig säga det. Fast du sa ingenting. Du vet vad jag menar.
>
> **Nej:** Någon är med dig. Okej. Säg... nej, du kan inte säga. Hälsa. Nej, gör inte det, det låter galet. Gå bara.

## 4. Dit
*Trigger: kontakten stark, runt minut sex. Landmärkesvarianten från kapitel 1.*

> Det jag sa förra gången. Om [vattnet / skogen / höjden / bron / kyrkogården]. Att du inte skulle gå dit.
>
> Jag har ändrat mig. Gå dit. Om du kan, om det inte är för långt. Jag vill veta om [det / den] finns.
>
> Här finns [det / den]. Jag går förbi varje dag. Men jag tror inte att [det / den] är... jag tror att någon har ritat [det / den]. Att allt här är ritat efter något som finns hos dig.
>
> [quietly] Det som är ritat kan suddas. Det som finns kan inte det.
>
> Så gå dit. Jag följer med. Det är ju det enda jag kan.

**Utan kartdata:**
> Jag vet inte var det ligger hos dig. Välj något själv. Något som du tror finns här också. Gå dit och stanna när du är framme.

## 5. På väg
*Trigger: avståndet till landmärket krymper stadigt (eller, utan kartdata, en och en halv minut efter scen 4). Kort.*

> Du går åt ett håll nu. Bestämt. Jag hör det.
>
> Jag går också. Samma håll, tror jag. Jag vet inte, jag ser bara det jag brukar se. Men det låter annorlunda när du har ett mål.

## 6. Framme
*Trigger: vandraren inom 50 meter från landmärket, eller ett stopp längre än tio sekunder efter scen 5 utan kartdata. Hållscen, med längre fönster: tjugo sekunder.*

**[vatten]**
> Är du framme? Stanna om det är vatten framför dig. Riktigt vatten.
>
> **Ja:** [quietly] Då finns det. Här är det bara... blankt. Det rör sig inte. Jag har kastat en sten i det en gång och den försvann utan ljud. Men hos dig finns det. Då är det inte bara ritat.
>
> **Nej:** Inte vatten. Okej. Så det jag ser här kanske är påhittat helt. Det är... jag vet inte om det är värre eller bättre.

**[skog]**
> Är du framme? Stanna om det är träd runt dig. Riktiga.
>
> **Ja:** [quietly] Då finns de. Här rör de sig på samma sätt varje gång. Jag har räknat. Men hos dig finns de. Då är det inte bara ritat.
>
> **Nej:** Inga träd. Så det här är... jag vet inte vad det här är då.

**[berg]**
> Är du framme? Stanna om du står högre än du gjorde nyss.
>
> **Ja:** [quietly] Då finns den. Här går man upp och kommer ingenstans, det blir inte högre, det bara känns så. Men hos dig finns den. Då är det inte bara ritat.
>
> **Nej:** Ingen höjd. Då är den här bara min. Det är okej. Jag tror det.

**[bro]**
> Är du framme? Stanna om det är vatten under bron.
>
> **Ja:** [quietly] Då finns det! Här går den över ingenting. Men hos dig går den över vatten. Då är det inte bara ritat. Då är det riktigt någonstans.
>
> **Nej:** Inget vatten. Så det är ingenting där heller. Okej. Då är vi lika, du och jag. Lite i alla fall.

**[kyrkogård]**
> Är du framme? Stanna om det finns namn där. På stenarna.
>
> **Ja:** [quietly] Då finns de. Här är stenarna tomma. Jag har tittat på varenda en. Men hos dig står det namn. Då är det inte bara ritat. Då har någon funnits.
>
> **Nej:** Inga namn. Så det är... tomt hos dig också. Vi går. Vi går härifrån.

## 7. Spring
*Trigger: vandrarens första tempoökning efter scen 6, eller så ber hon om den två minuter efter scen 6.*

> En sak till. Det är inte en fråga.
>
> Kan du springa? Bara lite. Bara så att jag... när du sprang förra gången så sprang jag också, och det var första gången på jag vet inte hur länge som mina ben gjorde något som jag ville. Fast det var ju du som ville. Men jag ville också.
>
> (vid ökning) [relieved] Ja! Ja, där. Det... det är som att någon lånar ut sig själv. Okej. Okej. Sakta ner när du vill, jag hänger med. Alltså, jag har ju inget val, men jag hade hängt med ändå.
>
> (ingen ökning) Det är okej. Det var mycket begärt. Vi går. Att gå är också något.

## 8. Det hon inte sa
*Trigger: kontakten stark, runt minut nio och en halv. Efter löpningen, före hemvägen.*

> Jag ska säga en sak, och sen pratar vi inte om den.
>
> Efter förra gången, när du sprang. Någon kom och tittade på mig. Inte sa något. Bara tittade. Jag tror att de märker när jag inte går som jag ska.
>
> Så jag kanske inte ber dig springa varje gång. Men ibland. Ibland är det värt det.
>
> Okej. Nu pratar vi inte om det.

## 9. Tillbaka
*Trigger: avståndet till startpunkten krymper stadigt och är under ungefär 300 meter, eller minut tolv, eller ett stopp längre än 30 sekunder efter minut elva. Kapitlets sista fråga. Vandrarens eget slutstopp är svaret.*

> Du är på väg tillbaka. Jag hör det. Det låter som förra gången, fast lugnare.
>
> Sista frågan. Och den här gången får stoppet vara långt.
>
> Kommer du tillbaka?
>
> (vandraren stannar, rösten tonar bort)
>
> (mycket svagt, nästan borta, och hon skrattar)
>
> Ja. Jag hörde det.
>
> (tystnad, sedan en annan röst från andra sidan, viskande:)
>
> ...hon frågade.

---

## Vad kapitlet testar

| Scen | Mekanik |
|---|---|
| 1 | Stopp som svar. Hållscen med femton sekunders fönster. |
| 2 | Koden verifierad mot något appen vet (ljus). Förtroendet byggs som i dagboken: kontrollera först. |
| 3 | En fråga utan rätt svar. Bara relation. |
| 4 | Landmärket från kapitel 1 sparat mellan kapitlen. Kapitlets enda regelrad. |
| 5 | Avstånd till landmärket krymper (nytt i motorn, samma form som "tillbaka"). |
| 6 | Framme, med längre svarsfönster. Replikan mot originalet, i hennes ord. |
| 7 | Tempoökning som något hon ber om för sin egen skull. Lättare ton. |
| 8 | Kostnaden antyds. Fröet till kapitel 3. |
| 9 | Slutstoppet är ett ja. Följeslagaren hör att hon frågade. |

## Vad motorn behöver som inte finns

- Landmärkets koordinater sparade från kapitel 1 (localStorage), och avstånd till det i stället för till start.
- Hållscen med svarsfönster: `until(stopped, { timeout })` finns redan; det som saknas är att ett stopp inom fönstret inte ska räknas som "vandraren stannade" i kontaktmätaren. Kapitel 1:s hållmekanik pausar redan förlusten, så det är troligen bara att använda den.
- Ja- och nej-grenar per fråga. Rak kod i `chapter2.js`, samma form som kapitel 1.
