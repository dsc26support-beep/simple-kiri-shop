// Admin dashboard "Inventory & sync" section against the REAL backend
// (harness) with a failing Google Sheet: stats, failing connection, recent
// failure, and no sheet ID on the page.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = 'http://127.0.0.1:8099';
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Email'], ['own_a', 'a', 'Ana Shop', 'active', '', 'a@x.com'],
    ['own_d', 'd', 'Dist Co', 'active', 'distributor', 'd@x.com'], ['own_admin', 'adm', 'Admin', 'active', '', 'boss@mwakete.com']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'], ['prod_a', 'own_a', 'a', 'Rice', 'active', 'other', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'], ['v1', 'prod_a', 'own_a', '1kg', 2, 'R-1', 10, 'active', '']]
}, { external: { [SHEET_ID]: { title: 'S', tabs: { Stock: [['Code', 'On hand'], ['R-1', 10]] } } } });
box.__props.MWAKETE_SHARE_EMAIL = 'stock@mwakete.com';
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
const A = { OwnerId: 'own_a', StoreSlug: 'a' };
const c = box.actionSaveInventoryConnection(A, { type: 'googleSheets', name: 'Ana stock', mapping: { Code: 'sku', 'On hand': 'physicalStock' }, mode: 'import', settings: { url: SHEET_ID, sheetName: 'Stock' } });
const p = box.actionPreviewInventoryImport(A, { connectionId: c.connection.connectionId });
box.actionApplyInventoryImport(A, { connectionId: c.connection.connectionId, planToken: p.preview.planToken });
delete box.__external[SHEET_ID];
box.actionSyncNow(A, { connectionId: c.connection.connectionId });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, cnd, e) => R.push([cnd ? 'PASS' : 'FAIL', n, e || '']);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    let res = { ok: true };
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'own_admin', storeName: 'Admin', storeSlug: 'adm', isAdmin: true } };
    else if (a === 'adminInventoryOverview') res = JSON.parse(JSON.stringify(box.actionAdminInventoryOverview({ OwnerId: 'own_admin', Email: 'boss@mwakete.com' })));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForSelector('#inv-admin .admin-stats', { timeout: 6000 });
  const text = await page.textContent('#inv-admin');
  ok('type counts', /2retailers/.test(text) && /1distributors/.test(text) && /0wholesalers/.test(text), text.slice(0, 200));
  ok('connections and failures', /1active connections/.test(text) && /1failing connections/.test(text) && /Google Sheets 1/.test(text));
  ok('failing connection names the store, source and plain error', /Ana Shop - Ana stock \(Google Sheets\).*Share and add/s.test(text), text);
  ok('recent failure listed', /Recent sync failures[\s\S]*Ana Shop \(Google Sheets\)/.test(text));
  ok('no sheet ID on the page', !(await page.content()).includes(SHEET_ID));
  ok('no horizontal scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
  let f = 0; console.log('\n--- admin: inventory & sync section ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
