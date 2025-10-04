// routes.js — rock-solid search submission + company click + extraction
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
    await page.waitForTimeout(300);
  }
  return null;
}

// ---------- client-side helpers (run in the page) ----------
function client_extractSnapshot() {
  const snapshot = {};
  const map = new Map();
  const phaseItems = Array.from(document.querySelectorAll('div[class*="_phaseItem"], [data-phase], .phase-item'));
  if (phaseItems.length) {
    for (const item of phaseItems) {
      const name =
        item.querySelector('div[class*="_phaseName"], .phase-name, [data-phase-name]')?.textContent?.trim() ||
        item.querySelector('*')?.textContent?.trim() || '';
      const countText =
        item.querySelector('div[class*="_phaseCount"], .phase-count, [data-phase-count]')?.textContent?.trim() ||
        item.textContent || '';
      if (!name) continue;
      const m = String(countText).match(/(\d+)/);
      const n = m ? Number(m[1]) : 0;
      map.set(name, n);
    }
  }
  const labels = ['Discovery','Preclinical','IND Application','IND Approval','Phase 1','Phase 2','Phase 3','Approved','Other'];
  const text = document.body.innerText;
  for (const L of labels) {
    if (!map.has(L)) {
      const re = new RegExp(`${L}\\s*(\\d+)`, 'i');
      const m = text.match(re);
      if (m) map.set(L, Number(m[1]));
    }
  }
  for (const [k, v] of map.entries()) snapshot[k] = v;
  return Object.keys(snapshot).length ? snapshot : null;
}

function client_extractTagsIntro() {
  const chips = Array.from(document.querySelectorAll(
    '[class*="tag"], [class*="chip"], .ant-tag, .ant-tag-green, .ant-tag-blue, .ant-tag-has-color'
  ));
  const tagTexts = chips.map(c => c.textContent.trim()).filter(Boolean);
  let labeledTags = [];
  const tagHeaders = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,strong,span'))
    .filter(el => /tags?/i.test(el.textContent));
  for (const hdr of tagHeaders) {
    const section = hdr.closest('section,div,article') || hdr.parentElement;
    if (!section) continue;
    const localChips = Array.from(section.querySelectorAll('[class*="tag"], [class*="chip"], .ant-tag'))
      .map(x => x.textContent.trim()).filter(Boolean);
    if (localChips.length) { labeledTags = localChips; break; }
  }
  const finalTags = labeledTags.length ? labeledTags : tagTexts;
  const uniq = Array.from(new Set(finalTags));
  return uniq.length ? `Tags ${uniq.join(' ')}` : null;
}

function client_extractTopListByHeading(headingRegex) {
  const allHeadings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,strong,span'));
  let section = null;
  for (const h of allHeadings) {
    const txt = (h.textContent || '').trim();
    if (headingRegex.test(txt)) {
      section = h.closest('section,div,article') || h.parentElement;
      if (section) break;
    }
  }
  if (!section) return [];

  let rows = Array.from(section.querySelectorAll('li, .item, .row, tr'))
    .filter(el => /\d/.test(el.innerText));
  if (!rows.length) {
    rows = Array.from(section.querySelectorAll('div, a, span'))
      .filter(el => el.children.length === 0 && /\d/.test(el.innerText))
      .map(el => el.parentElement);
  }

  const items = [];
  for (const r of rows.slice(0, 20)) {
    const raw = (r.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const m = raw.match(/(.+?)\s*(\d+)(?:\D*)$/);
    if (m) {
      const name = m[1].trim();
      const cnt = Number(m[2]);
      if (name && Number.isFinite(cnt)) items.push({ name, count: cnt, raw });
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  return deduped;
}

// ---------- main handler ----------
router.addHandler('search', async ({ request, page, log }) => {
  const { company } = request.userData;
  const shotsDir = path.join(process.cwd(), 'screenshots');
  ensureDir(shotsDir);

  log.info(`Processing company: ${company}`, { url: request.url });

  // 1) Go to homepage & settle
  await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // 2) Cookie consent
  await clickFirstVisible(page, [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Agree")',
    '#onetrust-accept-btn-handler',
    'button[aria-label*="accept" i]',
  ], log, 3000).catch(() => {});

  // 3) Find the global search input
  const searchSelectorList = [
    'input[placeholder*="Search" i]',
    'input[type="search"]',
    'input[aria-label*="Search" i]',
    'input[name*="search" i]',
    // common site-specific fallbacks:
    'header input',
    '.ant-input[type="text"]',
  ];
  const foundSearchSel = await waitForAny(page, searchSelectorList, 25000);
  if (!foundSearchSel) {
    await page.screenshot({ path: path.join(shotsDir, `${company}-no-search.png`), fullPage: true }).catch(() => {});
    await Dataset.pushData({ company, error: 'SEARCH_INPUT_NOT_FOUND', pageUrl: page.url() });
    return;
  }

  const searchInput = page.locator(foundSearchSel).first();
  await searchInput.click().catch(() => {});
  await searchInput.fill(company, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);

  // 4) Submit search robustly (4 strategies)
  const urlBefore = page.url();
  // a) Enter key (twice, some SPAs need two)
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter').catch(() => {});

  // b) Click a nearby "Search" button if present
  const clickedSearchBtn = await clickFirstVisible(page, [
    'button:has-text("Search")',
    'button[aria-label*="search" i]',
    'form button[type="submit"]',
    '.ant-input-search-button',
  ], log, 3000);

  // c) Submit the closest form
  try {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const form = el && (el.closest('form'));
      if (form) form.submit();
    }, foundSearchSel);
  } catch {}

  // d) If still on homepage after 3s, navigate to the public results route via JS
  await page.waitForTimeout(3000);
  const stillHomepage = page.url() === urlBefore;
  if (stillHomepage) {
    log.info('⚠️ Still on homepage after submit attempts — forcing navigation to results route.');
    try {
      // Known public results route used by SPA; keyword param works on free tier.
      await page.goto(`https://synapse.patsnap.com/homepage/search?keyword=${encodeURIComponent(company)}`, {
        waitUntil: 'domcontentloaded', timeout: 60000,
      });
    } catch {}
  }

  // 5) Wait for results page or results container
  //    (URL often contains /homepage/search and a results list renders)
  const onResults = () => /\/search/i.test(page.url()) || /results?/i.test(document.body.innerText);
  try {
    await page.waitForFunction(onResults, { timeout: 15000 });
  } catch {
    // Wake the SPA and try again
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 800).catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  // 6) Collect top clickable texts for diagnostics
  const clickables = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, [role="link"], button'))
      .filter(e => (e.offsetParent !== null))
      .map(e => ((e.innerText || '').trim()))
      .filter(Boolean);
    const uniq = [];
    const seen = new Set();
    for (const t of els) { const k = t.replace(/\s+/g,' ').toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(t); } }
    return uniq.slice(0, 30);
  }).catch(() => []);
  log.info(`🔎 Clickable texts (top 30): ${JSON.stringify(clickables)}`);

  // 7) Try to click a result that contains the company name
  const companyLc = company.toLowerCase();
  const resultSelectors = [
    // Typical result title areas
    `a:has-text("${company}")`,
    `[role="link"]:has-text("${company}")`,
    // partials for multi-word names
    `a:has-text("${company.split(' ')[0]}")`,
    // cards & list items commonly used in Ant Design or custom grids
    '.ant-list-item a',
    '.ant-card a',
    '.ant-list-item',
    '.ant-card',
    'main a',
  ];

  // prefer an exact text match if it exists in the clickables list
  let clickedCompany = false;
  const exactInClickables = clickables.find(t => t.toLowerCase() === companyLc);
  if (exactInClickables) {
    try {
      await page.locator(`a:has-text("${exactInClickables}")`).first().click({ timeout: 8000 });
      clickedCompany = true;
    } catch {}
  }

  if (!clickedCompany) {
    const foundSel = await waitForAny(page, resultSelectors, 20000);
    if (foundSel) {
      // Filter to only nodes that include the company text
      const loc = page.locator(foundSel).filter({ hasText: new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
      if (await loc.count().catch(() => 0)) {
        log.info(`🧭 Clicking company match in results via: ${foundSel}`);
        await loc.click({ timeout: 10000 }).catch(() => {});
        clickedCompany = true;
      }
    }
  }

  // Fallback: try to click any clickable that includes the company (JS)
  if (!clickedCompany) {
    const didClick = await page.evaluate((nameLc) => {
      const els = Array.from(document.querySelectorAll('a, [role="link"], button'));
      const el = els.find(e => (e.innerText || '').toLowerCase().includes(nameLc));
      if (el) { (el as HTMLElement).click(); return true; }
      return false;
    }, companyLc).catch(() => false);
    clickedCompany = !!didClick;
  }

  if (!clickedCompany) {
    await page.screenshot({ path: path.join(shotsDir, `${company}-no-company-link.png`), fullPage: true }).catch(() => {});
    await Dataset.pushData({
      company,
      error: 'COMPANY_LINK_NOT_FOUND',
      hints: clickables,
      pageUrl: page.url(),
    });
    return;
  }

  // 8) Handle potential new tab
  const context = page.context();
  const newPage = await context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
  const detailPage = newPage || page;

  await detailPage.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await detailPage.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await detailPage.waitForTimeout(800);

  // Optional: click "Pipeline" tab if present
  try {
    const pipelineTab =
      detailPage.getByRole?.('tab', { name: /pipeline/i }) ??
      detailPage.locator('//*[contains(@class,"tab") and contains(.,"Pipeline")]');
    if (await pipelineTab.first().count()) {
      await pipelineTab.first().click({ timeout: 8000 }).catch(() => {});
      await detailPage.waitForTimeout(600);
    }
  } catch {}

  // Gentle scrolling to trigger lazy content
  for (let i = 0; i < 5; i++) {
    await detailPage.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await detailPage.waitForTimeout(500);
  }

  // === Extract snapshot ===
  let pipelineSnapshot = null;
  for (let i = 0; i < 6; i++) {
    pipelineSnapshot = await detailPage.evaluate(client_extractSnapshot).catch(() => null);
    if (pipelineSnapshot && Object.keys(pipelineSnapshot).length) break;
    await detailPage.waitForTimeout(400);
  }

  // === Extract tags / introduction ===
  const introduction = await detailPage.evaluate(client_extractTagsIntro).catch(() => null);

  // === Extract top lists ===
  const diseaseDomainItems = await detailPage
    .evaluate(client_extractTopListByHeading, /disease\s*domain/i)
    .catch(() => []);
  const drugTypeItems = await detailPage
    .evaluate(client_extractTopListByHeading, /drug\s*type/i)
    .catch(() => []);
  const targetItems = await detailPage
    .evaluate(client_extractTopListByHeading, /\btargets?\b/i)
    .catch(() => []);

  const dd = diseaseDomainItems.slice(0, 5);
  const dt = drugTypeItems.slice(0, 5);
  const tg = targetItems.slice(0, 5);

  const result = { company, detailUrl: detailPage.url() };
  if (pipelineSnapshot) result.pipelineSnapshot = pipelineSnapshot;
  if (introduction) result.introduction = introduction;
  dd.forEach((it, i) => { result[`topDiseaseDomain_${i + 1}`] = it.name; result[`topDiseaseDomainCount_${i + 1}`] = it.count; });
  dt.forEach((it, i) => { result[`topDrugType_${i + 1}`] = it.name; result[`topDrugTypeCount_${i + 1}`] = it.count; });
  tg.forEach((it, i) => { result[`topTarget_${i + 1}`] = it.name; result[`topTargetCount_${i + 1}`] = it.count; });

  let pushed = false;
  if (result.pipelineSnapshot || result.introduction || dd.length || dt.length || tg.length) {
    await Dataset.pushData(result);
    pushed = true;
  } else {
    // Fallback: attempt to parse any pipeline-like table
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
          if (rows.length > maxRows) { maxRows = rows.length; selectedTable = table; }
        }
        if (!selectedTable) return null;
        return Array.from(selectedTable.querySelectorAll('tbody tr')).map((row) =>
          Array.from(row.querySelectorAll('th, td')).map((cell) => cell.innerText.trim())
        );
      });
    } catch {}

    if (pipelineTable && pipelineTable.length > 0) {
      const pipelineKV = {};
      for (const row of pipelineTable) {
        const firstCell = row?.[0];
        if (!firstCell) continue;
        const parts = String(firstCell).split('\n').map(s => s.trim()).filter(Boolean);
        const key = parts.shift();
        if (!key) continue;
        const value = parts.join(' ').replace(/\[\+(\d+)\]/g, '(+$1)');
        pipelineKV[key] = value || null;
      }
      await Dataset.pushData({ company, pipeline: pipelineKV, rawTable: pipelineTable, detailUrl: detailPage.url() });
      pushed = true;
    }
  }

  if (!pushed) {
    await detailPage.screenshot({ path: path.join(shotsDir, `${company}-no-pipeline.png`), fullPage: true }).catch(() => {});
    await Dataset.pushData({ company, error: 'PIPELINE_NOT_FOUND', detailUrl: detailPage.url() });
  }
});
