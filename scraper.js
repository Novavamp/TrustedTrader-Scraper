import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Parser as Json2csvParser } from 'json2csv';
import pLimit from 'p-limit';
import { URL } from 'url';
import path from 'path';

// ---- CLI arg parsing (tiny, zero deps) ----
const argv = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = argv.findIndex(a => a === `--${name}`);
    if (idx === -1) return def;
    return argv[idx + 1] ?? def;
}

// Defaults
const DEFAULT_CITY = 'London';
const DEFAULT_LIMIT = 50;

let rawRegion = (getArg('region', '') || '').trim();
const TOTAL_LIMIT = Number(getArg('limit', `${DEFAULT_LIMIT}`)) || 0; // 0 => unlimited
const OUT_FILE = getArg('out', `listingpro_trustedtrader_${Date.now()}.csv`);
const CONCURRENCY = Number(getArg('concurrency', '3')) || 3;
const USER_AGENT = getArg('ua', 'Mozilla/5.0 (compatible; TrustedTraderScraper/1.0)');
const BASE = 'https://www.trustedtrader.scot';
const DEFAULT_DELAY_MS = Number(getArg('delay', '900')) || 900;
const RETRY_ATTEMPTS = Number(getArg('retries', '3')) || 3;
const RETRY_BACKOFF_MS = 500; // base backoff

// Normalize region to Option C if provided (TitleCase per word, remove punctuation, join words)
function normalizeRegion(opt) {
    if (!opt) return '';
    // remove leading/trailing, convert multiple whitespace to single
    const cleaned = String(opt).trim().replace(/\s+/g, ' ');
    // split on spaces and punctuation
    const words = cleaned.split(/\s+/).map(w => {
        // keep alphanumerics only
        const alpha = w.replace(/[^A-Za-z0-9]/g, '');
        if (!alpha) return '';
        return alpha[0].toUpperCase() + alpha.slice(1).toLowerCase();
    }).filter(Boolean);
    return words.join('');
}

const REGION = normalizeRegion(rawRegion); // '' means global A–Z

// Build tradesAZ path (region or global)
const TRADES_AZ_PATH = REGION ? `/${REGION}/tradesAZ` : `/tradesAZ`;

// ListingPro fields - keep exact order
const CSV_FIELDS = [
    'Title', 'Description', 'Tagline', 'Google Address', 'Latitude', 'Longitude', 'Phone', 'Email', 'Website',
    'Twitter', 'Facebook', 'Linkedin', 'Google_plus', 'Youtube', 'Instagram', 'Youtube Video URL',
    'Price Status ($-moderatemoderate)', 'Price From', 'Price To', 'Claim Status',
    'Faq Question (sep. by pipe sign | )', 'Faq Answer (sep. by pipe sign | )',
    'Gallery', 'Pricing Plan ID', 'Business Hours (Day,OpenTime,CloseTime)', 'Category', 'Features', 'Tags (Keywords)', 'Location'
];

const concurrency = CONCURRENCY;
const delayMs = DEFAULT_DELAY_MS;

// Helpers
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHTML(url, opts = {}) {
    const attempts = opts.retries ?? RETRY_ATTEMPTS;
    const timeout = opts.timeout ?? 20000;
    let lastErr = null;

    for (let i = 0; i < attempts; i++) {
        try {
            const res = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
                timeout
            });
            return res.data;
        } catch (err) {
            lastErr = err;
            const backoff = RETRY_BACKOFF_MS * Math.pow(2, i);
            console.error(`fetchHTML error for ${url} (attempt ${i + 1}/${attempts}): ${err.message}. Retrying in ${backoff}ms...`);
            await sleep(backoff);
        }
    }

    // final failure
    throw new Error(`fetchHTML failed for ${url}: ${lastErr ? lastErr.message : 'unknown error'}`);
}

function absolute(href) {
    if (!href) return '';
    try {
        return new URL(href, BASE).toString();
    } catch {
        return href;
    }
}

// Parse category links from tradesAZ page
async function getCategoryLinks() {
    const url = `${BASE}${TRADES_AZ_PATH}`;
    console.log('Fetching categories from', url);

    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const links = new Map();

    $('a[href*="/search?bus_type="]').each((i, el) => {
        const $a = $(el);
        const href = $a.attr('href');
        const rawText = $a.text().trim();
        const title = $a.find('b').text().trim() || rawText;
        if (href && title) {
            // Try to extract count like " - 3 traders"
            const m = rawText.match(/\-\s*(\d+)\s*traders/i);
            const count = m ? Number(m[1]) : null;
            links.set(absolute(href.split('#')[0]), { title: title.replace(/\s+-\s+\d+\s+traders$/i, '').trim(), count });
        }
    });

    console.log(`Found ${links.size} category links.`);
    return Array.from(links.entries()).map(([href, meta]) => ({ href, title: meta.title, count: meta.count || 0 }));
}

// Helper: extract region from href or DOM fallback
function detectRegionFromHref(href, $el = null) {
    // href like "/Edinburgh/AMP-Installations-Lt-0000670.html"
    if (!href) return '';
    try {
        // Remove query/hash
        const clean = href.split(/[?#]/)[0];
        const parts = clean.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[0] && !parts[0].toLowerCase().includes('search')) {
            return parts[0]; // e.g. 'Edinburgh' or 'EastLothian'
        }
    } catch (e) {
        // noop
    }

    // fallback: read alt text from the listing image if DOM element passed
    try {
        if ($el) {
            const alt = $el.find('.results_logo_align img').attr('alt') || $el.find('.results_logo_align').text();
            if (alt) return alt.trim().replace(/\s+/g, '');
        }
    } catch (e) { /* noop */ }

    return '';
}

// Collect trader URLs (and detected region)
async function getTradersFromCategory(categoryUrl) {
    console.log('Fetching category results:', categoryUrl);
    const html = await fetchHTML(categoryUrl);
    const $ = cheerio.load(html);

    const resultMap = new Map(); // url -> region

    // Primary results selector
    $('.search_results ul li a').each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const full = absolute(href);
        // detect region from href; if none, fallback to global REGION or DOM
        let regionDetected = detectRegionFromHref(href, $(el)) || REGION || '';
        resultMap.set(full, regionDetected);
    });

    // Secondary fallback
    $('span[itemscope] li a').each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const full = absolute(href);
        let regionDetected = detectRegionFromHref(href, $(el)) || REGION || '';
        resultMap.set(full, regionDetected);
    });

    const traders = Array.from(resultMap.entries()).map(([url, region]) => ({ url, region }));

    console.log(` → ${traders.length} traders found on this page.`);
    return traders;
}

// Parse trader detail page and map to ListingPro fields
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

        // Website
        let website = '';
        const siteA = $('.details_web[itemprop="url"] a, .details_web a').first();
        if (siteA.length) website = absolute(siteA.attr('href') || siteA.text().trim());

        // Socials
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

        // Reviews (top 3)
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

        // derive region: prefer regionOverride, else detect from URL
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

        // Build record
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

        // clean newlines
        Object.keys(record).forEach(k => {
            if (typeof record[k] === 'string') record[k] = record[k].replace(/\r?\n|\r/g, ' ').trim();
        });

        return record;
    } catch (err) {
        console.error(`parseTraderDetail error for ${traderUrl}: ${err.message}`);
        return null;
    }
}

// CSV helpers (append after each category)
function appendToCsv(records, outFile) {
    if (!records || !records.length) return;
    const normalized = records.map(r => {
        const out = {};
        for (const f of CSV_FIELDS) out[f] = r[f] || '';
        return out;
    });

    const exists = fs.existsSync(outFile);
    if (!exists) {
        const parser = new Json2csvParser({ fields: CSV_FIELDS, excelStrings: true });
        const csv = parser.parse(normalized);
        fs.writeFileSync(outFile, csv + '\n', 'utf8');
    } else {
        const parser = new Json2csvParser({ fields: CSV_FIELDS, header: false, excelStrings: true });
        const csv = parser.parse(normalized);
        fs.appendFileSync(outFile, csv + '\n', 'utf8');
    }
}

// ---- Main workflow with improved stability ----
let totalScraped = 0;
let stopRequested = false;

process.on('SIGINT', () => {
    console.log('\nSIGINT received — stopping after current category...');
    stopRequested = true;
});

async function main() {
    try {
        const categories = await getCategoryLinks();
        const limit = pLimit(concurrency);

        console.log(`Region (normalized, empty => global): "${REGION}"  Output: ${OUT_FILE}  Limit: ${TOTAL_LIMIT || 'unlimited'}`);
        // estimated total across categories (dynamic)
        let estimatedTotal = 0;

        for (const { href: rawHref, title: categoryTitle, count } of categories) {
            if (stopRequested) break;

            // build category URL: if original href already contained location param, use it; otherwise append location=
            const categoryUrl = rawHref.includes('location=') ? rawHref : `${rawHref}&location=`;
            console.log(`Processing category "${categoryTitle}"`);
            // Notify estimated counts if available from link text
            if (count && Number.isFinite(count) && count > 0) {
                estimatedTotal += count;
                console.log(`total traders: ${estimatedTotal}`);
            }

            // polite pause
            await sleep(Math.floor(Math.random() * 400) + delayMs);

            let traders = [];
            try {
                traders = await getTradersFromCategory(categoryUrl);
            } catch (err) {
                console.error('Failed to fetch traders for category', categoryTitle, err.message);
                continue;
            }

            // Update estimated total with discovered number (server will read last "total traders" match)
            if (traders.length) {
                estimatedTotal += traders.length;
                console.log(`total traders: ${estimatedTotal}`);
            }

            // Apply global TOTAL_LIMIT: slice traders list to remaining allowed
            const remaining = TOTAL_LIMIT && TOTAL_LIMIT > 0 ? Math.max(0, TOTAL_LIMIT - totalScraped) : Infinity;
            if (remaining === 0) break;
            if (traders.length > remaining) {
                traders = traders.slice(0, remaining);
                console.log(` → sliced traders this category to remaining allowed: ${traders.length}`);
            }

            if (!traders.length) {
                console.log(` → no traders to process for ${categoryTitle}`);
                continue;
            }

            const currentCategoryRecords = [];
            console.log(`Processing category "${categoryTitle}" — traders to fetch: ${traders.length}`);

            const tasks = traders.map(({ url, region }) => limit(async () => {
                if (stopRequested) return;

                // small random jitter between requests
                await sleep(Math.floor(Math.random() * 600) + 200);

                try {
                    console.log(' -> scraping trader', url);
                    const rec = await parseTraderDetail(url, region || REGION || '');
                    if (rec) {
                        if (!rec.Category) rec.Category = categoryTitle;
                        // prefer detected region, then region override fallback
                        rec.Location = (region && region.length) ? region : (REGION || rec.Location || '');
                        currentCategoryRecords.push(rec);
                        totalScraped++;
                        console.log(`scraped (total so far): ${totalScraped}`);
                        // Early stop check
                        if (TOTAL_LIMIT > 0 && totalScraped >= TOTAL_LIMIT) {
                            stopRequested = true;
                        }
                    } else {
                        console.error('  parse returned null for', url);
                    }
                } catch (err) {
                    console.error('  error scraping trader', url, err.message);
                }
            }));

            // Wait for this category to finish (concurrent per concurrency)
            await Promise.all(tasks);

            // Save this category batch immediately (append)
            try {
                if (currentCategoryRecords.length) {
                    appendToCsv(currentCategoryRecords, OUT_FILE);
                    console.log(`Saved ${currentCategoryRecords.length} records for category "${categoryTitle}" to ${OUT_FILE}`);
                } else {
                    console.log(`No records scraped for category "${categoryTitle}" to save.`);
                }
            } catch (err) {
                console.error('Error while saving CSV for category:', err.message);
            }

            // polite pause between categories
            await sleep(800);

            if (TOTAL_LIMIT > 0 && totalScraped >= TOTAL_LIMIT) {
                console.log(`Reached TOTAL_LIMIT (${TOTAL_LIMIT}). Stopping.`);
                break;
            }
        }

        console.log(`\nFinished run. Total records scraped: ${totalScraped}`);
        console.log(`CSV is at: ${OUT_FILE} (saved after each category)`);
    } catch (err) {
        console.error('Fatal error:', err);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('Fatal (uncaught) error:', err);
    process.exitCode = 1;
});

