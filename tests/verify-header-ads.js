// Homepage header adverts: slide right-to-left, 6 s still, clickable, the
// built-in lines when none run; admin form. Backend mocked.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

async function home(browser, ads, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    const a = new URL(route.request().url()).searchParams.get('action');
    const body = a === 'getHeaderAds' ? { ok: true, ads } : { ok: true, products: [], stores: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  return { ctx, page, errors };
}
const current = (page) => page.$eval('.header-ticker .is-current', (e) => e.textContent.trim());

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* no adverts: the built-in lines, sliding */
  let { ctx, page, errors } = await home(browser, []);
  ok('no adverts: the built-in first line shows', /Local Kiribati sellers/.test(await current(page)));
  ok('...and it is not a link', (await page.$('.header-ticker a')) === null);
  await page.waitForTimeout(4200);   // ~6.7 s since load
  ok('after 6 s still, the next line takes its place', /Chat directly with the seller/.test(await current(page)), await current(page));
  const motion = await page.evaluate(() => {
    const t = document.querySelector('.header-ticker');
    const items = t.querySelectorAll('.header-ticker-item');
    return { styleIn: getComputedStyle(t.querySelector('.is-current')).transitionProperty, leaving: !!t.querySelector('.is-leaving') };
  });
  ok('lines move by sliding (transform), not a pop-in', /transform/.test(motion.styleIn) && motion.leaving, JSON.stringify(motion));
  // Direction: an entering line starts to the RIGHT, a leaving one ends to the LEFT.
  const dir = await page.evaluate(() => {
    const t = document.querySelector('.header-ticker');
    const leaving = t.querySelector('.is-leaving');
    const m = new DOMMatrix(getComputedStyle(leaving).transform);
    const parked = t.querySelector('.header-ticker-item:not(.is-current):not(.is-leaving)');
    const p = parked ? new DOMMatrix(getComputedStyle(parked).transform) : null;
    return { leftX: m.m41, waitingX: p ? p.m41 : null };
  });
  ok('slides from right to left (waiting line on the right, leaving line goes left)', dir.leftX < 0 && dir.waitingX > 0, JSON.stringify(dir));
  ok('no script errors (defaults)', errors.length === 0, errors.join(' | '));
  await ctx.close();

  /* adverts running: clickable, phone */
  const ADS = [{ text: '20% off rice at Teaube', link: 'store.html?store=tea' }, { text: 'Solar sale <b>now</b>', link: 'https://example.com/solar' }];
  ({ ctx, page, errors } = await home(browser, ADS));
  ok('adverts replace the built-in lines', /20% off rice at Teaube/.test(await current(page)) && !/Local Kiribati/.test(await page.textContent('.header-ticker')));
  ok('advert text is shown as text, not markup', (await page.$('.header-ticker b')) === null && /Solar sale <b>now<\/b>/.test(await page.textContent('.header-ticker')));
  ok('the strip is announced as adverts; only the advert on screen can be tabbed to', (await page.getAttribute('.header-ticker', 'aria-label')) === 'Adverts'
    && (await page.$$eval('.header-ticker a', (as) => as.map((a) => a.tabIndex))).join() === '0,-1');
  ok('an outside link opens in a new tab, safely', (await page.getAttribute('.header-ticker-item:nth-child(2) a', 'target')) === '_blank'
    && (await page.getAttribute('.header-ticker-item:nth-child(2) a', 'rel')) === 'noopener');
  if (SHOT) await page.screenshot({ path: SHOT + '/header-ads-phone.png', clip: { x: 0, y: 0, width: 390, height: 140 } });
  await page.hover('.header-ticker .is-current a');
  await page.waitForTimeout(5500);
  ok('it holds still while the shopper is pointing at it', /20% off rice/.test(await current(page)));
  await Promise.all([page.waitForURL(/store\.html\?store=tea/, { timeout: 5000 }).catch(() => {}), page.click('.header-ticker .is-current a')]);
  ok('tapping the advert opens its link', /store\.html\?store=tea/.test(page.url()), page.url());
  ok('no script errors (adverts)', errors.length === 0, errors.join(' | '));
  await ctx.close();

  /* desktop: inside the red header, clickable, logo and cart untouched */
  ({ ctx, page, errors } = await home(browser, ADS, { width: 1280, height: 800 }));
  const hit = await page.evaluate(() => {
    const a = document.querySelector('.header-ticker .is-current a');
    const r = a.getBoundingClientRect();
    const atLink = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const logo = document.querySelector('header.site-header a, .site-header .logo, header a');
    const lr = logo.getBoundingClientRect();
    const atLogo = document.elementFromPoint(lr.left + 5, lr.top + lr.height / 2);
    return { link: !!(atLink && atLink.closest('.header-ticker-link')), logo: !!(atLogo && !atLogo.closest('.header-ticker')), colour: getComputedStyle(a).color };
  });
  ok('desktop: the advert in the red header can be clicked', hit.link, JSON.stringify(hit));
  ok('desktop: the logo is still clickable beside it', hit.logo, JSON.stringify(hit));
  ok('desktop: white text on the red header', hit.colour === 'rgb(255, 255, 255)', hit.colour);
  if (SHOT) await page.screenshot({ path: SHOT + '/header-ads-desktop.png', clip: { x: 0, y: 0, width: 1280, height: 120 } });
  await ctx.close();

  /* remembered on this device: the next visit shows the advert first, not the defaults */
  ({ ctx, page } = await home(browser, ADS));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  ok('a returning visitor sees the advert straight away', /20% off rice/.test(await current(page)));
  await ctx.close();

  /* admin form */
  const actx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const calls = [];
  await actx.route('**/macros/s/**', (route) => {
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    const a = body.action || new URL(route.request().url()).searchParams.get('action');
    calls.push(Object.assign({ action: a }, body));
    let res = { ok: true };
    if (a === 'getOwnerProfile') res = { ok: true, owner: { ownerId: 'admin', storeName: 'Admin', storeSlug: 'adm', isAdmin: true } };
    else if (a === 'listStores') res = { ok: true, stores: [{ storeSlug: 'tea', storeName: 'Teaube' }] };
    else if (a === 'adminListHeaderAds') res = { ok: true, today: '2026-10-09', ads: [{ adId: 'ad_1', text: 'Solar sale', link: 'https://example.com', status: 'active', running: true, startDate: '', endDate: '' }] };
    else if (a === 'adminSaveHeaderAd') res = { ok: true, adId: 'ad_2' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });
  page = await actx.newPage();
  const aerr = []; page.on('pageerror', (e) => aerr.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'tok'); } catch (e) {} });
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  ok('admin: menu has Header adverts; the running advert is listed', (await page.$('.admin-jump a[href="#ha-heading"]')) !== null && /Solar sale/.test(await page.textContent('#ha-list'))
    && /1 advert\(s\) showing now/.test(await page.textContent('#ha-status')));
  await page.fill('#ha-text', '20% off rice at Teaube');
  ok('admin: live preview of the strip, with a character count', /20% off rice at Teaube/.test(await page.textContent('#ha-preview-text')) && (await page.textContent('#ha-count')) === '22');
  await page.selectOption('#ha-store', 'tea');
  ok('admin: picking a store fills the link', (await page.inputValue('#ha-link')) === 'store.html?store=tea');
  await page.fill('#ha-start', '2026-10-10');
  await page.fill('#ha-end', '2026-10-17');
  await page.click('#ha-save');
  await page.waitForTimeout(500);
  const sv = calls.filter((c) => c.action === 'adminSaveHeaderAd').pop();
  ok('admin: saving sends text, link, dates and on', sv && sv.text === '20% off rice at Teaube' && sv.link === 'store.html?store=tea' && sv.startDate === '2026-10-10'
    && sv.endDate === '2026-10-17' && sv.status === 'active', JSON.stringify(sv));
  await page.click('#ha-list [data-act="delete"]');
  await page.waitForTimeout(400);
  ok('admin: delete asks first, then deletes', calls.some((c) => c.action === 'adminDeleteHeaderAd' && c.adId === 'ad_1'));
  ok('admin: no script errors', aerr.length === 0, aerr.join(' | '));
  await actx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- header adverts ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
