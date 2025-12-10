// server.js — LinkedIn jobs wrapper with Cheerio HTML fallback (CommonJS)
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || process.env.PORT_NUMBER || 3000;

// --- Title / keyword filters for MSP / Helpdesk / Service Desk roles
const TITLE_KEYWORDS = [
  'service desk',
  'help desk',
  'helpdesk',
  'desktop support',
  'technical support',
  'support specialist',
  'service desk technician',
  'help desk technician',
  'msp',
  'managed service',
  '\\btech\\b',
  'it support',
  'it technician',
  'field technician',
  'support engineer',
  'support analyst'
].map(k => k.toLowerCase());

// Utilities
function toIntSafe(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLocation(loc) {
  if (!loc) return '';
  let s = loc.toString();
  // normalize common tokens (US -> United States) and remove duplicate tokens
  s = s.replace(/\bUS\b/gi, 'United States').replace(/[,\s]+/g, ' ').trim();
  s = Array.from(new Set(s.split(/\s+/))).join(' ');
  return s;
}

// Basic title/company match checker
function matchesTitleOrCompany(job) {
  const hay = ((job.position || '') + ' ' + (job.company || '') + ' ' + (job.description || '')).toLowerCase();
  return TITLE_KEYWORDS.some(kw => {
    try {
      const re = new RegExp(kw, 'i');
      return re.test(hay);
    } catch {
      return hay.includes(kw);
    }
  });
}

// Normalize various raw job shapes into stable shape
function normalizeJob(raw) {
  return {
    position: (raw.position || raw.title || raw.jobTitle || '').trim(),
    company: (raw.company || raw.companyName || raw.subtitle || '').trim(),
    location: (raw.location || raw.region || raw.jobLocation || '').trim(),
    date: (raw.date || raw.postedAt || raw.posted || '').trim(),
    salary: (raw.salary || raw.compensation || 'Not specified').trim(),
    jobUrl: (raw.jobUrl || raw.applyUrl || raw.url || '').trim(),
    companyLogo: (raw.companyLogo || raw.logo || '').trim(),
    agoTime: (raw.agoTime || raw.age || '').trim(),
    description: (raw.description || raw.snippet || '').trim()
  };
}

// HTML parsing heuristics: multiple selectors to cope with LinkedIn variations
function parseLinkedInHtml(html) {
  const $ = cheerio.load(html);
  const items = [];

  // Candidate selectors for LinkedIn job cards (try multiple)
  const cardSelectors = [
    '.base-card',                     // new LinkedIn base-card
    'li.job-result-card',             // older variations
    '.result-card',                   // common older class
    '.jobs-search-results__list-item' // list item wrapper
  ];

  const titleSelectors = [
    '.base-search-card__title',
    '.job-card-list__title',
    '.result-card__title',
    '.job-card-list__title'
  ];

  const companySelectors = [
    '.base-search-card__subtitle',
    '.result-card__subtitle',
    '.job-card-container__company-name',
    '.job-result-card__subtitle'
  ];

  const locationSelectors = [
    '.job-search-card__location',
    '.job-card-container__metadata-item',
    '.result-card__meta',
    '.job-result-card__location'
  ];

  const anchorsToTry = [
    'a.base-card__full-link',
    'a.result-card__full-card-link',
    'a.job-card-list__title-link',
    'a'
  ];

  // Iterate through card selectors to collect nodes
  let nodes = [];
  for (const cs of cardSelectors) {
    const found = $(cs).toArray();
    if (found.length) {
      nodes = found;
      break;
    }
  }

  // If no specific cards found, try generic job links container
  if (!nodes.length) {
    // fallback: find items that look like job links
    nodes = $('a[href*="/jobs/view"]').closest('li, div').toArray();
  }

  // Parse each node for fields
  for (const node of nodes) {
    const el = $(node);
    let position = '';
    for (const tsel of titleSelectors) {
      const t = el.find(tsel).first().text().trim();
      if (t) { position = t; break; }
    }
    if (!position) {
      // try anchor text
      const anchorText = el.find('a').first().text().trim();
      if (anchorText) position = anchorText;
    }

    let company = '';
    for (const csel of companySelectors) {
      const c = el.find(csel).first().text().trim();
      if (c) { company = c; break; }
    }

    let location = '';
    for (const lsel of locationSelectors) {
      const l = el.find(lsel).first().text().trim();
      if (l) { location = l; break; }
    }

    // jobUrl via anchors
    let jobUrl = '';
    for (const a of anchorsToTry) {
      const href = el.find(a).first().attr('href');
      if (href && href.indexOf('/jobs') !== -1) {
        jobUrl = href;
        break;
      } else if (href && href.startsWith('http')) {
        // sometimes direct link available
        jobUrl = href;
        break;
      }
    }

    // clean and push when position or company found
    if (position || company || jobUrl) {
      items.push({
        position: position || '',
        company: company || '',
        location: location || '',
        jobUrl: jobUrl || '',
        description: '', // not scraping long descriptions here
      });
    }
  }

  return items;
}

app.get('/search', async (req, res) => {
  try {
    const rawQuery = req.query || {};

    // --- sanitize incoming params ---
    const opts = {
      keyword: (rawQuery.keyword || rawQuery.keywords || rawQuery.q || 'service desk').toString().trim(),
      location: normalizeLocation(rawQuery.location || rawQuery.loc || 'United States'),
      days: toIntSafe(rawQuery.days, 7),
      limit: Math.min(Math.max(toIntSafe(rawQuery.limit, 10), 1), 100),
      start: Math.max(toIntSafe(rawQuery.start, 0), 0),
      requireRemote: String(rawQuery.require_remote || rawQuery.requireRemote || rawQuery.remote || false).toLowerCase() === 'true'
    };

    console.log('Search request - opts:', opts);

    // --- build upstream URL ---
    const upstreamBase = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
    // Map to common LinkedIn query params (best-effort)
    const upstreamParams = {
      location: opts.location,
      keywords: opts.keyword,
      start: opts.start,
      limit: opts.limit,
      // timeframe param (use LinkedIn's "time posted" filter if accepted by endpoint)
      f_TPR: `r${opts.days}`
    };

    if (opts.requireRemote) {
      // Common remote filter placeholder — may need adjustment if upstream expects different flag
      upstreamParams.f_JT = 'R';
    }

    const upstreamUrl = `${upstreamBase}?${qs.stringify(upstreamParams)}`;
    console.log('Upstream URL ->', upstreamUrl);

    // --- call upstream ---
    let upstreamResp;
    try {
      upstreamResp = await axios.get(upstreamUrl, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json, text/html, */*'
        },
        timeout: 20000
      });
    } catch (err) {
      // if the upstream returns a non-2xx, still try to use the response body if present
      if (err && err.response && err.response.data) {
        upstreamResp = err.response;
      } else {
        throw err;
      }
    }

    // --- parse response: try JSON first, then HTML fallback via cheerio ---
    let rawJobs = [];
    try {
      if (upstreamResp && upstreamResp.data) {
        // If it looks like JSON (array or object with elements/jobs), try to extract array
        const body = upstreamResp.data;
        if (Array.isArray(body)) {
          rawJobs = body;
        } else if (body && typeof body === 'object') {
          // Common shapes: { elements: [...] } or { jobs: [...] }
          if (Array.isArray(body.elements)) rawJobs = body.elements;
          else if (Array.isArray(body.jobs)) rawJobs = body.jobs;
          else if (Array.isArray(body.data)) rawJobs = body.data;
          else {
            // not a recognized JSON shape => fallback to HTML parse if data can be stringified
            const asString = JSON.stringify(body);
            if (asString && asString.trim().startsWith('<')) {
              rawJobs = parseLinkedInHtml(asString);
            } else {
              // no usable array present
              rawJobs = [];
            }
          }
        } else if (typeof body === 'string') {
          // HTML response — parse with cheerio
          rawJobs = parseLinkedInHtml(body);
        } else {
          rawJobs = [];
        }
      }
    } catch (parseErr) {
      console.warn('Parsing upstream response failed, attempting HTML parse as fallback', parseErr && parseErr.message);
      const asString = upstreamResp && upstreamResp.data ? String(upstreamResp.data) : '';
      if (asString) {
        rawJobs = parseLinkedInHtml(asString);
      } else {
        rawJobs = [];
      }
    }

    console.log(`Fetched ${rawJobs.length} jobs. Applying normalization & filters...`);

    // --- normalize, filter, dedupe ---
    const normalized = rawJobs
      .map(normalizeJob)
      .filter(j => (j.position || j.company))  // require some identity
      .filter(matchesTitleOrCompany);           // enforce MSP/helpdesk keywords

    // dedupe by jobUrl or position+company
    const seen = new Set();
    const deduped = [];
    for (const j of normalized) {
      const key = (j.jobUrl || (j.position + '|' + j.company)).trim();
      if (!seen.has(key)) {
        seen.add(key);
        // ensure absolute URL if relative
        if (j.jobUrl && j.jobUrl.startsWith('/')) {
          j.jobUrl = `https://www.linkedin.com${j.jobUrl}`;
        }
        deduped.push(j);
      }
    }

    const output = {
      totalFetched: rawJobs.length,
      totalReturned: deduped.length,
      jobs: deduped.slice(0, opts.limit)
    };

    console.log(`Returning ${output.totalReturned} filtered jobs (limit ${opts.limit})`);
    return res.json(output);

  } catch (err) {
    console.error('Search error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Upstream fetch or normalization failed', detail: (err && err.message) || String(err) });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'linked-jobs-wrapper', live: true, doc: 'GET /search?keyword=...&location=...&days=...&limit=...&start=...&require_remote=true' });
});

app.listen(PORT, () => {
  console.log(`LinkedIn jobs wrapper listening on ${PORT} — ENV PORT=${PORT}`);
});
