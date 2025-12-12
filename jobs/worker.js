// jobs/worker.js
import { scrapeQueue } from "./queue.js";
import { runScraper } from "../lib/scraper.js";

async function main() {
    scrapeQueue.on('error', err => console.error('Queue error:', err));
    scrapeQueue.on('waiting', jobId => console.log('Job waiting:', jobId));
    scrapeQueue.on('active', job => console.log(`Worker: picked up job ${job.id}`, job.data));
    scrapeQueue.on('completed', (job, result) => console.log(`Job ${job.id} completed`, result));
    scrapeQueue.on('failed', (job, err) => console.error(`Job ${job.id} failed:`, err && err.message));

    await scrapeQueue.isReady();
    console.log('Worker: queue ready, listening for jobs...');

    scrapeQueue.process(async (job) => {
        console.log('Worker: processing job', job.id);
        const { region, limit, outFile } = job.data;

        const result = await runScraper({
            region,
            limit,
            outFile,
            onProgress: (event) => {
                // Forward the original structured event directly
                job.progress(event);
            }
        });

        return { file: result.file, totalScraped: result.totalScraped };
    });
}

main().catch(err => {
    console.error('Worker fatal error', err);
    process.exit(1);
});
