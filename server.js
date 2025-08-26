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

// STOP: close the latest open session (no id needed)
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
    const duration = (d.endedAt - d.startedAt) / 60000;
    console.log("STOP ok", { _id: String(d._id), duration });
    res.json({ ok: true, endedAt, duration });
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
