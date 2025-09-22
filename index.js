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
const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.i
