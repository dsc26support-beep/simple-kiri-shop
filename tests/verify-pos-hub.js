/**
 * POS Integration Hub + native POS END TO END in the browser: the real pages
 * (owner/pos.html, owner/integrations.html) against the REAL Apps Script
 * sources. Sell by scanning a barcode -> cash change -> receipt -> stock down
 * -> refund; create a connection (secret shown once) -> signed push -> status
 * becomes Connected only then -> unmapped item -> match -> retry -> applied.
 * Also: feature-off message, offline banner, no sideways scroll on a phone,
 * no page errors. Screenshots go to SHOT_DIR if set.
 */
const crypto = require('crypto');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOT = process.env.SHOT_DIR || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'StoreType'], ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'retailer']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Category', 'ListingType', 'Status'], ['p1', 'own_s', 'bong', 'Rice', 'food', 'product', 'active']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'Barcode', 'ReservedQty'],
    ['v1', 'p1', 'own_s', '10kg', 20, 'RICE10', 12, 'active', '9300001', 0], ['v2', 'p1', 'own_s', '1kg', 3, 'RICE1', 40, 'active', '', 0]],
  Orders: [['OrderId', 'OwnerId', 'Status', 'CreatedAt', 'Total']]
});
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const backend = (b) => { Object.keys(box.__cache).filter((k) => k.indexOf('ratelimit') === 0).forEach((k) => delete box.__cache[k]);
  try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const stock = (id) => Number(box.__sheets.Variants.objects().find((v) => v.VariantId === id).StockQty);
const shot = async (p, name) => { if (SHOT) await p.screenshot({ path: `${SHOT}/${name}.png`, fullPage: true }); };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctxFor = async (storage, opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, opts || {}));
    await ctx.addInitScript((s) => { Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)); localStorage.setItem('skiri_cookie_consent', 'accepted'); }, storage);
    await ctx.route('**/macros/s/**', (route) => { const b = route.request().postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? backend(b) : '{"ok":true}' }); });
    return ctx;
  };
  const open = async (ctx, url) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(url + ': ' + String(e))); p.on('dialog', (d) => d.accept()); await p.goto(BASE + '/' + url, { waitUntil: 'load' }); return p; };
  const sellerCtx = await ctxFor({ skiri_owner_token: 'tok-s', skiri_owner_profile: JSON.stringify({ storeName: 'Bong Store', storeSlug: 'bong', posHub: true }) });
  const noScroll = async (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---- feature off
  let p = await open(sellerCtx, 'owner/pos.html');
  await p.waitForSelector('#pos-off:not(.hidden)', { timeout: 8000 }).catch(() => {});
  ok('POS page explains when the feature is off', await p.isVisible('#pos-off') && !(await p.isVisible('#pos-main')));
  await shot(p, 'pos-off');
  p = await open(sellerCtx, 'owner/integrations.html');
  await p.waitForSelector('#hub-off:not(.hidden)', { timeout: 8000 }).catch(() => {});
  ok('Integrations page explains when the feature is off', await p.isVisible('#hub-off') && !(await p.isVisible('#hub-main')));

  // ---- switch on
  box.__props.POS_HUB = 'on';
  p = await open(sellerCtx, 'owner/pos.html');
  await p.waitForSelector('#pos-main:not(.hidden)', { timeout: 8000 });
  ok('POS opens when on', await p.isVisible('#pos-q'));
  await p.fill('#pos-q', '9300001'); await p.press('#pos-q', 'Enter');
  await p.waitForSelector('.pos-line', { timeout: 8000 });
  ok('scanning a barcode puts the item in the cart', (await p.textContent('#pos-lines')).includes('Rice'));
  await p.click('.pos-qty [data-d="1"]');
  ok('total is 2 x 20 = 40.00', /40\.00/.test(await p.textContent('#pos-total')));
  await p.fill('#pos-tender', '50');
  ok('change shown before charging', /10\.00/.test(await p.textContent('#pos-change')));
  await shot(p, 'pos-cart');
  await p.click('#pos-charge');
  await p.waitForSelector('#receipt-modal:not(.hidden)', { timeout: 8000 });
  ok('receipt shown with number and total', /R-\d{8}-\d{4}/.test(await p.textContent('#receipt-body')) && /40\.00/.test(await p.textContent('#receipt-body')));
  ok('stock went 12 -> 10 on the server', stock('v1') === 10, stock('v1'));
  ok('cart is cleared after the sale', (await p.textContent('#pos-lines')).includes('Nothing added'));
  ok('POS page has no sideways scroll on a phone', await noScroll(p));
  await shot(p, 'pos-receipt');
  await p.click('#receipt-close');

  // card payment is labelled as not verified
  await p.fill('#pos-q', 'RICE1'); await p.press('#pos-q', 'Enter');
  await p.waitForSelector('.pos-line');
  await p.check('input[name="pay"][value="card"]');
  ok('card shows the "not verified" warning', /not verified/i.test(await p.textContent('#pay-digital')));
  await p.click('#pos-charge');
  await p.waitForSelector('#receipt-modal:not(.hidden)');
  ok('card receipt says recorded by seller / not verified', /not verified|unverified/i.test(await p.textContent('#receipt-body')));
  await p.click('#receipt-close');

  // offline blocks the sale
  await p.fill('#pos-q', 'RICE1'); await p.press('#pos-q', 'Enter'); await p.waitForSelector('.pos-line');
  await p.context().setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event('offline')));
  ok('offline: banner shown and charging disabled', await p.isVisible('#pos-offline') && await p.isDisabled('#pos-charge'));
  await shot(p, 'pos-offline');
  await p.context().setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.click('#pos-clear');

  // sales + refund
  await p.click('[data-tab="sales"]');
  await p.waitForSelector('#sales-list tbody tr');
  ok('sales history lists both sales', (await p.$$('#sales-list tbody tr')).length === 2);
  await p.click('#sales-list tbody tr:last-child button');
  await p.waitForSelector('#rf-go');
  await p.fill('.pos-refund-row input[type=number]', '1');
  await p.check('.pos-refund-row input[type=checkbox]');
  await p.fill('#rf-reason', 'wrong size');
  await shot(p, 'pos-sale-detail');
  await p.click('#rf-go');
  await p.waitForFunction(() => /Refunds recorded/.test(document.getElementById('sale-detail').textContent), null, { timeout: 8000 });
  ok('refund recorded, one unit back in stock', stock('v1') === 11, stock('v1'));
  await p.click('[data-tab="report"]');
  await p.waitForSelector('#rep-body table');
  ok('report shows in-store, online, connected channels', /In-store/.test(await p.textContent('#rep-body')) && /Connected systems/.test(await p.textContent('#rep-body')));
  await shot(p, 'pos-report');

  // ---- integrations
  p = await open(sellerCtx, 'owner/integrations.html');
  await p.waitForSelector('#hub-main:not(.hidden)', { timeout: 8000 });
  await p.click('#hub-add');
  await p.fill('#wiz-name', 'Main till'); await p.fill('#wiz-provider', 'Acme POS');
  await p.click('#wiz-create');
  await p.waitForSelector('#hub-wiz-2:not(.hidden)');
  const connId = (await p.textContent('#wiz-id')).trim(); const secret = (await p.textContent('#wiz-secret')).trim();
  ok('secret shown once in the wizard', secret.length >= 32 && /^conn_/.test(connId), connId);
  ok('Next stays disabled until the seller confirms they saved the secret', await p.isDisabled('#wiz-next'));
  await shot(p, 'hub-wizard-secret');
  await p.check('#wiz-saved'); await p.click('#wiz-next');
  ok('before any signed message the page says waiting, not connected', /Waiting/.test(await p.textContent('#wiz-wait')) && !/Connected\./.test(await p.textContent('#wiz-wait')));
  const send = (obj) => { const payload = JSON.stringify(obj); const ts = Date.now(); return JSON.parse(backend(JSON.stringify({ action: 'posPush', connectionId: connId, timestamp: ts, payload, signature: crypto.createHmac('sha256', secret).update(`${connId}.${ts}.${payload}`).digest('hex') }))); };
  ok('forged message does not connect it', send && JSON.parse(backend(JSON.stringify({ action: 'posPush', connectionId: connId, timestamp: Date.now(), payload: '{"type":"ping"}', signature: 'f'.repeat(64) }))).ok === false);
  await p.click('#wiz-check');
  await p.waitForTimeout(300);
  ok('still waiting after only a forged message', /Waiting/.test(await p.textContent('#wiz-wait')));
  ok('signed ping verifies', send({ type: 'ping' }).verified === true);
  await p.click('#wiz-check');
  await p.waitForFunction(() => /^Connected/.test(document.getElementById('wiz-wait').textContent), null, { timeout: 8000 });
  ok('Connected shown only after the signed message', true);
  await p.click('#wiz-done');
  // an unknown item arrives
  const r1 = send({ type: 'sale', id: 'T-1', occurredAt: new Date().toISOString(), lines: [{ sku: 'MYSTERY', name: 'Mystery', qty: 1, unitPrice: 5 }], payment: { method: 'cash', status: 'paid' } });
  ok('sale with an unknown item is held', r1.status === 'needs_mapping' && stock('v2') === 39, JSON.stringify(r1));
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('.hub-map', { timeout: 8000 });
  await shot(p, 'hub-main');
  ok('the item waits in "Items to match"', /MYSTERY/i.test(await p.textContent('#hub-mappings')));
  ok('the held sale is in the activity log as needing matching', /Needs matching/.test(await p.textContent('#hub-events')));
  await p.selectOption('.hub-map select', 'v2');
  await p.click('.hub-map button');
  await p.waitForFunction(() => /Nothing to match/.test(document.getElementById('hub-mappings').textContent), null, { timeout: 8000 });
  await p.click('#hub-events [data-do="retry"]'); await p.waitForTimeout(800); if (process.env.DBG) console.log(await p.textContent('#hub-events'), await p.textContent('#hub-status'));
  await p.waitForFunction(() => !document.querySelector('#hub-events [data-do="retry"]'), null, { timeout: 8000 });
  ok('after matching and retry the stock came off', stock('v2') === 38, stock('v2'));
  ok('Integrations page has no sideways scroll on a phone', await noScroll(p));
  await shot(p, 'hub-after');
  await p.click('.hub-card [data-act="settings"]');
  await p.waitForSelector('#d-save');
  ok('settings never show the secret', !(await p.content()).includes(secret));
  await shot(p, 'hub-settings');

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + '  ' + r[1] + (r[2] ? '  [' + r[2] + ']' : '')));
  const bad = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - bad}/${R.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
