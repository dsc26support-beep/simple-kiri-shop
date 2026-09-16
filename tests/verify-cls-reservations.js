/**
 * Space held before the thing that fills it arrives.
 *
 * Three reservations, each measured as a DIFFERENCE rather than against a fixed
 * ceiling, because an absolute number folds in every other shift on the page
 * and then blames whatever is under test.
 *
 * 1. THE HEADER LOGO. favicon.svg carries a viewBox and no width/height
 *    attributes, so until it arrives the browser has no intrinsic size and
 *    `width: auto` is 0. On a page with nav links beside it that was enough to
 *    WRAP the nav onto a second row; when the logo landed, the nav fitted back
 *    beside it and the header snapped 32px shorter, dragging <main> up with it.
 *    Measured at 0.0535 on privacy.html. This suite stalls the logo 600ms to
 *    make that deterministic instead of hoping to catch the race.
 *
 * 2. THE THREE PROFILE LINES on the customer dashboard. Empty paragraphs
 *    generate no line box, so the block was 36px until getCustomerProfile
 *    answered and 144px after - pushing My Orders and My Bookings down 108px.
 *    0.0596, the largest shift on the site.
 *
 * 3. .home-main BELONGS TO index.html ALONE. It makes <main> a flex column,
 *    and .container's `margin: 0 auto` then stops it stretching, so the
 *    container shrinks to fit its CONTENTS and moves whenever they change.
 *    Three pages carried it by mistake.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const P = (i) => ({ productId: 'p' + i, name: 'Item ' + i, description: 'x', category: 'food',
  status: 'active', imageUrl: '', listingType: 'product', storeSlug: 'bong', storeName: 'Bong Store',
  island: 'Tarawa', village: 'Bairiki', variants: [{ variantId: 'v' + i, label: 'one', price: 5 + i }],
  rating: null, reviewCount: 0, views: i, createdAt: '2026-01-01' });
const BODY = {
  ok: true,
  products: Array.from({ length: 8 }, (_, i) => P(i)),
  stores: Array.from({ length: 4 }, (_, i) => ({ storeSlug: 's' + i, storeName: 'Store ' + i, island: 'Tarawa', village: 'Bairiki' })),
  tips: [], conversations: [], orders: [], bookings: [],
  customer: { name: 'Teraoi Tebwerere', email: 'teraoi@example.com', phone: '73011111', island: 'Tarawa', village: 'Bairiki' },
  storeName: 'Bong', storeOpen: true
};

async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 } });
  await ctx.route('**/macros/s/**', async (r) => {
    if (opts.dataDelay) await new Promise((x) => setTimeout(x, opts.dataDelay));
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BODY) });
  });
  // Stalling ONE resource is what turns an intermittent race into a measurement.
  if (opts.slowLogo) {
    await ctx.route('**/favicon.svg', async (r) => {
      await new Promise((x) => setTimeout(x, 600));
      await r.continue();
    });
  }
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_customer_token', 't');
    } catch (e) {}
  });
  await page.goto(BASE + path, { waitUntil: opts.waitUntil || 'load' });
  return { ctx, page };
}

async function cls(browser, path, opts) {
  const { ctx, page } = await open(browser, path, opts);
  const total = await page.evaluate(() => new Promise((res) => {
    let t = 0;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) t += e.value; }))
      .observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => res(t), 1500);
  }));
  await ctx.close();
  return total;
}

// A race only ever ADDS shift, so the minimum of several runs is the race-free
// floor and the fair number to compare.
async function minCls(browser, path, opts, n) {
  const runs = [];
  for (let i = 0; i < (n || 3); i++) runs.push(await cls(browser, path, opts));
  return Math.min.apply(null, runs);
}

// customer-dashboard is deliberately NOT here. It still has a shift of its own
// - the orders and bookings filter rows, see the block at the end - and that
// shift is bimodal, landing on either 0.0103 or 0.0219 depending on how the
// render happens to interleave. A difference measured against noise like that
// says nothing about the logo, and a minimum-of-N big enough to settle it just
// hides the noise instead. The logo's reservation is asserted there directly
// instead, through the box geometry above.
const LOGO_PAGES = ['/index.html', '/customer-tips.html', '/customer-messages.html',
  '/privacy.html', '/terms.html'];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- 1. the logo holds its box ---------------------------------------- */
  {
    const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
    ok('the logo states a width instead of leaving it auto',
      /\.header-logo-mark \{[^}]*width: 36px/.test(css) &&
      !/\.header-logo-mark \{[^}]*width: auto/.test(css));

    // domcontentloaded, NOT load: 'load' waits for the stalled image, so by the
    // time it resolved the logo had arrived and the check proved nothing.
    const { ctx, page } = await open(browser, '/index.html',
      { slowLogo: true, waitUntil: 'domcontentloaded' });
    // Before the file has arrived: the box must already be its final size.
    const early = await page.evaluate(() => {
      const el = document.querySelector('.header-logo-mark');
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), loaded: el.complete && el.naturalWidth > 0 };
    });
    ok('the logo box is 36x36 BEFORE the file loads',
      early.w === 36 && early.h === 36 && early.loaded === false, JSON.stringify(early));
    await page.waitForTimeout(900);
    const late = await page.evaluate(() => {
      const el = document.querySelector('.header-logo-mark');
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), nat: el.naturalWidth + 'x' + el.naturalHeight };
    });
    ok('and unchanged after it loads - the reservation is the real size, not a guess',
      late.w === 36 && late.h === 36, JSON.stringify(late));
    ok('the source really is square, so 36x36 is exact and not a crop',
      late.nat.split('x')[0] === late.nat.split('x')[1], late.nat);
    await ctx.close();
  }

  // The measurement that matters: stalling the logo must cost NOTHING.
  for (const path of LOGO_PAGES) {
    const normal = await minCls(browser, path, {});
    const stalled = await minCls(browser, path, { slowLogo: true });
    ok('a stalled logo adds no shift: ' + path, stalled - normal < 0.002,
      'normal ' + normal.toFixed(4) + ' vs stalled ' + stalled.toFixed(4));
  }

  /* ---- 2. the profile lines hold their space ----------------------------- */
  {
    const { ctx, page } = await open(browser, '/customer-dashboard.html',
      { dataDelay: 500, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => {
      const v = document.getElementById('profile-view');
      return {
        view: Math.round(v.getBoundingClientRect().height),
        lines: Array.from(v.querySelectorAll('p')).map((e) => Math.round(e.getBoundingClientRect().height)),
        filled: v.textContent.replace(/\s/g, '').replace('Edit', '').length
      };
    });
    ok('the profile lines are still EMPTY at this point - otherwise this proves nothing',
      before.filled === 0, JSON.stringify(before));
    ok('...yet each already holds a line', before.lines.every((h) => h > 0), JSON.stringify(before.lines));

    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => {
      const v = document.getElementById('profile-view');
      return {
        view: Math.round(v.getBoundingClientRect().height),
        lines: Array.from(v.querySelectorAll('p')).map((e) => Math.round(e.getBoundingClientRect().height))
      };
    });
    ok('the block does not grow when the values arrive',
      after.view === before.view, before.view + ' -> ' + after.view);
    ok('and every line kept its height', JSON.stringify(after.lines) === JSON.stringify(before.lines),
      JSON.stringify(before.lines) + ' -> ' + JSON.stringify(after.lines));
    await ctx.close();
  }

  // Sized in em so one rule fits both text sizes; check it holds at every width.
  for (const width of [320, 390, 1366]) {
    const { ctx, page } = await open(browser, '/customer-dashboard.html', { width: width });
    await page.waitForTimeout(900);
    const h = await page.evaluate(() =>
      Math.round(document.getElementById('profile-view').getBoundingClientRect().height));
    ok('the filled profile block is 144px @' + width, h === 144, String(h));
    await ctx.close();
  }

  /* ---- 3. .home-main is index.html's alone ------------------------------- */
  {
    const pages = fs.readdirSync(REPO).filter((f) => f.endsWith('.html'));
    const carriers = pages.filter((f) => /<main[^>]*class="[^"]*\bhome-main\b/.test(
      fs.readFileSync(REPO + f, 'utf8')));
    ok('only index.html carries home-main',
      carriers.length === 1 && carriers[0] === 'index.html', carriers.join(', '));

    // The reason it matters, asserted as geometry rather than as a class list:
    // the container must fill the page, not shrink to its contents.
    for (const path of ['/customer-tips.html', '/privacy.html', '/terms.html']) {
      const { ctx, page } = await open(browser, path);
      await page.waitForTimeout(900);
      const r = await page.evaluate(() => {
        const c = document.querySelector('main > .container');
        if (!c) return null;
        const b = c.getBoundingClientRect();
        return { x: Math.round(b.x), w: Math.round(b.width), vw: innerWidth };
      });
      ok('the container fills the page, not its contents: ' + path,
        r && r.x === 0 && r.w === r.vw, JSON.stringify(r));
      await ctx.close();
    }
  }

  /* ---- what is deliberately LEFT on the dashboard ----------------------- */
  //
  // The orders and bookings filter rows are built from the statuses actually
  // present, so they are empty until the data lands and then ~34px tall. That
  // is the residual 0.0103-0.0219 above.
  //
  // It is not reserved ON PURPOSE. A seller-less account - which is most of
  // them on a young marketplace - never gets any filter chips at all, so a
  // reservation would buy back a small shift for the few by leaving a dead
  // 34px gap for the many. Pinned here so it cannot quietly grow.
  {
    const worst = Math.max.apply(null, await Promise.all(
      [0, 1, 2, 3].map(() => cls(browser, '/customer-dashboard.html', {}))));
    ok('the dashboard\'s remaining shift stays small and known',
      worst < 0.03, worst.toFixed(4) + ' (was 0.0596 before the profile lines were reserved)');
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
