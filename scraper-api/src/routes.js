import { createPlaywrightRouter, Dataset } from 'crawlee';
import fs from 'node:fs';
import path from 'node:path';

export const router = createPlaywrightRouter();

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

async function clickFirstVisible(page, selectorList, log, timeoutPerSel = 8000) {
  for (const sel of selectorList) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    try {
      await loc.waitFor({ timeout: timeoutPerSel });
      if (await loc.isVisible().catch(() => false)) {
        log.info(`👉 Clicking selector: ${sel}`);
        await loc.click({ timeout: timeoutPerSel }).catch(() => {});
        return true;
      }
    } catch {}
  }
  return false;
}

async function waitForAny(page, selectors, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const loc = page.locator(sel);
      if ((await loc.count().catch(() => 0)) > 0) return sel;
    }
    await page.waitForTimeout(400);
  }
  return null;
}

router.addHandler('search', async ({ request, page, log }) => {
  const { company } = request.userData;
  log.info(`Processing company: ${company}`, { url: request.url });

  const shotsDir = path.join(process.cwd(), 'screenshots');
  ensureDir(shotsDir);

  // 1) Load & settle
  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // 2) Cookie consent (best-effort)
  await clickFirstVisible(page, [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Agree")',
    '#onetrust-accept-btn-handler',
    'button[aria-label*="accept" i]',
  ], log, 3000).catch(() => {});

  // 3) Find search input (same intent as your Apify code)
  const searchSelector = [
    'input[placeholder*="Search" i]',
    'input[type="search"]',
    'input[aria-label*="Search" i]',
    'input[name*="search" i]',
  ].join(', ');

  try {
    await page.waitForSelector(searchSelector, { timeout: 25000 });
  } catch {
    await page.screenshot({ path: path.join(shotsDir, `${company}-no-search.png`), fullPage: true }).catch(() => {});
    await Dataset.pushData({ company, error: 'SEARCH_INPUT_NOT_FOUND', pageUrl: page.url() });
    return;
  }

  const searchInput = page.locator(searchSelector).first();
  await searchInput.click().catch(() => {});
  await searchInput.fill(company, { timeout: 15000 }).catch(() => {});
  // Some sites require a short pause before submit
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');

  // 4) Wait for results; gently scroll to trigger lazy rendering
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1200);
    await page.mouse.wheel(0, 800).catch(() => {});
  }

  // 5) Diagnostics: list visible buttons/links that contain “detail” or “view”
  const candidatesText = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, button'));
    return els
      .map(e => (e.innerText || '').trim())
      .filter(t => /detail|view|open|more/i.test(t))
      .slice(0, 20);
  }).catch(() => []);
  log.info(`🔎 Result action texts (top 20): ${JSON.stringify(candidatesText)}`);

  // 6) Click into the first result — broadened beyond "View Detail"
  const detailSelectors = [
    // Exact/close matches
    'a:has-text("View Detail")',
    'button:has-text("View Detail")',
    'a:has-text("View Details")',
    'button:has-text("View Details")',
    // Generic result cards that often contain company name
    `a:has-text("${company}")`,
    `a[title*="${company}" i]`,
    'a[href*="/product"]',
    'a[href*="/company"]',
    'a[href*="/drug"]',
    // last resort: first anchor inside main/results area
    'main a',
    '[role="main"] a',
  ];

  const foundSel = await waitForAny(page, detailSelectors, 25000);
  if (!foundSel) {
    await page.screenshot({ path: path.join(shotsDir, `${company}-no-detail.png`), fullPage: true }).catch(() => {});
    await Dataset.pushData({
      company,
      error: 'DETAIL_ENTRY_NOT_FOUND',
      hints: candidatesText,
      pageUrl: page.url(),
    });
    return;
  }

  // Try click; handle new tab/popups
  const context = page.context();
  const newPagePromise = context.waitForEvent('page').catch(() => null);

  await Promise.allSettled([
    page.locator(foundSel).first().click({ timeout: 12000 }),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
  ]);
  const maybePopup = await newPagePromise;
  const detailPage = maybePopup || page;

  await detailPage.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await detailPage.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await detailPage.waitForTimeout(1000);

  // Try Pipeline tab
  try {
    const pipelineTab =
      detailPage.getByRole?.('tab', { name: /pipeline/i }) ??
      detailPage.locator('//*[contains(@class,"tab") and contains(.,"Pipeline")]');
    await pipelineTab.first().click({ timeout: 8000 }).catch(() => {});
    await detailPage.waitForTimeout(800);
  } catch {}

  // Snapshot pass
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
    }).catch(() => null);

    if (pipelineSnapshot && Object.values(pipelineSnapshot).some((v) => v != null)) break;
    await detailPage.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await detailPage.waitForTimeout(500);
  }

  if (pipelineSnapshot && Object.values(pipelineSnapshot).some((v) => v != null)) {
    await Dataset.pushData({ company, pipelineSnapshot, detailUrl: detailPage.url() });
    return;
  }

  // Table fallback
  let pipelineTable = null;
  try {
    await detailPage.waitForSelector('table', { timeout: 15000 });
    pipelineTable = await detailPage.evaluate(() => {
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
        if (rows.length > maxRows) {
          maxRows = rows.length;
          selectedTable = table;
        }
      }
      if (!selectedTable) return null;
      return Array.from(selectedTable.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('th, td')).map((cell) => cell.innerText.trim())
      );
    });
  } catch {}

  if (pipelineTable && pipelineTable.length > 0) {
    await Dataset.pushData({ company, pipeline: pipelineTable, detailUrl: detailPage.url() });
    return;
  }

  // Final screenshot on miss
  await detailPage.screenshot({ path: path.join(shotsDir, `${company}-no-pipeline.png`), fullPage: true }).catch(() => {});
  await Dataset.pushData({
    company,
    error: 'PIPELINE_NOT_FOUND',
    detailUrl: detailPage.url(),
  });
});

