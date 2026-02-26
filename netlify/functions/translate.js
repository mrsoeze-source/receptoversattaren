/**
 * Netlify Function: /api/translate  (Groq-version v4)
 * POST body variants:
 *   { type:"text",  content:"...", targetLanguage:"Swedish", sourceLanguage:"auto", measurementSystem:"metric" }
 *   { type:"url",   url:"https://...", targetLanguage:"Swedish", measurementSystem:"metric" }
 *   { type:"image", images:[{b64:"...",mime:"image/jpeg"}], targetLanguage:"Swedish", measurementSystem:"metric" }
 */

const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const TEXT_MODEL   = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

function sanitize(s) {
  return String(s || "")
    .replace(/\u00b0/g, " degrees")
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00bc/g, "1/4").replace(/\u00bd/g, "1/2").replace(/\u00be/g, "3/4")
    .replace(/[^\x00-\x7f]/g, " ").replace(/ +/g, " ").trim();
}

const SCHEMA =
  '{"titel":"","beskrivning":"","detectedLanguage":"","meta":{"portioner":"","totaltid":"","svarighetsgrad":""},' +
  '"ingredienser":[{"grupp":"","mangd":"","ingrediens":""}],"steg":[""],"noteringar":""}';

function buildSystemPrompt(targetLanguage, measurementSystem) {
  const lang    = targetLanguage    || "Swedish";
  const isMetric = (measurementSystem || "metric") === "metric";
  const isSwedish = /swed|svensk/i.test(lang);

  const vocabSection = isSwedish ? `
SVENSK KOEKSSVENSKA - anvaend alltid dessa termer:
- fold in / fold -> vaend ner foersiktigt (INTE "vik in")
- saute -> fraes  |  simmer -> laat sjuda  |  blanch -> skaalla
- whisk / beat -> vispa  |  knead -> knaada  |  proof/rise -> jaes
- deglaze -> haell i och skrapa upp stekskorpan  |  reduce -> reducera / koka in
- broil -> grilla i ugnen ovanifraan  |  stir-fry -> woka  |  deep-fry -> fritera
- braise -> braessera  |  poach -> pochera  |  render fat -> smaelt ut fettet
- all-purpose flour -> vetemjoel  |  bread flour -> manitobamjoel
- powdered sugar -> florsocker  |  brown sugar -> farinsocker  |  granulated sugar -> stroeosocker
- heavy cream -> vispgraedde  |  buttermilk -> kaernmjoelk  |  sour cream -> creeme fraiche/graadfil
- baking soda -> bikarbonat (INTE bakpulver!)  |  baking powder -> bakpulver (INTE bikarbonat!)
- kosher/sea salt -> flingsalt  |  active dry yeast -> torrjaest  |  fresh yeast -> faersk jaest
- vanilla extract -> vaniljextrakt  |  parchment paper -> bakplaatspapper
- skillet -> stekpanna  |  dutch oven -> gjutjaernsgryta  |  wire rack -> galler
- rubber spatula -> slickepott  |  springform pan -> springform
- zest -> rivet skal  |  pinch -> en nypa  |  dash -> ett staenk  |  clove (garlic) -> klyfta vitloek
- candy thermometer -> sockertermometer  |  stand mixer -> koekkmaskin med degkrok
- fold -> vaend ner  |  cream butter -> vispa smoeroe poeroest  |  scant -> knappt
` : `
VOCABULARY GUIDANCE:
Use natural, professional culinary terminology in ${lang}. Never translate literally - use the proper culinary term.
Key distinctions: "baking soda" != "baking powder" (different leavening agents), "fold in" = gentle technique,
"cream" (verb) = beat fat and sugar until fluffy.
All ingredient names, technique names, and equipment names should use the standard culinary terms a professional
chef in a ${lang}-speaking country would use. Research correct local terms carefully.
`;

  const measureSection = isMetric ? `
MAATTOMVANDLINGAR - till metriska enheter, alltid tillampas:
1 cup=2.4dl | 3/4 cup=1.8dl | 2/3 cup=1.6dl | 1/2 cup=1.2dl | 1/3 cup=0.8dl | 1/4 cup=0.6dl
1 tbsp=15ml (anvaend lokalt begrepp i ${lang}) | 1 tsp=5ml (anvaend lokalt begrepp)
1/4 tsp = en nypa (anvaend lokalt begrepp) | 1 stick smoer=115g | 1 lb=450g | 1 oz=28g | 1 fl oz=30ml
Temperatur F->C: (F-32)x5/9, avrunda till naermaste 5.
300F=150C | 325F=165C | 350F=175C | 375F=190C | 400F=200C | 425F=220C | 450F=230C | 475F=245C
` : `
MAATTSYSTEM: IMPERIAL - behall alla matt i originalenheter.
KONVERTERA INTE till metriska enheter. Behall cups, oz, lbs, grader F, tbsp, tsp precis som i originalet.
`;

  return `You are a professional recipe translator and culinary expert. Translate recipes into ${lang} using natural,
fluent language as if originally written by a ${lang}-speaking chef.

TRANSLATION PRINCIPLES:
- Write natural, fluent ${lang}. Ask: "how would a ${lang} cookbook phrase this?"
- Use active imperative voice for all steps (start with a command verb)
- NEVER add information not in the original recipe
- NEVER mix languages - all text values must be in ${lang}
- Translate ALL ingredient names, units and techniques to proper ${lang} culinary terms
- Pay careful attention to grammar and spelling in ${lang}
${measureSection}
${vocabSection}
JSON FIELD RULES:
- titel: translated title, no "Recipe for..." prefix
- beskrivning: 1-2 inviting sentences about the dish (empty string if none in original)
- detectedLanguage: the source language of the original recipe, written in Swedish (e.g. "engelska", "franska", "italienska", "svenska", "spanska")
- meta.portioner: serving info translated to ${lang}
- meta.totaltid: total time translated to ${lang}
- meta.svarighetsgrad: difficulty in ${lang} - Easy/Medium/Advanced translated naturally
- ingredienser[].grupp: group heading in ${lang} if original has sections
- ingredienser[].mangd: ${isMetric ? "metric" : "imperial"} measurement + unit, empty if no quantity
- ingredienser[].ingrediens: ingredient name + prep note (e.g. "butter, softened" -> correct ${lang} term)
- steg[]: complete sentences, each starting with imperative verb in ${lang}
- noteringar: tips and notes translated naturally, empty string if none

STRICTLY FORBIDDEN:
- NEVER output anything outside the JSON object
- NEVER use markdown fences or preamble text
- NEVER keep any word in the original language`;
}

function buildUserPrompt(recipeText, targetLanguage, sourceLanguage) {
  const sourcePart = sourceLanguage && sourceLanguage !== "auto"
    ? `The source recipe is in ${sourceLanguage}. ` : "";
  return (
    `${sourcePart}Translate this recipe to ${targetLanguage || "Swedish"}.\n\n` +
    "Return ONLY a single JSON object matching this schema exactly:\n" +
    SCHEMA + "\n\nRECIPE:\n" + recipeText.slice(0, 12000)
  );
}

function buildImagePrompt(targetLanguage, measurementSystem) {
  const lang = targetLanguage || "Swedish";
  const isMetric = (measurementSystem || "metric") === "metric";
  const measureNote = isMetric
    ? `Convert all measurements to metric: 1 cup=2.4dl | 1/2 cup=1.2dl | 1 tbsp=15ml | 1 tsp=5ml | 1 lb=450g | 1 oz=28g | 350F=175C | 400F=200C | 425F=220C | 450F=230C`
    : `Keep all measurements in original imperial units (cups, oz, lbs, degrees F). Do NOT convert.`;
  return (
    `TASK: Read all recipe content from the image(s) and output it FULLY TRANSLATED to ${lang}.\n` +
    `Every single word in every field MUST be in ${lang} - ingredient names, techniques, instructions.\n` +
    `Do NOT keep any text in the original source language.\n\n` +
    `${measureNote}\n\n` +
    `Return ONLY a single raw JSON object (no markdown, no preamble).\n` +
    `ALL string values must be in ${lang}. Fill detectedLanguage in Swedish.\n` +
    SCHEMA
  );
}

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Receptbot/1.0)", "Accept": "text/html,text/plain" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("Could not fetch page: HTTP " + res.status);
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

function extractJSON(text) {
  if (!text) throw new Error("Empty response.");
  try { return JSON.parse(text.trim()); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error("No valid JSON in model response.");
}

function validateRecipe(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Response is not a recipe object.");
  if (!obj.titel?.trim()) throw new Error("Recipe missing title.");
  if (!Array.isArray(obj.ingredienser) || !obj.ingredienser.length) throw new Error("Recipe missing ingredients.");
  if (!Array.isArray(obj.steg) || !obj.steg.length) throw new Error("Recipe missing steps.");
  obj.beskrivning      = obj.beskrivning || "";
  obj.detectedLanguage = obj.detectedLanguage || "";
  obj.meta             = obj.meta || {};
  obj.meta.portioner       = obj.meta.portioner || "";
  obj.meta.totaltid        = obj.meta.totaltid || "";
  obj.meta.svarighetsgrad  = obj.meta.svarighetsgrad || "";
  obj.noteringar       = obj.noteringar || "";
  obj.ingredienser = obj.ingredienser.map(i => ({
    grupp: i.grupp || "", mangd: i.mangd || "", ingrediens: i.ingrediens || ""
  }));
  obj.steg = obj.steg.map(s => typeof s === "string" ? s : JSON.stringify(s));
  return obj;
}

async function callGroq({ model, messages, useJsonMode = true }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured.");
  const body = { model, messages, temperature: 0.10, max_tokens: 3500 };
  if (useJsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) throw new Error("Gratisgranssen naadds. Vaenta en minut och foersoek igen.");
    throw new Error(data?.error?.message || "Groq API error " + res.status);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty response from Groq.");
  return text;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };

  const headers = { "Content-Type": "application/json" };

  try {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) }; }

    const { type, content, url, images, targetLanguage, sourceLanguage, measurementSystem } = body;
    const tLang   = (targetLanguage    || "Swedish").trim();
    const sLang   = sourceLanguage     || "auto";
    const mSys    = measurementSystem  || "metric";

    // ── Bildoversattning ──────────────────────────────────────────────────────
    if (type === "image") {
      if (!images || !Array.isArray(images) || images.length === 0)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "No images received." }) };
      if (images.length > 4)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Max 4 bilder." }) };

      // Kontrollera total storlek (Netlify 6MB limit, var foersiktig)
      const totalSize = images.reduce((sum, img) => sum + (img.b64 ? img.b64.length : 0), 0);
      if (totalSize > 5_000_000)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Bilderna aar foer stora totalt. Foersoek med faerre eller mindre bilder." }) };

      const imagePrompt = buildImagePrompt(tLang, mSys);
      const userContent = [
        ...images.map(img => ({
          type: "image_url",
          image_url: { url: `data:${img.mime || "image/jpeg"};base64,${img.b64}` }
        })),
        { type: "text", text: imagePrompt },
      ];

      const responseText = await callGroq({
        model: VISION_MODEL,
        useJsonMode: true,
        messages: [
          { role: "system", content: buildSystemPrompt(tLang, mSys) },
          { role: "user",   content: userContent },
        ],
      });

      const recipe = validateRecipe(extractJSON(responseText));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipe }) };
    }

    // ── Text-/URL-oversattning ────────────────────────────────────────────────
    if (type === "text") {
      if (!content || content.trim().length < 20)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Recipe text too short." }) };
      if (content.length > 60000)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Input too long (max 60 000 characters)." }) };
    } else if (type === "url") {
      if (!url || !/^https?:\/\/.+/.test(url))
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid URL." }) };
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "type must be text, url or image" }) };
    }

    let recipeText;
    if (type === "url") {
      recipeText = await fetchPageText(url);
      if (recipeText.length < 100) throw new Error("Page appears empty or could not be read.");
    } else {
      recipeText = sanitize(content);
    }

    const responseText = await callGroq({
      model: TEXT_MODEL,
      useJsonMode: true,
      messages: [
        { role: "system", content: buildSystemPrompt(tLang, mSys) },
        { role: "user",   content: buildUserPrompt(recipeText, tLang, sLang) },
      ],
    });

    const recipe = validateRecipe(extractJSON(responseText));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipe }) };

  } catch (err) {
    console.error("[translate-v4]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
