const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json());

// 1) Serve /public statics
app.use(express.static(path.join(__dirname, "public")));

// 2) Explicit root route to index.html (fixes "Cannot GET /")
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Mongo setup ---
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT = process.env.PORT || 3000;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI"); process.exit(1);
}

let sessions;
async function initMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    sessions = db.collection(COLL_NAME);
    await sessions.createIndex({ startedAt: -1 }).catch(() => {});
    console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
  } catch (e) {
    console.error("Mongo connect error:", e);
    process.exit(1);
  }
}
initMongo();

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Start
app.post("/start", async (req, res) => {
  const subject = (req.body?.subject || "").slice(0, 200);
  const doc = { subject, startedAt: new Date(), endedAt: null };
  const r = await sessions.insertOne(doc);
  res.json({ ok: true, id: r.insertedId, startedAt: doc.startedAt });
});

// Stop
app.post("/stop", async (req, res) => {
  const id = req.body?.id;
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
  const endedAt = new Date();
  const r = await sessions.findOneAndUpdate(
    { _id: new (require("mongodb").ObjectId)(id) },
    { $set: { endedAt } },
    { returnDocument: "after" }
  );
  if (!r.value) return res.status(404).json({ ok: false, error: "Not found" });
  const doc = r.value;
  const duration = doc.startedAt && doc.endedAt ? (doc.endedAt - doc.startedAt) / 60000 : null;
  res.json({ ok: true, endedAt, duration });
});

// Sessions
app.get("/sessions", async (_req, res) => {
  const list = await sessions.find().sort({ startedAt: -1 }).limit(500).toArray();
  res.json(list);
});

app.listen(PORT, () => console.log("Timer running on", PORT));
