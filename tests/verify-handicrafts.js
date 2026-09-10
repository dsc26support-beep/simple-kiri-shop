// "Handicrafts & Souvenirs" - the new category.
//
// Two halves. The first is static: the id must exist on BOTH sides of the wire
// (helpers.js and Products.gs) or a seller files a mat and the backend maps it
// straight to 'other' on the way back out - silently, because categoryIdOf's
// fallback is deliberately quiet. The second is live: what a shopper and a
// seller actually see.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const fe = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
const be = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');

/* ---------- static: the id exists on both sides ---------- */
ok('frontend taxonomy carries the id', /id: 'handicrafts'/.test(fe));
ok('backend CATEGORY_IDS carries the id', /CATEGORY_IDS[\s\S]*?'handicrafts'[\s\S]*?\];/.test(be));

// The whole point of the shared list. A value the backend does not recognise
// falls through categoryIdOf to 'other' without an error anywhere.
const beIds = (be.match(/var CATEGORY_IDS = \[([\s\S]*?)\];/) || [])[1] || '';
const feIds = (fe.match(/const CATEGORIES = \[([\s\S]*?)\n\];/) || [])[1] || '';
const feIdList = [...feIds.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
const beIdList = [...beIds.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
ok('the two id lists are identical, in the same order',
  JSON.stringify(feIdList) === JSON.stringify(beIdList),
  `fe ${feIdList.length} / be ${beIdList.length}`);

/* ---------- static: the shape of the entry ---------- */
const row = (fe.match(/\{ id: 'handicrafts'[^\n]*\}/) || [''])[0];
ok('label reads "Handicrafts & Souvenirs"', /label: 'Handicrafts & Souvenirs'/.test(row), row);
ok('it is active', /active: true/.test(row), row);
ok('it is NOT popular, so the homepage strip is unchanged', /popular: false/.test(row), row);
ok('product is the only listing type offered', /types: \['product'\]/.test(row), row);

// Adjacency was the design decision, not an accident - assert it rather than
// leaving it to a comment.
ok('it sorts immediately after Agriculture',
  feIdList[feIdList.indexOf('agriculture') + 1] === 'handicrafts', feIdList.join(','));
ok('Other is still last', feIdList[feIdList.length - 1] === 'other', feIdList.join(','));

/* ---------- static: nothing was removed ---------- */
for (const id of ['food', 'fashion', 'electronics', 'home', 'building', 'vehicles',
  'fishing', 'agriculture', 'property', 'services', 'education', 'events', 'other']) {
  ok(`existing category '${id}' survives`, feIdList.includes(id) && beIdList.includes(id));
}
// order is a display sort key only. If it were ever stored on a row, shifting
// property/services/education/events would have rewritten live data.
ok('order is never persisted - it is only a sort key',
  /\.sort\(\(a, b\) => a\.order - b\.order\)/.test(fe) && !/Order:/.test(be.slice(0, 4000)));

/* ---------- static: the no-photo swatch ---------- */
ok('the placeholder swatch has a colour', /\.placeholder-swatch\.category-handicrafts \{/.test(css));
const hex = (css.match(/\.placeholder-swatch\.category-handicrafts \{ background: (#[0-9a-f]{6})/) || [])[1];
// Count swatch rules only. The colour appearing elsewhere in the sheet is
// fine; two CATEGORIES sharing one swatch is not, because the swatch is the
// only thing telling two photo-less listings apart.
const swatchHexes = [...css.matchAll(/\.placeholder-swatch\.category-[a-z]+ \{ background: (#[0-9a-f]{6}|var\(--[a-z-]+\))/g)]
  .map((m) => m[1]);
ok('and no other category swatch uses it',
  hex && swatchHexes.filter((h) => h === hex).length === 1, `${hex} x${swatchHexes.filter((h) => h === hex).length}`);

/* ---------- live ---------- */
const mk = (i) => ({
  productId: `h-${i}`, name: `pandanus mat ${i}`, category: 'handicrafts', description: 'woven',
  imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store', island: 'South Tarawa', village: 'Bairiki',
  variants: [{ variantId: `vh${i}`, label: 'Large', price: 20 + i }],
  rating: null, reviewCount: 0, views: i, createdAt: '2026-01-01'
});

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const asked = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = ''; let cat = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; cat = u.searchParams.get('category'); } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'searchProducts') {
      asked.push(cat);
      const n = cat === 'handicrafts' ? 3 : 0;
      return J({ ok: true, products: Array.from({ length: n }, (_, i) => mk(i)) });
    }
    if (a === 'listStores') return J({ ok: true, stores: [], hasMore: false, total: 0 });
    if (a === 'getHomePageData') return J({ ok: true, products: [], stores: [] });
    if (a === 'getTips') return J({ ok: true, tips: [] });
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return { ctx, page, errs, asked };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Browse page: the chip is on the rail, and choosing it queries the backend
  // with the id the backend now knows.
  {
    const { ctx, page, errs, asked } = await open(browser, '/categories.html');
    const chip = page.locator('#category-rail [data-category="handicrafts"]');
    ok('browse rail shows the chip', await chip.count() === 1);
    ok('chip reads its full label', (await chip.first().innerText()).includes('Handicrafts'),
      await chip.first().innerText().catch(() => ''));
    await chip.first().click();
    await page.waitForTimeout(600);
    ok('choosing it asks the backend for category=handicrafts', asked.includes('handicrafts'), asked.join(','));
    const tiles = await page.locator('#category-list a[href*="product.html"]').count();
    ok('its listings render', tiles >= 3, String(tiles));
    ok('no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // Homepage: NOT popular means it must NOT be on the strip - that was the
  // explicit choice, so a later `popular: true` slip should fail here.
  {
    const { ctx, page, errs } = await open(browser, '/index.html');
    const onStrip = await page.locator('#category-strip [data-category="handicrafts"]').count();
    ok('homepage strip does NOT show it', onStrip === 0, String(onStrip));
    const stripCount = await page.locator('#category-strip .chip-strip-item').count();
    ok('homepage strip still renders its popular chips', stripCount >= 6, String(stripCount));
    ok('no page errors on the homepage', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // Search page: reachable by URL, which is how the browse chip links out.
  {
    const { ctx, page, errs, asked } = await open(browser, '/search.html?category=handicrafts');
    await page.waitForTimeout(600);
    ok('search page accepts it as a category', asked.includes('handicrafts'), asked.join(','));
    ok('no page errors on search', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();

  // The APP_VERSION guard, conditional: a .gs change owes a bump, a
  // frontend-only branch owes nothing. Unconditional, this rots on merge.
  const { execSync } = require('child_process');
  let changed = '';
  try {
    changed = execSync('git -C ' + REPO + ' diff --name-only origin/main -- apps-script/', { encoding: 'utf8' }).trim();
  } catch (e) {}
  if (changed) {
    const mine = (fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8').match(/APP_VERSION = '([^']+)'/) || [])[1];
    let theirs = '';
    try {
      theirs = (execSync('git -C ' + REPO + ' show origin/main:apps-script/Code.gs', { encoding: 'utf8' })
        .match(/APP_VERSION = '([^']+)'/) || [])[1];
    } catch (e) {}
    ok('an Apps Script change bumps APP_VERSION', mine !== theirs, `${theirs} -> ${mine}`);
  } else {
    ok('no APP_VERSION bump owed - no .gs file differs from main', true);
  }

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
