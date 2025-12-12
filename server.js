import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { runScraper } from './lib/scraper.js';

const app = express();
app.use(express.json());
app.use(cors());

const __dirname = path.resolve();
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

app.use(express.static(path.join(__dirname, "public")));
app.use('/downloads', express.static(downloadsDir));

const JOBS = {}; // store jobs in memory

/* -----------------------------
   Start scrape job
----------------------------- */
app.post("/api/scrape", (req, res) => {
    const { region, limit } = req.body;
    const jobId = randomUUID();

    JOBS[jobId] = {
        id: jobId,
        scraped: 0,
        total: Number(limit) || 0,
        currentCategory: null,
        currentTrader: null,
        last: '',
        finished: false,
        file: null,
        clients: new Set(), // SSE connections for this job
        events: []          // last 50 events buffer
    };

    (async () => {
        try {
            await runScraper({
                region,
                limit: Number(limit),
                outFile: path.join(downloadsDir, `trustedtrader_${(region || 'all').replace(/\s+/g, '_')}_${Date.now()}.csv`),
                onProgress: (evt) => {
                    const j = JOBS[jobId];
                    if (!j) return;

                    // update job state
                    switch (evt.type) {
                        case 'progress':
                            if (evt.data.scraped !== undefined) j.scraped = evt.data.scraped;
                            if (evt.data.total !== undefined) j.total = evt.data.total;
                            break;
                        case 'category':
                            j.currentCategory = evt.data.name;
                            break;
                        case 'trader':
                            j.currentTrader = evt.data.url;
                            break;
                        case 'log':
                            j.last = evt.data.text;
                            break;
                        case 'finished':
                            // create a public URL path (served from /downloads)
                            const publicFile = `/downloads/${path.basename(evt.data.file)}`;

                            j.finished = true;
                            j.file = publicFile;

                            // overwrite the event's file so we don't leak server filesystem paths to clients
                            evt.data.file = publicFile;

                            console.log('Saved file:', evt.data.file);
                            break;
                        case 'error':
                            j.last = "[error] " + evt.data.text;
                            break;
                    }

                    // push to buffer
                    j.events.push(evt);
                    if (j.events.length > 50) j.events.shift();

                    // send event to all clients
                    j.clients.forEach(res => {
                        try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { }
                    });
                }
            });
        } catch (err) {
            const j = JOBS[jobId];
            if (j) {
                j.last = "[fatal] " + err.message;
                j.finished = true;
                const evt = { type: 'error', data: { text: err.message } };
                j.events.push(evt);
                j.clients.forEach(res => {
                    try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { }
                });
            }
        }
    })();

    res.json({ jobId });
});

/* -----------------------------
   SSE: stream events in real-time
----------------------------- */
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

    // add client
    job.clients.add(res);

    // send buffered events first
    if (job.events && job.events.length) {
        job.events.forEach(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    }

    // send initial snapshot
    const snapshot = {
        type: 'status',
        data: {
            scraped: job.scraped,
            total: job.total,
            currentCategory: job.currentCategory,
            currentTrader: job.currentTrader,
            finished: job.finished,
            file: job.file,
            last: job.last
        }
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    // remove client on disconnect
    req.on('close', () => {
        job.clients.delete(res);
        console.log(`[sse] client disconnected for job ${jobId}`);
    });
});

/* -----------------------------
   Cancel job
----------------------------- */
app.post("/api/scrape/cancel", (req, res) => {
    const { jobId } = req.body;
    const job = JOBS[jobId];
    if (!job) return res.status(404).json({ error: "Job not found" });

    job.finished = true;
    job.last = "Job cancelled by user.";

    const evt = { type: 'log', data: { text: job.last } };
    job.events.push(evt);
    job.clients.forEach(res => {
        try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { }
    });

    res.json({ message: "Cancellation requested" });
});

/* -----------------------------
   Start server
----------------------------- */
const PORT = 4000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
