// trustedtrader-to-listingpro.js
// Node >= 18 recommended (ESM style)
import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Parser as Json2csvParser } from 'json2csv';
import pLimit from 'p-limit';
import { URL } from 'url';

// ---- CLI arg parsing (very small, zero deps) ----
const argv = process.argv.slice(2);
function getArg(name, def = null) {
    const idx = argv.findIndex(a => a === `--${name}`);
    if (idx === -1) return def;
    return argv[idx + 1] ?? def;
}
const city = 'Angus';
const numberLimit = 50;
const REGION = getArg('region', `${city}`);
const TOTAL_LIMIT = Number(getArg('limit', `${numberLimit}`)) || 0; // 0 => unlimited
const OUT_FILE = getArg('out', `listingpro_trustedtrader_${city}.csv`);

const BASE = 'https://www.trustedtrader.scot';
const TRADES_AZ_PATH = `/${REGION}/tradesAZ`;
const USER_AGENT = 'Mozilla/5.0 (compatible; TrustedTraderScraper/1.0; +https://yourdomain.example)';

const concurrency = 3;
const delayMs = 900; // polite base delay

// exact ListingPro header columns (must keep order)
const CSV_FIELDS = [
    'Title', 'Description', 'Tagline', 'Google Address', 'Latitude', 'Longitude', 'Phone', 'Email', 'Website',
    'Twitter', 'Facebook', 'Linkedin', 'Google_plus', 'Youtube', 'Instagram', 'Youtube Video URL',
    'Price Status ($-moderatemoderate)', 'Price From', 'Price To', 'Claim Status',
    'Faq Question (sep. by pipe sign | )', 'Faq Answer (sep. by pipe sign | )',
    'Gallery', 'Pricing Plan ID', 'Business Hours (Day,OpenTime,CloseTime)', 'Category', 'Features', 'Tags (Keywords)', 'Location'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHTML(url) {
    try {
        const res = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
            timeout: 20000
        });
        return res.data;
    } catch (err) {
        console.error(`fetchHTML error for ${url}: ${err.message}`);
        throw err;
    }
}

function absolute(href) {
    if (!href) return '';
    try {
        return new URL(href, BASE).toString();
    } catch {
        return href;
    }
}

/** 1. Get category links from /<REGION>/tradesAZ */
async function getCategoryLinks() {
    const url = `${BASE}${TRADES_AZ_PATH}`;
    console.log('Fetching categories from', url);
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const links = new Map();
    $('a[href*="/search?bus_type="]').each((i, el) => {
        const $a = $(el);
        const href = $a.attr('href');
        const title = $a.find('b').text().trim() || $a.text().trim();
        if (href && title) {
            const full = absolute(href.split('#')[0]);
            links.set(full, title.replace(/\s+-\s+\d+\s+traders$/i, '').trim());
        }
    });

    console.log(`Found ${links.size} category links.`);
    return Array.from(links.entries()).map(([href, title]) => ({ href, title }));
}

/** 2. From a category search results page, collect trader detail links */
async function getTradersFromCategory(categoryUrl) {
    console.log('Fetching category results:', categoryUrl);
    const html = await fetchHTML(categoryUrl);
    const $ = cheerio.load(html);

    const resultLinks = new Set();
    $('.search_results ul li a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.includes(`/${REGION}/`)) resultLinks.add(absolute(href));
    });
    $('span[itemscope] li a').each((i, el) => {
        const href = $(el).attr('href');
        if (href) resultLinks.add(absolute(href));
    });

    console.log(` → ${resultLinks.size} traders found on this page.`);
    return Array.from(resultLinks);
}

/** 3. Parse individual trader detail page and map to ListingPro fields */
async function parseTraderDetail(traderUrl) {
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

        const lat = $('meta[itemprop="latitude"]').attr('content') || $('div[itemprop="geo"] meta[itemprop="latitude"]').attr('content') || '';
        const lng = $('meta[itemprop="longitude"]').attr('content') || $('div[itemprop="geo"] meta[itemprop="longitude"]').attr('content') || '';

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
            const href = ($(el).attr('href') || '').trim();
            if (!href) return;
            if (!facebook && href.includes('facebook.com')) facebook = absolute(href);
            if (!twitter && href.includes('twitter.com')) twitter = absolute(href);
            if (!instagram && href.includes('instagram.com')) instagram = absolute(href);
            if (!linkedin && href.includes('linkedin.com')) linkedin = absolute(href);
        });

        const description = $('div[itemprop="description"]').first().text().trim().replace(/\s+/g, ' ');
        const categories = [];
        $('.details_cat a').each((i, el) => { const txt = $(el).text().trim(); if (txt) categories.push(txt); });

        const images = [];
        $('.details_photos a').each((i, el) => {
            const href = $(el).attr('href') || $(el).find('img').attr('src');
            if (href) images.push(absolute(href));
        });
        const metaImg = $('meta[itemprop="image"]').attr('content') || $('div.details img').first().attr('src');
        if (metaImg && !images.includes(absolute(metaImg))) images.unshift(absolute(metaImg));

        let claimStatus = '';
        const memberText = $('.details').text().match(/Trusted Trader member since\s*(\d{4})/i);
        //claimStatus = memberText ? 'claimed' : 'Not claimed';

        const reviews = [];
        $('.details_review').each((i, el) => {
            if (reviews.length >= 3) return;
            const $r = $(el);
            const reviewer = $r.find('[itemprop="author"] [itemprop="name"]').first().text().trim() ||
                $r.find('.reviewer [itemprop="name"]').text().trim() || '';
            const comment = $r.find('[itemprop="description"]').first().text().trim() || $r.find('.review_description').first().text().trim() || '';
            const date = $r.find('meta[itemprop="datePublished"]').attr('content') || '';
            const rRating = $r.find('meta[itemprop="ratingValue"]').attr('content') || '';
            if (comment || reviewer) {
                reviews.push({ reviewer, comment: comment.replace(/\s+/g, ' ').trim(), date, rating: rRating });
            }
        });

        const record = {
            Title: title || '',
            Description: description || '',
            Tagline: (categories.length ? categories[0] : ''),
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
            'Claim Status': claimStatus || '',
            'Faq Question (sep. by pipe sign | )': '',
            'Faq Answer (sep. by pipe sign | )': '',
            Gallery: images.join(',') || '',
            'Pricing Plan ID': '',
            'Business Hours (Day,OpenTime,CloseTime)': '',
            Category: categories.join(',') || '',
            Features: '',
            'Tags (Keywords)': categories.join(',') || '',
            Location: REGION || ''
        };

        if (reviews.length) {
            const revText = reviews.map(r => `${r.reviewer ? `${r.reviewer}: ` : ''}${r.comment}`).join(' || ');
            record.Description = (record.Description ? record.Description + ' ' : '') + `Reviews snippet: ${revText}`;
        }

        Object.keys(record).forEach(k => {
            if (typeof record[k] === 'string') record[k] = record[k].replace(/\r?\n|\r/g, ' ').trim();
        });

        return record;
    } catch (err) {
        console.error(`parseTraderDetail error for ${traderUrl}: ${err.message}`);
        return null;
    }
}

// ---- CSV helpers: append after each category ----
function appendToCsv(records, outFile) {
    if (!records || !records.length) return;
    // normalize order
    const normalized = records.map(r => {
        const out = {};
        for (const f of CSV_FIELDS) out[f] = r[f] || '';
        return out;
    });

    // if file exists, append without header; otherwise write header + rows
    const exists = fs.existsSync(outFile);
    if (!exists) {
        const parser = new Json2csvParser({ fields: CSV_FIELDS, excelStrings: true });
        const csv = parser.parse(normalized);
        fs.writeFileSync(outFile, csv + '\n', 'utf8');
    } else {
        const parser = new Json2csvParser({ fields: CSV_FIELDS, header: false, excelStrings: true });
        const csv = parser.parse(normalized);
        // ensure newline separation
        fs.appendFileSync(outFile, csv + '\n', 'utf8');
    }
}

// ---- Main workflow with save-after-category and total limit ----
let totalScraped = 0;
let stopRequested = false;

process.on('SIGINT', () => {
    console.log('\nSIGINT received — stopping after current category (if any) and saving progress...');
    stopRequested = true;
});

async function main() {
    const categories = await getCategoryLinks();
    const limit = pLimit(concurrency);

    console.log(`Region: ${REGION}  Outfile: ${OUT_FILE}  Total limit: ${TOTAL_LIMIT || 'unlimited'}`);
    for (const { href: rawHref, title: categoryTitle } of categories) {
        if (stopRequested) break;
        const categoryUrl = rawHref.includes('location=') ? rawHref : `${rawHref}&location=`;
        await sleep(Math.floor(Math.random() * 400) + delayMs);

        let traders = [];
        try {
            traders = await getTradersFromCategory(categoryUrl);
        } catch (err) {
            console.error('Failed to fetch traders for category', categoryTitle, err.message);
            continue;
        }

        // respect global TOTAL_LIMIT: slice traders list to remaining allowed
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

        const tasks = traders.map(traderUrl => limit(async () => {
            if (stopRequested) return;
            // small random jitter
            await sleep(Math.floor(Math.random() * 600) + 200);
            if (stopRequested) return;
            try {
                console.log(' -> scraping trader', traderUrl);
                const rec = await parseTraderDetail(traderUrl);
                if (rec) {
                    if (!rec.Category) rec.Category = categoryTitle;
                    rec.Location = REGION;
                    currentCategoryRecords.push(rec);
                    totalScraped++;
                    console.log(`    scraped (total so far): ${totalScraped}`);
                    // Early exit if reached limit
                    if (TOTAL_LIMIT > 0 && totalScraped >= TOTAL_LIMIT) {
                        stopRequested = true;
                    }
                }
            } catch (err) {
                console.error('  error scraping trader', traderUrl, err.message);
            }
        }));

        // Await category tasks (some tasks may return early if stopRequested)
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

        // small polite pause between categories
        await sleep(800);

        if (TOTAL_LIMIT > 0 && totalScraped >= TOTAL_LIMIT) {
            console.log(`Reached TOTAL_LIMIT (${TOTAL_LIMIT}). Stopping.`);
            break;
        }
    }

    console.log(`\nFinished run. Total records scraped: ${totalScraped}`);
    console.log(`CSV is at: ${OUT_FILE} (saved after each category)`);
}

main().catch(err => {
    console.error('Fatal error:', err);
});
