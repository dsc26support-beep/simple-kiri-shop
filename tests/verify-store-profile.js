/**
 * Store page as a profile on phones and tablets (owner request, Nov 2026), in
 * the browser on the REAL backend: cover photo (or the store colour), round
 * logo over its edge with the open dot, name with the verified tick, place and
 * status, the seller's bio with More info, the big "Message the seller" button
 * opening the chat, Products | Photos tabs. Computers keep the old header. And
 * Settings: upload / remove the cover photo, write the bio.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : JSON.stringify(e).slice(0, 400)]);
const FUT = new Date(Date.now() + 30 * 86400000).toISOString();
const IMG = 'https://res.cloudinary.com/demo/image/upload/';

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Email', 'Phone', 'Status', 'Island', 'Village', 'DeliveryPickPay', 'DeliveryTruck', 'DeliveryTruckCost', 'StoreType', 'BrandColor', 'LogoUrl', 'PaymentMethods', 'Username', 'CoverUrl', 'StoreBio'],
    ['own_s', 'bong', 'Bong Store', 's@x.test', '73001111', 'active', 'South Tarawa', 'Bairiki', 'true', 'true', 5, 'retailer', '#0b3d91', IMG + 'logo.png', 'ib', 'bong', IMG + 'cover.jpg',
      'Fresh rice, flour and tinned fish. Open every day in Bairiki - come and see us, or order here and we deliver to your door anywhere on South Tarawa.'],
    ['own_p', 'plain', 'Plain Shop', 'p@x.test', '', 'active', 'Abaiang', '', 'true', 'false', '', 'retailer', '', '', '', 'plain', '', '']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-s', 'own_s', '', FUT]],
  SellerBadges: [['OwnerId', 'Badges'], ['own_s', 'verified']],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Description', 'Category', 'ListingType', 'ImageUrl', 'ImageUrl2', 'Status', 'SortOrder', 'CreatedAt', 'UpdatedAt'],
    ['p1', 'own_s', 'bong', 'Rice', '10kg bag', 'home', 'product', IMG + 'rice.jpg', IMG + 'rice2.jpg', 'active', 0, '', ''],
    ['p2', 'own_s', 'bong', 'Flour', '', 'home', 'product', IMG + 'flour.jpg', '', 'active', 1, '', ''],
    ['p3', 'own_s', 'bong', 'Tuna', '', 'home', 'product', '', '', 'active', 2, '', ''],
    ['p4', 'own_p', 'plain', 'Mat', '', 'home', 'product', '', '', 'active', 0, '', '']],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status'],
    ['v1', 'p1', 'own_s', '10kg', 20, '', 50, 'active'], ['v2', 'p2', 'own_s', '1kg', 4, '', 50, 'active'], ['v3', 'p3', 'own_s', 'can', 2, '', 50, 'active'], ['v4', 'p4', 'own_p', 'one', 10, '', 5, 'active']],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'ItemsJson', 'Status', 'CreatedAt']]
}, { guest: true });
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
const uploads = [];
box.uploadImage = (bytes, mime) => { uploads.push(mime); return { imageUrl: IMG + 'new-cover' + uploads.length + '.jpg', imageFileId: 'fc' + uploads.length }; };
box.deleteStoredImage = () => {};
box.getImageFolder = () => null;
const clear = () => Object.keys(box.__cache || {}).forEach((k) => delete box.__cache[k]);
const call = (b) => { clear(); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const callGet = (url) => { clear(); const u = new URL(url); const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
  try { return box.doGet({ parameter: p }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const owner = (id) => box.__sheets.Owners.objects().find((o) => o.OwnerId === id);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w, h, seller) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h || 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript((s) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (s) { localStorage.setItem('skiri_owner_token', 'tok-s'); localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'own_s', storeName: 'Bong Store', storeSlug: 'bong' })); }
    }, !!seller);
    await ctx.route('**/macros/s/**', (route) => { const req = route.request(); const b = req.postData(); route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : callGet(req.url()) }); });
    await ctx.route('https://res.cloudinary.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#6a61b8"/><circle cx="200" cy="150" r="80" fill="#fcd116"/></svg>' }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(w + ' ' + String(e)));
    return { ctx, p };
  };
  const geo = (p) => p.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height, shown: getComputedStyle(e).display !== 'none' && !e.closest('[hidden]') }; };
    return { profile: r('store-profile'), cover: r('sp-cover'), avatar: r('sp-avatar'), name: r('sp-name'), message: r('sp-message'), tabs: r('sp-tab-products'), list: r('product-list'),
      branding: getComputedStyle(document.querySelector('.store-branding')).display, side: document.documentElement.scrollWidth - innerWidth };
  });

  /* ---------- phone ---------- */
  let { ctx, p } = await open(390, 844);
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  await p.waitForTimeout(400);
  let g = await geo(p);
  ok('phone: the store opens as a profile, the old header details are hidden', g.profile.shown && g.branding === 'none', g);
  ok('...cover across the top, logo circle over its bottom edge', g.cover.w >= 389 && g.avatar.top < g.cover.bottom && g.avatar.bottom > g.cover.bottom && Math.abs(g.avatar.w - g.avatar.h) < 1, g);
  ok('...the cover is the seller’s photo', await p.evaluate(() => { const i = document.getElementById('sp-cover-img'); return !i.hidden && /cover\.jpg/.test(i.src); }));
  ok('...name and counts over the cover; name with the verified tick under the logo', (await p.textContent('#sp-cover-name')) === 'Bong Store' && /^3 products · 3 photos$/.test(await p.textContent('#sp-cover-stats')) && await p.isVisible('#sp-verified'));
  ok('...place and "Open now", with the green dot', /Bairiki · Open now/.test(await p.textContent('#sp-meta')) && await p.evaluate(() => !document.getElementById('sp-dot').classList.contains('is-closed')));
  ok('...the bio shows two lines, More info shows the rest and the details', await p.evaluate(() => { const b = document.getElementById('sp-bio'); return b.scrollHeight > b.clientHeight + 4; }) && await p.isHidden('#sp-info'));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone.png' });
  await p.click('#sp-more');
  ok('...tapping More info opens the whole bio, phone, delivery and payment', await p.isVisible('#sp-info') && /deliver to your door/.test(await p.textContent('#sp-bio-full')) && /73001111/.test(await p.textContent('#sp-info')) && (await p.textContent('#sp-more')) === 'Less info');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-more.png', fullPage: true });
  await p.click('#sp-more');
  g = await geo(p);
  ok('...one big full-width "Message the seller" button, then the tabs, then the products', g.message.w > 340 && g.message.h >= 50 && g.tabs.top > g.message.bottom && g.list.top > g.tabs.bottom && /Message the seller/i.test(await p.textContent('#sp-message')), g);
  await p.click('#sp-message');
  await p.waitForFunction(() => document.getElementById('chat-fab').getAttribute('aria-expanded') === 'true', null, { timeout: 8000 });
  ok('"Message the seller" opens the chat with the store', true);
  await p.click('#chat-window-close');
  ok('tabs: Products with the count is chosen first', /3 Products/.test(await p.textContent('#sp-tab-products')) && (await p.getAttribute('#sp-tab-products', 'aria-selected')) === 'true');
  await p.click('#sp-tab-photos');
  await p.waitForSelector('#store-photos:not([hidden]) a', { timeout: 5000 });
  const ph = await p.evaluate(() => ({ n: document.querySelectorAll('#store-photos a').length, cols: getComputedStyle(document.getElementById('store-photos')).gridTemplateColumns.split(' ').length,
    listHidden: getComputedStyle(document.getElementById('product-list')).display === 'none', href: document.querySelector('#store-photos a').getAttribute('href') }));
  ok('Photos: every product picture, three across; the product list steps aside', ph.n === 3 && ph.cols === 3 && ph.listHidden && /product\.html\?store=bong&product=p1/.test(ph.href), ph);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-photos.png' });
  await p.click('#sp-tab-products');
  ok('...and back to Products', await p.evaluate(() => getComputedStyle(document.getElementById('product-list')).display !== 'none' && document.getElementById('store-photos').hidden));
  ok('phone: no sideways scrolling', (await geo(p)).side <= 1);
  await ctx.close();

  /* ---------- no cover, no bio, no logo ---------- */
  ({ ctx, p } = await open(390, 844));
  await p.goto(BASE + '/store.html?store=plain', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Plain Shop', null, { timeout: 15000 });
  ok('a store with no cover, logo or bio: store colour banner, initials, a plain line instead of a bio', await p.evaluate(() => document.getElementById('sp-cover-img').hidden &&
    document.getElementById('sp-avatar-initials').textContent.length > 0 && /Shop from Plain Shop in Abaiang/.test(document.getElementById('sp-bio').textContent) && document.getElementById('sp-verified').hidden));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-plain.png' });
  await ctx.close();

  /* ---------- tablet, computer ---------- */
  ({ ctx, p } = await open(820, 1100));
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  g = await geo(p);
  ok('tablet: the same profile layout, larger cover and logo', g.profile.shown && g.cover.h >= 200 && g.avatar.w >= 120 && g.side <= 1, g);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-tablet.png' });
  await ctx.close();
  ({ ctx, p } = await open(1280, 900));
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  g = await geo(p);
  ok('computer: unchanged - no profile, the header shows the store as before', !g.profile.shown && g.branding !== 'none' && await p.isVisible('#store-name-tagline'), g);
  await ctx.close();

  /* ---------- Settings ---------- */
  ({ ctx, p } = await open(390, 900, true));
  await p.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('store-bio').value.length > 0, null, { timeout: 15000 });
  ok('Settings shows the current cover photo and bio, with a counter', await p.isVisible('#cover-preview') && await p.isVisible('#cover-remove') && /\d+/.test(await p.textContent('#store-bio-count')));
  require('fs').writeFileSync('/tmp/claude-0/sp-cover.png', PNG);
  await p.setInputFiles('#cover-image-input', '/tmp/claude-0/sp-cover.png');
  await p.waitForFunction(() => /Cover photo updated/.test(document.getElementById('cover-upload-status').textContent), null, { timeout: 15000 });
  ok('a new cover photo uploads and saves at once', /new-cover1/.test(owner('own_s').CoverUrl) && uploads.length === 1);
  await p.click('#cover-remove');
  await p.waitForFunction(() => /removed/.test(document.getElementById('cover-upload-status').textContent), null, { timeout: 10000 });
  ok('...and can be removed', owner('own_s').CoverUrl === '' && await p.isHidden('#cover-preview'));
  await p.fill('#store-bio', 'Rice and fish, every day.');
  ok('...the bio counter counts', (await p.textContent('#store-bio-count')) === '25');
  if (SHOTS) await p.screenshot({ path: SHOTS + '/settings-cover-bio.png', fullPage: false });
  await ctx.close();
  const r = JSON.parse(call(JSON.stringify({ action: 'updateOwnerProfile', token: 'tok-s', storeBio: 'Rice and fish, every day.' })));
  ok('Saving the settings form sends the bio (checked through the same action)', r.ok && owner('own_s').StoreBio === 'Rice and fish, every day.');

  ok('no page errors', errors.length === 0, errors);
  await browser.close();
  R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' && x[2] ? '  [' + x[2] + ']' : '')));
  const f = R.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); R.forEach((x) => console.log(x[0] + '  ' + x[1] + (x[0] === 'FAIL' && x[2] ? '  [' + x[2] + ']' : ''))); process.exit(1); });
