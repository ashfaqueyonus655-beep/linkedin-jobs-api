// server.js — defensive wrapper for linkedin-jobs-api (CommonJS)
const express = require("express");

// load package (CommonJS)
let pkg;
try {
  pkg = require("linkedin-jobs-api");
} catch (err) {
  console.error("Failed to require linkedin-jobs-api:", err);
  process.exit(1);
}

// detect callable search function (try several shapes)
let searchFn = null;
if (typeof pkg === "function") {
  // package itself is callable
  searchFn = pkg;
} else if (pkg && typeof pkg.query === "function") {
  // observed in your logs: query exists
  searchFn = pkg.query;
} else if (pkg && typeof pkg.default === "function") {
  searchFn = pkg.default;
} else if (pkg && pkg.default && typeof pkg.default.query === "function") {
  searchFn = pkg.default.query;
}

// if no usable function found, print debug keys and exit
if (!searchFn) {
  console.error("Could not find a usable search function in linkedin-jobs-api package.");
  console.error("Package keys:", Object.keys(pkg || {}));
  process.exit(1);
}

// create express app
const app = express();
app.set("trust proxy", true);

// helper: call searchFn and normalize result
async function callSearchFn(keyword, location, days) {
  // Best-effort parameter shapes — package may expect different names.
  // We try multiple shapes in order until one returns an array / non-empty result.
  const attempts = [
    // common guess: an options object { keywords, location, time }
    { args: [{ keywords: keyword, location: location, time: days }] },

    // alternate guess: { query: 'search terms', location, days }
    { args: [{ query: keyword, location: location, days: days }] },

    // alternate guess: just (queryString, optionsObject)
    { args: [keyword, { location, days }] },

    // fallback: single string argument
    { args: [keyword] }
  ];

  for (const attempt of attempts) {
    try {
      const res = await searchFn.apply(null, attempt.args);
      // If this returned something that looks like results, return it
      if (res) return res;
    } catch (err) {
      // log and continue trying other shapes
      console.warn("searchFn attempt failed for args:", JSON.stringify(attempt.args), "err:", String(err));
    }
  }

  // final attempt: if package exposes a 'query' that returns an object wrapper, try that and extract 'results' or 'jobs'
  try {
    const r = await searchFn({ query: keyword, location, days });
    return r;
  } catch (err) {
    throw new Error("All attempts to call search function failed: " + err.message);
  }
}

app.get("/search", async (req, res) => {
  const keyword = req.query.keyword || req.query.q || "MSP technician";
  const location = req.query.location || req.query.loc || "Remote";
  const days = req.query.days ? parseInt(req.query.days, 10) : 7;

  try {
    const results = await callSearchFn(keyword, location, days);

    // Normalize common result shapes into an array of job objects
    let jobs = results;
    if (!Array.isArray(results)) {
      // try to unwrap common wrappers
      if (results && Array.isArray(results.jobs)) jobs = results.jobs;
      else if (results && Array.isArray(results.results)) jobs = results.results;
      else if (results && results.data && Array.isArray(results.data)) jobs = results.data;
      else jobs = [results]; // last resort: wrap single object
    }

    res.json({
      success: true,
      count: jobs.length,
      jobs
    });
  } catch (err) {
    console.error("API Error:", err);
    // include pkg keys to help debugging in logs
    console.error("Package keys:", Object.keys(pkg || {}));
    res.status(500).json({
      success: false,
      error: String(err),
      hint: "See logs for package keys and attempt details"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("API running on port " + PORT);
});
