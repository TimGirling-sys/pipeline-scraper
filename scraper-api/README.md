# Synapse Scraper API

This project converts your Apify Actor into a standalone **API** you can deploy on **Render** (or any other platform).

### 🚀 Usage
1. Deploy on [Render.com](https://render.com)
2. POST to `/v1/scrape` with JSON body:

```json
{
  "companies": ["Genmab", "Seagen"],
  "maxConcurrency": 3
}
```

### Example
```bash
curl -X POST https://your-service.onrender.com/v1/scrape \  -H "Content-Type: application/json" \  -d '{"companies":["Genmab","Seagen"]}'
```

Returns scraped data as JSON.
