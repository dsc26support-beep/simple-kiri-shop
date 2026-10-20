/**
 * Admin overview in the browser, against the REAL backend (gas-harness
 * behind every Api.post): figures from the server, the work queue linking to
 * its sections, CSV export, retry state, admin-only, phone and desktop layout.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Status', 'StoreType', 'WholesaleVerified', 'CreatedAt'],
    ['own_adm', 'admin', 'Admin', 'admin@x.test', 'active', 'retailer', '', iso(100)], ['own_a', 'alpha', 'Alpha', 'a@x.test', 'active', 'retailer', '', iso(2)],
    ['own_w', 'whole', '=Whole, Ltd', 'w@x.test', 'active', 'wholesaler', '', iso(50)]],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-adm', 'own_adm', '', FUT], ['tok-a', 'own_a', '', FUT]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'Total', 'Status', 'CreatedAt'],
    ['o1', 'own_a', 'alpha', 'Tia', 10, 'Paid', iso(0)], ['o2', 'own_w', 'whole', 'Ben', 500, 'Fulfilled', iso(0)], ['o3', 'own_a', 'alpha', 'Kat', 30, 'Pending Payment', iso(5)]],
  Customers: [['CustomerId', 'Name', 'Email', 'CreatedAt'], ['c1', 'Tia', 't@x.test', iso(1)]],
  FeaturePurchases: [['PurchaseId', 'Status', 'BankMatchedAt'], ['f1', 'Pending review', '']],
  Conversations: [['ConversationId', 'OwnerId']], Featured: [['FeaturedId', 'Type', 'RefId', 'SortOrder', 'CreatedAt']]
}, { guest: true }); // counts customers: no harness shopper
box.__props.ADMIN_EMAILS = 'admin@x.test';
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const call = (b) => { try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  let failNext = 0;
  const open = async (w, token, profile) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
    await ctx.addInitScript(([t, p]) => { localStorage.setItem('skiri_owner_token', t); localStorage.setItem('skiri_owner_profile', p); localStorage.setItem('skiri_cookie_consent', 'accepted'); },
      [token, JSON.stringify(profile)]);
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      if (b && failNext && JSON.parse(b).action === 'getAdminOverview') { failNext--; return route.abort('failed'); }
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : '{"ok":true}' });
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
    return { ctx, p };
  };
  const ADMIN = { storeName: 'Admin', storeSlug: 'admin', isAdmin: true };

  let { ctx, p } = await open(1280, 'tok-adm', ADMIN);
  await p.waitForFunction(() => document.getElementById('ov-orders').textContent.trim() !== '–', null, { timeout: 10000 });
  const v = await p.evaluate(() => ['ov-orders', 'ov-sales', 'ov-stores', 'ov-customers'].map((id) => document.getElementById(id).textContent.trim()));
  ok('KPI cards show the server\'s numbers', v.join('|') === '2|$510.00|2|1', v.join('|'));
  ok('Overview is first in the admin section menu', (await p.$eval('.admin-jump a', (a) => a.getAttribute('href'))) === '#ov-heading');
  const work = await p.$$eval('#ov-work a', (as) => as.map((a) => a.getAttribute('href') + ' ' + a.textContent));
  ok('work queue links each item to its admin section', work.some((x) => x.startsWith('#feature-payments-heading') && /1 featuring payment/.test(x))
    && work.some((x) => x.startsWith('#wholesale-heading')), work.join(' | '));
  ok('chart drawn, with an accessible table', !!(await p.$('#ov-chart svg path.line')) && (await p.$$('#ov-chart-table tbody tr')).length === 7);
  ok('recent orders link to the order room in admin view', !!(await p.$('#ov-recent a[href*="as=admin"]')));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#ov-export')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok('CSV export of the top stores, safe for spreadsheets', /^Store,Store type,Orders,Confirmed sales/.test(csv) && csv.includes(`"'=Whole, Ltd",wholesaler,1,500.00`), csv);
  await p.selectOption('#ov-period', '30');
  await p.waitForFunction(() => document.querySelectorAll('#ov-chart-table tbody tr').length === 30, null, { timeout: 8000 });
  ok('30-day period reloads', true);
  if (process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/admin-overview-desktop.png', clip: { x: 0, y: 0, width: 1280, height: 1500 } });
  await ctx.close();

  failNext = 1;
  ({ ctx, p } = await open(390, 'tok-adm', ADMIN));
  await p.waitForSelector('#ov-retry', { timeout: 10000 });
  ok('a failed load offers Try again and shows no made-up numbers', (await p.textContent('#ov-orders')).trim() === '–');
  await p.click('#ov-retry');
  await p.waitForFunction(() => document.getElementById('ov-orders').textContent.trim() === '2', null, { timeout: 10000 });
  ok('Try again loads the overview', true);
  for (const w of [320, 375, 430]) {
    await p.setViewportSize({ width: w, height: 900 });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(`no sideways scroll at ${w}px`, over <= 1, String(over));
  }
  if (process.env.SHOT_DIR) { await p.setViewportSize({ width: 390, height: 900 }); await p.screenshot({ path: process.env.SHOT_DIR + '/admin-overview-phone.png', fullPage: false }); }
  await ctx.close();

  ({ ctx, p } = await open(1280, 'tok-a', { storeName: 'Alpha', storeSlug: 'alpha', isAdmin: true }));
  await p.waitForTimeout(1500);
  ok('a seller who fakes isAdmin in their browser gets no figures (the server refuses)', (await p.textContent('#ov-orders')).trim() === '–' || !(await p.isVisible('#ov-orders')));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  let fails = 0;
  console.log('\n--- admin overview (real backend) ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
