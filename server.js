// server.js — defensive wrapper for linkedin-jobs-api (CommonJS)
const express = require('express');
const axios = require('axios');
const qs = require('querystring');

const app = express();
const PORT = process.env.PORT || 3000;

// Keywords / title filters for MSP / Helpdesk / Service Desk roles
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
  'field technician'
].map(k => k.toLowerCase());

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

function normalizeJob(raw) {
  return {
    position: raw.position || raw.title || '',
    company: raw.company || raw.companyName || '',
    location: raw.location || raw.region || '',
    date: raw.date || raw.postedAt || '',
    salary: raw.salary || raw.compensation || 'Not specified',
    jobUrl: raw.jobUrl || raw.applyUrl || '',
    companyLogo: raw.companyLogo || raw.logo || '',
    agoTime: raw.agoTime || raw.age || ''
  };
}

app.get('/search', async (req, res) => {
  try {
    // --- sanitize & normalize incoming params ---
    const raw = {
      keyword: (req.query.keyword || '').toString().trim(),
      location: (req.query.location || '').toString().trim(),
      days: parseInt(req.query.days, 10),
      limit: parseInt(req.query.limit, 10),
      start: parseInt(req.query.start, 10),
      requireRemote: req.query.require_remote || req.query.requireRemote || req.query.remote || req.query.require_remote === 'true'
    };

    // safe defaults
    const opts = {
      keyword: raw.keyword || 'service desk',
      location: raw.location ? raw.location.replace(/\s+/g, ' ').replace(/,\s*/g, ',').replace(/\bUS\b/gi, 'United States') : 'United States',
      days: Number.isFinite(raw.days) ? raw.days : 7,
      limit: Number.isFinite(raw.limit) ? Math.min(Math.max(raw.limit, 1), 100) : 10,
      start: Number.isFinite(raw.start) ? Math.max(raw.start, 0) : 0,
      requireRemote: (raw.requireRemote === true || raw.requireRemote === 'true') ? true : false
    };

    // remove accidental duplicate tokens (e.g., "US US")
    opts.location = opts.location.split(/\s+/).filter((v,i,a) => a.indexOf(v) === i).join(' ');

    // --- log resolved options for debugging ---
    console.log('Search request - opts:', opts);

    // --- build upstream query (LinkedIn guest endpoint used in your logs) ---
    const upstreamBase = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
    // Example minimal param set; adapt if your upstream expects different names
    const upstreamParams = {
      location: opts.location,
      keywords: opts.keyword,
      start: opts.start,
      limit: opts.limit,
      // other flags may be required depending on upstream behavior
      f_TPR: `r${opts.days}`, // timeframe param example: 'r7' for 7 days (adjust upstream expectations)
    };

    // if user requested remote-only, add a common remote filter flag (may vary by upstream)
    if (opts.requireRemote) {
      upstreamParams.f_JT = 'R'; // NOTE: tune to upstream's expected filter param
    }

    const upstreamUrl = `${upstreamBase}?${qs.stringify(upstreamParams)}`;
    console.log('Upstream URL ->', upstreamUrl);

    // --- fetch from upstream ---
    const upstreamResp = await axios.get(upstreamUrl, {
      headers: {
        // use a browser-like UA to avoid basic bot-detection blocks
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (compatible; MSIE 11; Windows NT 10.0; Win64; x64)',
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 15000
    });

    // upstreamResp.data may already be JSON or HTML — try to parse
    const rawJobs = Array.isArray(upstreamResp.data) ? upstreamResp.data : (upstreamResp.data && upstreamResp.data.elements) ? upstreamResp.data.elements : (upstreamResp.data && upstreamResp.data.jobs) ? upstreamResp.data.jobs : [];

    console.log(`Fetched ${rawJobs.length} jobs. Applying normalization & filters...`);

    // --- normalize, filter, dedupe ---
    const normalized = rawJobs
      .map(normalizeJob)
      .filter(j => j.position || j.company)         // must have at least one identifier
      .filter(matchesTitleOrCompany);               // filter to MSP/helpdesk keywords

    // simple dedupe by jobUrl
    const seen = new Set();
    const deduped = [];
    for (const j of normalized) {
      const key = (j.jobUrl || j.position + '|' + j.company).trim();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(j);
      }
    }

    // --- response ---
    const output = {
      totalFetched: rawJobs.length,
      totalReturned: deduped.length,
      jobs: deduped.slice(0, opts.limit)
    };

    console.log(`Returning ${output.totalReturned} filtered jobs (limit ${opts.limit})`);
    res.json(output);

  } catch (err) {
    console.error('Search error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Upstream fetch or normalization failed', detail: (err && err.message) || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`LinkedIn jobs wrapper listening on ${PORT} — ENV PORT=${PORT}`);
});
