const { Client: NotionClient } = require("@notionhq/client");

const NOTION_TOKEN  = process.env.NOTION_TOKEN || "";          // required to sync
const NOTION_DB     = process.env.NOTION_DATABASE_ID || "";     // your DB id
const P_TITLE       = process.env.NOTION_TITLE_PROP   || "Name";
const P_DATE        = process.env.NOTION_DATE_PROP    || "Date";
const P_MINUTES     = process.env.NOTION_MINUTES_PROP || "";    // optional
const P_SUBJECT     = process.env.NOTION_SUBJECT_PROP || "";    // optional

const notion = (NOTION_TOKEN && NOTION_DB)
  ? new NotionClient({ auth: NOTION_TOKEN })
  : null;

// Create a Notion calendar entry
async function pushToNotion({ subject, startedAt, endedAt, minutes }) {
  if (!notion) return null; // Not configured; skip
  const props = {};

  // Title
  props[P_TITLE] = {
    title: [{ text: { content: subject ? `Study: ${subject}` : "Study Session" } }]
  };

  // Date range (calendar uses this)
  props[P_DATE] = {
    date: {
      start: new Date(startedAt).toISOString(),
      end:   new Date(endedAt).toISOString()
    }
  };

  // Optional Minute count
  if (P_MINUTES) {
    props[P_MINUTES] = { number: Math.round(minutes * 100) / 100 };
  }

  // Optional raw subject
  if (P_SUBJECT && subject) {
    props[P_SUBJECT] = { rich_text: [{ text: { content: subject } }] };
  }

  return await notion.pages.create({
    parent: { database_id: NOTION_DB },
    properties: props
  });
}


















const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// serve UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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

app.get("/health", (_req, res) => res.json({ ok: true }));

// START: create an open session
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

app.post("/stop", async (_req, res) => {
  try {
    const endedAt = new Date();
    const r = await sessions.findOneAndUpdate(
      { endedAt: null },
      { $set: { endedAt } },
      { sort: { startedAt: -1 }, returnDocument: "after" }
    );

    if (!r?.value) {
      console.warn("STOP: no open session");
      return res.status(404).json({ ok: false, error: "NO_OPEN_SESSION" });
    }

    const d = r.value;
    const minutes = (d.endedAt - d.startedAt) / 60000;

    // Fire-and-wait (simple & reliable). If you prefer non-blocking, remove await.
    try {
      await pushToNotion({
        subject: d.subject || "",
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        minutes
      });
      console.log("Notion sync ok");
    } catch (e) {
      console.error("Notion sync error", e?.message || e);
    }

    console.log("STOP ok", { id: String(d._id), minutes });
    res.json({ ok: true, endedAt, duration: minutes });
  } catch (e) {
    console.error("STOP error", e);
    res.status(500).json({ ok: false, error: "STOP_FAILED" });
  }
});


// list for sanity
app.get("/sessions", async (_req, res) => {
  const list = await sessions.find().sort({ startedAt: -1 }).limit(50).toArray();
  res.json(list);
});

app.listen(PORT, () => console.log("Timer running on", PORT));
