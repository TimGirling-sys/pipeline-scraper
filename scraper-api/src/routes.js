import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
  const company = request.userData.company;
  log.info(`🔍 Searching for ${company}`);

  await page.waitForSelector('input[type="search"]', { timeout: 20000 });
  await page.fill('input[type="search"]', company);
  await page.keyboard.press('Enter');

  await page.waitForTimeout(5000);
  const html = await page.content();

  await Dataset.pushData({ company, htmlLength: html.length, scrapedAt: new Date().toISOString() });
});
