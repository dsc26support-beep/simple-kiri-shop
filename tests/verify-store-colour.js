/**
 * Store colour in My Campaigns, in the browser on the REAL backend: the
 * seller's logo is read (served as image data by getStoreLogoData), its main
 * colours offered with the strongest suggested, the seller confirms one, and
 * the live email - top bar, button, tint, footer line - and the server preview
 * all wear it. Locked: no colour palette in the editor. Phone and desktop.
 */
const zlib = require('zlib');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { makeBox } = require('./lib/gas-harness.js');
const BASE = process.env.TX_BASE || 'http://127.0.0.1:8099';
const SHOTS = process.env.CS_SHOTS || '';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const DAY = 86400000;
const FUT = new Date(Date.now() + 30 * DAY).toISOString();
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

/** A 60x40 PNG: white border, Kiribati gold on the left two thirds, deep blue on the right. */
function logoPng() {
  const w = 60, h = 40;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const edge = x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
      const c = edge ? [255, 255, 255] : x < 40 ? [0xfc, 0xd1, 0x16] : [0x0b, 0x3d, 0x91];
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email', 'Phone', 'Island', 'Village', 'Username', 'LogoUrl', 'LogoFileId'],
    ['own_a', 'ana', 'Ana Shop', 'active', 'ana@x.com', '73001111', 'South Tarawa', 'Bairiki', 'ana', '', ''],
    ['own_adm', 'admin', 'ADMIN', 'active', 'boss@mwakete.com', '', '', '', 'boss', '', '']],
  Sessions: [['Token', 'OwnerId', 'CreatedAt', 'ExpiresAt'], ['tok-a', 'own_a', '', FUT]],
  Products: [['ProductId', 'OwnerId', 'StoreSlug', 'Name', 'Status', 'Category', 'ListingType', 'ImageUrl', 'Views', 'CreatedAt'],
    ['p1', 'own_a', 'ana', 'Rice 25kg', 'active', 'home', 'product', '', 50, ago(40)],
    ['p2', 'own_a', 'ana', 'Sugar 2kg', 'active', 'home', 'product', '', 30, ago(2)],
    ['p3', 'own_a', 'ana', 'Canoe hire', 'active', 'fishing', 'rental', '', 3, ago(9)]],
  Variants: [['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'Status']],
  Customers: [['CustomerId', 'Name', 'Email', 'Phone', 'EmailVerified', 'CreatedAt', 'UpdatedAt'], ['c1', 'Tera', 'tera@x.com', '7301', 'true', ago(100), ago(100)]],
  Orders: [['OrderId', 'OwnerId', 'StoreSlug', 'CustomerName', 'CustomerEmail', 'ItemsJson', 'Status', 'CreatedAt', 'Total'],
    ['o1', 'own_a', 'ana', 'Tera', 'tera@x.com', '[]', 'Fulfilled', ago(5), 30]],
  Bookings: [['BookingId', 'OwnerId', 'StoreSlug', 'ProductId', 'CustomerEmail', 'Status', 'CreatedAt']],
  Reviews: [['ReviewId', 'ProductId', 'OwnerId', 'StoreSlug', 'CustomerId', 'Status', 'CreatedAt']],
  AbandonedCarts: [['Id', 'StoreSlug', 'OwnerId', 'Email', 'CartJson', 'CreatedAt', 'Reminded', 'ConvertedOrderId']],
  Campaigns: [['CampaignId', 'Name', 'Type', 'Status', 'Objective', 'AudienceType', 'AudienceFilterJson', 'ProductIdsJson', 'StoreSlugsJson', 'Subject', 'PreviewText', 'BodyHtml', 'BodyText', 'CTAUrl', 'CTAType', 'StartAt', 'EndAt', 'CreatedAt', 'UpdatedAt', 'CreatedBy', 'MaxRecipients', 'SentCount', 'FailedCount', 'LastRunAt', 'SourceKey']],
  CampaignEvents: [['EventId', 'CampaignId', 'CustomerId', 'Email', 'EventType', 'Status', 'CreatedAt', 'SentAt', 'FailureReason', 'MetadataJson', 'Attempts']],
  MarketingPreferences: [['CustomerId', 'Email', 'PromotionalEmailOptIn', 'FrequencyLimit', 'LastPromotionalEmailAt', 'UpdatedAt', 'OptInAt', 'UnsubscribeToken']]
}, { guest: true });
box.__props.ADMIN_EMAILS = 'boss@mwakete.com';
box.__props.SITE_BASE_URL = 'https://mwakete.com';
box.__props.MARKETING_ENABLED = 'true';
box.__props.MARKETING_DRY_RUN = 'false';
box.MailApp.getRemainingDailyQuota = () => 100;
box.ocrPaymentImage = () => null;
box.ContentService = { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } };
box.setMarketingOptIn({ CustomerId: 'c1', Email: 'tera@x.com' }, true);
const call = (b) => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); try { return box.doPost({ postData: { contents: b } }).s; } catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); } };
const logoFile = box.DriveApp.createFolder('logos').createFile(box.Utilities.newBlob(logoPng(), 'image/png', 'logo'));
const ownersSheet = box.getSheet('Owners');
// The <img> on the page needs a real https address: the test serves the same PNG there.
const LOGO_URL = 'https://lh3.googleusercontent.com/d/' + logoFile.getId();
box.updateRowFromObject(ownersSheet, box.findRowById(ownersSheet, 'OwnerId', 'own_a').__row, { LogoUrl: LOGO_URL, LogoFileId: logoFile.getId() });
const ana = () => box.sheetToObjects(ownersSheet).find((o) => o.OwnerId === 'own_a');
const draft = box.actionSaveCampaignDraft(ana(), { name: 'Rice week', goal: 'products', productIds: ['p1'], audience: 'STORE_CUSTOMERS', template: 'spotlight',
  style: { background: '#fdecee', accent: '#ce1126', padding: 'normal' },
  blocks: [{ type: 'heading', text: 'New in at {{storeName}}', size: 24 }, { type: 'button', label: 'Shop now', target: 'store' }] }).campaign;
const rgb = (hex) => 'rgb(' + [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16)).join(', ') + ')';
const near = (a, b) => { const x = [1, 3, 5].map((i) => parseInt(a.substr(i, 2), 16)), y = [1, 3, 5].map((i) => parseInt(b.substr(i, 2), 16)); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 30; };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (w) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_owner_token', 'tok-a');
      localStorage.setItem('skiri_owner_profile', JSON.stringify({ ownerId: 'own_a', storeName: 'Ana Shop', storeSlug: 'ana' }));
    });
    await ctx.route('**/macros/s/**', (route) => {
      const b = route.request().postData();
      route.fulfill({ status: 200, contentType: 'application/json', body: b ? call(b) : '{"ok":true}' });
    });
    await ctx.route(LOGO_URL, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: logoPng() }));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin' flag/.test(String(e))) errors.push(String(e)); });
    p.on('dialog', (d) => d.accept());
    return { ctx, p };
  };
  const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/brand-' + name + '.png', fullPage: false }); };

  let { ctx, p } = await open(1280);
  await p.goto(BASE + '/owner/campaigns.html', { waitUntil: 'load' });
  await p.waitForSelector('#cs-brand [data-brand]', { timeout: 15000 });
  const offered = await p.$$eval('#cs-brand [data-brand]', (b) => b.map((x) => x.dataset.brand));
  ok('first visit: the logo is read and its colours offered straight away', offered.some((c) => near(c, '#fcd116')) && offered.some((c) => near(c, '#0b3d91')), offered.join());
  ok('...white background left out', !offered.some((c) => near(c, '#ffffff')));
  const suggested = await p.getAttribute('#cs-brand [data-brand][aria-checked="true"]', 'data-brand');
  ok('...the main logo colour is suggested', near(suggested, '#fcd116'), suggested);
  ok('...shown on a bar with dark text, since gold is light', (await p.evaluate(() => getComputedStyle(document.querySelector('#cs-brand .cs-brand-bar')).color)) === 'rgb(26, 26, 26)');
  ok('nothing is saved until the seller confirms', !ana().BrandColor);
  await shot(p, 'picker');
  const blue = offered.find((c) => near(c, '#0b3d91'));
  await p.click(`#cs-brand [data-brand="${blue}"]`);
  ok('choosing another colour updates the bar', (await p.evaluate(() => getComputedStyle(document.querySelector('#cs-brand .cs-brand-bar')).backgroundColor)) === rgb(blue)
    && (await p.evaluate(() => getComputedStyle(document.querySelector('#cs-brand .cs-brand-bar')).color)) === 'rgb(255, 255, 255)');
  await p.click('#cs-brand-save');
  await p.waitForFunction(() => /now use this colour/.test(document.getElementById('cs-brand').textContent), null, { timeout: 8000 });
  ok('Use this colour saves it to the store', ana().BrandColor === blue && !!ana().BrandColorSetAt, ana().BrandColor);
  ok('...and the card offers Change colour', /Change colour/.test(await p.textContent('#cs-brand')));
  await ctx.close();

  /* ---------- the editor wears it, and it is locked ---------- */
  ({ ctx, p } = await open(1280));
  await p.goto(BASE + '/owner/campaigns.html', { waitUntil: 'load' });
  await p.waitForSelector('#cs-brand-pick', { timeout: 15000 });
  ok('once confirmed, the picker no longer opens by itself', !(await p.$('#cs-brand [data-brand]')));
  await p.goto(BASE + '/owner/campaigns.html?edit=' + draft.campaignId, { waitUntil: 'load' });
  await p.waitForSelector('#cs-builder:not([hidden])', { timeout: 15000 });
  for (let i = 0; i < 6 && !(await p.isVisible('.cs-step[data-step="design"]')); i++) { await p.click('#cs-next-btn'); await p.waitForTimeout(400); }
  await p.waitForSelector('.cs-step[data-step="design"]:not([hidden])', { timeout: 10000 });
  const look = await p.evaluate(() => {
    const cs = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
    return { head: cs('#cs-email .cs-ehead', 'backgroundColor'), headText: document.querySelector('#cs-email .cs-ehead').textContent.trim(), logo: !!document.querySelector('#cs-email .cs-ehead img'),
      btn: cs('#cs-email .cs-ebtn', 'backgroundColor'), foot: cs('#cs-email .cs-efoot', 'borderTopColor'), bg: cs('#cs-email', 'backgroundColor') };
  });
  const brand = box.scBrand(ana());
  ok('the live email: top bar in the store colour with its logo and name', look.head === rgb(brand.fill) && look.logo && look.headText === 'Ana Shop', JSON.stringify(look));
  ok('...button and footer line in it, pale tint behind', look.btn === rgb(brand.fill) && look.foot === rgb(brand.fill) && look.bg === rgb(brand.tint));
  ok('...the campaign\'s old red/pink style is not used', look.btn !== 'rgb(206, 17, 38)' && look.bg !== 'rgb(253, 236, 238)');
  ok('...and no colour palette to change it', !(await p.$('[data-swatch]')) && /Your store colour/.test(await p.textContent('#cs-props')));
  await p.click('#cs-preview-btn');
  await p.waitForSelector('#cs-preview-dialog[open]', { timeout: 8000 });
  const srcdoc = await p.getAttribute('#cs-preview-frame', 'srcdoc');
  ok('the server preview matches: store colour bar with the logo, Mwakete only in the footer',
    srcdoc.includes('background:' + brand.fill + ';padding:12px 16px') && srcdoc.includes(LOGO_URL) && !/#ce1126/i.test(srcdoc) && /Sent by Mwakete for Ana Shop/.test(srcdoc));
  await p.keyboard.press('Escape');
  await shot(p, 'editor');
  await ctx.close();

  /* ---------- phone ---------- */
  ({ ctx, p } = await open(390));
  await p.goto(BASE + '/owner/campaigns.html', { waitUntil: 'load' });
  await p.waitForSelector('#cs-brand-pick', { timeout: 15000 });
  await p.click('#cs-brand-pick');
  await p.waitForSelector('#cs-brand [data-brand]', { timeout: 10000 });
  ok('phone: Change colour opens the picker on the saved colour', (await p.getAttribute('#cs-brand [data-brand][aria-checked="true"]', 'data-brand')) === blue);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('phone: no sideways scrolling', wide <= 1, wide);
  await shot(p, 'phone');
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  R.forEach((r) => console.log(r[0] + ' - ' + r[1] + (r[0] === 'FAIL' && r[2] !== '' ? ' :: ' + r[2] : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${R.length - failed}/${R.length} passed`);
  process.exit(failed ? 1 : 0);
})();
