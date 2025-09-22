// index.js — Zadarma → Webhook (baby-proof version, CommonJS)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");      // kept for later (ATZ, recordings, etc.)
const crypto = require("crypto");    // used if you enable signature checks

const app = express();

// ---------------------------
// STEP 1: trust proxy + capture RAW body for HMAC checks later
// ---------------------------
app.set("trust proxy", true);

const rawSaver = (req, res, buf) => {
  try {
    req.rawBody = buf ? buf.toString("utf8") : "";
  } catch {
    req.rawBody = "";
  }
};

// Use body parsers *with* the verify hook so raw body is preserved
app.use(bodyParser.json({ verify: rawSaver }));
app.use(bodyParser.urlencoded({ extended: true, verify: rawSaver }));

// ---------------------------
// Environment variables (add in Render → Settings → Environment)
// ---------------------------
const ATZ_TOKEN       = process.env.ATZ_TOKEN || "";        // ATZ CRM API token (optional for now)
const ZADARMA_KEY     = process.env.ZADARMA_KEY || "";      // Zadarma API key (optional for now)
const ZADARMA_SECRET  = process.env.ZADARMA_SECRET || "";   // Zadarma API secret (optional for now)

// ---------------------------
// Optional: signature verification (DISABLED by default)
// Read the latest Zadarma docs for the exact algorithm and header names.
// Toggle ENABLE_SIGNATURE_CHECK = true only after confirming the algorithm.
// ---------------------------
const ENABLE_SIGNATURE_CHECK = false;

function verifyZadarmaSignature(req) {
  // Placeholder template — confirm details in Zadarma docs before enabling.
  // Typical pattern: HMAC of (rawBody + API_KEY) with SECRET, base64-encoded.
  try {
    const received = req.header("Signature");
    if (!received) return false;

    const raw = req.rawBody || "";
    // Example (check docs before using!):
    // const expected = crypto
    //   .createHmac("sha1", ZADARMA_SECRET)
    //   .update(raw + ZADARMA_KEY)
    //   .digest("base64");
    // return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));

    // For now, always false to avoid false positives until you confirm spec.
    return false;
  } catch (e) {
    console.error("Signature verification error:", e);
    return false;
  }
}

// ---------------------------
// Basic health check
// ---------------------------
const PORT = process.env.PORT || 3000;
console.log("Booting webhook…");
console.log("PORT =", PORT);

app.get("/", (_, res) => res.status(200).send("Webhook is alive ✅"));

// ---------------------------
// Zadarma URL validation (GET): echoes back ?zd_echo=...
// Set this URL in Zadarma as the “About PBX calls” (validation) endpoint.
// ---------------------------
app.get("/zadarma", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo) return res.status(200).send(echo);
  res.status(200).send("OK");
});

// ---------------------------
// Event intake (POST): main webhook endpoint
// Set this same URL in Zadarma as the “About events” (notifications) endpoint.
// ---------------------------
app.post("/zadarma", async (req, res) => {
  try {
    // 1) Respond immediately so Zadarma doesn’t retry
    res.json({ ok: true });

    // 2) Optional: verify signature (keep disabled until algorithm is confirmed)
    if (ENABLE_SIGNATURE_CHECK) {
      if (!verifyZadarmaSignature(req)) {
        console.warn("⚠️  Rejected event: bad signature");
        return;
      }
    }

    // 3) Build a friendly event payload (Zadarma may send JSON or form-encoded)
    const payload = Object.keys(req.body || {}).length ? req.body : (req.query || {});
    console.log("📞 Incoming Zadarma event:", payload);

    // 4) OPTIONAL (later): push into ATZ CRM
    //    Uncomment and adapt once you decide Contact vs Candidate and fields.
    if (false && ATZ_TOKEN) {
      /*
      await axios.post("https://api.atzcrm.com/v1/<your-endpoint>", {
        phone:      payload.caller_id || payload.caller || payload.from || "",
        direction:  payload.call_type || payload.direction || "",
        event:      payload.event || "",
        extension:  payload.internal || "",
        call_id:    payload.call_id || payload.pbx_call_id || "",
        occurred_at: new Date().toISOString(),
        notes:      `Auto-logged from Zadarma`
      }, {
        headers: { Authorization: `Bearer ${ATZ_TOKEN}` }
      });
      */
    }

  } catch (err) {
    console.error("❌ Error handling event:", err?.response?.data || err?.message || err);
  }
});

// ---------------------------
// Global error visibility
// ---------------------------
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION:", e);
});
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e);
});

// ---------------------------
// Start server
// ---------------------------
app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
});
