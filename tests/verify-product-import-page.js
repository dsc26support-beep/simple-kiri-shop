// Bulk product import on the Import & Sync page, in a real browser talking to
// the REAL backend (apps-script/*.gs in the in-memory harness): download the
// product template, fill it in, choose it, every column matched automatically,
// per-row categories, "already on Mwakete" skipped, the problems file (with
// formula-looking cells made safe), apply, and the result.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const TMP = path.join(require('os').tmpdir(), 'mwk-import-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType', 'Island'], ['own_a', 'bong', 'Bong', 'active', '', 'Abaiang']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Status', 'Category', 'ListingType'], ['prod_m', 'own_a', 'bong', 'Woven fan', '', 'active', 'handicrafts', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty'], ['v1', 'prod_m', 'own_a', 'Standard', 8, 'OLD-FAN', 3, 'active', '']]
});
const OWNER = { OwnerId: 'own_a', StoreSlug: 'bong', StoreType: '', Island: 'Abaiang' };
const ACTIONS = { listInventoryConnections: 'actionListInventoryConnections', previewInventoryImport: 'actionPreviewInventoryImport',
  applyInventoryImport: 'actionApplyInventoryImport', saveInventoryConnection: 'actionSaveInventoryConnection', listSyncJobs: 'actionListSyncJobs',
  listSyncConflicts: 'actionListSyncConflicts' };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    let res;
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'own_a', storeName: 'Bong', storeSlug: 'bong', storeType: 'retailer', island: 'Abaiang' } };
    else if (ACTIONS[a] && box[ACTIONS[a]]) { const b = JSON.parse(JSON.stringify(body)); delete b.action; delete b.token; res = JSON.parse(JSON.stringify(box[ACTIONS[a]](OWNER, b))); }
    else res = { ok: true, jobs: [], conflicts: [], connections: [], connectors: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owner/inventory-sync.html', { waitUntil: 'load' });
  await page.waitForSelector('.sync-source', { timeout: 6000 });
  await page.click('.sync-source[data-source="csv"]');

  // ---- the template ----
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sync-template-btn')]);
  const tplPath = path.join(TMP, 'template.csv');
  await dl.saveAs(tplPath);
  const tpl = fs.readFileSync(tplPath, 'utf8').replace(/^﻿/, '');
  const lines = tpl.split(/\r\n/);
  ok('the product template downloads with the right columns and example rows', dl.suggestedFilename() === 'mwakete-product-template.csv'
    && lines[0] === 'Product name,Variety / size,Selling price,Stock on hand,SKU,Category,Description,Barcode,Cost price' && lines.length === 4, lines[0]);

  // A seller fills it in: their rows replace the examples.
  const mine = [lines[0],
    'Coconut soap,Small,2.00,50,SOAP-S,Personal Care,Made in Abaiang,,1.20',
    'Coconut soap,Large,3.50,30,SOAP-L,Personal Care,,,2.00',
    'Shell earrings,Pair,12,6,EAR-1,Jewellery & Accessories,,,',
    'Woven fan,,8,20,NEW-FAN,Handicrafts,,,',
    '=HYPERLINK("http://x"),,5,1,BAD-1,Spaceships,,,'].join('\r\n');
  const filled = path.join(TMP, 'my-products.csv');
  fs.writeFileSync(filled, '﻿' + mine);
  await page.setInputFiles('#sync-file', filled);
  await page.waitForSelector('#sync-mapping:not(.hidden)');
  const guessed = await page.$$eval('#sync-mapping select', (s) => s.map((x) => x.value));
  ok('every template column is matched automatically', JSON.stringify(guessed) === JSON.stringify(['productName', 'variantLabel', 'price', 'physicalStock', 'sku', 'category', 'description', 'barcode', 'costPrice']), JSON.stringify(guessed));
  await page.check('#sync-create-new');
  await page.click('#sync-preview-btn');
  await page.waitForSelector('#sync-step-preview:not(.hidden)', { timeout: 6000 });
  const prev = await page.textContent('#sync-preview');
  ok('preview: 2 new products, 1 already on Mwakete, 1 error', /2\s*new products/.test(prev) && /1\s*already on Mwakete/.test(prev) && /1\s*errors/.test(prev), prev.replace(/\s+/g, ' ').slice(0, 300));
  ok('...says why the fan is skipped', /Woven fan - already on Mwakete as "Woven fan"/.test(prev));
  ok('...and why the last row is wrong', /Category "Spaceships" is not one Mwakete has/.test(prev));

  // ---- the problems file ----
  ok('a "Download the problems" button is offered', await page.isVisible('#sync-problems-btn'));
  const [pd] = await Promise.all([page.waitForEvent('download'), page.click('#sync-problems-btn')]);
  const probPath = path.join(TMP, 'problems.csv');
  await pd.saveAs(probPath);
  const prob = fs.readFileSync(probPath, 'utf8').replace(/^﻿/, '').split(/\r\n/);
  ok('the problems file lists each skipped row with its line and reason', prob[0] === 'Line,Item,Problem' && prob.length === 3
    && prob.some((l) => /^5,Woven fan,/.test(l)) && prob.some((l) => /^6,,"?Category/.test(l)), prob.join(' | '));

  // ---- apply ----
  await page.click('#sync-apply-btn');
  await page.waitForSelector('#sync-step-done:not(.hidden)', { timeout: 6000 });
  const done = await page.textContent('#sync-done-text');
  ok('apply: says what was added and what was skipped', /added 2 new products/.test(done) && /skipped 1 already on Mwakete/.test(done), done);
  const prods = box.__sheets.Products.objects();
  const soap = prods.find((p) => p.Name === 'Coconut soap');
  ok('the products are on Mwakete with category, subcategory and description', soap && soap.Category === 'home' && soap.SubcategoryId === 'home-personal-care' && soap.Description === 'Made in Abaiang'
    && prods.find((p) => p.Name === 'Shell earrings').Category === 'fashion', JSON.stringify(soap));
  ok('the existing Woven fan was not duplicated or changed', prods.filter((p) => p.Name === 'Woven fan').length === 1
    && box.__sheets.Variants.objects().filter((v) => v.ProductId === 'prod_m').map((v) => v.SKU).join() === 'OLD-FAN');
  ok('no page errors', errors.length === 0, errors.join('; '));

  // ---- the csvCell guard the problems file relies on ----
  const guard = await page.evaluate(() => [csvCell('=HYPERLINK("x")'), csvCell('+1'), csvCell('-5'), csvCell('@cmd'), csvCell('Fine, thanks')]);
  ok('cells that a spreadsheet would run as a formula are made text; plain numbers (+1, -5) and commas stay right', JSON.stringify(guard) === JSON.stringify(['"\'=HYPERLINK(""x"")"', '+1', '-5', "'@cmd", '"Fine, thanks"']), JSON.stringify(guard));

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  let f = 0; console.log('\n--- bulk product import page (browser + real backend) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
