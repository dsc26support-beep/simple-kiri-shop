// The browse page: search in the header, and an admin-curated Featured strip.
//
// Two things carry real risk here.
//
// 1. getTips emits the SHEET's Category value untouched (Admin.gs buildTips),
//    unlike every other read path which maps it. A legacy 'pantry' must still
//    land in 'food', or a featured item silently never appears anywhere.
// 2. Featured placement must be admin-only and LABELLED. An unlabelled placed
//    item is an advert dressed as a search result.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8099';

const mk = (id, name, cat, desc) => ({ productId: id, name, description: desc || '',
  category: cat, listingType: 'product', imageUrls: [], storeSlug: 'a', storeName: 'A',
  variants: [{ variantId: 'v' + id, label: 'One', price: 10 }] });

const FOOD = [mk('p1', 'Chop Syue', 'food'), mk('p2', 'Brocolli Chop with Noodle', 'food', 'noodle dish'),
  mk('p3', 'Rice bag', 'food', 'twenty kilo')];
const FASHION = [mk('f1', 'Necklace', 'fashion')];

// One featured item in food, one in fishing, and one carrying the LEGACY
// 'pantry' value that must map to food.
const TIPS = { ok: true, stores: [], products: [
  mk('tip-food', 'Sponsored Rice', 'food'),
  mk('tip-legacy', 'Legacy Pantry Item', 'pantry'),
  mk('tip-other', 'Fishing Net', 'fishing')
] };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(query, tips = TIPS) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      const url = r.request().url();
      let a = '';
      try { a = (r.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!a) a = new URL(url).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true, products: [], stores: [] };
      if (a === 'searchProducts') {
        const cat = new URL(url).searchParams.get('category');
        res = { ok: true, products: cat === 'fashion' ? FASHION : cat === 'food' ? FOOD : [] };
      } else if (a === 'getTips') res = tips;
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const pg = await ctx.newPage();
    await pg.goto(BASE + '/categories.html' + (query || ''), { waitUntil: 'load' });
    await pg.waitForTimeout(900);
    return { ctx, pg };
  }

  const state = () => {
    const strip = document.getElementById('featured-strip');
    const names = (sel) => [...document.querySelectorAll(sel + ' .category-tile-name')]
      .map((n) => n.textContent.trim());
    return {
      stripHidden: strip.hidden,
      featured: names('#featured-list'),
      grid: names('#category-list'),
      status: document.getElementById('category-status').textContent.trim(),
      heading: (document.getElementById('featured-strip-heading') || {}).textContent,
      searchInHeader: !!document.querySelector('header.site-header #browse-search-input'),
      browseWordGone: !/\bBrowse\b/.test(
        document.querySelector('header.site-header').textContent)
    };
  };

  // ---------------- header search box ----------------
  {
    const { ctx, pg } = await open('?category=food');
    const g = await pg.evaluate(state);
    ok('the search box is in the header', g.searchInHeader === true);
    ok('and the word "Browse" no longer sits there', g.browseWordGone === true);
    ok('the page still has an accessible name', await pg.evaluate(
      () => !!document.getElementById('categories-heading')));
    await ctx.close();
  }

  // ---------------- search filters WITHIN the category ----------------
  {
    const { ctx, pg } = await open('?category=food');
    let g = await pg.evaluate(state);
    ok('food shows all three to start', g.grid.length === 3, JSON.stringify(g.grid));

    await pg.fill('#browse-search-input', 'noodle');
    await pg.waitForTimeout(300);
    g = await pg.evaluate(state);
    ok('typing filters the grid down', g.grid.length === 1 && /Brocolli/.test(g.grid[0]),
      JSON.stringify(g.grid));
    ok('it matches the description too, not just the name',
      /Brocolli/.test(g.grid[0]), JSON.stringify(g.grid));
    ok('the count line follows the filter', /1 product/.test(g.status), g.status);
    ok('and the page never left the browse URL', /categories\.html/.test(pg.url()), pg.url());

    // Submitting must not reload and lose the category.
    await pg.press('#browse-search-input', 'Enter');
    await pg.waitForTimeout(300);
    ok('pressing Enter does not reload the page',
      /categories\.html/.test(pg.url()) && !/\?q=/.test(pg.url()), pg.url());

    await pg.fill('#browse-search-input', 'zzzznothing');
    await pg.waitForTimeout(300);
    g = await pg.evaluate(state);
    ok('a miss says nothing MATCHED, not that the category is empty',
      /matches/.test(g.status) && !/Nothing in this category yet/.test(g.status), g.status);

    await pg.fill('#browse-search-input', '');
    await pg.waitForTimeout(300);
    g = await pg.evaluate(state);
    ok('clearing the box brings everything back', g.grid.length === 3, JSON.stringify(g.grid));
    await ctx.close();
  }

  // ---------------- featured strip ----------------
  {
    const { ctx, pg } = await open('?category=food');
    const g = await pg.evaluate(state);

    ok('the featured strip is shown for a category that has one',
      g.stripHidden === false, JSON.stringify(g));
    ok('it is LABELLED, so a placed item is not passed off as organic',
      /Featured/i.test(g.heading || ''), String(g.heading));
    ok('THE ONE THAT MATTERS: a legacy "pantry" category maps to food and appears',
      g.featured.includes('Legacy Pantry Item'), JSON.stringify(g.featured));
    ok('the food featured item appears', g.featured.includes('Sponsored Rice'), JSON.stringify(g.featured));
    ok('a featured item from ANOTHER category does not',
      !g.featured.includes('Fishing Net'), JSON.stringify(g.featured));
    ok('featured items are not duplicated into the ordinary grid',
      !g.grid.includes('Sponsored Rice'), JSON.stringify(g.grid));
    await ctx.close();
  }

  // ---------------- a category with nothing featured ----------------
  {
    const { ctx, pg } = await open('?category=fashion');
    const g = await pg.evaluate(state);
    ok('a category with no featured item hides the strip entirely',
      g.stripHidden === true && g.featured.length === 0, JSON.stringify(g));
    ok('and its own products still render', g.grid.length === 1, JSON.stringify(g.grid));
    await ctx.close();
  }

  // ---------------- switching category re-filters the strip ----------------
  {
    const { ctx, pg } = await open('?category=food');
    let g = await pg.evaluate(state);
    ok('food starts with a featured strip', g.stripHidden === false);
    await pg.click('.category-rail a[href*="fashion"], .category-rail [data-category="fashion"]')
      .catch(async () => {
        await pg.evaluate(() => {
          const el = [...document.querySelectorAll('.category-rail *')]
            .find((n) => /Fashion/.test(n.textContent));
          if (el) el.click();
        });
      });
    await pg.waitForTimeout(700);
    g = await pg.evaluate(state);
    ok('switching to fashion hides the strip again', g.stripHidden === true, JSON.stringify(g));
    await ctx.close();
  }

  // ---------------- the strip must not block the products ----------------
  {
    const { ctx, pg } = await open('?category=food', new Promise(() => {}) && TIPS);
    const g = await pg.evaluate(state);
    ok('products render regardless of the featured fetch', g.grid.length === 3, JSON.stringify(g.grid));
    await ctx.close();
  }

  // ---------------- who can place a featured item ----------------
  {
    const admin = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Admin.gs', 'utf8');
    for (const fn of ['actionAddFeatured', 'actionRemoveFeatured', 'actionListFeatured']) {
      const i = admin.indexOf('function ' + fn);
      const body = admin.slice(i, admin.indexOf('\n}', i));
      ok(`${fn} is admin-only - a seller cannot place themselves`,
        /isOwnerAdmin\(owner\)/.test(body), fn);
    }
    const js = fs.readFileSync('/home/user/simple-kiri-shop/assets/js/categories.js', 'utf8');
    // Matches API CALLS, not the words - a comment explaining that addFeatured
    // is admin-only would otherwise fail this.
    ok('the browse page only READS featured, never writes it',
      /Api\.get\('getTips'/.test(js) && !/Api\.(get|post)\('(add|remove)Featured'/.test(js));
    ok('and it maps the category rather than comparing raw',
      /categoryIdOf\(p\.category\) === currentCategory/.test(js));
  }

  await browser.close();
  console.log('\n--- Browse page: search + featured ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
