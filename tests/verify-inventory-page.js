// Seller inventory page (owner/inventory.html): summary tiles, health
// filters, search, the receive / adjust / settings panel, failure handling
// (never claims a save the server didn't confirm; retry reuses the request
// id), and history. Backend rules: test-inventory-actions.js.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const ITEM = (o) => Object.assign({ productId: 'p', productName: 'Rice', label: '1kg', productStatus: 'active', sku: '', barcode: '', price: 2,
  costPrice: null, tracked: true, physical: 10, reserved: 0, available: 10, reorderLevel: null, reorderQty: null, health: 'healthy' }, o);
const ITEMS = [
  ITEM({ variantId: 'v1', label: '1kg', physical: 10, reserved: 2, available: 8, sku: 'R1', costPrice: 1.5 }),
  ITEM({ variantId: 'v2', label: '5kg', physical: 3, available: 3, reorderLevel: 5, reorderQty: 20, health: 'low' }),
  ITEM({ variantId: 'v3', productName: 'Flour', label: '25kg', physical: 0, available: 0, health: 'out' }),
  ITEM({ variantId: 'v4', productName: 'Soap', label: 'bar', tracked: false, physical: null, available: null, health: 'untracked' })
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const calls = [];
  let receiveMode = 'fail';
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    calls.push(Object.assign({ action: a }, body));
    let res = { ok: true };
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'o', storeName: 'Bong', storeSlug: 'b' } };
    else if (a === 'getInventory') res = { ok: true, items: ITEMS, summary: { varieties: 4, tracked: 3, low: 1, out: 1, reservedUnits: 2, stockValue: 15, valueIsPartial: true }, capabilities: { sync: false } };
    else if (a === 'listStockMovements') res = { ok: true, total: 1, hasMore: false, movements: [{ movementId: 'm1', createdAt: '2026-10-07T01:00:00Z', type: 'ORDER_RESERVED', quantity: 2, previousStock: 10, newStock: 10, reservedBefore: 0, reservedAfter: 2, source: 'checkout', referenceId: 'ORD-1', notes: '', productName: 'Rice', label: '1kg' }] };
    else if (a === 'receiveStock') {
      if (receiveMode === 'fail') return route.abort('failed');
      res = { ok: true, item: Object.assign({}, ITEMS[0], { physical: 15, available: 13 }) };
    } else if (a === 'adjustStock') res = { ok: false, error: '2 are held by open orders, so stock can\'t go below 2. Your stock has not been changed.' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owner/inventory.html', { waitUntil: 'load' });
  await page.waitForSelector('.inv-row', { timeout: 6000 });

  const tiles = await page.$$eval('.inv-tile', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('summary tiles: tracked, low, out, held, value (* = partial)', tiles.join('|') === '3tracked items|1low stock|1out of stock|2held by orders|$15.00*stock value (cost)', tiles.join('|'));
  ok('loading text is cleared once the list is in', (await page.textContent('#inv-status')).trim() === '');
  ok('all 4 rows shown', (await page.$$('.inv-row')).length === 4);
  const r1 = await page.$eval('.inv-row[data-variant-id="v1"]', (r) => r.textContent.replace(/\s+/g, ' '));
  ok('row shows available, in stock, held and SKU', /8 available/.test(r1) && /10 in stock/.test(r1) && /2 held/.test(r1) && /SKU R1/.test(r1), r1);
  ok('low row explains the level and usual reorder', /at or below your level of 5\. You usually reorder 20/.test(await page.textContent('.inv-row[data-variant-id="v2"]')));
  ok('untracked row says unlimited', /Unlimited/.test(await page.textContent('.inv-row[data-variant-id="v4"]')));

  await page.click('.inv-chip[data-filter="low"]');
  ok('Low filter', (await page.$$('.inv-row')).length === 1 && await page.getAttribute('.inv-chip[data-filter="low"]', 'aria-pressed') === 'true');
  await page.click('.inv-tile--out');
  ok('tapping the "out of stock" tile filters too', (await page.$$('.inv-row')).length === 1 && !!(await page.$('.inv-row[data-variant-id="v3"]')));
  await page.click('.inv-chip[data-filter="all"]');
  await page.fill('#inv-search', 'r1');
  ok('search matches SKU', (await page.$$('.inv-row')).length === 1);
  await page.fill('#inv-search', '');

  // Receive: first attempt has no connection -> honest error, then retry with the same request id.
  await page.click('.inv-row[data-variant-id="v1"] [data-act="receive"]');
  ok('panel opens with the current numbers', /10 in stock, 2 held by orders, 8 available/.test(await page.textContent('#inv-panel-sub')));
  await page.click('#inv-submit');
  ok('receive needs a quantity (no request sent)', /how many units arrived/.test(await page.textContent('#inv-panel-error')) && !calls.some((c) => c.action === 'receiveStock'));
  await page.fill('#inv-qty', '5');
  await page.fill('#inv-supplier', 'ABC Trading');
  await page.click('#inv-submit');
  await page.waitForFunction(() => /only ever be applied once/.test(document.getElementById('inv-panel-error').textContent), null, { timeout: 5000 }).catch(() => {});
  ok('dropped connection: says it could not confirm + retry is safe, no "Saved"', /couldn't reach Mwakete to confirm.*only ever be applied once/.test(await page.textContent('#inv-panel-error')) && await page.isHidden('#inv-panel-saved'));
  receiveMode = 'ok';
  await page.click('#inv-submit');
  await page.waitForSelector('#inv-panel-saved:not(.hidden)', { timeout: 5000 }).catch(() => {});
  const sent = calls.filter((c) => c.action === 'receiveStock');
  ok('retry reuses the same request id (server applies it once)', sent.length === 2 && sent[0].requestId && sent[0].requestId === sent[1].requestId, JSON.stringify(sent.map((s) => s.requestId)));
  ok('success shows "Saved" with new numbers and updates the row', /Saved\. 15 in stock, 13 available/.test(await page.textContent('#inv-panel-saved')) &&
    /13 available/.test(await page.textContent('.inv-row[data-variant-id="v1"]')));
  ok('receive sent supplier and quantity', sent[1].quantity === '5' && sent[1].supplier === 'ABC Trading');

  // Adjust: server refusal shown verbatim.
  await page.click('.inv-row[data-variant-id="v1"] [data-act="adjust"]');
  ok('adjust defaults to "I counted it" with the current count', await page.inputValue('#inv-count') === '15');
  await page.selectOption('#inv-reason', 'damaged');
  ok('switching reason shows the units field instead', await page.isVisible('#inv-qty') && await page.isHidden('#inv-count'));
  await page.selectOption('#inv-reason', 'count');
  await page.fill('#inv-count', '1');
  await page.click('#inv-submit');
  await page.waitForFunction(() => /held by open orders/.test(document.getElementById('inv-panel-error').textContent), null, { timeout: 4000 }).catch(() => {});
  ok('server refusal is shown as-is', /2 are held by open orders/.test(await page.textContent('#inv-panel-error')));

  // History
  ok('history shows a held-for-order row with reserved change', /Held for order \+2.*held 0 → 2.*ORD-1/s.test(await page.textContent('#inv-history')));
  await page.click('.inv-row[data-variant-id="v2"] [data-act="history"]');
  await page.waitForTimeout(400);
  const hc = calls.filter((c) => c.action === 'listStockMovements').slice(-1)[0];
  ok('per-item history asks for that variety and says so', hc.variantId === 'v2' && /Showing: Rice - 5kg/.test(await page.textContent('#inv-history-filter')));
  ok('no horizontal scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  ok('no page errors', errors.length === 0, errors.join('; '));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: true }).catch(() => {});

  await browser.close();
  let f = 0; console.log('\n--- seller inventory page ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
