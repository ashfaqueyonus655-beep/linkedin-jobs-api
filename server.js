// server.js — safe import wrapper for a CommonJS library
import express from "express";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Try to require the package (handles CommonJS)
let linkedinPkg;
try {
  linkedinPkg = require("linkedin-jobs-api");
} catch (err) {
  console.error("Failed to require linkedin-jobs-api:", err);
  process.exit(1);
}

// Extract the search function from possible shapes
const search =
  linkedinPkg.search ||                 // named export shape
  (linkedinPkg.default && linkedinPkg.default.search) || // default.search
  linkedinPkg;                           // fallback: package itself is a function

if (!search || typeof search !== "function") {
  console.error("Could not find a usable `search` function in linkedin-jobs-api package.");
  console.error("Package keys:", Object.keys(linkedinPkg));
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);

app.get("/search", async (req, res) => {
  try {
    const keyword = req.query.keyword || "MSP technician";
    const location = req.query.location || "Remote";
    const days = req.query.days ? parseInt(req.query.days) : 7;

    // Call the extracted search function.
    // If the package expects a different param shape, adapt here.
    const results = await search({
      keywords: keyword,
      location: location,
      time: days
    });

    res.json({
      success: true,
      count: Array.isArray(results) ? results.length : (results?.length || 0),
      jobs: results
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      message: error?.message || String(error)
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
