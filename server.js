const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// Serve UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Env
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT = process.env.PORT || 3000;

if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

let sessions;

// Connect Mongo
(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  sessions = db.collection(COLL_NAME);
  await sessions.createIndex({ startedAt: -1 });
  await sessions.createIndex({ sid: 1 }, { sparse: true, unique: false });
  console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
})().catch(e => { console.error("Mongo connect error:", e); process.exit(1); });

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// START: insert, return string id, and also write sid on the doc
app.post("/start", async (req, res) => {
  try {
    const subject = (req.body?.subject || "").slice(0, 200);
    const doc = { subject, startedAt: new Date(), endedAt: null };
    const r = await sessions.insertOne(doc);
    const idStr = r.insertedId.toHexString();

    // persist sid on the same doc (avoids any ObjectId vs string mismatch later)
    await sessions.updateOne({ _id: r.insertedId }, { $set: { sid: idStr } });

    // post-insert sanity read
    const check = await sessions.findOne({ _id: r.insertedId });
    console.log("START ok", { id: idStr, foundAfterInsert: !!check });

    res.json({ ok: true, id: idStr, startedAt: doc.startedAt });
  } catch (e) {
    console.error("START error", e);
    res.status(500).json({ ok: false, error: "START_FAILED" });
  }
});

// STOP: try multiple match strategies incl. latest open
app.post("/stop", async (req, res) => {
  try {
    // normalize id
    const raw = req.body?.id;
    const idStr = (typeof raw === "string"
      ? raw
      : (raw && (raw.$oid || raw.oid || raw.id)) || String(raw || "")
    ).trim();

    const endedAt = new Date();
    let result = null;

    // 1) _id: ObjectId
    if (idStr) {
      try {
        result = await sessions.findOneAndUpdate(
          { _id: new ObjectId(idStr) },
          { $set: { endedAt } },
          { returnDocument: "after" }
        );
        if (result?.value) {
          const doc = result.value;
          const duration = doc.startedAt && doc.endedAt ? (doc.endedAt - doc.startedAt) / 60000 : null;
          console.log("STOP ok via _id:ObjectId", { id: idStr, duration });
          return res.json({ ok: true, id: String(doc._id), endedAt, duration });
        }
      } catch (_) { /* parse error falls through */ }
    }

    // 2) _id: string
    if (idStr && !result?.value) {
      result = await sessions.findOneAndUpdate(
        { _id: idStr },
        { $set: { endedAt } },
        { returnDocument: "after" }
      );
      if (result?.value) {
        const doc = result.value;
        const duration = doc.startedAt && doc.endedAt ? (doc.endedAt - doc.startedAt) / 60000 : null;
        console.log("STOP ok via _id:string", { id: idStr, duration });
        return res.json({ ok: true, id: String(doc._id), endedAt, duration });
      }
    }

    // 3) sid field (string copy of id)
    if (idStr && !result?.value) {
      result = await sessions.findOneAndUpdate(
        { sid: idStr },
        { $set: { endedAt } },
        { returnDocument: "after" }
      );
      if (result?.value) {
        const doc = result.value;
        const duration = doc.startedAt && doc.endedAt ? (doc.endedAt - doc.startedAt) / 60000 : null;
        console.log("STOP ok via sid", { id: idStr, duration });
        return res.json({ ok: true, id: String(doc._id), endedAt, duration });
      }
    }

    // 4) Fallback: latest open session
    result = await sessions.findOneAndUpdate(
      { endedAt: null },
      { $set: { endedAt } },
      { sort: { startedAt: -1 }, returnDocument: "after" }
    );
    if (result?.value) {
      const doc = result.value;
      const duration = doc.startedAt && doc.endedAt ? (doc.endedAt - doc.startedAt) / 60000 : null;
      console.warn("STOP fallback used (closed latest open)", { fallbackId: String(doc._id) });
      return res.json({ ok: true, id: String(doc._id), endedAt, duration });
    }

    console.warn("STOP not found after all attempts", { idStr });
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  } catch (e) {
    console.error("STOP error", e);
    res.status(500).json({ ok: false, error: "STOP_FAILED" });
  }
});

// List
app.get("/sessions", async (_req, res) => {
  try {
    const list = await sessions.find().sort({ startedAt: -1 }).limit(500).toArray();
    res.json(list);
  } catch (e) {
    console.error("SESSIONS error", e);
    res.status(500).json({ ok: false, error: "LIST_FAILED" });
  }
});

app.listen(PORT, () => console.log("Timer running on", PORT));
