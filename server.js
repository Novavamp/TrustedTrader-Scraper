import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runScraper } from './lib/scraper.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const rootDir = process.cwd();
const downloadsDir = path.join(rootDir, 'downloads');
fs.mkdirSync(downloadsDir, { recursive: true });
app.use(express.static(path.join(rootDir, 'public')));

// Job IDs are random capability tokens. Keep generated files out of the public
// static directory and expose them only through the matching job download route.
const jobs = new Map();
const MAX_ACTIVE_JOBS = 2;
const MAX_JOB_AGE_MS = 60 * 60 * 1000;

function sendEvent(job, event) {
  job.events.push(event);
  if (job.events.length > 50) job.events.shift();
  for (const client of job.clients) {
    if (!client.writableEnded) client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function publicJob(job) {
  return {
    scraped: job.scraped,
    total: job.total,
    currentCategory: job.currentCategory,
    currentTrader: job.currentTrader,
    finished: job.finished,
    cancelled: job.cancelled,
    fileReady: Boolean(job.file),
    last: job.last,
  };
}

function pruneJobs() {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.finished && job.clients.size === 0) {
      if (job.file) fs.promises.unlink(job.file).catch(() => {});
      jobs.delete(id);
    }
  }
}
setInterval(pruneJobs, 5 * 60 * 1000).unref();

app.post('/api/scrape', async (req, res) => {
  const region = typeof req.body?.region === 'string' ? req.body.region.trim() : '';
  const limit = req.body?.limit === undefined ? 0 : Number(req.body.limit);
  if (region.length > 80 || /[\\/\\0]/.test(region)) {
    return res.status(400).json({ error: 'Region must be a plain text value of at most 80 characters.' });
  }
  if (!Number.isInteger(limit) || limit < 0 || limit > 5000) {
    return res.status(400).json({ error: 'Limit must be an integer between 0 and 5000.' });
  }
  const activeJobs = [...jobs.values()].filter((job) => !job.finished).length;
  if (activeJobs >= MAX_ACTIVE_JOBS) {
    return res.status(429).json({ error: 'The server is busy. Try again when an active job finishes.' });
  }

  const id = randomUUID();
  const controller = new AbortController();
  const file = path.join(downloadsDir, `export-${id}.csv`);
  const job = {
    id, region, scraped: 0, total: limit, currentCategory: null,
    currentTrader: null, last: '', finished: false, cancelled: false,
    file: null, outputPath: file, controller, clients: new Set(), events: [],
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  res.status(202).json({ jobId: id });

  try {
    await runScraper({
      region,
      limit,
      outFile: file,
      abortSignal: controller.signal,
      onProgress(event) {
        switch (event.type) {
          case 'progress':
            job.scraped = event.data.scraped ?? job.scraped;
            job.total = event.data.total ?? job.total;
            break;
          case 'category': job.currentCategory = event.data.name; break;
          case 'trader': job.currentTrader = event.data.url; break;
          case 'log': job.last = event.data.text ?? ''; break;
          case 'finished':
            if (!job.cancelled && fs.existsSync(file)) job.file = file;
            break;
          case 'error': job.last = event.data.text ?? 'Scraper error'; break;
        }
        sendEvent(job, event.type === 'finished'
          ? { type: 'finished', data: { fileReady: Boolean(job.file), totalScraped: job.scraped } }
          : event);
      },
    });
  } catch (error) {
    if (!job.cancelled) {
      job.last = error instanceof Error ? error.message : 'Unexpected scraper error';
      sendEvent(job, { type: 'error', data: { text: job.last } });
    }
  } finally {
    job.finished = true;
    job.controller = null;
    for (const client of job.clients) client.end();
    job.clients.clear();
    if (!job.file) fs.promises.unlink(file).catch(() => {});
  }
});

app.get('/api/scrape/events', (req, res) => {
  const id = typeof req.query.jobId === 'string' ? req.query.jobId : '';
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  job.clients.add(res);
  for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'status', data: publicJob(job) })}\n\n`);
  req.on('close', () => job.clients.delete(res));
});

app.post('/api/scrape/cancel', (req, res) => {
  const id = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.finished) return res.status(409).json({ error: 'Job has already finished.' });
  job.cancelled = true;
  job.last = 'Cancellation requested.';
  job.controller?.abort();
  sendEvent(job, { type: 'log', data: { text: job.last } });
  res.json({ message: 'Cancellation requested.' });
});

app.get('/api/scrape/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.finished || !job.file || !fs.existsSync(job.file)) {
    return res.status(404).json({ error: 'Export is not available.' });
  }
  res.download(job.file, `business-listings-${job.id}.csv`);
});

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
