const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || "studytimer";
const COLL_NAME = process.env.MONGO_COLLECTION || "sessions";
const PORT = process.env.PORT || 3000;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI");
  process.exit(1);
}

let sessions;
async function initMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  sessions = db.collection(COLL_NAME);
  console.log("Connected to MongoDB", DB_NAME, COLL_NAME);
}
initMongo();

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/start", async (req, res) => {
  const subject = req.body?.subject || "";
  const doc = { subject, startedAt: new Date(), endedAt: null };
  const r = await sessions.insertOne(doc);
  res.json({ ok: true, id: r.insertedId, startedAt: doc.startedAt });
});

app.post("/stop", async (req, res) => {
  const id = req.body?.id;
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
  const endedAt = new Date();
  const r = await sessions.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { endedAt } },
    { returnDocument: "after" }
  );
  if (!r.value) return res.status(404).json({ ok: false, error: "Not found" });
  const doc = r.value;
  let duration = null;
  if (doc.startedAt && doc.endedAt) duration = (doc.endedAt - doc.startedAt)/60000;
  res.json({ ok: true, endedAt, duration });
});

app.get("/sessions", async (_req, res) => {
  const list = await sessions.find().sort({ startedAt: -1 }).toArray();
  res.json(list);
});

app.listen(PORT, () => console.log("Timer running on", PORT));
