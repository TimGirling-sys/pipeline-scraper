// routes.js — click by company name after search + stronger diagnostics
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
        log.info(`👉 Clicking: ${sel}`);
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
  const shotsDir = path.join(process.cwd(), 'screenshots');
  ensureDir(shotsDir);

  log.info(`Processing company: ${company}`, { url: request.url });

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

  // 3) Find search input (your original intent + close variants)
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
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');

  // 4) Wait for results; let SPA render; gently scroll to wake lazy loaders
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, 900).catch(() => {});
  }

  // 5) Prefer clicking a link that contains the company name (case-insensitive)
  //    This avoids relying on “View Details” marketing cards.
  const companyNameLower = company.toLowerCase();
  const linkSelector = 'a, [role="link"], button';

  // collect candidate links/buttons that contain the company name
  const candidates = await page.evaluate((sel, nameLc) => {
    const els = Array.from(document.querySelectorAll(sel));
    const items = [];
    for (const e of els) {
      const text = (e.innerText || '').trim();
      if (!text) continue;
      if (text.toLowerCase().includes(nameLc)) {
        const href = e.getAttribute('href') || '';
        items.push({ text, href });
      }
    }
    return items.slice(0, 20);
  }, linkSelector, companyNameLower).catch(() => []);

  log.info(`🔎 Company-matching links/buttons (top 20): ${JSON.stringify(candidates)}`);

  // Build dynamic selectors for exact text hits first, then partials
  const dynamicSelectors = [];
  // exact text hits first (case-sensitive selector in Playwright; we’ll add a couple of forms)
  dynamicSelectors.push(`a:has-text("${company}")`, `[role="link"]:has-text("${company}")`, `button:has-text("${company}")`);
  // looser partials
  dynamicSelectors.push(`a:has-text("${company.split(' ')[0]}")`);
  // generic likely areas
  dynamicSelectors.push('main a', '[role="main"] a');

  const foundSel = await waitForAny(page, dynamicSelectors, 25000);
  if (!foundSel) {
    // As a last resort, click the first candidate we saw via JS (by text match)
    if (candidates.length > 0) {
      const firstText = candidates[0].text;
      log.info(`⚠️ Using JS-found candidate: ${firstText}`);
      try {
        await page.locator(`a:has-text("${firstText}")`).first().click({ timeout: 12000 });
      } catch {
        // if the selector form fails, try a coarse query via evaluate
        const clicked = await page.evaluate((txt) => {
          const els = Array.from(document.querySelectorAll('a, [role="link"], button'));
          const el = els.find(e => (e.innerText || '').trim() === txt);
          if (el) { el.click(); return true; }
          return false;
        }, firstText).catch(() => false);
        if (!clicked) {
          await page.screenshot({ path: path.join(shotsDir, `${company}-no-company-link.png`), fullPage: true }).catch(() => {});
          await Dataset.pushData({
            company,
            error: 'COMPANY_LINK_NOT_FOUND',
            hints: candidates,
            pageUrl: page.url(),
          });
          return;
        }
      }
    } else {
      await page.screenshot({ path: path.join(shotsDir, `${company}-no-company-link.png`), fullPage: true }).catch(() => {});
      await Dataset.pushData({
        company,
        error: 'COMPANY_LINK_NOT_FOUND',
        hints: [],
        pageUrl: page.url(),
      });
      return;
    }
  } else {
    await page.locator(foundSel).first().click({ timeout: 12000 }).catch(() => {});
  }

  // Handle potential new tab
  const context = page.context();
  const newPage = await context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
  const detailPage = newPage || page;

  await detailPage.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await detailPage.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await detailPage.waitForTimeout(1000);

  // Optional: try to click "Pipeline" tab if present
  try {
    const pipelineTab =
      detailPage.getByRole?.('tab', { name: /pipeline/i }) ??
      detailPage.locator('//*[contains(@class,"tab") and contains(.,"Pipeline")]');
    if (await pipelineTab.first().count()) {
      await pipelineTab.first().click({ timeout: 8000 }).catch(() => {});
      await detailPage.waitForTimeout(800);
    }
  } catch {}

  // === Pipeline snapshot first (your original approach) ===
  let pipelineSnapshot = null;
  for (let i = 0; i < 6; i++) {
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
    await detailPage.waitForTimeout(600);
  }

  if (pipelineSnapshot && Object.values(pipelineSnapshot).some((v) => v != null)) {
    await Dataset.pushData({ company, pipelineSnapshot, detailUrl: detailPage.url() });
    return;
  }

  // === Table fallback ===
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
