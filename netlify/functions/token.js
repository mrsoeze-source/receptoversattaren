/**
 * Netlify Function: /api/token
 * GET → returns a short-lived HMAC-signed token the client must include
 *        in every /api/translate call.
 *
 * The TOKEN_SECRET never leaves the server — the HTML source contains
 * no secrets at all. An attacker must call /api/token first (rate-limited)
 * and each token expires in 5 minutes and is single-use.
 */
const crypto = require("crypto");

const TOKEN_TTL_SECONDS = 5 * 60; // 5 minutes

// Netlify built-in rate limit: generous for page loads but blocks bulk harvesting
exports.config = {
  path: "/api/token",
  rateLimit: {
    windowSize: 60,
    maxRequests: 10,
    aggregateBy: ["ip", "domain"],
  },
};

// Allowed origins (same list as translate.js)
const ALLOWED_ORIGINS = [
  process.env.SITE_URL,
  process.env.URL,
  "http://localhost:8888",
  "http://localhost:3000",
].filter(Boolean);

exports.handler = async (event) => {
  const origin = event.headers["origin"] || "";

  // Only GET allowed
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }

  // CORS origin check
  const originOk = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  if (!originOk && origin !== "") {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: "Forbidden" }) };
  }

  const corsHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate", // tokens must not be cached
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] || "null"),
  };

  const secret = process.env.TOKEN_SECRET;
  if (!secret) {
    // If TOKEN_SECRET is not configured, issue a placeholder so the app
    // still works while TOKEN_SECRET is optional (translate.js skips check if not set)
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: true, token: null }),
    };
  }

  // Generate single-use nonce + expiry
  const nonce = crypto.randomBytes(16).toString("hex");
  const exp   = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  // Sign: HMAC-SHA256( TOKEN_SECRET, nonce:exp )
  const payload = `${nonce}:${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ ok: true, token: { nonce, exp, sig } }),
  };
};
