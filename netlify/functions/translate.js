/**
 * Netlify Function: /api/translate  (Gemini-version – GRATIS)
 * Använder Google Gemini API: 1 500 anrop/dag, 15/minut – helt gratis.
 *
 * Enda fil som skiljer sig från Anthropic-versionen.
 * Frontendfilen (index.html) är OFÖRÄNDRAD.
 *
 * POST body:
 *   { type: "text", content: "..." }   – klistrad text
 *   { type: "url",  url: "https://..." } – hämta sida + översätt
 *
 * Svar:
 *   { ok: true,  recipe: { ... } }
 *   { ok: false, error: "..." }
 */

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent";

// Rensa bort icke-ASCII-tecken som stör API-anropet
function sanitize(s) {
  return String(s || "")
    .replace(/\u00b0/g, " degrees")
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00bc/g, "1/4").replace(/\u00bd/g, "1/2").replace(/\u00be/g, "3/4")
    .replace(/[^\x00-\x7f]/g, " ").replace(/ +/g, " ").trim();
}

const METRIC =
  "1 cup=2.4dl, 1/2 cup=1.2dl, 1/4 cup=0.6dl, 1/3 cup=0.8dl\n" +
  "1 tbsp=1 msk, 1 tsp=1 tsk, 1/4 tsp=en knivsudd\n" +
  "1 stick butter=115g, 1 lb=450g, 1 oz=28g\n" +
  "F till C: (F-32)*5/9 avrunda till narmaste 5. 350F=175C 375F=190C 400F=200C 425F=220C 450F=230C";

const SCHEMA =
  '{"titel":"","beskrivning":"","meta":{"portioner":"","totaltid":"","svarighetsgrad":"Enkel"},' +
  '"ingredienser":[{"grupp":"","mangd":"","ingrediens":""}],"steg":[""],"noteringar":""}';

function buildPrompt(recipeText) {
  return (
    "Translate this recipe to Swedish. Convert all measurements to metric.\n" +
    METRIC + "\n\n" +
    "Reply ONLY with raw JSON (no markdown, no extra text) matching this schema:\n" +
    SCHEMA + "\n\nRECIPE:\n" + recipeText.slice(0, 12000)
  );
}

// Hämtar en webbsida server-side (inga CORS-problem här, till skillnad fran webbläsaren)
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
  // Strippa HTML-taggar till ren text
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ").trim()
    .slice(0, 20000);
}

function extractJSON(text) {
  if (!text) throw new Error("Tomt svar.");
  try { return JSON.parse(text.trim()); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error("Inget giltigt JSON i svaret.");
}

function validateRecipe(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Svaret ar inte ett receptobjekt.");
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

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY saknas i Netlify-miljövariabler.");

  const res = await fetch(GEMINI_URL + "?key=" + apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,       // Låg temperatur = mer förutsägbar JSON-utmatning
        maxOutputTokens: 2500,
      },
    }),
  });

  const data = await res.json();

  // Gemini-specifika felkoder
  if (!res.ok) {
    const msg = data?.error?.message || "Gemini API-fel " + res.status;
    // Hjälpsamt meddelande vid gratisgräns
    if (res.status === 429) throw new Error("Gratisgränsen nådd (15/minut eller 1500/dag). Försök igen om en minut.");
    throw new Error(msg);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Tomt svar från Gemini.");
  return text;
}

// ── Huvudhanterare ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };

  const headers = { "Content-Type": "application/json" };

  try {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Ogiltig JSON-body" }) }; }

    const { type, content, url } = body;

    // Validera indata
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

    const responseText = await callGemini(buildPrompt(recipeText));
    const recipe = validateRecipe(extractJSON(responseText));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipe }) };

  } catch (err) {
    console.error("[translate-gemini]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
