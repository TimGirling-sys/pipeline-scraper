import { PlaywrightCrawler, ProxyConfiguration, Dataset } from 'crawlee';
import { router } from './routes.js';

export async function runScrape({ companies = [], maxConcurrency = 5, proxyUrl = null } = {}) {
  const proxyConfiguration = proxyUrl
    ? new ProxyConfiguration({ proxyUrls: [proxyUrl] })
    : undefined;

  const startRequests = companies.map((company) => ({
    url: 'https://synapse.patsnap.com/',
    userData: { label: 'search', company },
  }));

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    headless: true, // set to false locally to watch the browser
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 90,
    maxConcurrency,
    minConcurrency: Math.min(2, maxConcurrency),

    // Make the environment closer to Apify’s defaults
    preNavigationHooks: [
      async ({ page }) => {
        await page.setViewportSize({ width: 1366, height: 768 }).catch(() => {});

        // Use a common Chrome UA instead of Playwright’s default
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
        });
        await page.addInitScript(() => {
          // Light anti-bot hardening
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          // Fake plugins/mimeTypes length
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });
      },
    ],

    launchContext: {
      launchOptions: {
        args: [
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1366,768',
          '--lang=en-US',
          '--disable-blink-features=AutomationControlled',
        ],
        // Force a mainstream Chrome UA
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    },
  });

  await crawler.run(startRequests);

  const data = await Dataset.getData();
  return data;
}
