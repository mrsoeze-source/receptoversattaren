/**
 * Netlify Function: /api/translate  (Groq-version v2 – förbättrad prompt)
 *
 * Groq gratis-lager: ~14 400 anrop/dag, inget kreditkort, inga EU-spärrar.
 * Datacenter i Helsinki – fungerar utmärkt från Sverige.
 *
 * POST body:
 *   { type: "text", content: "..." }
 *   { type: "url",  url: "https://..." }
 *
 * Svar:
 *   { ok: true,  recipe: { ... } }
 *   { ok: false, error: "..." }
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL    = "llama-3.3-70b-versatile";

function sanitize(s) {
  return String(s || "")
    .replace(/\u00b0/g, " degrees")
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00bc/g, "1/4").replace(/\u00bd/g, "1/2").replace(/\u00be/g, "3/4")
    .replace(/[^\x00-\x7f]/g, " ").replace(/ +/g, " ").trim();
}

// ── Systemprompt: roll + köksvokabulär + principer ───────────────────────────
const SYSTEM_PROMPT = `Du är en professionell receptöversättare och kock med lång erfarenhet av svensk matlagning och bakning. Du översätter engelska recept till korrekt, naturlig svenska som låter som om det är skrivet från början på svenska – inte som en ordagrann maskinöversättning.

ÖVERSÄTTNINGSPRINCIPER:
- Skriv naturlig, flytande svenska. Tänk "hur skulle en svensk kokkbok formulera detta?"
- Använd aktiv form: "Blanda mjölet" inte "Mjölet blandas"
- Håll meningarna korta och tydliga i steg-listan
- Bevara receptets ton: om originalet är vardagligt, håll det vardagligt; om det är högtidligt, håll det högtidligt
- Lägg ALDRIG till information som inte finns i originalet

KÖKSVOKABULÄR – använd alltid dessa svenska termer:

Tekniker:
- fold in / fold → vänd ner försiktigt (INTE "vik in")
- sauté → fräs
- simmer → låt sjuda / koka på svag värme
- blanch → skålla (INTE "blanchera" om det kan undvikas)
- whisk → vispa
- beat → vispa / slå
- cream (butter+sugar) → rör smör och socker poröst
- knead → knåda
- proof / rise (dough) → jäs
- rest (meat) → vila / låt vila
- deglaze → häll i och skrapa upp stekskorpan
- reduce → reducera / koka in
- caramelize → karamellisera
- render (fat) → smält ut fettet
- score → skär ett rutnätsmönster / rista
- baste → pensla / ösa
- broil → grilla (i ugnen ovanifrån)
- broiler → grill (ugnens övervärme)
- stir-fry → woka
- deep-fry → fritera
- pan-fry → steka i panna
- braise → brässera / långkoka med lock
- poach → pochera

Ingredienser och utrustning:
- all-purpose flour → vetemjöl (INTE "allsidigt mjöl")
- bread flour → manitobamjöl / vetemjöl special
- powdered sugar / confectioners' sugar → florsocker
- brown sugar → farinsocker (ljust eller mörkt)
- granulated sugar → strösocker
- heavy cream / whipping cream → vispgrädde
- half-and-half → mellangrädde (eller blandning grädde+mjölk)
- buttermilk → kärnmjölk (eller filmjölk)
- sour cream → crème fraîche / gräddfil
- cream cheese → färskost / philadelphiaost
- baking soda → bikarbonat (INTE "bakpulver")
- baking powder → bakpulver (INTE "bikarbonat")
- kosher salt / sea salt → flingsalt / grovt salt
- active dry yeast → torrjäst
- fresh yeast → färsk jäst
- vanilla extract → vaniljextrakt / vaniljessens
- vanilla bean → vaniljstång
- parchment paper / baking paper → bakplåtspapper
- baking sheet → plåt / ugnsplåt
- skillet → stekpanna
- dutch oven → gryta med lock / gjutjärnsgryta
- instant-read thermometer → stektermometer
- stand mixer → hushållsassistent / köksmaskin
- food processor → matberedare
- rubber spatula → slickepott
- wire rack → galler
- offset spatula → vinklad palettkniv
- springform pan → springform
- bundt pan → kransmould
- cast iron → gjutjärn
- stainless steel → rostfritt stål
- nonstick → non-stick / teflon
- zest → rivet skal (citron-/apelsinskal)
- pinch → en nypa (INTE "en klämma")
- dash → ett stänk / en skvätt
- clove (garlic) → klyfta vitlök
- stalk (celery) → stjälk selleri
- bunch → knippe
- handful → en näve

MÅTTOMVANDLINGAR – använd alltid dessa:
1 cup = 2,4 dl  |  3/4 cup = 1,8 dl  |  2/3 cup = 1,6 dl  |  1/2 cup = 1,2 dl  |  1/3 cup = 0,8 dl  |  1/4 cup = 0,6 dl
1 tbsp (matsked) = 1 msk  |  1 tsp (tesked) = 1 tsk  |  1/2 tsp = 1/2 tsk  |  1/4 tsp = en knivsudd
1 stick butter = 115 g  |  1 lb = 450 g  |  1 oz = 28 g  |  1 fl oz = 30 ml
Grader: (F-32)×5/9 avrunda till närmaste 5. 300F=150C  325F=165C  350F=175C  375F=190C  400F=200C  425F=220C  450F=230C  475F=245C
Tider: lämna som minuter, skriv "minuter" (inte "min.")

FORMATREGLER FÖR JSON-SVARET:
- titel: svensk titel, kortfattad, inget "Recept på..." i början
- beskrivning: 1-2 meningar om rätten, inbjudande ton (lämna tomt om originalet saknar)
- meta.portioner: t.ex. "4 portioner" eller "ca 24 kakor"
- meta.totaltid: t.ex. "45 minuter" eller "1 timme 20 minuter"  
- meta.svarighetsgrad: välj ett av: Enkel / Medel / Avancerad
- ingredienser[].grupp: grupprubrik på svenska om originalet har grupper (t.ex. "Fyllning", "Glasyr")
- ingredienser[].mangd: mått + enhet (t.ex. "2,4 dl", "115 g", "1 msk") – TOM sträng om inget mått anges
- ingredienser[].ingrediens: ingrediensnamnet + eventuell beredning (t.ex. "smör, rumstempererat")
- steg: fullständiga meningar, börja varje steg med ett verb i imperativ ("Blanda", "Häll i", "Grädda")
- noteringar: tips, varianter, förvaringsanvisningar – översätt och sammanfatta naturligt

ABSOLUT FÖRBJUDET:
- Lägg ALDRIG till kommentarer, förklaringar eller markdown utanför JSON
- Skriv ALDRIG "Här är JSON:" eller liknande
- Använd ALDRIG engelska ord i den svenska texten om ett bra svenskt alternativ finns
- Skriv ALDRIG "c:a" – använd "ca"
- Skriv ALDRIG "min" för minuter – skriv "minuter"`;

// ── Användarprompt: uppgiften med recept ──────────────────────────────────────
function buildUserPrompt(recipeText) {
  return (
    "Översätt följande recept till svenska enligt dina instruktioner.\n\n" +
    "Svara ENDAST med ett enda JSON-objekt som matchar detta schema exakt " +
    "(inga markdown-tecken, inga inledande ord, bara ren JSON):\n" +
    '{"titel":"","beskrivning":"","meta":{"portioner":"","totaltid":"","svarighetsgrad":"Enkel"},' +
    '"ingredienser":[{"grupp":"","mangd":"","ingrediens":""}],"steg":[""],"noteringar":""}\n\n' +
    "RECEPT ATT ÖVERSÄTTA:\n" +
    recipeText.slice(0, 12000)
  );
}

// ── Hämta webbsida server-side ────────────────────────────────────────────────
async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Receptbot/1.0)",
      "Accept": "text/html,text/plain",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("Kunde inte hämta sidan: HTTP " + res.status);
  const html = await res.text();
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ").trim()
    .slice(0, 15000);
}

// ── JSON-extraktion ───────────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text) throw new Error("Tomt svar.");
  try { return JSON.parse(text.trim()); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error("Inget giltigt JSON i svaret.");
}

// ── Validering och normalisering ──────────────────────────────────────────────
function validateRecipe(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Svaret är inte ett receptobjekt.");
  if (!obj.titel?.trim()) throw new Error("Receptet saknar titel.");
  if (!Array.isArray(obj.ingredienser) || !obj.ingredienser.length) throw new Error("Receptet saknar ingredienser.");
  if (!Array.isArray(obj.steg) || !obj.steg.length) throw new Error("Receptet saknar steg.");
  obj.beskrivning = obj.beskrivning || "";
  obj.meta = obj.meta || {};
  obj.meta.portioner = obj.meta.portioner || "";
  obj.meta.totaltid = obj.meta.totaltid || "";
  obj.meta.svarighetsgrad = obj.meta.svarighetsgrad || "Enkel";
  obj.noteringar = obj.noteringar || "";
  obj.ingredienser = obj.ingredienser.map(i => ({
    grupp: i.grupp || "", mangd: i.mangd || "", ingrediens: i.ingrediens || ""
  }));
  obj.steg = obj.steg.map(s => typeof s === "string" ? s : JSON.stringify(s));
  return obj;
}

// ── Groq API-anrop ────────────────────────────────────────────────────────────
async function callGroq(userPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY saknas i Netlify-miljövariabler.");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.15,   // Låg = mer konsekvent, följer instruktionerna bättre
      max_tokens: 3000,    // Mer utrymme för långa recept
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || "Groq API-fel " + res.status;
    if (res.status === 429) {
      throw new Error("Gratisgränsen nådd tillfälligt. Vänta en minut och försök igen.");
    }
    throw new Error(msg);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Tomt svar från Groq.");
  return text;
}

// ── Netlify-hanterare ─────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };

  const headers = { "Content-Type": "application/json" };

  try {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Ogiltig JSON-body" }) }; }

    const { type, content, url } = body;

    if (type === "text") {
      if (!content || content.trim().length < 20)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Recepttexten är för kort." }) };
      if (content.length > 60000)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Indata för lång (max 60 000 tecken)." }) };
    } else if (type === "url") {
      if (!url || !/^https?:\/\/.+/.test(url))
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Ogiltig URL." }) };
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "type måste vara text eller url" }) };
    }

    let recipeText;
    if (type === "url") {
      recipeText = await fetchPageText(url);
      if (recipeText.length < 100) throw new Error("Sidan verkar tom eller kunde inte läsas.");
    } else {
      recipeText = sanitize(content);
    }

    const responseText = await callGroq(buildUserPrompt(recipeText));
    const recipe = validateRecipe(extractJSON(responseText));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipe }) };

  } catch (err) {
    console.error("[translate-groq-v2]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
