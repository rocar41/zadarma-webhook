const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
// --- STEP 1: trust proxy + capture raw request body for signature checks ---
app.set("trust proxy", true);

const rawSaver = (req, res, buf) => {
  try {
    req.rawBody = buf ? buf.toString("utf8") : "";
  } catch {
    req.rawBody = "";
  }
};

// IMPORTANT: use these parsers so raw body is preserved
app.use(require("body-parser").json({ verify: rawSaver }));
app.use(require("body-parser").urlencoded({ extended: true, verify: rawSaver }));


// Helpful startup logs
const PORT = process.env.PORT || 3000;
console.log("Booting webhook...");
console.log("PORT =", PORT);

// Parse JSON and form-encoded
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Secrets (ok to leave empty while testing)
const ATZ_TOKEN = process.env.ATZ_TOKEN || "";
const ZADARMA_KEY = process.env.ZADARMA_KEY || "";
const ZADARMA_SECRET = process.env.ZADARMA_SECRET || "";

// Health check
app.get("/", (_, res) => res.status(200).send("Webhook is alive ✅"));

// Echo validator for Zadarma (?zd_echo=...)
app.get("/zadarma", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo) return res.status(200).send(echo);
  res.status(200).send("OK");
});

// Event intake
app.post("/zadarma", async (req, res) => {
  try {
    const payload = Object.keys(req.body || {}).length ? req.body : req.query || {};
    res.json({ ok: true }); // reply immediately
    console.log("📞 Incoming Zadarma event:", payload);

    // OPTIONAL: push to ATZ (leave commented until your webhook is stable)
    if (false && ATZ_TOKEN) {
      /*
      await axios.post("https://api.atzcrm.com/v1/example-call-log", {
        phone: payload.caller_id || payload.caller || payload.from || "",
        direction: payload.call_type || payload.direction || "",
        event: payload.event || "",
        when: new Date().toISOString(),
        notes: `From Zadarma call_id=${payload.call_id || payload.pbx_call_id || "n/a"}`
      }, {
        headers: { Authorization: `Bearer ${ATZ_TOKEN}` }
      });
      */
    }
  } catch (err) {
    console.error("❌ Error handling event:", err?.response?.data || err?.message || err);
  }
});

// Global error visibility
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION:", e);
});
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e);
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook listening on port ${PORT}`);
});

