const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "256kb" }));

// serve UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// env
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT = process.env.PORT || 3000;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI");
  process.exit(1);
}

let sessions;

// connect Mongo
(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  sessions = db.collection(COLL_NAME);
  await sessions.createIndex({ startedAt: -1 }).catch(() => {});
  console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
})().catch((e) => {
  console.error("Mongo connect error:", e);
  process.exit(1);
});

// health
app.get("/health", (_req, res) => res.json({ ok: true }));

// start
app.post("/start", async (req, res) => {
  try {
    const subject = (req.body?.subject || "").slice(0, 200);
    const doc = { subject, startedAt: new Date(), endedAt: null };
    const r = await sessions.insertOne(doc);
    const id = r.insertedId.toHexString();            // <- force string id
    console.log("START ok", { id, subject });
    res.json({ ok: true, id, startedAt: doc.startedAt });
  } catch (e) {
    console.error("START error", e);
    res.status(500).json({ ok: false, error: "START_FAILED" });
  }
});

// stop
app.post("/stop", async (req, res) => {
  try {
    let raw = req.body?.id;
    // normalize & trim
    const idStr = (typeof raw === "string"
      ? raw
      : (raw && (raw.$oid || raw.oid || raw.id)) || String(raw || "")
    ).trim();

    const endedAt = new Date();
    let result = null;

    // 1) Try ObjectId(_id)
    try {
      if (idStr) {
        result = await sessions.findOneAndUpdate(
          { _id: new (require("mongodb").ObjectId)(idStr) },
          { $set: { endedAt } },
          { returnDocument: "after" }
        );
      }
    } catch { /* ignore parse errors */ }

    // 2) Try string _id
    if (!result?.value && idStr) {
      result = await sessions.findOneAndUpdate(
        { _id: idStr },
        { $set: { endedAt } },
        { returnDocument: "after" }
      );
    }

    // 3) Fallback: stop the most recent "open" session
    if (!result?.value) {
      result = await sessions.findOneAndUpdate(
        { endedAt: null },
        { $set: { endedAt } },
        { sort: { startedAt: -1 }, returnDocument: "after" }
      );
      if (result?.value) {
        console.warn("STOP fallback used (ended latest open session)", {
          fallbackId: String(result.value._id)
        });
      }
    }

    if (!result?.value) {
      console.warn("STOP not found after all attempts", { idStr });
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const doc = result.value;
    const duration = (doc.startedAt && doc.endedAt)
      ? (doc.endedAt - doc.startedAt) / 60000
      : null;

    console.log("STOP ok", { id: String(doc._id), duration });
    res.json({ ok: true, id: String(doc._id), endedAt, duration });
  } catch (e) {
    console.error("STOP error", e);
    res.status(500).json({ ok: false, error: "STOP_FAILED" });
  }
});


// list
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
