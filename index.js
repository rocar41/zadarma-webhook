// index.js — Zadarma → Candidate upsert (no signature check, singular ATZ endpoints)

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();

// ---------- Step 1: trust proxy + capture RAW body (future-proof) ----------
app.set("trust proxy", true);
const rawSaver = (req, res, buf) => {
  try { req.rawBody = buf ? buf.toString("utf8") : ""; } catch { req.rawBody = ""; }
};
app.use(bodyParser.json({ verify: rawSaver }));
app.use(bodyParser.urlencoded({ extended: true, verify: rawSaver }));

// ------------------------------ Config (ENV) ------------------------------
// Works without these; ATZ actions only run if ATZ_API_TOKEN is set.
const PORT             = process.env.PORT || 3000;

// Turn ATZ integration on/off without code edits:
const ATZ_ENABLE       = (process.env.ATZ_ENABLE || "1") === "1";
// Your base URL (defaults to v1):
const ATZ_BASE_URL     = process.env.ATZ_BASE_URL || "https://api.atzcrm.com/v1";
// Token from ATZ Admin → API:
const ATZ_API_TOKEN    = process.env.ATZ_API_TOKEN || process.env.ATZ_TOKEN || "";
// Owner for new candidates (find your ID in ATZ; set env ATZ_OWNER_ID="123"):
const ATZ_OWNER_ID     = parseInt(process.env.ATZ_OWNER_ID || "1", 10);

// OPTIONAL: if your ATZ supports a candidate activity endpoint, set e.g.
// ATZ_ACTIVITY_PATH = "/candidate/{id}/activities"
// We’ll replace {id} automatically with the candidate id.
const ATZ_ACTIVITY_PATH = process.env.ATZ_ACTIVITY_PATH || "";

// Map PBX extensions → ATZ user IDs (JSON), e.g. {"101":"123","102":"124"}
let ATZ_OWNER_MAP = {};
try { ATZ_OWNER_MAP = JSON.parse(process.env.ATZ_OWNER_MAP || "{}"); } catch { ATZ_OWNER_MAP = {}; }

// ------------------------------ Startup logs ------------------------------
console.log("Booting webhook…");
console.log("PORT =", PORT);
console.log("ATZ_ENABLE =", ATZ_ENABLE, "| ATZ_BASE_URL =", ATZ_BASE_URL);
if (!ATZ_API_TOKEN && ATZ_ENABLE) console.warn("⚠️ ATZ_API_TOKEN not set; ATZ actions will be skipped.");

// ------------------------------ Health & echo ------------------------------
app.get("/", (_, res) => res.status(200).send("Webhook is alive ✅"));

app.get("/zadarma", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo) return res.status(200).send(echo);
  res.status(200).send("OK");
});

// ------------------------------ Helpers ------------------------------
const atz = axios.create({
  baseURL: ATZ_BASE_URL,
  timeout: 15000,
  headers: ATZ_API_TOKEN ? { Authorization: `Bearer ${ATZ_API_TOKEN}` } : {}
});

const normPhone = (p) => (p || "").toString().replace(/[^\d+]/g, "");
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// Parse Zadarma-ish payloads defensively
function extractCall(payload) {
  const event     = (payload.event || payload.Event || "").toString();
  const callId    = payload.pbx_call_id || payload.call_id || "";
  const from      = payload.caller_id || payload.caller || payload.from || payload.number_from || "";
  const to        = payload.destination || payload.called_did || payload.to || payload.number_to || "";
  const internal  = payload.internal || payload.extension || "";
  const dirRaw    = (payload.call_type || payload.direction || "").toString().toLowerCase();
  const duration  = toInt(payload.duration || payload.billsec || payload.billing_seconds || 0, 0);

  let direction = "unknown";
  if (dirRaw.includes("in")) direction = "inbound";
  else if (dirRaw.includes("out")) direction = "outbound";
  else if (from && internal && !to) direction = "outbound";
  else if (to && internal && !from) direction = "inbound";

  return {
    event,
    callId,
    from: normPhone(from),
    to: normPhone(to),
    internal: (internal || "").toString(),
    direction,
    duration_seconds: duration
  };
}

// ------------------------------ ATZ: Candidate ------------------------------
// ATZ uses SINGULAR endpoints: /v1/candidate (list/create).
// We’ll do a small paged client-side search for a matching phone, then create if not found.

async function atzListCandidatesPage(page = 1, limit = 50) {
  const resp = await atz.get("/candidate", { params: { page, limit } });
  // Some APIs return {data: [...]}, others return array directly — handle both.
  const data = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
  return data;
}

async function atzFindCandidateByPhone(phone) {
  if (!phone) return null;
  const target = normPhone(phone);
  for (let page = 1; page <= 3; page++) {
    const list = await atzListCandidatesPage(page, 50);
    const match = list.find(c => normPhone(c.phone) === target);
    if (match) return match;
    if (list.length < 50) break; // no more pages
  }
  return null;
}

async function atzCreateCandidate({ phone, ownerId, callId }) {
  const last4 = (normPhone(phone).slice(-4) || "Lead");
  const body = {
    first_name: "Caller",
    last_name: last4,
    phone: phone,
    owner_id: ownerId || ATZ_OWNER_ID,
    description: `Auto-created from Zadarma call ${callId}`
  };
  const resp = await atz.post("/candidate", body);
  return resp.data;
}

async function atzGetOrCreateCandidateByPhone(phone, ownerId, callId) {
  let cand = await atzFindCandidateByPhone(phone);
  if (cand) return cand;
  return atzCreateCandidate({ phone, ownerId, callId });
}

// Optional activity creation if you set ATZ_ACTIVITY_PATH
async function atzCreateCandidateActivity(candidateId, call) {
  if (!ATZ_ACTIVITY_PATH) {
    console.log("ℹ️ ATZ_ACTIVITY_PATH not set — skipping activity creation.");
    return;
  }
  const path = ATZ_ACTIVITY_PATH.replace("{id}", String(candidateId));
  const payload = {
    type: "call",
    subject: `Call ${call.direction}`,
    notes: [
      `Call ID: ${call.callId}`,
      `From: ${call.from || "n/a"}`,
      `To: ${call.to || "n/a"}`,
      `Extension: ${call.internal || "n/a"}`,
      `Duration: ${call.duration_seconds || 0}s`,
      `Event: ${call.event}`
    ].join("\n"),
    direction: call.direction || "unknown",
    duration_seconds: call.duration_seconds || 0,
    occurred_at: new Date().toISOString()
  };
  const resp = await atz.post(path, payload);
  return resp.data;
}

// ------------------------------ Main webhook ------------------------------
app.post("/zadarma", async (req, res) => {
  // reply immediately so Zadarma doesn’t retry
  res.json({ ok: true });

  const body = Object.keys(req.body || {}).length ? req.body : (req.query || {});
  const call = extractCall(body);
  console.log("📞 Incoming Zadarma event:", call, "| raw keys:", Object.keys(body));

  // Only act on "end" events so we have final duration
  const ev = (call.event || "").toLowerCase();
  const isEnd = ev.includes("end") || ev === "call_end" || ev.includes("finished");

  if (!isEnd) return;

  if (!ATZ_ENABLE || !ATZ_API_TOKEN) {
    console.log("ℹ️ ATZ disabled or token missing — skipping candidate logging.");
    return;
  }

  try {
    // Prefer the external party number for matching:
    const phoneForMatch = call.direction === "outbound" ? call.to : call.from;
    if (!phoneForMatch) {
      console.warn("⚠️ No phone to match; skipping ATZ upsert.");
      return;
    }

    // Owner mapping by PBX extension if provided
    const ownerId = ATZ_OWNER_MAP[call.internal] ? parseInt(ATZ_OWNER_MAP[call.internal], 10) : ATZ_OWNER_ID;

    // Upsert Candidate
    const candidate = await atzGetOrCreateCandidateByPhone(phoneForMatch, ownerId, call.callId);
    const candId = candidate?.id || candidate?.slug || candidate?.uuid;
    console.log("✅ Candidate upsert:", { candId, phone: phoneForMatch });

    // Optional: create a call activity if path configured
    if (candId && ATZ_ACTIVITY_PATH) {
      await atzCreateCandidateActivity(candId, call);
      console.log("✅ Logged call activity on candidate:", candId);
    }
  } catch (e) {
    const respData = e?.response?.data || e?.message || e;
    console.error("❌ ATZ error:", respData);
  }
});

// ------------------------------ Errors & start ------------------------------
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));

app.listen(PORT, () => console.log(`🚀 Webhook listening on port ${PORT}`));
