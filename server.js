const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- Static UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---- Mongo
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME   = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT      = process.env.PORT || 3000;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

let sessions;
(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  sessions = db.collection(COLL_NAME);
  await sessions.createIndex({ startedAt: -1 });
  console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
})().catch(e => { console.error("Mongo connect error:", e); process.exit(1); });

// ---- Notion (safe/optional)
let NotionClientCtor = null;
try { NotionClientCtor = require("@notionhq/client").Client; }
catch { console.log("Notion SDK not installed; skipping Notion sync"); }

const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_DB    = process.env.NOTION_DATABASE_ID || "";
const P_TITLE      = process.env.NOTION_TITLE_PROP   || "Name";
const P_DATE       = process.env.NOTION_DATE_PROP    || "Date";
const P_MINUTES    = process.env.NOTION_MINUTES_PROP || "";     // optional
const P_SUBJECT    = process.env.NOTION_SUBJECT_PROP || "";     // optional

const notion = (NotionClientCtor && NOTION_TOKEN && NOTION_DB)
  ? new NotionClientCtor({ auth: NOTION_TOKEN })
  : null;

async function pushToNotion({ subject, startedAt, endedAt, minutes }) {
  if (!notion) return null;
  const props = {
    [P_TITLE]: { title: [{ text: { content: subject ? `Study: ${subject}` : "Study Session" } }] },
    [P_DATE]:  { date: { start: new Date(startedAt).toISOString(), end: new Date(endedAt).toISOString() } },
  };
  if (P_MINUTES) props[P_MINUTES] = { number: Math.round(minutes * 100) / 100 };
  if (P_SUBJECT && subject) props[P_SUBJECT] = { rich_text: [{ text: { content: subject } }] };
  return notion.pages.create({ parent: { database_id: NOTION_DB }, properties: props });
}

// ---- Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- START
app.post("/start", async (req, res) => {
  const subject = (req.body?.subject || "").slice(0, 200);
  const doc = { subject, startedAt: new Date(), endedAt: null };
  const r = await sessions.insertOne(doc);
  console.log("START ok", { _id: r.insertedId.toHexString() });
  res.json({ ok: true, startedAt: doc.startedAt });
});

// ---- STOP (bullet-proof: open → latest fallback → always push to Notion)
app.post("/stop", async (_req, res) => {
  const now = new Date();

  // 1) Try to close latest open session
  let r = await sessions.findOneAndUpdate(
    { endedAt: null },
    { $set: { endedAt: now } },
    { sort: { startedAt: -1 }, returnDocument: "after" }
  );

  // 2) If none open, fallback: take the most recent session and ensure it has endedAt
  if (!r?.value) {
    const latest = await sessions.find().sort({ startedAt: -1 }).limit(1).toArray();
    if (latest.length === 0) {
      console.warn("STOP: no sessions exist");
      return res.status(404).json({ ok: false, error: "NO_SESSIONS" });
    }
    const d = latest[0];
    const endedAt = d.endedAt ? new Date(d.endedAt) : now;
    if (!d.endedAt) {
      await sessions.updateOne({ _id: d._id }, { $set: { endedAt } });
    }
    const minutes = (endedAt - new Date(d.startedAt)) / 60000;
    try { await pushToNotion({ subject: d.subject || "", startedAt: d.startedAt, endedAt, minutes }); console.log("Notion sync ok (fallback)"); } catch (e) { console.error("Notion sync error", e?.message || e); }
    console.log("STOP ok (fallback)", { _id: String(d._id), minutes });
    return res.json({ ok: true, endedAt, duration: minutes, fallback: true });
  }

  // 3) Open-session path
  const d = r.value;
  const minutes = (new Date(d.endedAt) - new Date(d.startedAt)) / 60000;
  try { await pushToNotion({ subject: d.subject || "", startedAt: d.startedAt, endedAt: d.endedAt, minutes }); console.log("Notion sync ok"); } catch (e) { console.error("Notion sync error", e?.message || e); }
  console.log("STOP ok (open)", { _id: String(d._id), minutes });
  res.json({ ok: true, endedAt: d.endedAt, duration: minutes });
});

// ---- List
app.get("/sessions", async (_req, res) => {
  const list = await sessions.find().sort({ startedAt: -1 }).limit(50).toArray();
  res.json(list);
});

app.listen(PORT, () => console.log("Timer running on", PORT));
