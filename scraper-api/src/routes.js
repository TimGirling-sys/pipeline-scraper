// routes.js — click by company name after search + extract snapshot, tags, and top lists
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

// --------- DOM extraction helpers (run in page context) ----------
function client_extractSnapshot() {
  const snapshot = {};
  const map = new Map();
  // Look for typical phase items
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
  // Also scan any obvious phase summary blocks
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
  // Try “Tags” section or chip-like elements
  const chips = Array.from(document.querySelectorAll(
    '[class*="tag"], [class*="chip"], .ant-tag, .ant-tag-green, .ant-tag-blue, .ant-tag-has-color'
  ));
  const tagTexts = chips.map(c => c.textContent.trim()).filter(Boolean);

  // If there is a labeled “Tags” block, prefer chips inside it
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
  // Find a heading that matches and then extract list/table beneath it
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

  // Collect candidate rows/items within the section
  let rows = Array.from(section.querySelectorAll('li, .item, .row, tr'))
    .filter(el => /\d/.test(el.innerText)); // must contain a number

  if (!rows.length) {
    // fallback: pick direct children blocks that contain a number
    rows = Array.from(section.querySelectorAll('div, a, span'))
      .filter(el => el.children.length === 0 && /\d/.test(el.innerText))
      .map(el => el.parentElement);
  }

  // Parse top 10 then we’ll cut to 5 at the caller
  const items = [];
  for (const r of rows.slice(0, 20)) {
    const raw = (r.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    // Heuristic: last number is the count
    const m = raw.match(/(.+?)\s*(\d+)(?:\D*)$/);
    if (m) {
      const name = m[1].trim();
      const cnt = Number(m[2]);
      if (name && Number.isFinite(cnt)) items.push({ name, count: cnt, raw });
    }
  }
  // Prefer unique names, keep original order
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

// ---------------------------------------------------------------

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

  // 3) Find search input
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

  // 4) Wait for results; nudge lazy rendering
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, 900).catch(() => {});
  }

  // 5) Prefer links that contain the company name
  const companyNameLower = company.toLowerCase();
  const candidates = await page.evaluate((nameLc) => {
    const els = Array.from(document.querySelectorAll('a, [role="link"], button'));
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
  }, companyNameLower).catch(() => []);

  const dynamicSelectors = [
    `a:has-text("${company}")`,
    `[role="link"]:has-text("${company}")`,
    `button:has-text("${company}")`,
    `a:has-text("${company.split(' ')[0]}")`,
    'main a', '[role="main"] a',
  ];

  const foundSel = await waitForAny(page, dynamicSelectors, 25000);
  if (!foundSel) {
    if (candidates.length > 0) {
      const firstText = candidates[0].text;
      try {
        await page.locator(`a:has-text("${firstText}")`).first().click({ timeout: 12000 });
      } catch {
        const clicked = await page.evaluate((txt) => {
          const els = Array.from(document.querySelectorAll('a, [role="link"], button'));
          const el = els.find(e => (e.innerText || '').trim() === txt);
          if (el) { el.click(); return true; }
          return false;
        }, firstText).catch(() => false);
        if (!clicked) {
          await page.screenshot({ path: path.join(shotsDir, `${company}-no-company-link.png`), fullPage: true }).catch(() => {});
          await Dataset.pushData({ company, error: 'COMPANY_LINK_NOT_FOUND', hints: candidates, pageUrl: page.url() });
          return;
        }
      }
    } else {
      await page.screenshot({ path: path.join(shotsDir, `${company}-no-company-link.png`), fullPage: true }).catch(() => {});
      await Dataset.pushData({ company, error: 'COMPANY_LINK_NOT_FOUND', hints: [], pageUrl: page.url() });
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

  // Optional: click "Pipeline" tab
  try {
    const pipelineTab =
      detailPage.getByRole?.('tab', { name: /pipeline/i }) ??
      detailPage.locator('//*[contains(@class,"tab") and contains(.,"Pipeline")]');
    if (await pipelineTab.first().count()) {
      await pipelineTab.first().click({ timeout: 8000 }).catch(() => {});
      await detailPage.waitForTimeout(800);
    }
  } catch {}

  // Try a couple of scroll passes so dynamic widgets render
  for (let i = 0; i < 4; i++) {
    await detailPage.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await detailPage.waitForTimeout(600);
  }

  // === Extract snapshot (Discovery..Approved) ===
  let pipelineSnapshot = null;
  for (let i = 0; i < 6; i++) {
    pipelineSnapshot = await detailPage.evaluate(client_extractSnapshot).catch(() => null);
    if (pipelineSnapshot && Object.keys(pipelineSnapshot).length) break;
    await detailPage.waitForTimeout(500);
  }

  // === Extract Tags/Introduction (chips) ===
  const introduction = await detailPage.evaluate(client_extractTagsIntro).catch(() => null);

  // === Extract Top lists ===
  const diseaseDomainItems = await detailPage
    .evaluate(client_extractTopListByHeading, /disease\s*domain/i)
    .catch(() => []);
  const drugTypeItems = await detailPage
    .evaluate(client_extractTopListByHeading, /drug\s*type/i)
    .catch(() => []);
  const targetItems = await detailPage
    .evaluate(client_extractTopListByHeading, /\btargets?\b/i)
    .catch(() => []);

  // Keep top 5 each
  const dd = diseaseDomainItems.slice(0, 5);
  const dt = drugTypeItems.slice(0, 5);
  const tg = targetItems.slice(0, 5);

  // Build Apify-style payload keys
  const result = { company, detailUrl: detailPage.url() };
  if (pipelineSnapshot) result.pipelineSnapshot = pipelineSnapshot;
  if (introduction) result.introduction = introduction;

  dd.forEach((it, i) => {
    result[`topDiseaseDomain_${i + 1}`] = it.name;
    result[`topDiseaseDomainCount_${i + 1}`] = it.count;
  });
  dt.forEach((it, i) => {
    result[`topDrugType_${i + 1}`] = it.name;
    result[`topDrugTypeCount_${i + 1}`] = it.count;
  });
  tg.forEach((it, i) => {
    result[`topTarget_${i + 1}`] = it.name;
    result[`topTargetCount_${i + 1}`] = it.count;
  });

  // If we still have nothing but company/url, fall back to the table we previously parsed
  let pushed = false;
  if (
    result.pipelineSnapshot ||
    result.introduction ||
    dd.length || dt.length || tg.length
  ) {
    await Dataset.pushData(result);
    pushed = true;
  } else {
    // Fallback: try to harvest any pipeline-like table as before
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
      // normalize to key/value like your Apify shape expects elsewhere
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
