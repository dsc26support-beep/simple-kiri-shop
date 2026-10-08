// Inventory page for a distributor, against the REAL backend (harness):
// Locations / Suppliers / Reports tools, adding a warehouse, the per-item
// split, Transfer, receiving into a location with a saved supplier, and a
// retailer seeing none of it. Plus sign-up's new "Distributor" choice.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = 'http://127.0.0.1:8099';

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_d', 'd', 'Dist', 'active', 'distributor'], ['own_r', 'r', 'Ret', 'active', '']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType'],
    ['prod_d', 'own_d', 'd', 'Rice', 'active', 'food', 'product'], ['prod_r', 'own_r', 'r', 'Soap', 'active', 'home', 'product']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'CostPrice'],
    ['v1', 'prod_d', 'own_d', '25kg', 30, 'R25', 100, 'active', '', 20], ['vr', 'prod_r', 'own_r', 'bar', 1, '', 5, 'active', '', '']]
});
// Only the inventory screens' own calls go to the backend; nav badges etc. get a stub.
const INV = /Inventory|Stock|Location|Supplier|inventoryReport/;
let who = { OwnerId: 'own_d', StoreSlug: 'd', StoreType: 'distributor' };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    let res;
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: who.OwnerId, storeName: who.OwnerId, storeSlug: who.StoreSlug, storeType: who.StoreType || 'retailer', wholesaleVerified: true } };
    else {
      const fn = 'action' + a.charAt(0).toUpperCase() + a.slice(1);
      if (typeof box[fn] === 'function' && INV.test(a)) { const b = JSON.parse(JSON.stringify(body)); delete b.action; delete b.token; res = JSON.parse(JSON.stringify(box[fn](who, b))); }
      else res = { ok: true };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/owner/inventory.html', { waitUntil: 'load' });
  await page.waitForSelector('.inv-row', { timeout: 6000 });

  const tools = await page.$$eval('#inv-more [data-tool], #inv-more a', (b) => b.map((x) => x.textContent.trim()));
  ok('distributor sees Import / Sync, Locations, Suppliers, Reports', tools.join('|') === 'Import / Sync|Locations|Suppliers|Reports', tools.join('|'));
  ok('no Transfer button until there is a second location', !(await page.$('[data-act="transfer"]')));

  await page.click('[data-tool="locations"]');
  await page.waitForSelector('#inv-locations .inv-move', { timeout: 4000 });
  ok('locations list starts with the main location holding everything', /Main location.*100 units across 1 item.*\$2,?000\.00 at cost/s.test(await page.textContent('#inv-locations')), await page.textContent('#inv-locations'));
  await page.fill('#inv-loc-name', 'Bairiki warehouse');
  await page.click('#inv-location-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('#inv-locations .inv-move').length === 2, null, { timeout: 4000 }).catch(() => {});
  ok('warehouse added', /Bairiki warehouse/.test(await page.textContent('#inv-locations')));
  await page.waitForSelector('[data-act="transfer"]', { timeout: 4000 }).catch(() => {});
  ok('item now shows its split and a Transfer button', /Main location 100 · Bairiki warehouse 0/.test(await page.textContent('.inv-row')) && !!(await page.$('[data-act="transfer"]')), await page.textContent('.inv-row'));

  await page.click('[data-act="transfer"]');
  ok('transfer defaults to main -> warehouse', await page.inputValue('#inv-from') === 'default' && (await page.$eval('#inv-to', (s) => s.options[s.selectedIndex].text)).startsWith('Bairiki warehouse'));
  await page.fill('#inv-qty', '60');
  await page.click('#inv-submit');
  await page.waitForSelector('#inv-panel-saved:not(.hidden)', { timeout: 5000 }).catch(() => {});
  ok('moved: message and split update; total unchanged', /Moved\. Main location 40 · Bairiki warehouse 60/.test(await page.textContent('#inv-panel-saved')) &&
    /Main location 40 · Bairiki warehouse 60/.test(await page.textContent('.inv-row')) && /100 in stock/.test(await page.textContent('.inv-row')));

  await page.click('[data-tool="suppliers"]');
  await page.fill('#inv-sup-name', 'ABC Trading');
  await page.fill('#inv-sup-phone', '7300 1234');
  await page.click('#inv-sup-save');
  await page.waitForFunction(() => /ABC Trading/.test(document.getElementById('inv-suppliers').textContent), null, { timeout: 4000 }).catch(() => {});
  ok('supplier added to the list', /ABC Trading.*7300 1234/s.test(await page.textContent('#inv-suppliers')));

  await page.click('[data-act="receive"]');
  ok('receive offers the locations and the saved supplier', (await page.$$eval('#inv-loc option', (o) => o.map((x) => x.textContent))).join('|') === 'Main location (now 40)|Bairiki warehouse (now 60)' &&
    (await page.$$eval('#inv-supplier-list option', (o) => o.map((x) => x.value))).join() === 'ABC Trading');
  await page.selectOption('#inv-loc', { index: 1 });
  await page.fill('#inv-qty', '25');
  await page.fill('#inv-supplier', 'ABC Trading');
  await page.click('#inv-submit');
  await page.waitForFunction(() => /Bairiki warehouse 85/.test(document.querySelector('.inv-row').textContent), null, { timeout: 5000 }).catch(() => {});
  ok('received into the warehouse: 85 there, 125 total', /Bairiki warehouse 85/.test(await page.textContent('.inv-row')) && /125 in stock/.test(await page.textContent('.inv-row')));

  await page.click('[data-tool="reports"]');
  await page.waitForFunction(() => /Received by supplier/.test(document.getElementById('inv-report').textContent), null, { timeout: 4000 }).catch(() => {});
  const rep = await page.textContent('#inv-report');
  ok('report: received 25, by supplier, by location', /25units received/.test(rep) && /ABC Trading 25/.test(rep) && /Bairiki warehouse 85/.test(rep), rep);
  ok('no horizontal scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  ok('no page errors (distributor)', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: true }).catch(() => {});

  // A retailer sees the simple page.
  who = { OwnerId: 'own_r', StoreSlug: 'r', StoreType: '' };
  await page.goto(BASE + '/owner/inventory.html', { waitUntil: 'load' });
  await page.waitForSelector('.inv-row', { timeout: 6000 });
  const rtools = await page.$$eval('#inv-more [data-tool], #inv-more a', (b) => b.map((x) => x.textContent.trim()));
  ok('retailer sees only Import / Sync and Reports', rtools.join('|') === 'Import / Sync|Reports', rtools.join('|'));
  const look = await page.evaluate(() => {
    const st = (el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, color: c.color, border: c.borderTopColor, bw: c.borderTopWidth }; };
    return { tools: [...document.querySelectorAll('#inv-more .btn')].map(st), receive: st(document.querySelector('[data-act="receive"]')) };
  });
  ok('Import / Sync and Reports are outline only: purple border and text, no fill',
    look.tools.length === 2 && look.tools.every((t) => t.bg === 'rgba(0, 0, 0, 0)' && t.color === 'rgb(106, 97, 184)' && t.border === 'rgb(106, 97, 184)' && t.bw === '2px'), JSON.stringify(look.tools));
  // Every dark purple button is outlined now (Oct 2026), Receive included.
  ok('...and Receive is outlined in dark purple', look.receive.bg === 'rgb(255, 255, 255)' && look.receive.border === 'rgb(51, 45, 99)', JSON.stringify(look.receive));
  await page.screenshot({ path: process.env.SHOT2 || '/dev/null', fullPage: false }).catch(() => {});
  ok('retailer: no split, no Transfer, no location picker', !(await page.$('.inv-split')) && !(await page.$('[data-act="transfer"]')));
  await page.click('[data-act="receive"]');
  ok('...receive has no location field', !(await page.$('#inv-loc')));

  // Sign-up offers Distributor and promises the call.
  // Signed out, or the login page goes straight to the dashboard.
  const out = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  out.on('pageerror', (e) => errors.push(String(e)));
  await out.goto(BASE + '/owner/login.html', { waitUntil: 'load' });
  const types = await out.$$eval('input[name="storeType"]', (r) => r.map((x) => x.value));
  ok('sign-up offers Retailer, Wholesaler, Distributor', types.join() === 'retailer,wholesaler,distributor', types.join());
  await out.evaluate(() => { const r = document.querySelector('input[name="storeType"][value="distributor"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  ok('picking Distributor shows the verification-call note', !(await out.$eval('#wholesaler-note', (n) => n.hidden)));
  ok('no page errors', errors.length === 0, errors.join('; '));

  await browser.close();
  let f = 0; console.log('\n--- distributor inventory tools (real backend in harness) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
