import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log }) => {
  const company = request.userData.company;
  log.info(`🔍 Searching for ${company}`);

  // 1) Wait for the page to load properly
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // 2) Try to dismiss cookie / consent banners
  const consentSelectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Agree")',
    'text=Accept all',
    '#onetrust-accept-btn-handler',
    'button[aria-label*="accept" i]'
  ];
  for (const sel of consentSelectors) {
    const el = page.locator(sel);
    if (await el.count()) {
      log.info(`✅ Dismissing cookie banner with selector: ${sel}`);
      await el.first().click().catch(() => {});
      break;
    }
  }

  // 3) Detect login screen
  const bodyText = await page.textContent('body').catch(() => '');
  const looksLikeLogin =
    /sign in|log in|password|email/i.test(bodyText || '') ||
    (await page.locator('input[type="password"]').count()) > 0;

  if (looksLikeLogin) {
    log.warning('🔒 Login page detected. Skipping scrape for this company.');
    await Dataset.pushData({
      company,
      error: 'LOGIN_REQUIRED',
      url: page.url(),
      title: await page.title().catch(() => null),
      scrapedAt: new Date().toISOString(),
    });
    return;
  }

  // 4) Try to find a search bar (several patterns)
  const searchCandidates = [
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="Search" i]',
    'input[name*="search" i]'
  ].join(', ');

  log.info('🔎 Looking for search bar...');
  const searchInputs = page.locator(searchCandidates);

  let hasSearch = false;
  try {
    await searchInputs.first().waitFor({ timeout: 60000 });
    hasSearch = true;
  } catch {
    log.warning('⚠️ No search input found after 60s.');
  }

  if (!hasSearch) {
    await Dataset.pushData({
      company,
      error: 'SEARCH_INPUT_NOT_FOUND',
      url: page.url(),
      title: await page.title().catch(() => null),
      scrapedAt: new Date().toISOString(),
    });
    return;
  }

  // 5) Perform the search
  const search = searchInputs.first();
  await search.click({ delay: 30 }).catch(() => {});
  await search.fill(company, { timeout: 30000 }).catch(() => {});
  await page.keyboard.press('Enter');

  // 6) Wait for results
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000); // Give the app time to render

  // 7) Capture the page
  const html = await page.content();
  const title = await page.title().catch(() => null);
  const url = page.url();

  // Optionally save a screenshot (helpful if debugging)
  await page.screenshot({ path: `screenshots/${company}-page.png`, fullPage: true }).catch(() => {});

  // 8) Push results
  await Dataset.pushData({
    company,
    title,
    url,
    htmlLength: html.length,
    scrapedAt: new Date().toISOString(),
  });

  log.info(`✅ Finished scraping ${company}`);
});

