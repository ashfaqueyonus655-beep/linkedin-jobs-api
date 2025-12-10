// server.js — single-page fetch + server-side filtering & limit
const express = require("express");

let pkg;
try {
  pkg = require("linkedin-jobs-api");
} catch (err) {
  console.error("Failed to require linkedin-jobs-api:", err);
  process.exit(1);
}

// detect callable function
let searchFn = null;
if (typeof pkg === "function") searchFn = pkg;
else if (pkg && typeof pkg.query === "function") searchFn = pkg.query;
else if (pkg && typeof pkg.default === "function") searchFn = pkg.default;
else if (pkg && pkg.default && typeof pkg.default.query === "function") searchFn = pkg.default.query;

if (!searchFn) {
  console.error("Could not find a usable search function in linkedin-jobs-api package.");
  console.error("Package keys:", Object.keys(pkg || {}));
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);

// small helper to safely read and trim string query params
function qstr(req, name, fallback = "") {
  try {
    const v = req.query[name];
    if (v === undefined || v === null) return fallback;
    if (Array.isArray(v)) return String(v.join(" ")).trim();
    return String(v).trim();
  } catch {
    return fallback;
  }
}

function toInt(req, name, fallback) {
  const v = qstr(req, name, "");
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// helper: normalize job text
function textFor(job) {
  const parts = [];
  if (job.position) parts.push(job.position);
  if (job.title) parts.push(job.title);
  if (job.name) parts.push(job.name);
  if (job.description) parts.push(job.description);
  if (job.snippet) parts.push(job.snippet);
  if (job.summary) parts.push(job.summary);
  if (job.company) parts.push(job.company);
  if (job.companyName) parts.push(job.companyName);
  if (job.location) parts.push(job.location);
  if (job.jobUrl) parts.push(job.jobUrl);
  return parts.join(" ").toLowerCase();
}

// scoring function
function scoreJob(job, mustKeywords, broaderKeywords, remoteIndicators) {
  const t = textFor(job);
  let score = 0;
  for (const k of mustKeywords) if (t.includes(k)) score += 60;
  for (const k of broaderKeywords) if (t.includes(k)) score += 8;
  for (const k of remoteIndicators) if (t.includes(k)) score += 10;
  if ((job.location || "").toLowerCase().includes("remote")) score += 12;
  return score;
}

// health
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * /search
 * query params:
 *   keyword  (string) - search terms
 *   location (string) - location string
 *   days     (number) - how recent
 *   limit    (number) - max items to return (default 10)
 *   start    (number) - pagination offset (default 0)
 *   require_remote (true/false) - server will prefer remote results
 *   title_filters (comma separated) - extra tokens to require (optional)
 */
app.get("/search", async (req, res) => {
  // safe parsing
  const keyword = qstr(req, "keyword", qstr(req, "keywords", "service desk"));
  const location = qstr(req, "location", "Remote");
  const days = toInt(req, "days", undefined);
  const limit = Math.max(1, Math.min(100, toInt(req, "limit", 10))); // clamp 1..100
  const start = Math.max(0, toInt(req, "start", 0));
  const requireRemote = qstr(req, "require_remote", "") === "true";
  const titleFiltersRaw = qstr(req, "title_filters", "");
  const titleFilters = titleFiltersRaw ? titleFiltersRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  // Build options for the library - provide limit/start/count variants
  const opts = {
    keywords: keyword,
    query: keyword,
    location: location,
    time: days,
    limit: limit,     // library may use this
    count: limit,     // some libraries use 'count'
    start: start
  };

  console.log("Search request - opts:", { keyword, location, days, limit, start, requireRemote, titleFilters });

  try {
    // single call only - do not iterate pages
    let results;
    try {
      results = await searchFn(opts); // preferred
    } catch (err1) {
      try {
        results = await searchFn(keyword, { location, time: days, limit, start, count: limit });
      } catch (err2) {
        // final fallback - single-arg
        results = await searchFn(keyword);
      }
    }

    // Normalize to array of jobs
    let jobs = results;
    if (!Array.isArray(jobs)) {
      if (results && Array.isArray(results.jobs)) jobs = results.jobs;
      else if (results && Array.isArray(results.results)) jobs = results.results;
      else if (results && Array.isArray(results.data)) jobs = results.data;
      else jobs = results ? [results] : [];
    }

    console.log(`Raw jobs returned: ${jobs.length}`);

    // Server-side filtering + scoring
    const mustKeywords = ["service desk","help desk","helpdesk","service-desk","help-desk"];
    const broaderKeywords = ["desktop support","it support","technician","msp","support engineer","field tech","1st line","1st-line","level 1","level 2"];
    const remoteIndicators = ["remote","work from home","wfh","work-from-home","hybrid"];

    // if title_filters provided, merge them into mustKeywords
    for (const tf of titleFilters) if (!mustKeywords.includes(tf)) mustKeywords.push(tf);

    // Filter and score
    const scored = jobs.map(job => {
      const s = scoreJob(job, mustKeywords, broaderKeywords, remoteIndicators);
      return { job, score: s };
    })
    // keep only those with a positive score OR keep broader set if none matched
    .filter(x => x.score > 0);

    let finalList = scored.sort((a,b) => b.score - a.score).map(x => x.job);

    // if nothing matched strictly, fallback to fuzzy broader match
    if (finalList.length === 0) {
      const fuzzy = jobs.filter(job => {
        const t = textFor(job);
        return broaderKeywords.some(k => t.includes(k)) || mustKeywords.some(k => t.includes(k));
      });
      finalList = fuzzy.slice(0, limit);
    }

    // enforce remote if required
    if (requireRemote) {
      const filteredRemote = finalList.filter(j => {
        const t = textFor(j);
        return remoteIndicators.some(k => t.includes(k)) || (j.location && String(j.location).toLowerCase().includes("remote"));
      });
      if (filteredRemote.length > 0) finalList = filteredRemote;
      // if filteredRemote is empty, keep original finalList to avoid zero-results
    }

    // final truncation to requested limit
    finalList = finalList.slice(0, limit);

    console.log(`Final results: ${finalList.length} (limited to ${limit})`);

    res.json({
      success: true,
      count: finalList.length,
      jobs: finalList
    });
  } catch (err) {
    console.error("API error:", err);
    console.error("Package keys:", Object.keys(pkg || {}));
    res.status(500).json({ success: false, error: String(err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
