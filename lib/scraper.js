// lib/scraper.js
import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Parser as Json2csvParser } from 'json2csv';
import pLimit from 'p-limit';
import { URL } from 'url';
import path from 'path';

const DEFAULTS = {
    BASE: 'https://www.trustedtrader.scot',
    USER_AGENT: 'Mozilla/5.0 (compatible; TrustedTraderScraper/1.0)',
    DEFAULT_DELAY_MS: 900,
    RETRY_ATTEMPTS: 3,
    RETRY_BACKOFF_MS: 500,
    CONCURRENCY: 3,
    DEFAULT_LIMIT: 50,
    CSV_FIELDS: [
        'Title', 'Description', 'Tagline', 'Google Address', 'Latitude', 'Longitude', 'Phone', 'Email', 'Website',
        'Twitter', 'Facebook', 'Linkedin', 'Google_plus', 'Youtube', 'Instagram', 'Youtube Video URL',
        'Price Status ($-moderatemoderate)', 'Price From', 'Price To', 'Claim Status',
        'Faq Question (sep. by pipe sign | )', 'Faq Answer (sep. by pipe sign | )',
        'Gallery', 'Pricing Plan ID', 'Business Hours (Day,OpenTime,CloseTime)', 'Category', 'Features', 'Tags (Keywords)', 'Location'
    ]
};

/**
 * normalizeRegion - converts input region string to TitleCase words concatenated (same logic you had)
 */
function normalizeRegion(opt) {
    if (!opt) return '';
    const cleaned = String(opt).trim().replace(/\s+/g, ' ');
    const words = cleaned.split(/\s+/).map(w => {
        const alpha = w.replace(/[^A-Za-z0-9]/g, '');
        if (!alpha) return '';
        return alpha[0].toUpperCase() + alpha.slice(1).toLowerCase();
    }).filter(Boolean);
    return words.join('');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * runScraper(options)
 * - options: {
 *     region, limit, outFile, concurrency, userAgent, base, delayMs,
 *     retries, retryBackoffMs, onProgress, abortSignal
 *   }
 * - onProgress(event) where event = { type: 'log'|'progress'|'category'|'trader'|'record'|'finished'|'error', data }
 * - returns { file, totalScraped }
 */
export async function runScraper(opts = {}) {
    // Merge options with defaults
    const opt = {
        base: opts.base || DEFAULTS.BASE,
        userAgent: opts.userAgent || DEFAULTS.USER_AGENT,
        delayMs: typeof opts.delayMs === 'number' ? opts.delayMs : DEFAULTS.DEFAULT_DELAY_MS,
        retries: typeof opts.retries === 'number' ? opts.retries : DEFAULTS.RETRY_ATTEMPTS,
        retryBackoffMs: typeof opts.retryBackoffMs === 'number' ? opts.retryBackoffMs : DEFAULTS.RETRY_BACKOFF_MS,
        concurrency: typeof opts.concurrency === 'number' ? opts.concurrency : DEFAULTS.CONCURRENCY,
        totalLimit: typeof opts.limit === 'number' ? opts.limit : (typeof opts.totalLimit === 'number' ? opts.totalLimit : 0),
        regionRaw: opts.region || '',
        outFile: opts.outFile || path.join(process.cwd(), `trustedtrader_${Date.now()}.csv`),
        csvFields: opts.csvFields || DEFAULTS.CSV_FIELDS,
        onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : () => { },
        abortSignal: opts.abortSignal || null
    };

    let stopRequested = false;
    // wire abortSignal if provided
    if (opt.abortSignal) {
        if (opt.abortSignal.aborted) stopRequested = true;
        opt.abortSignal.addEventListener?.('abort', () => {
            stopRequested = true;
            opt.onProgress({ type: 'log', data: { text: 'Abort signal received — stopping gracefully...' } });
        });
    }

    // allow caller to cancel by setting a flag; also return a cancel() function
    const cancel = () => { stopRequested = true; };

    const REGION = normalizeRegion(opt.regionRaw);
    const TRADES_AZ_PATH = REGION ? `/${REGION}/tradesAZ` : `/tradesAZ`;

    // local helpers that capture opt
    async function fetchHTML(url, { retries = opt.retries, timeout = 20000 } = {}) {
        let lastErr = null;
        for (let i = 0; i < retries; i++) {
            if (stopRequested) throw new Error('Stopped by user');
            try {
                const res = await axios.get(url, {
                    headers: { 'User-Agent': opt.userAgent, Accept: 'text/html' },
                    timeout
                });
                return res.data;
            } catch (err) {
                lastErr = err;
                const backoff = opt.retryBackoffMs * Math.pow(2, i);
                opt.onProgress({ type: 'log', data: { text: `fetchHTML error for ${url} (attempt ${i + 1}/${retries}): ${err.message}. Retrying in ${backoff}ms...` } });
                await sleep(backoff);
            }
        }
        throw new Error(`fetchHTML failed for ${url}: ${lastErr ? lastErr.message : 'unknown error'}`);
    }

    function absolute(href) {
        if (!href) return '';
        try {
            return new URL(href, opt.base).toString();
        } catch {
            return href;
        }
    }

    // Category links
    async function getCategoryLinks() {
        const url = `${opt.base}${TRADES_AZ_PATH}`;
        opt.onProgress({ type: 'log', data: { text: `Fetching categories from ${url}` } });
        const html = await fetchHTML(url);
        const $ = cheerio.load(html);
        const links = new Map();

        $('a[href*="/search?bus_type="]').each((i, el) => {
            const $a = $(el);
            const href = $a.attr('href');
            const rawText = $a.text().trim();
            const title = $a.find('b').text().trim() || rawText;
            if (href && title) {
                const m = rawText.match(/\-\s*(\d+)\s*traders/i);
                const count = m ? Number(m[1]) : null;
                links.set(absolute(href.split('#')[0]), { title: title.replace(/\s+-\s+\d+\s+traders$/i, '').trim(), count });
            }
        });

        const arr = Array.from(links.entries()).map(([href, meta]) => ({ href, title: meta.title, count: meta.count || 0 }));
        opt.onProgress({ type: 'log', data: { text: `Found ${arr.length} category links.` } });
        return arr;
    }

    // detect region helper (same as original)
    function detectRegionFromHref(href, $el = null) {
        if (!href) return '';
        try {
            const clean = href.split(/[?#]/)[0];
            const parts = clean.split('/').filter(Boolean);
            if (parts.length >= 2 && parts[0] && !parts[0].toLowerCase().includes('search')) {
                return parts[0];
            }
        } catch (e) { }
        try {
            if ($el) {
                const alt = $el.find('.results_logo_align img').attr('alt') || $el.find('.results_logo_align').text();
                if (alt) return alt.trim().replace(/\s+/g, '');
            }
        } catch (e) { }
        return '';
    }

    async function getTradersFromCategory(categoryUrl) {
        opt.onProgress({ type: 'log', data: { text: `Fetching category results: ${categoryUrl}` } });
        const html = await fetchHTML(categoryUrl);
        const $ = cheerio.load(html);
        const resultMap = new Map();

        $('.search_results ul li a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const full = absolute(href);
            const regionDetected = detectRegionFromHref(href, $(el)) || REGION || '';
            resultMap.set(full, regionDetected);
        });

        $('span[itemscope] li a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const full = absolute(href);
            const regionDetected = detectRegionFromHref(href, $(el)) || REGION || '';
            resultMap.set(full, regionDetected);
        });

        const traders = Array.from(resultMap.entries()).map(([url, region]) => ({ url, region }));
        opt.onProgress({ type: 'log', data: { text: ` → ${traders.length} traders found on this page.` } });
        return traders;
    }

    // parse detail (keeps behaviour)
    async function parseTraderDetail(traderUrl, regionOverride) {
        try {
            const html = await fetchHTML(traderUrl);
            const $ = cheerio.load(html);

            const title = $('h1[itemprop="name"]').first().text().trim() || '';

            const street = $('div[itemprop="address"] [itemprop="streetAddress"]').first().text().trim() || '';
            const locality = $('div[itemprop="address"] [itemprop="addressLocality"]').first().text().trim() || '';
            const postcode = $('div[itemprop="address"] [itemprop="postalCode"]').first().text().trim() || '';

            const googleAddressParts = [];
            if (street) googleAddressParts.push(street.replace(/\s+<br>/i, ' '));
            if (locality) googleAddressParts.push(locality);
            if (postcode) googleAddressParts.push(postcode);
            const googleAddress = googleAddressParts.join(', ').replace(/\s+/g, ' ').trim();

            const lat = $('meta[itemprop="latitude"]').attr('content') ||
                $('div[itemprop="geo"] meta[itemprop="latitude"]').attr('content') || '';
            const lng = $('meta[itemprop="longitude"]').attr('content') ||
                $('div[itemprop="geo"] meta[itemprop="longitude"]').attr('content') || '';

            const phones = [];
            $('.details_tel[itemprop="telephone"], .search_results_tel, .details_tel').each((i, el) => {
                const t = $(el).text().replace(/\s+/g, ' ').trim();
                if (t) phones.push(t);
            });

            let website = '';
            const siteA = $('.details_web[itemprop="url"] a, .details_web a').first();
            if (siteA.length) website = absolute(siteA.attr('href') || siteA.text().trim());

            let facebook = '', twitter = '', instagram = '', linkedin = '';
            $('a').each((i, el) => {
                const h = ($(el).attr('href') || '').trim();
                if (!h) return;
                if (!facebook && h.includes('facebook.com')) facebook = absolute(h);
                if (!twitter && h.includes('twitter.com')) twitter = absolute(h);
                if (!instagram && h.includes('instagram.com')) instagram = absolute(h);
                if (!linkedin && h.includes('linkedin.com')) linkedin = absolute(h);
            });

            const description = $('div[itemprop="description"]').first().text().trim().replace(/\s+/g, ' ') || '';

            const categories = [];
            $('.details_cat a').each((i, el) => {
                const txt = $(el).text().trim();
                if (txt) categories.push(txt);
            });

            const images = [];
            $('.details_photos a').each((i, el) => {
                const href = $(el).attr('href') || $(el).find('img').attr('src');
                if (href) images.push(absolute(href));
            });

            const metaImg = $('meta[itemprop="image"]').attr('content') || $('div.details img').first().attr('src');
            if (metaImg) {
                const abs = absolute(metaImg);
                if (!images.includes(abs)) images.unshift(abs);
            }

            const reviews = [];
            $('.details_review').each((i, el) => {
                if (reviews.length >= 3) return;
                const $r = $(el);
                const reviewer = $r.find('[itemprop="author"] [itemprop="name"]').first().text().trim()
                    || $r.find('.reviewer [itemprop="name"]').text().trim() || '';
                const comment = $r.find('[itemprop="description"]').first().text().trim()
                    || $r.find('.review_description').first().text().trim() || '';
                const date = $r.find('meta[itemprop="datePublished"]').attr('content') || '';
                const rating = $r.find('meta[itemprop="ratingValue"]').attr('content') || '';
                if (comment || reviewer) {
                    reviews.push({ reviewer, comment: comment.replace(/\s+/g, ' ').trim(), date, rating });
                }
            });

            let finalRegion = regionOverride || '';
            if (!finalRegion) {
                try {
                    const pathname = new URL(traderUrl).pathname;
                    const parts = pathname.split('/').filter(Boolean);
                    finalRegion = parts.length >= 2 ? parts[0] : '';
                } catch (e) {
                    finalRegion = '';
                }
            }

            const record = {
                Title: title || '',
                Description: description || '',
                Tagline: categories[0] || '',
                'Google Address': googleAddress || '',
                Latitude: lat || '',
                Longitude: lng || '',
                Phone: phones.join(' | ') || '',
                Email: '',
                Website: website || '',
                Twitter: twitter || '',
                Facebook: facebook || '',
                Linkedin: linkedin || '',
                Google_plus: '',
                Youtube: '',
                Instagram: instagram || '',
                'Youtube Video URL': '',
                'Price Status ($-moderatemoderate)': '',
                'Price From': '',
                'Price To': '',
                'Claim Status': '',
                'Faq Question (sep. by pipe sign | )': '',
                'Faq Answer (sep. by pipe sign | )': '',
                Gallery: images.join(',') || '',
                'Pricing Plan ID': '',
                'Business Hours (Day,OpenTime,CloseTime)': '',
                Category: categories.join(',') || '',
                Features: '',
                'Tags (Keywords)': categories.join(',') || '',
                Location: finalRegion || (REGION || '')
            };

            if (reviews.length) {
                const snippet = reviews.map(r => `${r.reviewer ? `${r.reviewer}: ` : ''}${r.comment}`).join(' || ');
                record.Description = `${record.Description} Reviews snippet: ${snippet}`.trim();
            }

            Object.keys(record).forEach(k => {
                if (typeof record[k] === 'string') record[k] = record[k].replace(/\r?\n|\r/g, ' ').trim();
            });

            return record;
        } catch (err) {
            opt.onProgress({ type: 'error', data: { text: `parseTraderDetail error for ${traderUrl}: ${err.message}` } });
            return null;
        }
    }

    // CSV append helper (saves records immediately)
    function appendToCsv(records, outFile) {
        if (!records || !records.length) return;
        const normalized = records.map(r => {
            const out = {};
            for (const f of opt.csvFields) out[f] = r[f] || '';
            return out;
        });

        const exists = fs.existsSync(outFile);
        if (!exists) {
            const parser = new Json2csvParser({ fields: opt.csvFields, excelStrings: true });
            const csv = parser.parse(normalized);
            fs.writeFileSync(outFile, csv + '\n', 'utf8');
        } else {
            const parser = new Json2csvParser({ fields: opt.csvFields, header: false, excelStrings: true });
            const csv = parser.parse(normalized);
            fs.appendFileSync(outFile, csv + '\n', 'utf8');
        }
    }

    // ---- main flow ----
    let totalScraped = 0;
    try {
        const categories = await getCategoryLinks();
        const limit = pLimit(opt.concurrency);

        opt.onProgress({ type: 'log', data: { text: `Region (normalized): "${REGION}"  Output: ${opt.outFile}  Limit: ${opt.totalLimit || 'unlimited'}` } });

        let estimatedTotal = 0;

        for (const { href: rawHref, title: categoryTitle, count } of categories) {
            if (stopRequested) break;

            const categoryUrl = rawHref.includes('location=') ? rawHref : `${rawHref}&location=`;
            opt.onProgress({ type: 'category', data: { name: categoryTitle } });

            if (count && Number.isFinite(count) && count > 0) {
                estimatedTotal += count;
                opt.onProgress({ type: 'log', data: { text: `total traders (estimated): ${estimatedTotal}` } });
            }

            await sleep(Math.floor(Math.random() * 400) + opt.delayMs);

            let traders = [];
            try {
                traders = await getTradersFromCategory(categoryUrl);
            } catch (err) {
                opt.onProgress({ type: 'error', data: { text: `Failed to fetch traders for category "${categoryTitle}": ${err.message}` } });
                continue;
            }

            if (traders.length) {
                estimatedTotal += traders.length;
                opt.onProgress({ type: 'log', data: { text: `total traders (updated): ${estimatedTotal}` } });
            }

            const remaining = opt.totalLimit && opt.totalLimit > 0 ? Math.max(0, opt.totalLimit - totalScraped) : Infinity;
            if (remaining === 0) break;
            if (traders.length > remaining) {
                traders = traders.slice(0, remaining);
                opt.onProgress({ type: 'log', data: { text: ` → sliced traders this category to remaining allowed: ${traders.length}` } });
            }

            if (!traders.length) {
                opt.onProgress({ type: 'log', data: { text: ` → no traders to process for ${categoryTitle}` } });
                continue;
            }

            const currentCategoryRecords = [];
            opt.onProgress({ type: 'log', data: { text: `Processing category "${categoryTitle}" — traders to fetch: ${traders.length}` } });

            const tasks = traders.map(({ url, region }) => limit(async () => {
                if (stopRequested) return;
                await sleep(Math.floor(Math.random() * 600) + 200);

                try {
                    opt.onProgress({ type: 'trader', data: { url } });
                    const rec = await parseTraderDetail(url, region || REGION || '');
                    if (rec) {
                        if (!rec.Category) rec.Category = categoryTitle;
                        rec.Location = (region && region.length) ? region : (REGION || rec.Location || '');
                        currentCategoryRecords.push(rec);
                        totalScraped++;
                        opt.onProgress({ type: 'progress', data: { scraped: totalScraped, total: opt.totalLimit || null } });
                        opt.onProgress({ type: 'record', data: { record: rec } });
                        if (opt.totalLimit > 0 && totalScraped >= opt.totalLimit) stopRequested = true;
                    } else {
                        opt.onProgress({ type: 'log', data: { text: `parse returned null for ${url}` } });
                    }
                } catch (err) {
                    opt.onProgress({ type: 'error', data: { text: `error scraping trader ${url}: ${err.message}` } });
                }
            }));

            await Promise.all(tasks);

            if (currentCategoryRecords.length) {
                try {
                    appendToCsv(currentCategoryRecords, opt.outFile);
                    opt.onProgress({ type: 'log', data: { text: `Saved ${currentCategoryRecords.length} records for category "${categoryTitle}" to ${opt.outFile}` } });
                } catch (err) {
                    opt.onProgress({ type: 'error', data: { text: `Error while saving CSV for category: ${err.message}` } });
                }
            } else {
                opt.onProgress({ type: 'log', data: { text: `No records scraped for category "${categoryTitle}" to save.` } });
            }

            await sleep(800);

            if (opt.totalLimit > 0 && totalScraped >= opt.totalLimit) {
                opt.onProgress({ type: 'log', data: { text: `Reached TOTAL_LIMIT (${opt.totalLimit}). Stopping.` } });
                break;
            }
        }

        opt.onProgress({ type: 'finished', data: { file: opt.outFile } });
        return { file: opt.outFile, totalScraped, cancel };
    } catch (err) {
        opt.onProgress({ type: 'error', data: { text: `Fatal error: ${err.message}` } });
        throw err;
    }
}
