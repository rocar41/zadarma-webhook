// index.js — Zadarma → ATZ Candidate upsert (no signature check)
// Adds: owner ID discovery + safe retry if owner invalid

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();

// ---------- trust proxy + capture RAW body ----------
app.set("trust proxy", true);
const rawSaver = (req, res, buf) => {
  try { req.rawBody = buf ? buf.toString("utf8") : ""; } catch { req.rawBody = ""; }
};
app.use(bodyParser.json({ verify: rawSaver }));
app.use(bodyParser.urlencoded({ extended: true, verify: rawSaver }));

// ------------------------------ ENV ------------------------------
const PORT = process.env.PORT || 3000;

// ATZ toggles/config
const ATZ_ENABLE = (process.env.ATZ_ENABLE || "1") === "1";
const ATZ_BASE_URL = process.env.ATZ_BASE_URL || "https://api.atzcrm.com/v1";
const ATZ_API_TOKEN = process.env.ATZ_API_TOKEN || process.env.ATZ_TOKEN || "";
const ATZ_OWNER_ID = parseInt(process.env.ATZ_OWNER_ID || "0", 10) || null; // your default owner
const ATZ_OWNER_MAP = safeParseJSON(process.env.ATZ_OWNER_MAP || "{}"); // {"101":"123"}
const ATZ_ACTIVITY_PATH = process.env.ATZ_ACTIVITY_PATH || ""; // e.g. "/candidate/{id}/activities"
// Turn on once to dump user IDs to logs so you can pick the right owner_id
const ATZ_LIST_USERS_ON_BOOT = (process.env.ATZ_LIST_USERS_ON_BOOT || "0") === "1";

// ------------------------------ startup logs ------------------------------
console.log("Booting webhook…");
console.log("PORT =", PORT);
console.log("ATZ_ENABLE =", ATZ_ENABLE, "| ATZ_BASE_URL =", ATZ_BASE_URL);
if (ATZ_ENABLE && !ATZ_API_TOKEN) console.warn("⚠️ ATZ_API_TOKEN not set — ATZ calls will be skipped.");

// ------------------------------ health & echo ------------------------------
app.get("/", (_, res) => res.status(200).send("Webhook is alive ✅"));

app.get("/zadarma", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo) return res.status(200).send(echo);
  res.status(200).send("OK");
});

// ------------------------------ utils ------------------------------
function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
const normPhone = (p) => (p || "").toString().replace(/[^\d+]/g, "");
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// Better direction detection for Zadarma NOTIFY_* patterns
function guessDirection(payload) {
  const event = (payload.event || "").toString().toUpperCase();
  const hasInternal = !!(payload.internal || payload.extension);
  const hasDest = !!(payload.destination);
  const hasCalledDid = !!(payload.called_did);
  // Heuristics tuned to your logs:
  if (event.includes("OUT")) return "outbound";
  if (event.includes("INTERNAL")) return "inbound"; // ringing to an internal ext from outside
  if (event.includes("START") && hasCalledDid && !hasInternal) return "inbound";
  if (event.includes("START") && hasInternal && hasDest) return "outbound";
  return "unknown";
}

function extractCall(payload) {
  const event     = (payload.event || payload.Event || "").toString();
  const callId    = payload.pbx_call_id || payload.call_id || "";
  const from      = payload.caller_id || payload.caller || payload.from || payload.number_from || "";
  const to        = payload.destination || payload.called_did || payload.to || payload.number_to || "";
  const internal  = payload.internal || payload.extension || "";
  const duration  = toInt(payload.duration || payload.billsec || payload.billing_seconds || 0, 0);
  const direction = guessDirection(payload);

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

// ------------------------------ ATZ client ------------------------------
const atz = axios.create({
  baseURL: ATZ_BASE_URL,
  timeout: 15000,
  headers: ATZ_API_TOKEN ? { Authorization: `Bearer ${ATZ_API_TOKEN}` } : {}
});

let ATZ_USERS_CACHE = null;

async function loadAtzUsersIfWanted() {
  if (!ATZ_ENABLE || !ATZ_API_TOKEN || !ATZ_LIST_USERS_ON_BOOT) return;
  try {
    const resp = await atz.get("/users");
    const list = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
    ATZ_USERS_CACHE = list;
    console.log("👥 ATZ users (id → name):");
    list.forEach(u => console.log(`   ${u.id} → ${u.name || u.full_name || u.email || "(no name)"}`));
    console.log("ℹ️ Use one of these IDs for ATZ_OWNER_ID or map in ATZ_OWNER_MAP like {\"101\":\"<id>\"}");
  } catch (e) {
    console.warn("⚠️ Could not list ATZ users:", e?.response?.data || e.message);
  }
}

// list candidates (paged)
async function atzListCandidatesPage(page = 1, limit = 50) {
  const resp = await atz.get("/candidate", { params: { page, limit } });
  return Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
}

async function atzFindCandidateByPhone(phone) {
  if (!phone) return null;
  const target = normPhone(phone);
  for (let page = 1; page <= 3; page++) {
    const list = await atzListCandidatesPage(page, 50);
    const match = list.find(c => normPhone(c.phone) === target);
    if (match) return match;
    if (list.length < 50) break;
  }
  return null;
}

function pickOwnerId(internalExt) {
  // 1) mapped by extension
  if (internalExt && ATZ_OWNER_MAP[internalExt]) {
    const id = parseInt(ATZ_OWNER_MAP[internalExt], 10);
    if (Number.isFinite(id)) return id;
  }
  // 2) fallback to global owner
  if (Number.isFinite(ATZ_OWNER_ID)) return ATZ_OWNER_ID;
  return null;
}

async function atzCreateCandidate({ phone, ownerId, callId }) {
  const last4 = (normPhone(phone).slice(-4) || "Lead");
  const basePayload = {
    first_name: "Caller",
    last_name: last4,
    phone: phone,
    description: `Auto-created from Zadarma call ${callId}`
  };

  // Try WITH owner_id first if provided
  if (ownerId) {
    try {
      const resp = await atz.post("/candidate", { ...basePayload, owner_id: ownerId });
      return resp.data;
    } catch (e) {
      const msg = e?.response?.data || e.message || e;
      // If ATZ complains about owner, retry without owner_id
      if (JSON.stringify(msg).includes("Invalid user for owner")) {
        console.warn(`⚠️ owner_id ${ownerId} invalid — retrying without owner_id.`);
      } else {
        throw e;
      }
    }
  }
  // Retry WITHOUT owner_id
  const resp2 = await atz.post("/candidate", basePayload);
  return resp2.data;
}

async function atzGetOrCreateCandidateByPhone(phone, ownerId, callId) {
  let cand = await atzFindCandidateByPhone(phone);
  if (cand) return cand;
  return atzCreateCandidate({ phone, ownerId, callId });
}

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

// ------------------------------ webhook intake ------------------------------
app.post("/zadarma", async (req, res) => {
  res.json({ ok: true }); // reply fast

  const body = Object.keys(req.body || {}).length ? req.body : (req.query || {});
  const call = extractCall(body);
  console.log("📞 Incoming Zadarma event:", call, "| raw keys:", Object.keys(body));

  // Only act when the call is over (we have duration)
  const ev = (call.event || "").toLowerCase();
  const isEnd = ev.includes("end") || ev === "call_end" || ev.includes("finished");
  if (!isEnd) return;

  if (!ATZ_ENABLE || !ATZ_API_TOKEN) {
    console.log("ℹ️ ATZ disabled or token missing — skipping candidate logging.");
    return;
  }

  try {
    // Use the external party number for matching
    const phoneForMatch = call.direction === "outbound" ? call.to : call.from;
    if (!phoneForMatch) {
      console.warn("⚠️ No external phone to match; skipping ATZ upsert.");
      return;
    }

    // pick owner (may be null)
    const ownerId = pickOwnerId(call.internal);

    // upsert candidate
    const candidate = await atzGetOrCreateCandidateByPhone(phoneForMatch, ownerId, call.callId);
    const candId = candidate?.id || candidate?.slug || candidate?.uuid || null;
    console.log("✅ Candidate upsert:", { candId, phone: phoneForMatch, usedOwnerId: ownerId });

    // optional activity
    if (candId && ATZ_ACTIVITY_PATH) {
      await atzCreateCandidateActivity(candId, call);
      console.log("✅ Logged call activity on candidate:", candId);
    }
  } catch (e) {
    console.error("❌ ATZ error:", e?.response?.data || e.message || e);
  }
});

// ------------------------------ errors & start ------------------------------
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));

app.listen(PORT, async () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
  await loadAtzUsersIfWanted(); // logs IDs if ATZ_LIST_USERS_ON_BOOT=1
});
