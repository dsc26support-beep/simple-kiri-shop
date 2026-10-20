/**
 * Payment options in the browser, on the REAL backend: a seller ticks IB,
 * MPaisa and Teremo and adds their own in Settings, saves, and the storefront
 * and product page say "We accept IB, MPaisa, Teremo, …" under the store name.
 * An account number typed as their own option is refused. Phone and desktop.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const FUT = new Date(Date.now() + 9e8).toISOString();

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Phone', 'Island', 'Village', 'Username', 'Messenger', 'LogoUrl', 'DeliveryPickPay'],
    ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', '73001111', 'South Tarawa', 'Bairiki', 'ana', '', 'https://res.cloudinary.com/x/ana-logo.png', 'true']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'CreatedAt'],
    ['p1', 'own_a', 'ana', 'Rice 25kg', 'active', 'home', 'product', '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status'], ['v1', 'p1', 'own_a', 'One', 30, 'active']]
}, { guest: true });
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const call = (b) => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const callGet = (url) => {
  const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
  Object.keys(box.__cache).forEach((k) => delete box.__cache[k]);
  try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); }
};
const ana = () => box.sheetToObjects(box.getSheet('Owners')).find((o) => o.OwnerId === 'own_a');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w, seller) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((s) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (s) {
        localStorage.setItem('skiri_owner_token', 'tok-a');
        localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'own_a', storeName: 'Ana Shop', storeSlug: 'ana' }));
      }
    }, !!seller);
    await ctx.route('**/macros/s/**', (route) => {
      const req = route.request();
      const b = req.postData();
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : callGet(req.url()) });
    });
    await ctx.route('https://res.cloudinary.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0b3d91"/></svg>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('dialog', (d) => d.accept());
    return { ctx, p };
  };
  const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/pay-' + name + '.png', fullPage: false }); };

  /* ---------- the storefront before: nothing ---------- */
  let { ctx, p } = await open(1280);
  await p.goto(BASE + '/store.html?store=ana', { waitUntil: 'load' });
  await p.waitForFunction(() => /Ana Shop/.test(document.getElementById('store-name-tagline').textContent), null, { timeout: 15000 });
  ok('a store that has not chosen shows no payment line', await p.isHidden('#store-payment-line'));
  await ctx.close();

  /* ---------- Settings ---------- */
  ({ ctx, p } = await open(1280, true));
  await p.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('store-name').value === 'Ana Shop', null, { timeout: 15000 });
  const offered = await p.$$eval('input[name="paymentMethod"]', (b) => b.map((x) => x.value + ':' + x.closest('label').textContent.trim().replace(/\s+/g, ' ')));
  ok('Settings offers IB, MPaisa, Teremo and Cash', offered.join('|') === 'ib:IB (internet banking)|mpaisa:MPaisa|teremo:Teremo|cash:Cash', offered.join('|'));
  ok('...and says account numbers are never shown', /never your account numbers/.test(await p.textContent('#payment-options-heading + .helper-text')));
  await p.check('input[name="paymentMethod"][value="ib"]');
  await p.check('input[name="paymentMethod"][value="mpaisa"]');
  await p.check('input[name="paymentMethod"][value="teremo"]');
  await p.fill('#payment-other', 'ANZ 1234 5678');
  await p.click('#save-settings-btn');
  await p.waitForFunction(() => /account numbers/i.test(document.getElementById('settings-error').textContent), null, { timeout: 10000 }).catch(() => {});
  ok('an account number as their own option is refused with a reason', /account numbers/i.test(await p.textContent('#settings-error')) && !ana().PaymentOther, await p.textContent('#settings-error'));
  await p.fill('#payment-other', 'BKL transfer');
  await p.click('#save-settings-btn');
  await p.waitForFunction(() => document.getElementById('settings-success').textContent.trim() !== '', null, { timeout: 10000 }).catch(() => {});
  ok('Save stores the ticks and their own option', ana().PaymentMethods === 'ib,mpaisa,teremo' && ana().PaymentOther === 'BKL transfer', ana().PaymentMethods + ' / ' + ana().PaymentOther);
  await shot(p, 'settings');
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('store-name').value === 'Ana Shop', null, { timeout: 15000 });
  ok('...and they are ticked again after a reload', (await p.$$eval('input[name="paymentMethod"]:checked', (b) => b.map((x) => x.value))).join() === 'ib,mpaisa,teremo'
    && (await p.inputValue('#payment-other')) === 'BKL transfer');
  await ctx.close();

  /* ---------- storefront and product page ---------- */
  for (const w of [1280, 390]) {
    ({ ctx, p } = await open(w));
    await p.goto(BASE + '/store.html?store=ana', { waitUntil: 'load' });
    await p.waitForSelector('#store-payment-line:not([hidden])', { timeout: 15000 }).catch(() => {});
    const line = (await p.textContent('#store-payment-line')).replace(/\s+/g, ' ').trim();
    ok(`${w}px storefront: "We accept IB, MPaisa, Teremo, BKL transfer"`, line === 'We accept IB, MPaisa, Teremo, BKL transfer', line);
    const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`${w}px: no sideways scrolling`, wide <= 1, wide);
    await shot(p, 'store-' + w);
    await p.goto(BASE + '/product.html?store=ana&product=p1', { waitUntil: 'load' });
    await p.waitForSelector('#store-payment-line:not([hidden])', { timeout: 15000 }).catch(() => {});
    ok(`${w}px product page shows the same line`, /We accept IB, MPaisa, Teremo, BKL transfer/.test((await p.textContent('#store-payment-line')).replace(/\s+/g, ' ')));
    await ctx.close();
  }

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + ' - ' + r[1] + (r[0] === 'FAIL' && r[2] !== '' ? ' :: ' + r[2] : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})();
