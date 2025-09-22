
// index.js — Zadarma → ATZ Candidate upsert + append to custom field "Zadarma Call Log"
// No signature check; resilient update across multiple ATZ payload/endpoint styles.

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
const ATZ_LIST_USERS_ON_BOOT = (process.env.ATZ_LIST_USERS_ON_BOOT || "0") === "1";

// 🔑 Your custom field key/name (exact label or internal key)
const ATZ_CUSTOM_FIELD_KEY = (process.env.ATZ_CUSTOM_FIELD_KEY || "Zadarma Call Log").trim();

console.log("Booting webhook…");
console.log("PORT =", PORT);
console.log("ATZ_ENABLE =", ATZ_ENABLE, "| ATZ_BASE_URL =", ATZ_BASE_URL);
console.log("Custom field key =", ATZ_CUSTOM_FIELD_KEY || "(not set)");
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

// UTC timestamp (ISO without ms)
function nowIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getMilliseconds()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Direction heuristic tuned to your Zadarma logs
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
  const isRecorded = (payload.is_recorded || payload.recorded || "0").toString() === "1";

  const direction = guessDirection(payload);

  return {
    event,
    callId,
    from: normPhone(from),
    to: normPhone(to),
    internal: (internal || "").toString(),
    direction,
    duration_seconds: duration,
    disposition,
    isRecorded
  };
}

// Make a readable single-line summary
function buildLogLine(call) {
  const ts = nowIso(); // UTC
  const dir = (call.direction || "unknown").toUpperCase();
  const dur = `${call.duration_seconds || 0}s`;
  const disp = call.disposition ? ` ${call.disposition}` : "";
  const rec = call.isRecorded ? " rec=Y" : "";
  const fromTo = [call.from || "?", "→", call.to || "?"].join(" ");
  return `[${ts}] ${dir} ${dur}${disp}${rec} ${fromTo} (ext:${call.internal || "-"}) id=${call.callId}`;
}

// ------------------------------ ATZ client ------------------------------
const atz = axios.create({
  baseURL: ATZ_BASE_URL,
  timeout: 15000,
  headers: ATZ_API_TOKEN ? { Authorization: `Bearer ${ATZ_API_TOKEN}` } : {}
});

app.listen(PORT, async () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
  if (ATZ_LIST_USERS_ON_BOOT && ATZ_API_TOKEN && ATZ_ENABLE) {
    try {
      const resp = await atz.get("/users");
      const list = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);
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

  // Try with owner first
  if (ownerId) {
    try {
      const resp = await atz.post("/candidate", { ...basePayload, owner_id: ownerId });
      return resp.data;
    } catch (e) {
      const msg = e?.response?.data || e.message || e;
      if (JSON.stringify(msg).includes("Invalid user for owner")) {
        console.warn(`⚠️ owner_id ${ownerId} invalid — retrying without owner_id.`);
      } else {
        throw e;
      }
    }
  }
  // Fallback without owner
  const resp2 = await atz.post("/candidate", basePayload);
  return resp2.data;
}

async function atzGetOrCreateCandidateByPhone(phone, ownerId, callId) {
  let cand = await atzFindCandidateByPhone(phone);
  if (cand) return cand;
  return atzCreateCandidate({ phone, ownerId, callId });
}

// --- read a candidate by id OR slug (try a few forms) ---
async function atzGetCandidateDetail(idOrSlug) {
  const candId = String(idOrSlug);
  const tries = [
    { method: "get", path: `/candidate/${candId}` }, // singular detail
  ];
  for (const t of tries) {
    try {
      const resp = await atz[t.method](t.path);
      return resp.data;
    } catch (e) {
      if (e?.response?.status === 404) continue;
    }
  }
  return null;
}

// --- update a candidate's custom field by APPENDING a line ---
// Tries several payload shapes + PUT/PATCH, and id vs slug paths.
async function atzAppendToCustomField(idOrSlug, fieldKey, line, ownerIdFallback) {
  const current = await atzGetCandidateDetail(idOrSlug);
  let prevVal = "";

  // Try to read prior value from common shapes:
  if (current) {
    // direct field
    if (typeof current[fieldKey] === "string") prevVal = current[fieldKey];
    // object map
    else if (current.custom_fields && typeof current.custom_fields === "object") {
      if (typeof current.custom_fields[fieldKey] === "string") prevVal = current.custom_fields[fieldKey];
    }
    // array of {key,value}
    else if (Array.isArray(current.custom_fields)) {
      const hit = current.custom_fields.find(f => f.key === fieldKey || f.name === fieldKey);
      if (hit && typeof hit.value === "string") prevVal = hit.value;
    }
  }

  const newVal = prevVal ? `${prevVal}\n${line}` : line;

  // Build three payload styles
  const payloads = [
    // 1) object map
    { body: { custom_fields: { [fieldKey]: newVal }, owner_id: ownerIdFallback || undefined }, tag: "obj-map" },
    // 2) array of key/value
    { body: { custom_fields: [{ key: fieldKey, value: newVal }], owner_id: ownerIdFallback || undefined }, tag: "kv-array" },
    // 3) direct field (if ATZ surfaces custom directly)
    { body: { [fieldKey]: newVal, owner_id: ownerIdFallback || undefined }, tag: "direct" }
  ];

  // Try both PUT and PATCH, and both /candidate/{id} & /candidate/{slug}
  const idOrSlugStr = String(idOrSlug);
  const paths = [`/candidate/${idOrSlugStr}`];
  const verbs = ["put", "patch"];

  for (const method of verbs) {
    for (const path of paths) {
      for (const p of payloads) {
        try {
          const resp = await atz[method](path, p.body);
          console.log(`✅ Custom field append via ${method.toUpperCase()} ${path} style=${p.tag}`);
          return resp.data;
        } catch (e) {
          const status = e?.response?.status;
          const data = e?.response?.data || e.message || e;
          if (status === 404) {
            console.warn(`↪︎ 404 on ${method.toUpperCase()} ${path} style=${p.tag} — trying next`);
            continue;
          } else {
            // Log but keep trying other shapes
            console.warn(`↪︎ ${method.toUpperCase()} ${path} style=${p.tag} failed:`, data);
          }
        }
      }
    }
  }
  console.error("❌ Could not update custom field; tried multiple payloads & verbs");
  return null;
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
    console.log("ℹ️ ATZ disabled or token missing — skipping ATZ actions.");
    return;
  }

  try {
    // For matching, prefer the external party number
    const phoneForMatch = call.direction === "outbound" ? call.to : call.from;
    if (!phoneForMatch) {
      console.warn("⚠️ No external phone to match; skipping ATZ upsert.");
      return;
    }

    const ownerId = pickOwnerId(call.internal);
    const candidate = await atzGetOrCreateCandidateByPhone(phoneForMatch, ownerId, call.callId);
    const candId = candidate?.id || candidate?.slug || candidate?.uuid || null;
    console.log("✅ Candidate upsert:", { candId, phone: phoneForMatch, usedOwnerId: ownerId });

    // Build one-line summary and append to custom field
    if (candId && ATZ_CUSTOM_FIELD_KEY) {
      const line = buildLogLine(call);
      await atzAppendToCustomField(candId, ATZ_CUSTOM_FIELD_KEY, line, ownerId);
    }
  } catch (e) {
    console.error("❌ ATZ error:", e?.response?.data || e.message || e);
  }
});

// ------------------------------ errors ------------------------------
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
