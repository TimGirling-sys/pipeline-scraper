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
    headless: true,
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 60,
    maxConcurrency,
    minConcurrency: Math.min(2, maxConcurrency),
    preNavigationHooks: [
      async ({ page }) => {
        await page.route('**/*', (route) => {
          const req = route.request();
          const type = req.resourceType();
          if (['image', 'font', 'media'].includes(type)) return route.abort();
          const url = req.url();
          if (/\b(googletagmanager|google-analytics|segment|hotjar|mixpanel)\b/i.test(url)) {
            return route.abort();
          }
          return route.continue();
        });
      },
    ],
    launchContext: {
      launchOptions: { args: ['--disable-gpu', '--no-sandbox'] },
    },
  });

  await crawler.run(startRequests);
  const data = await Dataset.getData();
  return data;
}
