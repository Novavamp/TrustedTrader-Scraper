import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors());

// Serve frontend & downloads
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

// Store running scraper jobs
const JOBS = {};
// JOB STRUCTURE:
// {
//   id,
//   child,
//   last,
//   scraped,
//   total,
//   currentCategory,
//   currentTrader,
//   file,
//   start,
//   finished
// }


/* ---------------------------------------------------
   START SCRAPER JOB
--------------------------------------------------- */
app.post("/api/scrape", (req, res) => {
  const { region, limit } = req.body;
  const jobId = randomUUID();

  const outFile = `trustedtrader_${region.replace(/\s+/g, "_")}_${Date.now()}.csv`;
  const filePath = path.join(__dirname, "downloads", outFile);

  // Spawn CLI scraper
  const child = spawn("node", [
    path.join(__dirname, "scraper.js"),
    "--region", region,
    "--limit", String(limit || 0),
    "--out", filePath
  ]);

  JOBS[jobId] = {
    id: jobId,
    child,
    file: null,
    last: "",
    scraped: 0,
    total: Number(limit) || 0,
    currentCategory: null,
    currentTrader: null,
    start: Date.now(),
    finished: false
  };

  /* Parse scraper stdout for data to feed SSE */
  child.stdout.on("data", chunk => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      JOBS[jobId].last = line;

      // Detect total count (if your scraper outputs it)
      const tot = line.match(/total traders:\s*(\d+)/i);
      if (tot) JOBS[jobId].total = Number(tot[1]);

      // Detect scraped count
      const scr = line.match(/scraped \(total so far\):\s*(\d+)/i);
      if (scr) JOBS[jobId].scraped = Number(scr[1]);

      // Detect category
      const cat = line.match(/^Processing category "([^"]+)"/i);
      if (cat) JOBS[jobId].currentCategory = cat[1];

      // Detect trader
      const tr = line.match(/-> scraping trader\s+(.*)$/i);
      if (tr) JOBS[jobId].currentTrader = tr[1];
    }
  });

  child.stderr.on("data", err => {
    JOBS[jobId].last = "[stderr] " + String(err);
  });

  child.on("exit", () => {
    JOBS[jobId].finished = true;
    JOBS[jobId].file = "/downloads/" + outFile;
  });

  res.json({ jobId });
});

/* ---------------------------------------------------
   CANCEL SCRAPER JOB
--------------------------------------------------- */
app.post("/api/scrape/cancel", (req, res) => {
  const { jobId } = req.body;
  const job = JOBS[jobId];

  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.child) job.child.kill("SIGINT");

  return res.json({ message: "Cancellation requested" });
});

/* ---------------------------------------------------
   SEND EVENTS (SSE)
--------------------------------------------------- */
app.get("/api/scrape/events", (req, res) => {
  const { jobId } = req.query;
  const job = JOBS[jobId];

  if (!job) {
    res.writeHead(404);
    return res.end("Unknown jobId");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });

  const int = setInterval(() => {
    if (!JOBS[jobId]) return;

    const j = JOBS[jobId];
    const events = [];

    // Log event
    if (j.last) {
      events.push({ type: "log", data: { text: j.last } });
      j.last = null;
    }

    // Progress event
    events.push({
      type: "progress",
      data: { scraped: j.scraped, total: j.total }
    });

    // Category event
    if (j.currentCategory) {
      events.push({
        type: "category",
        data: { name: j.currentCategory }
      });
    }

    // Trader event
    if (j.currentTrader) {
      events.push({
        type: "trader",
        data: { url: j.currentTrader }
      });
    }

    // Finish event
    if (j.finished) {
      events.push({
        type: "finished",
        data: { file: j.file }
      });

      events.forEach(e =>
        res.write(`data: ${JSON.stringify(e)}\n\n`)
      );

      clearInterval(int);
      return;
    }

    // Push all events now
    events.forEach(e =>
      res.write(`data: ${JSON.stringify(e)}\n\n`)
    );

  }, 500);

  req.on("close", () => clearInterval(int));
});

/* ---------------------------------------------------
   SERVER START
--------------------------------------------------- */
const PORT = 3000;
app.listen(PORT, () =>
  console.log(`Scraper server running at http://localhost:${PORT}`)
);
