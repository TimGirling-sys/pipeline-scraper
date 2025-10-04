import express from 'express';
import { runScrape } from './main.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/v1/scrape', async (req, res) => {
  try {
    const { companies = [], maxConcurrency = 5, proxyUrl = null } = req.body || {};
    if (!Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({ error: 'Provide non-empty companies[]' });
    }
    const data = await runScrape({ companies, maxConcurrency, proxyUrl });
    res.json({ ok: true, count: data.items.length, items: data.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`✅ Scraper API listening on :${port}`);
});
