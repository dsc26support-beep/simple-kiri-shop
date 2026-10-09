// Admin page: section menu, search across orders / payments / review cases,
// and reference shortcuts (backend mocked). Phone width.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

const RESULTS = {
  ok: true, phone: false, exact: null,
  stores: [{ ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', status: 'active' }],
  products: [],
  orders: [{ orderId: 'SKS-bong-20261001-1111', ownerId: 'o1', storeName: 'Bong', customerName: 'Tia <b>I</b>', customerPhone: '73009999', status: 'Paid', total: 27, itemsSummary: '2× Rice', createdAt: '2026-10-01T01:00:00Z' }],
  payments: [{ purchaseId: 'fp1', reference: 'MWFAB23CD', ownerId: 'o1', storeName: 'Bong', status: 'Approved', amount: 0.7, createdAt: '2026-10-02T00:00:00Z' }],
  cases: [{ reviewId: 'rev_abc123', caseType: 'LISTING', productName: 'Water', storeName: 'Bong', status: 'PENDING', severity: 'high' }]
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const calls = [];
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    calls.push(Object.assign({ action: a }, body));
    let res = { ok: true };
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'admin', storeName: 'Admin', storeSlug: 'adm', isAdmin: true } };
    else if (a === 'adminSearch') res = Object.assign({}, RESULTS, body.q === 'SKS-bong-20261001-1111' ? { exact: { type: 'order', id: 'SKS-bong-20261001-1111' } } : {},
      body.q === 'rev_abc123' ? { exact: { type: 'case', id: 'rev_abc123' } } : {});
    else if (a === 'listReviewCases') res = { ok: true, total: 1, page: 0, pageSize: 20, hasMore: false,
      metrics: { pending: 1, highPriority: 1, categoryRequests: 0, disputed: 0, resolvedInPeriod: 0, periodDays: 30 },
      cases: [{ reviewId: 'rev_abc123', caseType: 'LISTING', productName: 'Water', storeName: 'Bong', severity: 'high', status: 'PENDING', version: 1, reason: 'x' }] };
    else if (a === 'getReviewCase') res = { ok: true, case: { reviewId: 'rev_abc123', caseType: 'LISTING', status: 'PENDING', version: 1, productName: 'Water', history: [], otherCases: [] } };
    else if (a === 'listFeaturePurchases') res = { ok: true, purchases: [{ purchaseId: 'fp1', reference: 'MWFAB23CD', status: 'Approved', amount: 0.7, days: 7, productNames: ['Rice'], storeName: 'Bong', createdAt: '2026-10-02T00:00:00Z', bankMatchedAt: 'x' }] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForSelector('.admin-jump', { state: 'visible', timeout: 6000 });

  /* section menu */
  const links = await page.$$eval('.admin-jump a', (as) => as.map((a) => a.getAttribute('href')));
  const targetsExist = await page.evaluate((hs) => hs.every((h) => !!document.querySelector(h)), links);
  ok('menu: every entry points at a real section', links.length >= 9 && targetsExist, links.join());
  await page.click('.admin-jump a[href="#mkt-heading"]');
  await page.waitForTimeout(900);
  const pos = await page.evaluate(() => ({ top: document.getElementById('mkt-heading').getBoundingClientRect().top,
    menu: document.querySelector('.admin-jump').getBoundingClientRect() }));
  ok('menu: jumps to Marketing, heading not hidden under the menu', pos.top >= pos.menu.bottom - 2 && pos.top < 300, JSON.stringify(pos));
  ok('menu: stays at the top while scrolling', Math.round(pos.menu.top) === 0, pos.menu.top);
  await page.waitForTimeout(300);
  ok('menu: marks where you are', (await page.getAttribute('.admin-jump a[href="#mkt-heading"]', 'aria-current')) === 'true');
  ok('menu: no sideways page scroll on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  /* one search across everything */
  await page.click('.admin-jump a[href="#admin-search-heading"]');
  await page.fill('#admin-search-input', 'bong');
  await page.waitForSelector('.admin-search-hit[data-order]', { timeout: 4000 }).catch(() => {});
  const heads = await page.$$eval('#admin-search-results h3', (hs) => hs.map((h) => h.textContent.replace(/\s+/g, ' ').trim()));
  ok('search: stores, orders, payments and review cases in one list', heads.join('|') === 'Stores (1)|Orders (1)|Featuring payments (1)|Listing review cases (1)', heads.join('|'));
  ok('search: text is escaped', /Tia <b>I<\/b>/.test(await page.textContent('#admin-search-results')));
  await page.click('.admin-search-hit[data-order]');
  await page.waitForTimeout(300);
  let panel = await page.textContent('#admin-analytics');
  ok('order: shows store, customer, status, total and items', /Order SKS-bong-20261001-1111/.test(panel) && /73009999/.test(panel) && /\$27\.00/.test(panel) && /2× Rice/.test(panel), panel);
  await page.click('.admin-search-hit[data-payment]');
  await page.waitForTimeout(300);
  ok('payment: shows its details', /Featuring payment MWFAB23CD/.test(await page.textContent('#admin-analytics')));
  await page.click('[data-jump-payment]');
  await page.waitForTimeout(900);
  ok('payment: "Show in Featuring payments" goes to its row and highlights it', await page.$eval('#feature-payments-list', (l) => !!l.querySelector('.admin-flash')));

  /* shortcuts */
  await page.fill('#admin-search-input', 'SKS-bong-20261001-1111');
  await page.press('#admin-search-input', 'Enter');
  await page.waitForTimeout(500);
  ok('shortcut: an exact order number opens the order', /Order SKS-bong-20261001-1111/.test(await page.textContent('#admin-analytics'))
    && /Opened SKS-bong-20261001-1111/.test(await page.textContent('#admin-search-status')));
  await page.fill('#admin-search-input', 'rev_abc123');
  await page.press('#admin-search-input', 'Enter');
  await page.waitForTimeout(900);
  const lr = calls.filter((c) => c.action === 'listReviewCases').pop();
  ok('shortcut: a case id opens it in Listing review', lr && lr.q === 'rev_abc123' && lr.status === 'all'
    && calls.some((c) => c.action === 'getReviewCase' && c.reviewId === 'rev_abc123'), JSON.stringify(lr));
  if (SHOT) await page.screenshot({ path: SHOT + '/admin-jump.png' });
  ok('no script errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  let f = 0;
  console.log('\n--- admin menu + search ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
