// index.js — Zadarma → ATZ Candidate upsert + Activity with auto-fallbacks (no signature check)

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

const ATZ_ENABLE = (process.env.ATZ_ENABLE || "1") === "1";
const ATZ_BASE_URL = process.env.ATZ_BASE_URL || "https://api.atzcrm.com/v1";
const ATZ_API_TOKEN = process.env.ATZ_API_TOKEN || process.env.ATZ_TOKEN || "";
const ATZ_OWNER_ID = parseInt(process.env.ATZ_OWNER_ID || "0", 10) || null; // default owner (optional)
const ATZ_OWNER_MAP = safeParseJSON(process.env.ATZ_OWNER_MAP || "{}");      // {"101":"123"}
const ATZ_ACTIVITY_PATH = process.env.ATZ_ACTIVITY_PATH || "";               // optional preferred path
const ATZ_LIST_USERS_ON_BOOT = (process.env.ATZ_LIST_USERS_ON_BOOT || "0") === "1";

console.log("Booting webhook…");
console.log("PORT =", PORT);
console.log("ATZ_ENABLE =", ATZ_ENABLE, "| ATZ_BASE_URL =", ATZ_BASE_URL);
console.log("ATZ_ACTIVITY_PATH (preferred) =", ATZ_ACTIVITY_PATH || "(none)");
if (ATZ_ENABLE && !ATZ_API_TOKEN) console.warn("⚠️ ATZ_API_TOKEN not set — ATZ calls will be skipped.");

// ------------------------------ health & echo ------------------------------
app.get("/", (_, res) => res.status(200).send("Webhook is alive ✅"));

app.get("/zadarma", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo) return res.status(200).send(echo);
  res.status(200).send("OK");
});

// ------------------------------ utils ------------------------------
function safeParseJSON(s) { try { return JSON.parse(s); } catch { return {}; } }
const normPhone = (p) => (p || "").toString().replace(/[^\d+]/g, "");
const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// Better direction detection for Zadarma NOTIFY_* patterns (tuned to your logs)
function guessDirection(payload) {
  const event = (payload.event || "").toString().toUpperCase();
  const hasInternal = !!(payload.internal || payload.extension);
  const hasDest = !!(payload.destination);
  const hasCalledDid = !!(payload.called_did);
  if (event.includes("OUT")) return "outbound";
  if (event.includes("INTERNAL")) return "inbound";
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
  const disposition = (payload.disposition || "").toString();

  const direction = guessDirection(payload);

  return {
    event,
    callId,
    from: normPhone(from),
    to: normPhone(to),
    internal: (internal || "").toString(),
    direction,
    duration_seconds: duration,
    disposition
  };
}

// ------------------------------ ATZ client ------------------------------
const atz = axios.create({
  baseURL: ATZ_BASE_URL,
  timeout: 15000,
  headers: ATZ_API_TOKEN ? { Authorization: `Bearer ${ATZ_API_TOKEN}` } : {}
});

let ATZ_USERS_CACHE = null;
app.listen(PORT, async () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
  if (ATZ_LIST_USERS_ON_BOOT && ATZ_API_TOKEN && ATZ_ENABLE) {
    try {
      const resp = await atz.get("/users");
      const list = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
      ATZ_USERS_CACHE = list;
      console.log("👥 ATZ users (id → name):");
      list.forEach(u => console.log(`   ${u.id} → ${u.name || u.full_name || u.email || "(no name)"}`));
    } catch (e) {
      console.warn("⚠️ Could not list ATZ users:", e?.response?.data || e.message);
    }
  }
});

// ------------------------------ ATZ helpers ------------------------------
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
  if (internalExt && ATZ_OWNER_MAP[internalExt]) {
    const id = parseInt(ATZ_OWNER_MAP[internalExt], 10);
    if (Number.isFinite(id)) return id;
  }
  if (Number.isFinite(AT
