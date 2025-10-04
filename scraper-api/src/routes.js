// routes.js (Render API) — mirrors your working Apify logic, no login checks
import { createPlaywrightRouter, Dataset } from 'crawlee';

export const router = createPlaywrightRouter();

// We keep your "search" entry like in Apify (label set from main/start code)
router.addHandler('search', async ({ request, page, log }) => {
  const { company } = request.userData;
  log.info(`Processing company: ${company}`, { url: request.url });

  // Load homepage
  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Cookie consent (same intent as your Apify code)
  try {
    const cookieButton = await page.locator('button:has-text("Accept")').first();
    if (await cookieButton.isVisible({ timeout: 2000 })) {
      await cookieButton.click().catch(() => {});
      log.info('Accepted cookies');
    }
  } catch {}

  // === Search box (kept the same idea, slightly more forgiving) ===
  // Your Apify selector: input[placeholder*="Search"]
  // We add `i` (case-insensitive) and a couple of near-equivalents but still prefer your original.
  const searchSelector = [
    'input[placeholder*="Search" i]',
    'input[type="search"]',
    'input[aria-label*="Search" i]',
    'input[name*="search" i]',
  ].join(', ');

  try {
    await page.waitForSelector(searchSelector, { timeout: 20000 });
  } catch {
    await Dataset.pushData({ company, error: 'Search input not found' });
    return;
  }

  const searchInput = page.locator(searchSelector).first();
  await searchInput.click().catch(() => {});
  await searchInput.fill(company, { timeout: 15000 }).catch(() => {});
  await page.keyboard.press('Enter');

  // Your Apify code waits for “View Detail”. We’ll keep that, with a small fallback.
  try {
    await page.waitForSelector('text="View Detail"', { timeout: 25000 });
  } catch {
    // small grace scroll to trigger lazy content before giving up
    await page.mouse.wheel(0, 1000).catch(() => {});
    await page.waitForTimeout(1500);
    try {
      await page.waitForSelector('text="View Detail"', { timeout: 8000 });
    } catch {
      await Dataset.pushData({ company, error: 'View Detail button not found' });
      return;
    }
  }

  const firstView = page.locator('text="View Detail"').first();

  // Handle possible new tab/popup like you did
  let detailPage = page;
  const context = page.context();
  let newPagePromise;
  try {
    newPagePromise = context.waitForEvent('page', { timeout: 5000 });
  } catch {}
  await Promise.allSettled([
    firstView.click().catch(() => {}),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
  ]);
  try {
    const maybePopup = newPagePromise ? await newPagePromise.catch(() => null) : null;
    if (maybePopup) {
      detailPage = maybePopup;
      await detailPage.waitForLoadState('domcontentloaded', { timeout: 20000 });
    }
  } catch {}

  // Try to click “Pipeline” tab (kept from your code)
  try {
    const pipelineTab =
      detailPage.getByRole?.('tab', { name: /pipeline/i }) ??
      detailPage.locator('//*[contains(@class,"tab") and contains(.,"Pipeline")]');
    await pipelineTab.first().click({ timeout: 8000 });
    await detailPage.waitForTimeout(800);
  } catch {}

  // --- Your snapshot/table extraction logic below is kept intact (with tiny safety tweaks) ---

  // Try primary UI snapshot first (your approach)
  let pipelineSnapshot = null;
  for (let i = 0; i < 5; i++) {
    pipelineSnapshot = await detailPage.evaluate(() => {
      const phaseItems = Array.from(document.querySelectorAll('div[class*="_phaseItem"]'));
      if (phaseItems.length > 0) {
        const snapshot = {};
        phaseItems.forEach((item) => {
          const nameEl = item.querySelector('div[class*="_phaseName"]');
          const countEl = item.querySelector('div[class*="_phaseCount"]');
          const name = nameEl && nameEl.textContent.trim();
          const count = countEl && countEl.textContent.trim();
          if (name && count) snapshot[name] = count;
        });
        return snapshot;
      }
      return null;
    });

    if (pipelineSnapshot && Object.values(pipelineSnapshot).some((v) => v != null)) break;
    await detailPage.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await detailPage.waitForTimeout(500);
  }

  // If snapshot found, return it (raw; your Make mapping can stay the same)
  if (pipelineSnapshot && Object.values(pipelineSnapshot).some((v) => v != null)) {
    await Dataset.pushData({
      company,
      pipelineSnapshot,
    });
    log.info(`Finished processing ${company} (snapshot extracted)`);
    return;
  }

  // Fallback: pick a table that contains the expected keywords (your table approach)
  try {
    await detailPage.waitForSelector('table', { timeout: 15000 });
    const pipelineTable = await detailPage.evaluate(() => {
      const keywordPatterns = [
        /discovery/i, /preclinical/i, /ind\s*application/i, /ind\s*approval/i,
        /phase\s*1/i, /phase\s*2/i, /phase\s*3/i, /approved/i, /other/i,
        /disease\s+domain/i, /count/i,
      ];
      const tables = Array.from(document.querySelectorAll('table'));
      let selectedTable = null;
      let maxRows = 0;
      for (const table of tables) {
        const text = table.innerText.toLowerCase();
        if (!keywordPatterns.some((re) => re.test(text))) continue;
        const rows = table.querySelectorAll('tbody tr');
        const rowCount = rows.length;
        if (rowCount > maxRows) {
          maxRows = rowCount;
          selectedTable = table;
        }
      }
      if (!selectedTable) return null;
      const rows = Array.from(selectedTable.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('th, td')).map((cell) => cell.innerText.trim())
      );
      return rows;
    });

    if (pipelineTable && pipelineTable.length > 0) {
      await Dataset.pushData({
        company,
        pipeline: pipelineTable,
      });
      log.info(`Finished processing ${company} (table extracted)`);
      return;
    }
  } catch {}

  await Dataset.pushData({
    company,
    error: 'Pipeline snapshot not found',
  });
  log.info(`Finished processing ${company} (snapshot not found)`);
});
