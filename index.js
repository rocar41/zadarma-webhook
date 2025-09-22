// index.js — Zadarma → Candidate upsert + call activity (no signature check)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();

// --- Keep proxy trust + raw body capture (future-proof) ---
app.set("trust proxy", true);
const rawSaver = (req, res, buf) => {
  try { req.rawBody = buf ? buf.toString("utf8") : ""; } catch { req.rawBody = ""; }
};
app.use(bodyParser.json({ verify: rawSaver }));
app.use(bodyParser.urlencoded({ extended: true, verify: rawSaver }));

// ================== CONFIG via Environment Variables ==================
const PORT            = process.env.PORT || 3000;

// ATZ CRM config
const ATZ_ENABLE      = (process.env.ATZ_ENABLE || "1") === "1"; // set to "0" to disable without code edits
const ATZ_BASE_URL    = process.env.ATZ_BASE_URL || "https://api.atzcrm.com/v1"; // <-- CHANGE if your ATZ base differs
const ATZ_TOKEN       = process.env.ATZ_TOKEN || ""; // required when ATZ_ENABLE=1

// Optional: map PBX extensions to ATZ owner/user IDs
// e.g., {"200":"123"} means extension 200 assigns owner_id 123 in ATZ
const ATZ_OWNER_MAP   = JSON.parse(process.env.ATZ_OWNER_MAP || "{}");

// =====================================================================

// Health logs
console.log("Booting webhook…");
console.log("PORT =", PORT);
console.log("ATZ_ENABLE =", ATZ_ENABLE, "| ATZ_BASE_URL =", ATZ_BASE_URL);

// Health check
app.get("/", (_, res) => res.status(200).send("Webhook is alive ✅"));

// Zadarma URL validation (GET ?zd_echo=...)
app.get("/zadarma", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo) return res.status(200).send(echo);
  res.status(200).send("OK");
});

// ------------------------- Helpers -------------------------
const atz = axios.create({
  baseURL: ATZ_BASE_URL,
  timeout: 10000,
  headers: ATZ_TOKEN ? { Authorization: `Bearer ${ATZ_TOKEN}` } : {}
});

const normPhone = (p) => (p || "").toString().replace(/[^\d+]/g, "");
const toInt = (v, def = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

// Very defensive extraction since payload keys vary by event
function extractCallFields(payload) {
  const event     = payload.event || payload.Event || payload.type || "";
  const callId    = payload.call_id || payload.pbx_call_id || payload.CallID || "";
  const from      = payload.caller_id || payload.caller || payload.from || payload.src || payload.number_from || "";
  const to        = payload.destination || payload.called_did || payload.to || payload.dst || payload.number_to || "";
  const internal  = payload.internal || payload.extension || payload.agent || payload.user || "";
  const dirRaw    = (payload.call_type || payload.direction || "").toString().toLowerCase();

  // Direction heuristic
  let direction = "unknown";
  if (dirRaw.includes("in")) direction = "inbound";
  else if (dirRaw.includes("out")) direction = "outbound";
  else if (from && internal && !to) direction = "outbound";
  else if (to && internal && !from) direction = "inbound";

  // Duration: Zadarma often gives seconds at end notifications
  const dur = toInt(payload.duration || payload.billsec || payload.billing_seconds || payload.time || 0, 0);

  return {
    event,
    callId,
    from: normPhone(from),
    to: normPhone(to),
    internal: (internal || "").toString(),
    direction,
    duration_seconds: dur
  };
}

// -------------------- ATZ: Candidate + Activity --------------------
// NOTE: Adjust these THREE marked blocks if your ATZ API differs.
async function findOrCreateCandidateByPhone(phone, fallbackOwnerId, callId) {
  if (!phone) return null;

  // (1) SEARCH candidate by phone  <<< ADJUST if your API differs
  // Some CRMs use a list endpoint with filters; others have a dedicated search.
  // Replace with your real search endpoint/params.
  try {
    const search = await atz.get("/candidates", { params: { phone } });
    if (Array.isArray(search.data) && search.data.length > 0) {
      return search.data[0]; // assume first is best match
    }
  } catch (e) {
    console.warn("ATZ search failed (will attempt create):", e?.response?.data || e.message);
  }

  // (2) CREATE candidate if not found  <<< ADJUST fields for your ATZ schema
  try {
    const create = await atz.post("/candidates", {
      first_name: "Auto",
      last_name: phone,
      phone,
      owner_id: fallbackOwnerId || undefined,
      description: `Auto-created from Zadarma call ${callId}`
    });
    return create.data;
  } catch (e) {
    console.error("ATZ create candidate failed:", e?.response?.data || e.message);
    return null;
  }
}

async function createCandidateCallActivity(candidateId, data) {
  if (!candidateId) return;

  // (3) CREATE activity on candidate  <<< ADJUST endpoint + fields for your ATZ
  // Many CRMs accept something like /candidates/{id}/activities or a generic /activities with candidate_id.
  try {
    await atz.post(`/candidates/${candidateId}/activities`, {
      type: "call",
      subject: `Call ${data.direction || "call"}`,
      notes: [
        `Call ID: ${data.callId}`,
        `From: ${data.from || "n/a"}`,
        `To: ${data.to || "n/a"}`,
        `Extension: ${data.internal || "n/a"}`,
        `Duration: ${data.duration_seconds || 0}s`,
        `Event: ${data.event}`
      ].join("\n"),
      direction: data.direction || "unknown",
      duration_seconds: data.duration_seconds || 0,
      occurred_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("ATZ create activity failed:", e?.response?.data || e.message);
  }
}

// ------------------------- Main Intake -------------------------
app.post("/zadarma", async (req, res) => {
  // Always respond quickly so Zadarma doesn't retry
  res.json({ ok: true });

  // Build payload
  const body = Object.keys(req.body || {}).length ? req.body : (req.query || {});
  const call = extractCallFields(body);
  console.log("📞 Incoming Zadarma event:", call, "| raw keys:", Object.keys(body));

  // Only log to ATZ on "end" type events so we have final duration
  // Depending on account, end events may be NOTIFY_END / NOTIFY_OUT_END / call_end, etc.
  const ev = (call.event || "").toLowerCase();
  const looksLikeEnd =
    ev.includes("end") || ev.includes("finished") || ev === "call_end";

  if (!ATZ_ENABLE || !ATZ_TOKEN) {
    if (looksLikeEnd) {
      console.log("ℹ️ ATZ disabled or token missing—skipping candidate logging.");
    }
    return;
  }

  if (looksLikeEnd) {
    try {
      // Choose the phone we’ll use to match: prefer external party
      const phoneForMatch = call.direction === "outbound" ? call.to : call.from;

      // Decide owner by extension, if mapped
      const ownerId = ATZ_OWNER_MAP[call.internal] || undefined;

      // Upsert candidate
      const candidate = await findOrCreateCandidateByPhone(phoneForMatch, ownerId, call.callId);
      if (!candidate || !candidate.id) {
        console.warn("⚠️ Could not get/create candidate for phone:", phoneForMatch);
        return;
      }

      // Create activity
      await createCandidateCallActivity(candidate.id, call);
      console.log(`✅ Logged call on candidate ${candidate.id} (${phoneForMatch})`);
    } catch (e) {
      console.error("❌ ATZ upsert/log failed:", e?.response?.data || e.message);
    }
  }
});

// Error visibility
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));

// Start server
app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
