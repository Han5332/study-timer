// server.js
const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---------- Static UI ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ---------- Mongo ----------
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT      = process.env.PORT || 3000;

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

// ---------- Notion (safe/optional + auto-map) ----------
let NotionClientCtor = null;
try {
  NotionClientCtor = require("@notionhq/client").Client; // only if installed
} catch {
  console.log("Notion SDK not installed; skipping Notion sync");
}

const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_DB    = process.env.NOTION_DATABASE_ID || "";

const notion =
  NotionClientCtor && NOTION_TOKEN && NOTION_DB
    ? new NotionClientCtor({ auth: NOTION_TOKEN })
    : null;

// Discover the first title/date/number/rich_text props in the DB
async function mapNotionProps() {
  if (!notion) return null;
  const db = await notion.databases.retrieve({ database_id: NOTION_DB });
  const props = db.properties || {};
  const first = (t) =>
    Object.entries(props).find(([_, v]) => v.type === t)?.[0] || null;
  return {
    title: first("title"),     // required
    date: first("date"),       // required (for calendar)
    number: first("number"),   // optional (Minutes)
    rich_text: first("rich_text"), // optional (Subject)
    all: Object.keys(props),
  };
}

// Create a Notion page for the session
async function pushToNotion({ subject, startedAt, endedAt, minutes }) {
  if (!notion) return { skipped: true, reason: "notion-not-configured" };
  const map = await mapNotionProps();
  if (!map || !map.title || !map.date) {
    throw new Error(
      `Notion DB missing required properties (found: ${JSON.stringify(map?.all || [])})`
    );
  }
  const properties = {
    [map.title]: {
      title: [{ text: { content: subject ? `Study: ${subject}` : "Study Session" } }],
    },
    [map.date]: {
      date: {
        start: new Date(startedAt).toISOString(),
        end:   new Date(endedAt).toISOString(),
      },
    },
  };
  if (map.number) properties[map.number] = { number: Math.round(minutes * 100) / 100 };
  if (map.rich_text && subject)
    properties[map.rich_text] = { rich_text: [{ text: { content: subject } }] };

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DB },
    properties,
  });
  return { pageId: page.id, mapped: map };
}

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- START ----------
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

// ---------- STOP (open-first, then latest fallback, always try Notion) ----------
app.post("/stop", async (_req, res) => {
  try {
    const now = new Date();

    // 1) close latest open session
    let r = await sessions.findOneAndUpdate(
      { endedAt: null },
      { $set: { endedAt: now } },
      { sort: { startedAt: -1 }, returnDocument: "after" }
    );

    // 2) fallback: if none open, pick most recent and ensure it has endedAt
    let d = r?.value;
    if (!d) {
      const latest = await sessions.find().sort({ startedAt: -1 }).limit(1).toArray();
      if (latest.length === 0) {
        console.warn("STOP: no sessions exist");
        return res.status(404).json({ ok: false, error: "NO_SESSIONS" });
      }
      d = latest[0];
      if (!d.endedAt) {
        d.endedAt = now;
        await sessions.updateOne({ _id: d._id }, { $set: { endedAt: d.endedAt } });
      }
      console.log("STOP ok (fallback)", { _id: String(d._id) });
    } else {
      console.log("STOP ok (open)", { _id: String(d._id) });
    }

    const minutes = (new Date(d.endedAt) - new Date(d.startedAt)) / 60000;

    // Push to Notion (non-fatal if misconfigured)
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

// ---------- Sessions list (sanity) ----------
app.get("/sessions", async (_req, res) => {
  try {
    const list = await sessions.find().sort({ startedAt: -1 }).limit(50).toArray();
    res.json(list);
  } catch (e) {
    console.error("SESSIONS error", e);
    res.status(500).json({ ok: false, error: "LIST_FAILED" });
  }
});

// ---------- Notion debug helpers ----------
app.get("/notion/check", async (_req, res) => {
  try {
    if (!notion) return res.json({ ok: false, error: "notion-not-configured" });
    const map = await mapNotionProps();
    res.json({ ok: true, database: NOTION_DB, map });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/notion/test", async (_req, res) => {
  try {
    if (!notion) return res.json({ ok: false, error: "notion-not-configured" });
    const now = new Date();
    const started = new Date(now.getTime() - 5 * 60000);
    const out = await pushToNotion({ subject: "Test", startedAt: started, endedAt: now, minutes: 5 });
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => console.log("Timer running on", PORT));
