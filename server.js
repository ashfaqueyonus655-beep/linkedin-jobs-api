import express from "express";
import { search } from "linkedin-jobs-api";

const app = express();
app.set("trust proxy", true);

app.get("/search", async (req, res) => {
  try {
    const keyword = req.query.keyword || "MSP technician";
    const location = req.query.location || "Remote";
    const days = req.query.days ? parseInt(req.query.days) : 7;

    const results = await search({
      keywords: keyword,
      location: location,
      time: days
    });

    res.json({
      success: true,
      count: results.length,
      jobs: results
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      message: error.toString()
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
