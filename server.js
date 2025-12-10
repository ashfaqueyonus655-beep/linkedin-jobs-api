// server.js (CommonJS)
const express = require("express");
const search = require("linkedin-jobs-api"); // package exports the function as CommonJS default

const app = express();
app.set("trust proxy", true);

app.get("/search", async (req, res) => {
  try {
    const keyword = req.query.keyword || "MSP technician";
    const location = req.query.location || "Remote";
    const days = req.query.days ? parseInt(req.query.days, 10) : 7;

    // Call the linkedin-jobs-api package function
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
  } catch (err) {
    console.error("API Error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("API running on port " + PORT);
});
