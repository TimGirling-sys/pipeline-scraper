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
    headless: true, // set to false to watch browser locally
    requestHandlerTimeoutSecs: 180, // was 90
    navigationTimeoutSecs: 90,      // was 60
    maxConcurrency,
    minConcurrency: Math.min(2, maxConcurrency),
    preNavigationHooks: [
      async ({ page }) => {
        await page.setViewportSize({ width: 1366, height: 768 }).catch(() => {});
        // Only skip heavy media, keep fonts/images so UI renders correctly
        await page.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (type === 'media') return route.abort();
          return route.continue();
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
        ],
      },
    },
  });

  await crawler.run(startRequests);

  const data = await Dataset.getData();
  return data;
}
