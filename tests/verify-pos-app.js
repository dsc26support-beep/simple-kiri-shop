/**
 * Mwakete POS end to end (Oct 2026): the embedded till (owner/pos.html) and the
 * standalone app (pos/) in real Chromium, both talking to the REAL backend
 * rules (apps-script/*.gs in Node via tests/lib/pos-live-backend.js).
 *
 *  A. both interfaces run the same app and the same prices
 *  B. two-way sync: a sale / stock change / price change on one shows on the other
 *  C. recovery: a till that missed changes (gap) reloads; cursor persists
 *  D. offline: sale saved before "done", survives restart, uploads once
 *  E. two tills oversell offline: both kept, stock 0, a review case
 *  F. barcodes keep leading zeros; unknown codes say so
 *  H. staff PIN on a registered till; cashier limits enforced; revoke keeps pending sales
 *  I. measured propagation latency (backend acceptance -> other till shows it)
 *  layout: computer sidebar + split checkout; phone without sideways scroll
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makePosBackend } = require('./lib/pos-live-backend.js');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : String(e).slice(0, 300)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = { ownerId: 'own_a', storeName: 'Teraina Store', storeSlug: 'a', status: 'active' };

(async () => {
  const be = makePosBackend();
  const browser = await chromium.launch();
  const newCtx = async (vw) => {
    const ctx = await browser.newContext({ viewport: vw || { width: 1280, height: 860 } });
    await ctx.addInitScript((o) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('skiri_owner_token', 'tok-owner-a'); localStorage.setItem('skiri_owner_profile', JSON.stringify(o));
        localStorage.setItem('skiri_cookie_consent', 'true'); sessionStorage.setItem('seeded', '1');
      }
    }, OWNER);
    await be.attach(ctx);
    return ctx;
  };
  const errors = [];
  const open = async (ctx, path) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(path + ': ' + e));
    await p.goto(BASE + path, { waitUntil: 'load' });
    await p.waitForSelector('.pos-tile', { timeout: 15000 });
    return p;
  };
  const tileStock = (p, v) => p.$eval(`.pos-tile[data-v="${v}"] .pos-tile-stock`, (e) => e.textContent).catch(() => '');
  const waitStock = async (p, v, text, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) { if ((await tileStock(p, v)).includes(text)) return Date.now(); await sleep(50); }
    return 0;
  };
  const sell = async (p, picks, method) => {
    for (const v of picks) await p.click(`.pos-tile[data-v="${v}"]`);
    if (method && method !== 'cash') await p.click(`[data-method="${method}"]`);
    if (method === 'ib' || method === 'mpaisa') await p.fill('#pos-ref', 'REF-1');
    await p.click('#pos-complete');
    await p.waitForSelector('.pos-dialog .pos-receipt', { timeout: 15000 });
    const text = await p.$eval('.pos-dialog', (e) => e.innerText);
    await p.click('.pos-dialog [data-close]');
    return text;
  };
  const pending = (p) => p.$eval('#pos-statusbar', (e) => { const m = /(\d+) waiting to sync/.exec(e.innerText); return m ? Number(m[1]) : -1; });

  /* ---------- A. both interfaces ---------- */
  const ctxA = await newCtx();
  const ctxB = await newCtx();
  const A = await open(ctxA, '/owner/pos.html');
  const B = await open(ctxB, '/pos/');
  ok('A. embedded till (seller dashboard) loads the catalogue', (await A.$$('.pos-tile')).length === 3);
  ok('A. standalone app loads the same catalogue', (await B.$$('.pos-tile')).length === 3);
  ok('A. both run the same app code (pos-app.js) and the shared price rules (pos-core.js)', await A.evaluate(() => typeof PosApp === 'object' && typeof posPriceCart === 'function')
    && await B.evaluate(() => typeof PosApp === 'object' && typeof posPriceCart === 'function'));
  ok('A. other stores\' items are never shown', !(await A.$('.pos-tile[data-v="v_b"]')));

  const pwa = await B.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('./');
    const link = document.querySelector('link[rel="manifest"]');
    const m = await (await fetch(link.href)).json();
    return { scope: reg ? reg.scope : '', display: m.display, start: m.start_url, scopeM: m.scope, icons: m.icons.length, name: m.name };
  });
  ok('A. installable: own manifest (standalone, start and scope ./, icons) and a service worker for /pos/ only', /\/pos\/$/.test(pwa.scope) && pwa.display === 'standalone'
    && pwa.start === './' && pwa.scopeM === './' && pwa.icons >= 2 && pwa.name === 'Mwakete POS', JSON.stringify(pwa));

  /* ---------- B. two-way sync ---------- */
  let receipt = await sell(A, ['v_rice', 'v_rice']);
  ok('B. embedded sale is confirmed by Mwakete before it says so', /confirmed by Mwakete/i.test(receipt) && /Synchronised with Mwakete/i.test(receipt), receipt);
  ok('B. ...stock really moved on the server (100 -> 98)', be.stock('v_rice') === 98);
  ok('B. standalone shows it without a page reload', await waitStock(B, 'v_rice', '98 in stock') > 0, await tileStock(B, 'v_rice'));
  receipt = await sell(B, ['v_soap']);
  ok('B. standalone sale shows on the embedded till', /confirmed by Mwakete/i.test(receipt) && await waitStock(A, 'v_soap', '39 in stock') > 0);
  // Inventory: receive goods on one till, the other follows.
  await A.click('[data-view="inventory"]');
  await A.click('[data-act="receive"][data-v="v_tuna"]');
  await A.fill('#rc-q', '4');
  await A.click('#rc-go');
  await sleep(500);
  ok('B. goods received on the embedded till: Mwakete stock 6 -> 10', be.stock('v_tuna') === 10);
  ok('B. ...and the standalone till shows 10', await waitStock(B, 'v_tuna', '10 in stock') > 0);
  // Price change: new sales get it, old sales keep theirs.
  await A.click('[data-act="edit"][data-v="v_soap"]');
  await A.fill('#ed-p', '1.5');
  await A.click('#ed-go');
  await sleep(400);
  const priceSeen = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 20000) { if ((await B.$eval('.pos-tile[data-v="v_soap"] .pos-tile-price', (e) => e.textContent).catch(() => '')).includes('1.50')) return true; await sleep(100); } return false; })();
  ok('B. a price change reaches the other till', priceSeen);
  ok('B. ...the earlier sale keeps the price it was sold at ($1.20)', be.box.__sheets.PosSaleLines.objects().some((l) => l.VariantId === 'v_soap' && Number(l.UnitPrice) === 1.2));
  await A.click('[data-view="sell"]');

  /* ---------- I. latency ---------- */
  const lat = [];
  for (let i = 0; i < 8; i++) {
    const before = be.stock('v_soap');
    const t = Date.now();
    await sell(A, ['v_soap']);
    const accepted = be.accepted.filter((x) => x.action === 'posCheckout').slice(-1)[0].at;
    const seen = await waitStock(B, 'v_soap', (before - 1) + ' in stock', 20000);
    if (seen) lat.push(seen - accepted);
  }
  lat.sort((a, b) => a - b);
  const med = lat[Math.floor((lat.length - 1) / 2)], p95 = lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)];
  ok(`I. propagation measured: ${lat.length}/8 updates seen; median ${med} ms, 95th ${p95} ms (local test server, polling 3 s after activity)`, lat.length === 8, JSON.stringify(lat));
  console.log('LATENCY_MS ' + JSON.stringify({ samples: lat, median: med, p95, max: lat[lat.length - 1] }));

  /* ---------- C. cursor + recovery ---------- */
  const cursor = await B.evaluate(() => PosEngine.status().cursor);
  ok('C. the till keeps a change cursor', cursor > 0, cursor);
  // A missing change (trimmed log) after B's cursor: B must reload, not skip it.
  // B is offline while A sells (A is online), then the change B missed is lost from the log.
  await ctxB.setOffline(true);
  await sell(A, ['v_rice']);
  const sheet = be.box.SpreadsheetApp.getActive().getSheetByName('PosChanges');
  const rows = be.box.__sheets.PosChanges.objects();
  const idx = rows.findIndex((r) => r.OwnerId === 'own_a' && Number(r.Seq) === cursor + 1);
  if (idx >= 0) sheet.deleteRows(idx + 2, 1);
  await ctxB.setOffline(false);
  await B.evaluate(() => PosEngine.pollChanges());
  const log = await B.evaluate(async () => (await PosDB.all('log')).map((l) => l.kind));
  ok('C. a gap in the change log makes the till reload its catalogue (never a silent skip)', log.includes('resync'), JSON.stringify(log.slice(-6)));
  ok('C. ...and it then shows Mwakete\'s number', await waitStock(B, 'v_rice', be.stock('v_rice') + ' in stock') > 0, await tileStock(B, 'v_rice') + ' vs ' + be.stock('v_rice'));

  /* ---------- D. offline sales ---------- */
  await ctxB.setOffline(true); be.down = true;
  await B.evaluate(() => window.dispatchEvent(new Event('offline')));
  const tunaBefore = be.stock('v_tuna');
  receipt = await sell(B, ['v_tuna']);
  ok('D. offline sale: told it is saved on this till, not confirmed', /saved on this till/i.test(receipt) && !/confirmed by Mwakete/i.test(receipt), receipt);
  ok('D. ...it has a till receipt number (R-YYYYMMDD-CODE-n)', /R-\d{8}-[A-Z0-9]+-\d{4}/.test(receipt), receipt);
  receipt = await sell(B, ['v_tuna'], 'mpaisa');
  ok('D. offline MPaisa: pending verification', /Pending verification/i.test(receipt), receipt);
  ok('D. 2 waiting to sync, local stock already lower', await pending(B) === 2 && await waitStock(B, 'v_tuna', String(tunaBefore - 2) + ' in stock', 3000) > 0, await tileStock(B, 'v_tuna'));
  ok('D. Mwakete has not changed yet (nothing claimed)', be.stock('v_tuna') === tunaBefore);
  // Restart while offline: the app opens from its own cache and the sales are still there.
  await B.reload({ waitUntil: 'load' });
  await B.waitForSelector('.pos-tile', { timeout: 15000 });
  ok('D. app restarted offline: opens, and the 2 sales are still waiting', await pending(B) === 2);
  await B.click('[data-view="sync"]');
  await B.click('#sy-reload');
  await sleep(300);
  ok('D. a catalogue reload attempt does not erase waiting sales', await B.evaluate(async () => (await PosDB.all('queue')).length) === 2);
  // Back online.
  be.down = false; await ctxB.setOffline(false);
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await B.click('#sy-now');
  await sleep(800);
  ok('D. back online: both uploaded, nothing waiting', await B.evaluate(async () => (await PosDB.all('queue')).length) === 0);
  const offSales = be.sales().filter((s) => s.CompletedOffline === 'yes' && s.DeviceId === '');
  ok('D. Mwakete has them once each, marked "made offline", stock now lower', offSales.length >= 2 && be.stock('v_tuna') === tunaBefore - 2
    && new Set(be.sales().map((s) => s.ClientTxnId)).size === be.sales().length, JSON.stringify(offSales.map((s) => s.ReceiptNo)));
  await B.click('[data-view="sell"]');

  /* ---------- D2. lost answer ---------- */
  be.dropNextAnswer('posCheckout');
  const countBefore = be.sales().length;
  receipt = await sell(A, ['v_soap']);
  ok('D2. lost answer: the till does not claim success or failure', /awaiting confirmation|has not answered/i.test(receipt), receipt);
  ok('D2. ...Mwakete did record it once', be.sales().length === countBefore + 1);
  await A.evaluate(() => PosEngine.flushQueue(true));
  await sleep(500);
  ok('D2. sending again (same reference) makes no second sale; the till settles it', be.sales().length === countBefore + 1 && await A.evaluate(async () => (await PosDB.all('queue')).length) === 0);

  /* ---------- E. concurrent offline oversell ---------- */
  const left = be.stock('v_tuna');
  await ctxA.setOffline(true); await ctxB.setOffline(true); be.down = true;
  await A.evaluate(() => window.dispatchEvent(new Event('offline'))); await B.evaluate(() => window.dispatchEvent(new Event('offline')));
  const pickN = (n) => Array.from({ length: n }, () => 'v_tuna');
  await sell(A, pickN(left)).catch((e) => errors.push('sellA ' + e));
  await sell(B, pickN(2)).catch((e) => errors.push('sellB ' + e));
  be.down = false; await ctxA.setOffline(false); await ctxB.setOffline(false);
  await A.evaluate(() => PosEngine.flushQueue(true)); await B.evaluate(() => PosEngine.flushQueue(true));
  await sleep(500);
  ok('E. two tills sold the last stock offline: both sales kept', be.sales().filter((s) => s.CompletedOffline === 'yes').length >= 4);
  ok('E. ...stock stops at 0 (not negative, not last-till-wins)', be.stock('v_tuna') === 0, be.stock('v_tuna'));
  ok('E. ...a review case was opened', (be.box.__sheets.PosCases ? be.box.__sheets.PosCases.objects() : []).some((c) => c.Kind === 'oversold'));
  await A.click('[data-view="reviews"]');
  await A.waitForSelector('#cs-list .pos-row', { timeout: 8000 }).catch(() => {});
  ok('E. ...visible in Reviews on the till', /Sold more than Mwakete had/i.test(await A.$eval('#cs-list', (e) => e.innerText)));
  await A.click('[data-view="sell"]');

  /* ---------- F. barcodes ---------- */
  await A.fill('#pos-q', '0093000017');
  await A.press('#pos-q', 'Enter');
  await sleep(150);
  ok('F. scanning 0093000017 adds rice (leading zeros kept)', (await A.$eval('#pos-cart', (e) => e.innerText)).includes('Rice'));
  await A.fill('#pos-q', '0000111');
  await A.press('#pos-q', 'Enter');
  ok('F. an unknown code says so (and offers to add it, for a manager)', /No item has the code/.test(await A.$eval('#pos-scan-msg', (e) => e.innerText)));
  await A.click('#pos-clear');

  /* ---------- H. staff on a registered till ---------- */
  await B.click('[data-view="settings"]');
  await B.fill('#dv-name', 'Front counter');
  await B.click('#dv-reg');
  await B.waitForSelector('.pos-tile', { timeout: 15000 }).catch(() => {});
  ok('H. the owner made the standalone device a till', await B.evaluate(() => !!JSON.parse(localStorage.getItem('mwk_pos_device') || 'null')));
  const own = (action, body) => JSON.parse(be.box.doPost({ postData: { contents: JSON.stringify(Object.assign({ action, token: 'tok-owner-a' }, body)) } }).s);
  const cash = own('posSaveStaff', { name: 'Tiaon', role: 'cashier', pin: '4821' });
  ok('H. owner adds a cashier', cash.ok);
  await B.evaluate(() => localStorage.removeItem('skiri_owner_token'));
  await B.reload({ waitUntil: 'load' });
  await B.waitForSelector('#pin-who', { timeout: 15000 });
  await B.selectOption('#pin-who', cash.staff.staffId);
  for (const d of '4821') await B.click(`[data-d="${d}"]`);
  await B.click('[data-go]');
  await B.waitForSelector('.pos-tile', { timeout: 15000 });
  ok('H. cashier signed in with a PIN', /Tiaon/.test(await B.$eval('#pos-root', (e) => e.innerText)));
  ok('H. the owner\'s cost prices are gone from this device once a cashier signs in', await B.evaluate(async () => (await PosDB.all('items')).every((i) => i.costPrice === undefined)));
  ok('H. cashier sees no Reports, Reviews or confirm-payments in the menu', !(await B.$('[data-view="reports"]')) && !(await B.$('[data-view="reviews"]')) && !(await B.$('[data-view="payments"]')));
  receipt = await sell(B, ['v_rice']);
  ok('H. cashier sells, recorded with their name', /Served by Tiaon/i.test(receipt) && be.sales().slice(-1)[0].StaffName.indexOf('Tiaon') === 0, receipt);
  const forbidden = await B.evaluate(() => PosEngine.call('posVoidSale', { saleId: 'x', requestId: 'void-fake-0001', reason: 'try' }));
  ok('H. a cashier calling void directly is refused by the server', forbidden.errorKind === 'forbidden', JSON.stringify(forbidden));
  // Revoke the till while it holds an offline sale.
  await ctxB.setOffline(true); be.down = true;
  await B.evaluate(() => window.dispatchEvent(new Event('offline')));
  await sell(B, ['v_soap']);
  const dev = JSON.parse(await B.evaluate(() => localStorage.getItem('mwk_pos_device')));
  own('posRevokeDevice', { deviceId: dev.deviceId });
  be.down = false; await ctxB.setOffline(false);
  await B.evaluate(() => PosEngine.flushQueue(true));
  await sleep(400);
  const qAfter = await B.evaluate(async () => ({ q: (await PosDB.all('queue')).map((e) => e.state + ':' + e.error), log: (await PosDB.all('log')).slice(-5).map((l) => l.kind + ' ' + l.message) }));
  ok('H. revoked till: its waiting sale is NOT deleted', qAfter.q.length === 1, JSON.stringify(qAfter));
  ok('H. ...the till asks to sign in again', /Sign in again/.test(await B.$eval('#pos-statusbar', (e) => e.innerText)));

  /* ---------- layout ---------- */
  const lay = await A.evaluate(() => ({ side: getComputedStyle(document.querySelector('.pos-side')).display, cols: getComputedStyle(document.querySelector('.pos-sell')).gridTemplateColumns.split(' ').length }));
  ok('layout: computer has the left sidebar and a split checkout', lay.side !== 'none' && lay.cols === 2, JSON.stringify(lay));
  const ctxP = await newCtx({ width: 390, height: 844 });
  const P = await open(ctxP, '/pos/');
  const ph = await P.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, side: getComputedStyle(document.querySelector('.pos-side')).display, menu: !!document.querySelector('#pos-menu-btn') }));
  ok('layout: phone has a menu button, no sidebar, no sideways scroll', ph.side === 'none' && ph.menu && ph.over <= 1, JSON.stringify(ph));
  await P.click('.pos-tile[data-v="v_soap"]');
  const cartBox = await P.$eval('#pos-complete', (e) => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width }; });
  ok('layout: phone checkout button is large enough to tap', cartBox.h >= 52, JSON.stringify(cartBox));

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  let f = 0; console.log('\n--- Mwakete POS end to end ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e && st === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
