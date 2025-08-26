// Minimal Notion Study Timer (single-origin)
const express = require("express");
const path = require("path");
const { Client } = require("@notionhq/client");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve UI

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const isoNow = () => new Date().toISOString();

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Start a session: creates a Notion page with Start Time
app.post("/start", async (req, res) => {
  try {
    const subject = (req.body && req.body.subject) ? String(req.body.subject) : "";
    const page = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        "Name": { title: [{ text: { content: subject ? `Study: ${subject}` : "Study Session" } }] },
        "Start Time": { date: { start: isoNow() } },
        ...(subject ? { "Subject": { rich_text: [{ text: { content: subject } }] } } : {})
      }
    });
    res.json({ ok: true, pageId: page.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop a session: updates End Time on the Notion page
app.post("/stop", async (req, res) => {
  try {
    const pageId = String(req.body.pageId || "");
    if (!pageId) return res.status(400).json({ ok: false, error: "Missing pageId" });
    await notion.pages.update({
      page_id: pageId,
      properties: {
        "End Time": { date: { start: isoNow() } }
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Notion Basic Timer on :${port}`));
