/**
 * Store page as a profile on phones and tablets (owner request, Nov 2026), in
 * the browser on the REAL backend: cover photo (or the store colour), round
 * logo over its edge with the open dot, name with the verified tick, place and
 * status, the seller's bio; since 2 Nov Products / Photos / Info / Share are round
 * buttons beside the logo (Info opens a panel from the bottom). Since 1 Nov:
 * no red header and no message button there - the ⋮ menu sits on the cover
 * (and Home and the cart on a tablet), and the store's own seller changes the
 * banner and logo from the page. Computers keep the old header. And Settings:
 * upload / remove the cover photo, write the bio.
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
    const menu = document.querySelector('.header-menu-btn'); const mb = menu && menu.getBoundingClientRect();
    return { profile: r('store-profile'), cover: r('sp-cover'), avatar: r('sp-avatar'), name: r('sp-name'), list: r('product-list'),
      header: getComputedStyle(document.querySelector('header.site-header')).display, menuOnCover: !!(menu && menu.closest('#sp-cover')), menu: mb && { top: mb.top, right: mb.right },
      home: getComputedStyle(document.querySelector('.sp-home')).display, cart: document.getElementById('header-cart-link') ? { on: !!document.getElementById('header-cart-link').closest('#sp-cover'), d: getComputedStyle(document.getElementById('header-cart-link')).display } : null,
      message: document.getElementById('sp-message'), cams: [getComputedStyle(document.getElementById('sp-cam-cover')).display, getComputedStyle(document.getElementById('sp-cam-logo')).display],
      branding: getComputedStyle(document.querySelector('.store-branding')).display, side: document.documentElement.scrollWidth - innerWidth };
  });

  /* ---------- phone ---------- */
  let { ctx, p } = await open(390, 844);
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  await p.waitForTimeout(400);
  let g = await geo(p);
  ok('phone: the store opens as a profile; no red/yellow header at all', g.profile.shown && g.header === 'none', g);
  ok('...the ⋮ menu is on the cover, top right', g.menuOnCover && g.menu.top < g.cover.bottom && g.menu.right > 340, g);
  ok('...no Home or cart icons on a phone cover (the bottom bar has them)', g.home === 'none' && (!g.cart || g.cart.d === 'none'), g);
  ok('...no "Message the seller" button; the round chat button stays', g.message === null && await p.isVisible('#chat-fab'), g);
  ok('...a customer sees no camera buttons', g.cams.every((d) => d === 'none'), g.cams);
  await p.click('.header-menu-btn');
  await p.waitForTimeout(150);
  ok('...the ⋮ menu opens over the cover and its first item can be tapped', await p.evaluate(() => {
    const first = Array.from(document.querySelectorAll('#header-menu-panel .header-menu-item')).find((e) => e.getClientRects().length > 0);
    if (!first) return false; const r = first.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(el && first.contains(el)) && r.right <= innerWidth; }));
  const look = await p.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#header-menu-panel .header-menu-item')).filter((e) => e.getClientRects().length > 0);
    const cs = items.map((e) => getComputedStyle(e));
    const tops = items.map((e) => Math.round(e.getBoundingClientRect().top));
    return { n: items.length, flex: cs.every((c) => c.display === 'flex'), tall: items.every((e) => e.getBoundingClientRect().height >= 43.5),
      plain: cs.every((c) => c.textDecorationLine === 'none'), ink: cs.every((c) => c.color === 'rgb(26, 26, 26)'), oneEach: new Set(tops).size === tops.length };
  });
  ok('...and looks like the menu everywhere else: one item per line, 44px tall, dark text, no underlines', look.n >= 3 && look.flex && look.tall && look.plain && look.ink && look.oneEach, look);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-menu.png' });
  await p.keyboard.press('Escape');
  await p.mouse.click(5, 600);
  ok('...cover across the top, logo circle over its bottom edge', g.cover.w >= 389 && g.avatar.top < g.cover.bottom && g.avatar.bottom > g.cover.bottom && Math.abs(g.avatar.w - g.avatar.h) < 1, g);
  ok('...the cover is the seller’s photo', await p.evaluate(() => { const i = document.getElementById('sp-cover-img'); return !i.hidden && /cover\.jpg/.test(i.src); }));
  ok('...the name over the cover, with the verified tick; no counts there any more (they are on the buttons)', (await p.textContent('#sp-cover-name')) === 'Bong Store' && !(await p.$('#sp-cover-stats')) && await p.isVisible('#sp-verified'));
  const acts = await p.evaluate(() => {
    const av = document.getElementById('sp-avatar').getBoundingClientRect();
    return Array.from(document.querySelectorAll('.sp-actions .sp-act')).map((b) => { const r = b.getBoundingClientRect(); const i = b.querySelector('.sp-act-icon').getBoundingClientRect();
      return { id: b.id, label: b.querySelector('.sp-act-label').textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, round: getComputedStyle(b.querySelector('.sp-act-icon')).borderRadius, iw: i.width, ih: i.height, besideLogo: r.left > av.right - 1 && r.top < av.bottom + 4 }; });
  });
  ok('...Products, Photos, Info and Share as round buttons with a word under each, in a row beside the logo', acts.map((a) => a.id).join() === 'sp-tab-products,sp-tab-photos,sp-more,sp-share'
    && acts.every((a) => a.round === '50%' && a.iw >= 44 && Math.abs(a.iw - a.ih) < 1 && a.besideLogo && a.right <= 390) && acts.every((a, i) => i === 0 || (a.left >= acts[i - 1].right - 1 && Math.abs(a.top - acts[0].top) < 2)), acts);
  ok('...Products and Photos carry their counts', acts[0].label.replace(/\s+/g, ' ') === '3 Products' && acts[1].label.replace(/\s+/g, ' ') === '3 Photos' && acts[2].label === 'Info' && acts[3].label === 'Share', acts.map((a) => a.label));
  ok('...the old tab bar and "More info" link are gone', !(await p.$('.sp-tabs')) && !(await p.$('button.sp-more')));
  ok('...no name / place / "Open now" lines under the logo (owner, 1 Nov): the green dot says open', await p.isHidden('#sp-meta') && await p.evaluate(() => document.getElementById('sp-name').classList.contains('sr-only')) && await p.evaluate(() => !document.getElementById('sp-dot').classList.contains('is-closed')));
  ok('...the verified tick sits by the name on the cover', await p.evaluate(() => !!document.getElementById('sp-verified').closest('#sp-cover') && !document.getElementById('sp-verified').hidden));
  ok('...the bio shows two lines; the details wait in the Info panel', await p.evaluate(() => { const b = document.getElementById('sp-bio'); return b.scrollHeight > b.clientHeight + 4; }) && await p.isHidden('#sp-info'));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone.png' });
  await p.click('#sp-more');
  await p.waitForTimeout(350);
  const sh = await p.evaluate(() => { const d = document.getElementById('sp-sheet'); const r = d.getBoundingClientRect(); return { open: d.open, modal: d.matches(':modal'), bottom: Math.round(r.bottom), top: r.top, vh: innerHeight, w: r.width }; });
  ok('Info: a panel slides up from the bottom with the whole bio, phone, delivery and payment', sh.open && sh.modal && Math.abs(sh.bottom - sh.vh) <= 1 && sh.top > 100 && /deliver to your door/.test(await p.textContent('#sp-bio-full')) && /73001111/.test(await p.textContent('#sp-info')) && /Bong Store/.test(await p.textContent('#sp-sheet-title')), sh);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-more.png' });
  await p.click('#sp-sheet-close');
  ok('...✕ closes it', await p.evaluate(() => !document.getElementById('sp-sheet').open));
  await p.click('#sp-bio');
  await p.waitForTimeout(300);
  ok('...tapping the bio opens it too', await p.evaluate(() => document.getElementById('sp-sheet').open));
  await p.mouse.click(195, 40);
  await p.waitForTimeout(200);
  ok('...and tapping outside the panel closes it', await p.evaluate(() => !document.getElementById('sp-sheet').open));
  g = await geo(p);
  ok('...the products come straight after the profile', g.list.top > g.avatar.bottom && g.list.top - g.avatar.bottom < 260, g);
  await p.click('#chat-fab');
  await p.waitForFunction(() => document.getElementById('chat-fab').getAttribute('aria-expanded') === 'true', null, { timeout: 8000 });
  ok('the round chat button still opens the chat with the store', true);
  await p.click('#chat-window-close');
  ok('Products is chosen first (highlighted)', (await p.getAttribute('#sp-tab-products', 'aria-pressed')) === 'true' && (await p.getAttribute('#sp-tab-photos', 'aria-pressed')) === 'false'
    && await p.evaluate(() => getComputedStyle(document.querySelector('#sp-tab-products .sp-act-icon')).backgroundColor !== getComputedStyle(document.querySelector('#sp-tab-photos .sp-act-icon')).backgroundColor));
  await p.click('#sp-tab-photos');
  await p.waitForSelector('#store-photos:not([hidden]) a', { timeout: 5000 });
  const ph = await p.evaluate(() => ({ n: document.querySelectorAll('#store-photos a').length, cols: getComputedStyle(document.getElementById('store-photos')).gridTemplateColumns.split(' ').length,
    listHidden: getComputedStyle(document.getElementById('product-list')).display === 'none', href: document.querySelector('#store-photos a').getAttribute('href') }));
  ok('Photos: every product picture, three across; the product list steps aside; Photos is highlighted', (await p.getAttribute('#sp-tab-photos', 'aria-pressed')) === 'true' && ph.n === 3 && ph.cols === 3 && ph.listHidden && /product\.html\?store=bong&product=p1/.test(ph.href), ph);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-photos.png' });
  await p.click('#sp-tab-products');
  ok('...and back to Products', await p.evaluate(() => getComputedStyle(document.getElementById('product-list')).display !== 'none' && document.getElementById('store-photos').hidden));
  ok('phone: no sideways scrolling', (await geo(p)).side <= 1);
  await ctx.close();

  /* ---------- no cover, no bio, no logo ---------- */
  ({ ctx, p } = await open(390, 844));
  await p.goto(BASE + '/store.html?store=plain', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Plain Shop', null, { timeout: 15000 });
  ok('a store with no cover, logo or bio: store colour banner, initials, and no made-up bio line', await p.evaluate(() => document.getElementById('sp-cover-img').hidden &&
    document.getElementById('sp-avatar-initials').textContent.length > 0 && document.getElementById('sp-bio').hidden && document.getElementById('sp-meta').hidden && document.getElementById('sp-verified').hidden));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-plain.png' });
  await ctx.close();

  /* ---------- tablet, computer ---------- */
  ({ ctx, p } = await open(820, 1100));
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  g = await geo(p);
  ok('tablet: the same profile layout, larger cover and logo, no red header', g.profile.shown && g.header === 'none' && g.cover.h >= 200 && g.avatar.w >= 120 && g.side <= 1, g);
  ok('tablet: Home, cart and ⋮ on the cover (no bottom bar at this size)', g.home !== 'none' && g.cart && g.cart.on && g.cart.d !== 'none' && g.menuOnCover, g);
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-tablet.png' });
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.waitForTimeout(250);
  g = await geo(p);
  ok('...widened to a computer, the header and its ⋮ menu come back', g.header !== 'none' && !g.menuOnCover && !g.profile.shown, g);
  await ctx.close();
  ({ ctx, p } = await open(1280, 900));
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  g = await geo(p);
  ok('computer: unchanged - no profile, the red header shows the store as before, ⋮ in it', !g.profile.shown && g.header !== 'none' && g.branding !== 'none' && !g.menuOnCover && await p.isVisible('#store-name-tagline'), g);
  await ctx.close();

  /* ---------- the seller on their own store page ---------- */
  require('fs').writeFileSync('/tmp/claude-0/sp-cover.png', PNG);
  ({ ctx, p } = await open(390, 844, true));
  await p.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Bong Store', null, { timeout: 15000 });
  g = await geo(p);
  ok('the store’s own seller sees "Change banner" and a camera on the logo', g.cams.every((d) => d !== 'none'), g.cams);
  await p.setInputFiles('#sp-cover-input', '/tmp/claude-0/sp-cover.png');
  await p.waitForFunction(() => /Saved/.test(document.getElementById('sp-upload-status').textContent), null, { timeout: 15000 });
  ok('...changing the banner uploads it, saves it and shows it at once', /new-cover/.test(owner('own_s').CoverUrl) && await p.evaluate(() => /new-cover/.test(document.getElementById('sp-cover-img').src)));
  await p.setInputFiles('#sp-logo-input', '/tmp/claude-0/sp-cover.png');
  await p.waitForFunction(() => /new-cover\d+\.jpg/.test(document.getElementById('sp-avatar-img').src) && /Saved/.test(document.getElementById('sp-upload-status').textContent), null, { timeout: 15000 });
  ok('...changing the logo the same way', /new-cover/.test(owner('own_s').LogoUrl));
  if (SHOTS) await p.screenshot({ path: SHOTS + '/store-phone-owner.png' });
  await ctx.close();
  ({ ctx, p } = await open(390, 844, true));
  await p.goto(BASE + '/store.html?store=plain', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('sp-name').textContent === 'Plain Shop', null, { timeout: 15000 });
  ok('...but not on someone else’s store', (await geo(p)).cams.every((d) => d === 'none'));
  await ctx.close();

  /* ---------- Settings ---------- */
  ({ ctx, p } = await open(390, 900, true));
  await p.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('store-bio').value.length > 0, null, { timeout: 15000 });
  ok('Settings shows the current cover photo and bio, with a counter', await p.isVisible('#cover-preview') && await p.isVisible('#cover-remove') && /\d+/.test(await p.textContent('#store-bio-count')));
  await p.setInputFiles('#cover-image-input', '/tmp/claude-0/sp-cover.png');
  await p.waitForFunction(() => /Cover photo updated/.test(document.getElementById('cover-upload-status').textContent), null, { timeout: 15000 });
  ok('a new cover photo uploads and saves at once', /new-cover3/.test(owner('own_s').CoverUrl) && uploads.length === 3, uploads);
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
