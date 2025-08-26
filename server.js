const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// Serve UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

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
  await sessions.createIndex({ sid: 1 }, { sparse: true });
  console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
})().catch(e => { console.error("Mongo connect error:", e); process.exit(1); });

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// START — insert, return string id, and also store sid
app.post("/start", async (req, res) => {
  try {
    const subject = (req.body?.subject || "").slice(0, 200);
    const doc = { subject, startedAt: new Date(), endedAt: null };
    const r = await sessions.insertOne(doc);
    const idStr = r.insertedId.toHexString();
    await sessions.updateOne({ _id: r.insertedId }, { $set: { sid: idStr } });

    // post-insert check for diagnostics
    const check = await sessions.findOne({ _id: r.insertedId }, { projection: { _id: 1, sid: 1, endedAt: 1 } });
    console.log("START ok", { id: idStr, foundAfterInsert: !!check, endedAt: check?.endedAt ?? null });

    res.json({ ok: true, id: idStr, startedAt: doc.startedAt });
  } catch (e) {
    console.error("START error", e);
    res.status(500).json({ ok: false, error: "START_FAILED" });
  }
});

// STOP by id — tries multiple match strategies
// STOP: update by id (no endedAt filter), then by sid, then latest
app.post("/stop", async (req, res) => {
  try {
    const raw = req.body?.id;
    const idStr = (typeof raw === "string"
      ? raw
      : (raw && (raw.$oid || raw.oid || raw.id)) || String(raw || "")
    ).trim();

    const endedAt = new Date();
    let r, doc;

    // 1) Try _id as ObjectId (no endedAt filter)
    if (idStr) {
      try {
        r = await sessions.findOneAndUpdate(
          { _id: new (require("mongodb").ObjectId)(idStr) },
          { $set: { endedAt } },
          { returnDocument: "after" }
        );
        if (r?.value) {
          doc = r.value;
          const duration = (doc.endedAt - doc.startedAt) / 60000;
          console.log("STOP ok via _id:ObjectId", { id: idStr, duration });
          return res.json({ ok: true, id: String(doc._id), endedAt, duration });
        }
      } catch { /* if parse fails, fall through */ }

      // 2) Try _id as string
      r = await sessions.findOneAndUpdate(
        { _id: idStr },
        { $set: { endedAt } },
        { returnDocument: "after" }
      );
      if (r?.value) {
        doc = r.value;
        const duration = (doc.endedAt - doc.startedAt) / 60000;
        console.log("STOP ok via _id:string", { id: idStr, duration });
        return res.json({ ok: true, id: String(doc._id), endedAt, duration });
      }

      // 3) Try sid (string copy we wrote on start)
      r = await sessions.findOneAndUpdate(
        { sid: idStr },
        { $set: { endedAt } },
        { returnDocument: "after" }
      );
      if (r?.value) {
        doc = r.value;
        const duration = (doc.endedAt - doc.startedAt) / 60000;
        console.log("STOP ok via sid", { id: idStr, duration });
        return res.json({ ok: true, id: String(doc._id), endedAt, duration });
      }
    }

    // 4) Fallback: latest doc that is still open OR even if missing the field
    r = await sessions.findOneAndUpdate(
      { $or: [ { endedAt: null }, { endedAt: { $exists: false } } ] },
      { $set: { endedAt } },
      { sort: { startedAt: -1 }, returnDocument: "after" }
    );
    if (r?.value) {
      doc = r.value;
      const duration = (doc.endedAt - doc.startedAt) / 60000;
      console.warn("STOP ok via latest fallback", { id: String(doc._id), duration });
      return res.json({ ok: true, id: String(doc._id), endedAt, duration });
    }

    console.warn("STOP not found after all attempts", { idStr });
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  } catch (e) {
    console.error("STOP error", e);
    return res.status(500).json({ ok: false, error: "STOP_FAILED" });
  }
});


// NEW: STOP the latest open session regardless of id
app.post("/stop-latest", async (_req, res) => {
  try {
    const endedAt = new Date();
    const r = await sessions.findOneAndUpdate(
      { endedAt: null },
      { $set: { endedAt } },
      { sort: { startedAt: -1 }, returnDocument: "after" }
    );
    if (!r?.value) {
      console.warn("STOP-LATEST no open session");
      return res.status(404).json({ ok: false, error: "NO_OPEN_SESSION" });
    }
    const d = r.value;
    const duration = (d.endedAt - d.startedAt) / 60000;
    console.log("STOP ok via latest", { id: String(d._id), duration });
    res.json({ ok: true, id: String(d._id), endedAt, duration });
  } catch (e) {
    console.error("STOP-LATEST error", e);
    res.status(500).json({ ok: false, error: "STOP_LATEST_FAILED" });
  }
});

// List (for sanity)
app.get("/sessions", async (_req, res) => {
  const list = await sessions.find().sort({ startedAt: -1 }).limit(50).toArray();
  res.json(list);
});

// Debug (what the server sees)
app.get("/debug/latest", async (_req, res) => {
  const docs = await sessions.find({}, { projection: { _id: 1, sid: 1, startedAt: 1, endedAt: 1 } })
    .sort({ startedAt: -1 }).limit(5).toArray();
  res.json(docs.map(d => ({
    _id: typeof d._id === 'object' && d._id ? (d._id.toString ? d._id.toString() : d._id) : d._id,
    sid: d.sid || null, startedAt: d.startedAt, endedAt: d.endedAt
  })));
});

app.listen(PORT, () => console.log("Timer running on", PORT));
