// server.js
// Study Timer: Mongo + Notion (auto-mapped), resilient STOP flow, seconds shown in title.

const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

/* =========================
 * Static UI
 * ========================= */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* =========================
 * MongoDB
 * ========================= */
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT = process.env.PORT || 3000;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI");
  process.exit(1);
}

let sessions; // Mongo collection handle

(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  sessions = db.collection(COLL_NAME);
  await sessions.createIndex({ startedAt: -1 });
  console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
})().catch((e) => {
  console.error("Mongo connect error:", e);
  process.exit(1);
});

/* =========================
 * Notion (safe/optional; auto-map properties)
 * Supports either:
 *   - Start/End separate date columns, or
 *   - One Date column with a range (start/end)
 * Also fills number properties named like "Minutes" / "Duration (hours)"
 * and an optional rich_text "Subject".
 * ========================= */
let NotionClientCtor = null;
try {
  NotionClientCtor = require("@notionhq/client").Client; // only if installed
} catch {
  console.log("Notion SDK not installed; skipping Notion sync");
}

const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_DB = process.env.NOTION_DATABASE_ID || "";
const TIMEZONE = process.env.TIMEZONE || "UTC";

const notion =
  NotionClientCtor && NOTION_TOKEN && NOTION_DB
    ? new NotionClientCtor({ auth: NOTION_TOKEN })
    : null;

// Format HH:MM:SS in requested timezone for title text
function fmtHMS(d) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: TIMEZONE,
  }).format(new Date(d));
}

// Auto-detect Notion database property names
async function mapNotionProps() {
  if (!notion) return null;
  const db = await notion.databases.retrieve({ database_id: NOTION_DB });
  const props = db.properties || {};
  const entries = Object.entries(props);

  const title = entries.find(([_, v]) => v.type === "title")?.[0] || null;

  const dateNames = entries
    .filter(([_, v]) => v.type === "date")
    .map(([k]) => k);

  const startProp =
    dateNames.find((n) => /start/i.test(n)) ||
    dateNames.find((n) => /begin/i.test(n)) ||
    null;
  const endProp =
    dateNames.find((n) => /end/i.test(n)) ||
    dateNames.find((n) => /finish/i.test(n)) ||
    null;

  // If both Start+End not present, fall back to a single Date column (range)
  const rangeProp =
    !startProp || !endProp
      ? dateNames.find((n) => /^date$/i.test(n)) || dateNames[0] || null
      : null;

  const numberNames = entries
    .filter(([_, v]) => v.type === "number")
    .map(([k]) => k);

  // Try to find minutes/hours columns by name patterns
  const minutesProp =
    numberNames.find((n) => /minute|mins|min\b/i.test(n)) ||
    numberNames.find((n) => /duration.*min/i.test(n)) ||
    null;
  const hoursProp =
    numberNames.find((n) => /hour|hrs|duration(\s|\(|$)/i.test(n)) ||
    null;

  const subjectProp =
    entries.find(([k, v]) => v.type === "rich_text" && /subject/i.test(k))?.[0] ||
    entries.find(([k, v]) => v.type === "rich_text")?.[0] ||
    null;
  
// Wallet relation (preferred)
  const forcedWalletRel = process.env.NOTION_WALLET_RELATION_PROP || "";
  let walletRelationProp = null;
  if (forcedWalletRel && props[forcedWalletRel]?.type === "relation") {
    walletRelationProp = forcedWalletRel;
  } else {
    walletRelationProp = entries.find(([k, v]) => v.type === "relation" && /wallet/i.test(k))?.[0] || null;
  }

  // Wallet tag (select / multi_select) fallback
  const forcedWalletSel = process.env.NOTION_WALLET_SELECT_PROP || "";
  let walletSelectProp = null;
  let walletSelectType = null;
  const isSel = (v) => v.type === "select" || v.type === "multi_select";

  if (forcedWalletSel && props[forcedWalletSel] && isSel(props[forcedWalletSel])) {
    walletSelectProp = forcedWalletSel;
    walletSelectType = props[forcedWalletSel].type;
  } else {
    const found = entries.find(([k, v]) => isSel(v) && (/wallet|tag/i.test(k)));
    if (found) {
      walletSelectProp = found[0];
      walletSelectType = found[1].type; // "select" or "multi_select"
    }
  }

  return {
    title,
    startProp,
    endProp,
    rangeProp,
    minutesProp,
    hoursProp,
    subjectProp,
    walletRelationProp,
    walletSelectProp, 
    walletSelectType,
    all: Object.keys(props),
  };
}

async function pushToNotion({ subject, startedAt, endedAt, minutes }) {
  if (!notion) return { skipped: true, reason: "notion-not-configured" };

  const map = await mapNotionProps();
  if (!map || !map.title || (!map.rangeProp && !(map.startProp && map.endProp))) {
    throw new Error(`Notion DB needs a Title and either (Start+End) date columns or one Date column. Found: ${JSON.stringify(map?.all || [])}`);
  }

  const startISO = new Date(startedAt).toISOString();
  const endISO   = new Date(endedAt).toISOString();

  const DEFAULT_SUBJECT = process.env.DEFAULT_SUBJECT || "Misc";
  const cleanSubject = (subject && String(subject).trim()) ? String(subject).trim() : DEFAULT_SUBJECT;

  const properties = {
    [map.title]: { title: [{ text: { content: cleanSubject } }] }
  };

  // dates
  if (map.startProp && map.endProp) {
    properties[map.startProp] = { date: { start: startISO } };
    properties[map.endProp]   = { date: { start: endISO } };
  } else if (map.rangeProp) {
    properties[map.rangeProp] = { date: { start: startISO, end: endISO } };
  }

  // numbers
  if (map.minutesProp) properties[map.minutesProp] = { number: Math.round(minutes * 100) / 100 };
  if (map.hoursProp)   properties[map.hoursProp]   = { number: Math.round((minutes / 60) * 1000) / 1000 };

  // subject (optional mirror)
  if (map.subjectProp) {
    properties[map.subjectProp] = { rich_text: [{ text: { content: cleanSubject } }] };
  }

  // ------- WALLET RELATION -------
  const walletPageId = await resolveWalletPageId();
  if (walletPageId && map.walletRelationProp) {
    properties[map.walletRelationProp] = { relation: [{ id: walletPageId }] };
  }
  // --------------------------------

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DB },
    properties
  });

  return { pageId: page.id, mapped: map, title: cleanSubject, linkedWallet: !!(walletPageId && map.walletRelationProp) };
}



/* =========================
 * Health
 * ========================= */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* =========================
 * START
 * ========================= */
app.post("/start", async (req, res) => {
  try {
    const subject = (req.body?.subject || "").slice(0, 200);
    const doc = { subject, startedAt: new Date(), endedAt: null };
    const r = await sessions.insertOne(doc);
    console.log("START ok", { _id: r.insertedId.toHexString() });
    res.json({ ok: true, startedAt: doc.startedAt });
  } catch (e) {
    console.error("START error", e);
    res.status(500).json({ ok: false, error: "START_FAILED" });
  }
});

/* =========================
 * STOP
 * - Close latest open session
 * - If none open, close the most recent session (fallback)
 * - Always attempt Notion sync after writing Mongo
 * ========================= */
app.post("/stop", async (_req, res) => {
  try {
    const now = new Date();

    // 1) try to close the latest open session
    let r = await sessions.findOneAndUpdate(
      { endedAt: null },
      { $set: { endedAt: now } },
      { sort: { startedAt: -1 }, returnDocument: "after" }
    );

    // 2) fallback: if nothing open, take the most recent and ensure it has endedAt
    let d = r?.value;
    if (!d) {
      const latest = await sessions
        .find()
        .sort({ startedAt: -1 })
        .limit(1)
        .toArray();

      if (latest.length === 0) {
        console.warn("STOP: no sessions exist");
        return res.status(404).json({ ok: false, error: "NO_SESSIONS" });
      }

      d = latest[0];
      if (!d.endedAt) {
        d.endedAt = now;
        await sessions.updateOne(
          { _id: d._id },
          { $set: { endedAt: d.endedAt } }
        );
      }
      console.log("STOP ok (fallback)", { _id: String(d._id) });
    } else {
      console.log("STOP ok (open)", { _id: String(d._id) });
    }

    const minutes =
      (new Date(d.endedAt) - new Date(d.startedAt)) / 60000;

    // Notion (non-fatal)
    try {
      const out = await pushToNotion({
        subject: d.subject || "",
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        minutes,
      });
      console.log("Notion sync", out);
    } catch (e) {
      console.error("Notion sync error", e?.message || e);
    }

    res.json({ ok: true, endedAt: d.endedAt, duration: minutes });
  } catch (e) {
    console.error("STOP error", e);
    res.status(500).json({ ok: false, error: "STOP_FAILED" });
  }
});

/* =========================
 * Sessions list (for sanity)
 * ========================= */
app.get("/sessions", async (_req, res) => {
  try {
    const list = await sessions
      .find()
      .sort({ startedAt: -1 })
      .limit(100)
      .toArray();
    res.json(list);
  } catch (e) {
    console.error("SESSIONS error", e);
    res.status(500).json({ ok: false, error: "LIST_FAILED" });
  }
});

/* =========================
 * Notion debug helpers
 * ========================= */
app.get("/notion/check", async (_req, res) => {
  try {
    if (!notion)
      return res.json({ ok: false, error: "notion-not-configured" });
    const map = await mapNotionProps();
    res.json({ ok: true, database: NOTION_DB, map });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/notion/test", async (_req, res) => {
  try {
    if (!notion)
      return res.json({ ok: false, error: "notion-not-configured" });
    const now = new Date();
    const started = new Date(now.getTime() - 5 * 60000);
    const out = await pushToNotion({
      subject: "Test",
      startedAt: started,
      endedAt: now,
      minutes: 5,
    });
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
 * Start server
 * ========================= */
app.listen(PORT, () => console.log("Timer running on", PORT));
