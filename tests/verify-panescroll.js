// The browse page's rail and product pane scroll past each other.
//
// The assertions that matter are the negative ones: scrolling the RAIL must
// leave the products where they were, and vice versa. A layout that merely
// looks right (both panes present, both with an overflow value) can still
// scroll as one lump, which is exactly the bug being fixed.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

// Enough tiles that the pane must overflow at any viewport under test.
const mk = (cat, i) => ({
  productId: `${cat}-${i}`, name: `${cat} item ${i}`, category: cat, description: 'x',
  imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store', island: 'South Tarawa', village: 'Bairiki',
  variants: [{ variantId: `v${cat}${i}`, label: '1kg', price: 5 + i }],
  rating: null, reviewCount: 0, views: i, createdAt: '2026-01-01'
});

async function open(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; let cat = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; cat = u.searchParams.get('category'); } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'searchProducts') {
      return J({ ok: true, products: Array.from({ length: 40 }, (_, i) => mk(cat || 'food', i)) });
    }
    if (a === 'listStores') return J({ ok: true, stores: [], hasMore: false, total: 0 });
    if (a === 'getTips') return J({ ok: true, tips: [] });
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(BASE + '/categories.html', { waitUntil: 'load' });
  await page.waitForSelector('.category-rail-item');
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}

const metrics = (page) => page.evaluate(() => {
  const rail = document.querySelector('.category-rail');
  const pane = document.querySelector('.category-pane');
  return {
    doc: window.scrollY,
    docScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
    railTop: rail.scrollTop, railScrollable: rail.scrollHeight > rail.clientHeight + 2,
    paneTop: pane.scrollTop, paneScrollable: pane.scrollHeight > pane.clientHeight + 2,
    railBottom: Math.round(rail.getBoundingClientRect().bottom),
    paneBottom: Math.round(pane.getBoundingClientRect().bottom),
    vh: window.innerHeight
  };
});

async function suite(browser, label, width, height) {
  const { ctx, page, errs } = await open(browser, width, height);
  // The list pages in 12 at a time (CATEGORY_PAGE_SIZE). Page it out so the
  // pane genuinely overflows - otherwise "does it scroll independently" is
  // answered by a pane that has nothing to scroll.
  for (let i = 0; i < 3; i++) {
    const more = page.locator('#category-more');
    if (await more.count() && await more.first().isVisible()) {
      await more.first().click();
      await page.waitForTimeout(200);
    }
  }
  // Clicking More… scrolls the button into view, which leaves the pane parked
  // at its maximum - measure from a known zero instead.
  await page.evaluate(() => {
    document.querySelector('.category-rail').scrollTop = 0;
    document.querySelector('.category-pane').scrollTop = 0;
  });
  await page.waitForTimeout(150);
  const m0 = await metrics(page);

  ok(`${label}: the document itself no longer scrolls`, !m0.docScrollable,
    `scrollHeight vs ${m0.vh}`);
  // The rail scrolls only when it overflows; on a tall tablet all fourteen
  // entries fit and a scrollbar would be wrong. What must hold either way is
  // that it never overflows its box unreachably - asserted just below.
  ok(`${label}: the rail either fits or has its own scroll box`,
    m0.railScrollable || m0.railBottom <= m0.vh + 1,
    m0.railScrollable ? 'scrolls' : 'fits');
  ok(`${label}: the products have their own scroll box`, m0.paneScrollable);

  // Both panes must END inside the viewport - if either overflows the bottom,
  // its scroll box is taller than the screen and the tail is unreachable with
  // the document locked.
  ok(`${label}: the rail ends on screen`, m0.railBottom <= m0.vh + 1, `${m0.railBottom} / ${m0.vh}`);
  ok(`${label}: the products end on screen`, m0.paneBottom <= m0.vh + 1, `${m0.paneBottom} / ${m0.vh}`);

  // --- the point of the change ---
  await page.locator('.category-rail').hover();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(250);
  const m1 = await metrics(page);
  ok(`${label}: scrolling the rail moves the rail`,
    m0.railScrollable ? m1.railTop > m0.railTop : m1.railTop === 0,
    m0.railScrollable ? `${m0.railTop} -> ${m1.railTop}` : 'rail fits, nothing to scroll');
  ok(`${label}: scrolling the rail leaves the products still`, m1.paneTop === m0.paneTop,
    `${m0.paneTop} -> ${m1.paneTop}`);
  ok(`${label}: scrolling the rail leaves the document still`, m1.doc === 0, String(m1.doc));

  await page.locator('.category-pane').hover();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(250);
  const m2 = await metrics(page);
  ok(`${label}: scrolling the products moves the products`, m2.paneTop > m1.paneTop,
    `${m1.paneTop} -> ${m2.paneTop}`);
  ok(`${label}: scrolling the products leaves the rail where the shopper left it`,
    m2.railTop === m1.railTop, `${m1.railTop} -> ${m2.railTop}`);
  ok(`${label}: scrolling the products leaves the document still`, m2.doc === 0, String(m2.doc));

  // The last rail entry must be reachable - the complaint that started this.
  const lastSeen = await page.evaluate(() => {
    const rail = document.querySelector('.category-rail');
    rail.scrollTop = rail.scrollHeight;
    const items = rail.querySelectorAll('.category-rail-item');
    const last = items[items.length - 1];
    const r = last.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    return { text: last.textContent.trim(), inside: r.bottom <= rr.bottom + 1 && r.top >= rr.top - 1 };
  });
  ok(`${label}: the last category can be scrolled into view`, lastSeen.inside, lastSeen.text);

  // Switching category returns the products to the top, but must NOT yank the
  // rail back - the shopper is reading the rail when they tap.
  await page.locator('.category-pane').hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(250);
  const before = await metrics(page);
  await page.locator('.category-rail-item').nth(3).click();
  await page.waitForTimeout(600);
  const after = await metrics(page);
  ok(`${label}: switching category puts the products back at the top`,
    before.paneTop > 0 && after.paneTop === 0, `${before.paneTop} -> ${after.paneTop}`);

  ok(`${label}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  await suite(browser, 'phone', 390, 844);
  await suite(browser, 'tablet', 768, 1024);
  await suite(browser, 'desktop', 1280, 800);
  await browser.close();

  /* ---------- scoping: no other page may inherit a locked document ---------- */
  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  const html = fs.readFileSync(REPO + 'categories.html', 'utf8');
  ok('categories.html is the page that opts in', /<body class="[^"]*browse-locked/.test(html));
  const others = fs.readdirSync(REPO).filter((f) => f.endsWith('.html') && f !== 'categories.html');
  const leaked = others.filter((f) => /browse-locked/.test(fs.readFileSync(REPO + f, 'utf8')));
  ok('no other page opts in', leaked.length === 0, leaked.join(','));

  // Every declaration in the block must be behind the class. An unscoped
  // `overflow: hidden` on body would freeze the whole site.
  const block = (css.match(/body\.browse-locked \{[\s\S]*?\n\}/) || [''])[0];
  ok('the locked body rule exists and is class-scoped', /^body\.browse-locked \{/.test(block), block.slice(0, 40));
  ok('it uses dvh with a vh fallback, in that order',
    /height: 100vh;\s*\n\s*height: 100dvh;/.test(block), block);
  ok('the rail rule turns sticky off inside the lock',
    /body\.browse-locked \.category-rail \{[\s\S]*?position: static/.test(css));
  ok('the rail keeps position: sticky for anyone NOT locked',
    /\.category-rail \{[\s\S]*?position: sticky/.test(css));
  ok('both panes get min-height: 0, without which they never scroll',
    /body\.browse-locked \.category-rail,\s*\n\s*body\.browse-locked \.category-pane \{[\s\S]*?min-height: 0/.test(css));

  const js = fs.readFileSync(REPO + 'assets/js/categories.js', 'utf8');
  ok('the reset targets the pane element, not the window',
    /\.category-pane'\);\s*\n\s*if \(pane\) pane\.scrollTop = 0;/.test(js) && !/window\.scrollTo\(0, 0\)/.test(js));

  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  const { execSync } = require('child_process');
  let mainCache = '';
  try {
    mainCache = (execSync('git -C ' + REPO + ' show origin/main:sw.js', { encoding: 'utf8' })
      .match(/CACHE = 'mwakete-v(\d+)'/) || [])[1];
  } catch (e) {}
  const mine = (sw.match(/CACHE = 'mwakete-v(\d+)'/) || [])[1];
  let changed = '';
  try { changed = execSync('git -C ' + REPO + ' diff --name-only origin/main', { encoding: 'utf8' }).trim(); } catch (e) {}
  if (changed) ok('CACHE bumped past main', Number(mine) > Number(mainCache), `${mainCache} -> ${mine}`);
  else ok('no CACHE bump owed - tree matches main', true);

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
