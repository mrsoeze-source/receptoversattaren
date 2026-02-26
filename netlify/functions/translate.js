/**
 * Netlify Function: /api/translate  (Groq-version v3 – multispråk + bildstöd)
 *
 * Groq gratis-lager: ~14 400 anrop/dag, inget kreditkort, inga EU-spärrar.
 *
 * POST body:
 *   { type: "text",  content: "...", targetLanguage: "Swedish", sourceLanguage: "auto" }
 *   { type: "url",   url: "https://...", targetLanguage: "Swedish" }
 *   { type: "image", image: "<base64>",  targetLanguage: "Swedish" }
 *
 * Svar:
 *   { ok: true,  recipe: { ... } }
 *   { ok: false, error: "..." }
 */

const GROQ_URL    = "https://api.groq.com/openai/v1/chat/completions";
const TEXT_MODEL  = "llama-3.3-70b-versatile";          // Text och URL
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"; // Bilder

// ── Sanering ──────────────────────────────────────────────────────────────────
function sanitize(s) {
  return String(s || "")
    .replace(/\u00b0/g, " degrees")
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00bc/g, "1/4").replace(/\u00bd/g, "1/2").replace(/\u00be/g, "3/4")
    .replace(/[^\x00-\x7f]/g, " ").replace(/ +/g, " ").trim();
}

// ── JSON-schema för receptsvar ────────────────────────────────────────────────
const SCHEMA =
  '{"titel":"","beskrivning":"","meta":{"portioner":"","totaltid":"","svarighetsgrad":""},' +
  '"ingredienser":[{"grupp":"","mangd":"","ingrediens":""}],"steg":[""],"noteringar":""}';

// ── Systemprompt (anpassad efter målspråk) ────────────────────────────────────
function buildSystemPrompt(targetLanguage) {
  const lang = targetLanguage || "Swedish";

  const isSwedish = /swed|svensk/i.test(lang);

  const vocabSection = isSwedish ? `
SVENSK KÖKSSVENSKA – använd alltid dessa termer:
- fold in / fold → vänd ner försiktigt (INTE "vik in")
- sauté → fräs  |  simmer → låt sjuda  |  blanch → skålla
- whisk / beat → vispa  |  knead → knåda  |  proof/rise → jäs
- deglaze → häll i och skrapa upp stekskorpan  |  reduce → reducera / koka in
- broil → grilla i ugnen ovanifrån  |  stir-fry → woka  |  deep-fry → fritera
- braise → brässera  |  poach → pochera  |  render fat → smält ut fettet
- all-purpose flour → vetemjöl  |  bread flour → manitobamjöl
- powdered sugar → florsocker  |  brown sugar → farinsocker  |  granulated sugar → strösocker
- heavy cream → vispgrädde  |  buttermilk → kärnmjölk  |  sour cream → crème fraîche/gräddfil
- baking soda → bikarbonat (INTE bakpulver!)  |  baking powder → bakpulver (INTE bikarbonat!)
- kosher/sea salt → flingsalt  |  active dry yeast → torrjäst  |  fresh yeast → färsk jäst
- vanilla extract → vaniljextrakt  |  parchment paper → bakplåtspapper
- skillet → stekpanna  |  dutch oven → gjutjärnsgryta  |  wire rack → galler
- rubber spatula → slickepott  |  springform pan → springform
- zest → rivet skal  |  pinch → en nypa  |  dash → ett stänk  |  clove (garlic) → klyfta vitlök
` : `
VOCABULARY GUIDANCE:
Use natural, professional culinary terminology in ${lang}. Never translate literally — use the proper culinary term.
Key distinctions to get right: "baking soda" ≠ "baking powder" (different leavening agents), "fold in" = gentle technique (not literal folding), "cream" (verb) = beat fat and sugar until fluffy.
All ingredient names, technique names, and equipment names should use the standard culinary terms a professional chef in a ${lang}-speaking country would use.
`;

  return `You are a professional recipe translator and chef with expertise in culinary traditions worldwide. You translate recipes into ${lang} using natural, fluent language — as if the recipe was originally written in ${lang}, not translated.

TRANSLATION PRINCIPLES:
- Write natural, fluent ${lang}. Ask: "how would a ${lang} cookbook phrase this?"
- Use active imperative voice for steps: Start each step with a command verb
- Keep steps concise and clear
- Preserve the original tone (casual stays casual, refined stays refined)
- NEVER add information not in the original

MEASUREMENT CONVERSIONS – always apply:
1 cup=2.4dl | 3/4 cup=1.8dl | 2/3 cup=1.6dl | 1/2 cup=1.2dl | 1/3 cup=0.8dl | 1/4 cup=0.6dl
1 tbsp=1 tablespoon (use local term in ${lang}) | 1 tsp=1 teaspoon (use local term)
1/4 tsp=a pinch (use local term) | 1 stick butter=115g | 1 lb=450g | 1 oz=28g | 1 fl oz=30ml
Temperature F→C: (F-32)×5/9, round to nearest 5.
300F=150C | 325F=165C | 350F=175C | 375F=190C | 400F=200C | 425F=220C | 450F=230C | 475F=245C
${vocabSection}
JSON FORMAT RULES:
- titel: translated title, no "Recipe for..." prefix
- beskrivning: 1-2 inviting sentences about the dish (empty string if original has none)
- meta.portioner: serving info in ${lang}, e.g. "4 portions" in ${lang}
- meta.totaltid: total time in ${lang}, e.g. "45 minutes" in ${lang}
- meta.svarighetsgrad: difficulty in ${lang} — choose one of: Easy / Medium / Advanced (translated to ${lang})
- ingredienser[].grupp: group heading in ${lang} if original has groups (e.g. "Filling", "Glaze")
- ingredienser[].mangd: metric measurement + unit, empty string if no quantity
- ingredienser[].ingrediens: ingredient name + prep note if any (e.g. "butter, softened" → local equivalent)
- steg[]: full sentences, each starting with an imperative verb in ${lang}
- noteringar: tips, variations, storage — translated and summarised naturally

STRICTLY FORBIDDEN:
- NEVER output anything outside the JSON object
- NEVER use markdown fences or any preamble
- NEVER mix languages (all text values must be in ${lang})`;
}

// ── Användarprompt ────────────────────────────────────────────────────────────
function buildUserPrompt(recipeText, targetLanguage, sourceLanguage) {
  const sourcePart = sourceLanguage && sourceLanguage !== "auto"
    ? `The source recipe is in ${sourceLanguage}. ` : "";
  return (
    `${sourcePart}Translate the following recipe to ${targetLanguage || "Swedish"}.\n\n` +
    "Return ONLY a single JSON object matching this schema exactly:\n" +
    SCHEMA + "\n\n" +
    "RECIPE:\n" + recipeText.slice(0, 12000)
  );
}

function buildImagePrompt(targetLanguage) {
  const lang = targetLanguage || "Swedish";
  return (
    `TASK: Read the recipe in this image and output it FULLY TRANSLATED to ${lang}.\n` +
    `The entire output — every word in every field — MUST be in ${lang}. ` +
    `Do NOT keep any text in the original language. ` +
    `Translate ingredient names, technique descriptions, and all instructions to ${lang}.\n\n` +
    `Also convert all measurements to metric:\n` +
    `1 cup=2.4dl | 1/2 cup=1.2dl | 1/4 cup=0.6dl | 1 tbsp=1 msk | 1 tsp=1 tsk | ` +
    `1 lb=450g | 1 oz=28g | 350F=175C | 400F=200C | 425F=220C | 450F=230C\n\n` +
    `Return ONLY a single raw JSON object (no markdown, no preamble) in this exact schema.\n` +
    `ALL string values must be written in ${lang}:\n` +
    SCHEMA
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

// ── JSON-extraktion med fallbacks ─────────────────────────────────────────────
function extractJSON(text) {
  if (!text) throw new Error("Empty response.");
  try { return JSON.parse(text.trim()); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error("No valid JSON in model response.");
}

// ── Validering och normalisering ──────────────────────────────────────────────
function validateRecipe(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Response is not a recipe object.");
  if (!obj.titel?.trim()) throw new Error("Recipe missing title.");
  if (!Array.isArray(obj.ingredienser) || !obj.ingredienser.length) throw new Error("Recipe missing ingredients.");
  if (!Array.isArray(obj.steg) || !obj.steg.length) throw new Error("Recipe missing steps.");
  obj.beskrivning = obj.beskrivning || "";
  obj.meta = obj.meta || {};
  obj.meta.portioner = obj.meta.portioner || "";
  obj.meta.totaltid = obj.meta.totaltid || "";
  obj.meta.svarighetsgrad = obj.meta.svarighetsgrad || "";
  obj.noteringar = obj.noteringar || "";
  obj.ingredienser = obj.ingredienser.map(i => ({
    grupp: i.grupp || "", mangd: i.mangd || "", ingrediens: i.ingrediens || ""
  }));
  obj.steg = obj.steg.map(s => typeof s === "string" ? s : JSON.stringify(s));
  return obj;
}

// ── Groq API-anrop ────────────────────────────────────────────────────────────
async function callGroq({ model, messages, useJsonMode = true }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured in Netlify environment variables.");

  const body = {
    model,
    messages,
    temperature: 0.15,
    max_tokens: 3000,
  };
  // JSON mode: forces valid JSON output — much more reliable
  if (useJsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || "Groq API error " + res.status;
    if (res.status === 429) throw new Error("Gratisgränsen nådd tillfälligt. Vänta en minut och försök igen.");
    throw new Error(msg);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty response from Groq.");
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
    catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) }; }

    const { type, content, url, image, imageMime, targetLanguage, sourceLanguage } = body;
    const tLang = (targetLanguage || "Swedish").trim();
    const sLang = sourceLanguage || "auto";

    // ── Bildöversättning ──────────────────────────────────────────────────────
    if (type === "image") {
      if (!image || image.length < 100)
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "No image received." }) };
      if (image.length > 4_000_000) // Frontend compresses to ~1600px JPEG before sending
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Bilden är för stor. Försök med ett foto med lägre upplösning." }) };

      const imagePrompt = buildImagePrompt(tLang);
      const responseText = await callGroq({
        model: VISION_MODEL,
        useJsonMode: true,
        messages: [
          { role: "system", content: buildSystemPrompt(tLang) },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${imageMime||"image/jpeg"};base64,${image}` } },
              { type: "text", text: imagePrompt },
            ],
          }
        ],
      });

      const recipe = validateRecipe(extractJSON(responseText));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipe }) };
    }

    // ── Text-/URL-översättning ────────────────────────────────────────────────
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
        { role: "system", content: buildSystemPrompt(tLang) },
        { role: "user",   content: buildUserPrompt(recipeText, tLang, sLang) },
      ],
    });

    const recipe = validateRecipe(extractJSON(responseText));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipe }) };

  } catch (err) {
    console.error("[translate-groq-v3]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
