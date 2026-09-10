// Part 1: the one "Show More" renamed and re-homed above the Account tab.
// Part 2: yellow stars, purple rating numbers.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCTS = Array.from({ length: 30 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: 'pantry', storeSlug: 'bong',
  storeName: 'Bong', imageUrl: '', variants: [{ variantId: 'v' + i, label: '1kg', price: 5 }],
  rating: 4.3, reviewCount: 12
}));

async function open(browser, path, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: PRODUCTS, stores: [], tips: [], conversations: [],
      storeName: 'Bong', storeOpen: true, reviews: [], average: 4.3, count: 12, distribution: [1, 1, 2, 3, 5],
      product: Object.assign({}, PRODUCTS[0], { description: 'x' }),
      store: { storeName: 'Bong', storeSlug: 'bong', isOpen: true, deliveryPickPay: true } }) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + '/' + path, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  return { ctx, page };
}

const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const PURPLE = [51, 45, 99];   // --color-purple #332d63
const GOLD = [252, 209, 22];   // --color-gold  #fcd116

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- there is still exactly ONE of these buttons ----
  const html = fs.readFileSync('/home/user/simple-kiri-shop/categories.html', 'utf8');
  ok('label reads "More…"', /id="category-more"[^>]*>More…</.test(html), (html.match(/id="category-more".{0,60}/) || [])[0]);
  ok('the old "Show More" wording is gone from the tree',
    !fs.readdirSync('/home/user/simple-kiri-shop').some((f) => f.endsWith('.html') &&
      /Show More/.test(fs.readFileSync('/home/user/simple-kiri-shop/' + f, 'utf8'))));

  // ---- mobile: in the nav, above Account, not overlapping ----
  {
    const { ctx, page } = await open(browser, 'categories.html', 390);
    await page.waitForSelector('.category-tile');
    const m = await page.evaluate(() => {
      const btn = document.getElementById('category-more');
      const slot = document.getElementById('bottom-nav-more-slot');
      const items = [...document.querySelectorAll('.bottom-nav-item')];
      const account = items[items.length - 1];
      const b = btn.getBoundingClientRect(), a = account.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
      return {
        count: document.querySelectorAll('#category-more, .load-more-row button').length,
        inSlot: btn.parentElement === slot,
        hidden: btn.hidden,
        text: btn.textContent,
        accountLabel: account.querySelector('.bottom-nav-label').textContent,
        // Above the Account tab: horizontally centred on it, vertically clear of it.
        overlapsAccount: !(b.bottom <= a.top || b.top >= a.bottom || b.right <= a.left || b.left >= a.right),
        aboveNav: b.bottom <= nav.top + 1,
        centredOnAccount: Math.abs((b.left + b.right) / 2 - (a.left + a.right) / 2) < 12,
        onScreen: b.left >= 0 && b.right <= window.innerWidth && b.top >= 0,
        navItems: items.length
      };
    });
    ok('still exactly one More button in the document', m.count === 1, String(m.count));
    ok('it lives in the nav slot on mobile', m.inSlot, JSON.stringify(m));
    ok('the tab it sits over is Account', m.accountLabel === 'Account', m.accountLabel);
    ok('it does NOT overlap the Account icon', m.overlapsAccount === false, JSON.stringify(m));
    ok('it sits entirely above the nav bar', m.aboveNav, JSON.stringify(m));
    ok('it is centred over the Account tab', m.centredOnAccount, JSON.stringify(m));
    ok('it is fully on screen', m.onScreen, JSON.stringify(m));
    ok('label is More…', m.text.trim() === 'More…', m.text);
    ok('5 nav tabs, unchanged', m.navItems === 5, String(m.navItems));

    // The paging it drives must still work from its new home.
    const before = await page.evaluate(() => document.querySelectorAll('.category-tile').length);
    await page.click('#category-more');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelectorAll('.category-tile').length);
    ok('clicking it still pages the list', after > before, `${before} -> ${after}`);

    // And it still disappears at the end of the list, as it always did.
    await page.click('#category-more');
    await page.waitForTimeout(300);
    const end = await page.evaluate(() => ({
      n: document.querySelectorAll('.category-tile').length,
      hidden: document.getElementById('category-more').hidden
    }));
    ok('it hides once everything is shown', end.n === 30 && end.hidden === true, JSON.stringify(end));
    await ctx.close();
  }

  // ---- desktop: the bar is display:none, so the button stays in the page ----
  {
    const { ctx, page } = await open(browser, 'categories.html', 1100);
    await page.waitForSelector('.category-tile');
    const d = await page.evaluate(() => {
      const btn = document.getElementById('category-more');
      const b = btn.getBoundingClientRect();
      return {
        inPage: !!btn.closest('.load-more-row'),
        navShown: getComputedStyle(document.querySelector('.bottom-nav')).display !== 'none',
        visible: b.width > 0 && b.height > 0,
        text: btn.textContent.trim()
      };
    });
    ok('bottom nav is hidden on desktop (unchanged)', d.navShown === false, JSON.stringify(d));
    ok('so the button stays in the page and remains usable', d.inPage && d.visible, JSON.stringify(d));
    ok('same label on desktop', d.text === 'More…', d.text);

    // Rotating/resizing across the breakpoint re-homes it rather than losing it.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(250);
    const afterResize = await page.evaluate(() => {
      const btn = document.getElementById('category-more');
      return { inSlot: btn.parentElement === document.getElementById('bottom-nav-more-slot'),
               count: document.querySelectorAll('#category-more').length };
    });
    ok('resizing to phone width moves it into the nav', afterResize.inSlot, JSON.stringify(afterResize));
    ok('and never clones it', afterResize.count === 1, String(afterResize.count));
    await ctx.close();
  }

  // ---- the slot is inert on every other page ----
  {
    const { ctx, page } = await open(browser, 'index.html', 390);
    const inert = await page.evaluate(() => {
      const slot = document.getElementById('bottom-nav-more-slot');
      if (!slot) return { missing: true };
      const r = slot.getBoundingClientRect();
      return { children: slot.children.length, h: Math.round(r.height),
               pe: getComputedStyle(slot).pointerEvents };
    });
    ok('slot exists but is empty elsewhere', inert.children === 0, JSON.stringify(inert));
    ok('an empty slot takes no clicks', inert.pe === 'none', JSON.stringify(inert));
    await ctx.close();
  }

  // ---- colours ----
  {
    const { ctx, page } = await open(browser, 'product.html?store=bong&product=p0', 390);
    // The reviews block is a <details> that starts shut (PR #28), so everything
    // inside it is invisible until opened. Opened here so the assertions below
    // stay about what they were written for; verify-reviewsfold.js owns the
    // folding behaviour.
    await page.evaluate(() => {
      const d = document.getElementById('reviews-section');
      if (d) d.open = true;
    });
    await page.waitForTimeout(200);
    await page.waitForSelector('.rating-stars-fill, .reviews-average-value');
    const c = await page.evaluate(() => {
      const g = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : null; };
      const revText = document.querySelector('.review-body, .review-text, .reviews-list p');
      return {
        starsFill: g('.rating-stars-fill'),
        starsEmpty: g('.rating-stars-empty') || g('.rating-stars'),
        ratingValue: g('.rating-value'),
        avgValue: g('.reviews-average-value'),
        barNum: g('.rating-bar-star-num'),
        barStar: g('.rating-bar-star'),
        reviewText: revText ? getComputedStyle(revText).color : null
      };
    });
    ok('stars are yellow', JSON.stringify(rgb(c.starsFill)) === JSON.stringify(GOLD), c.starsFill);
    ok('the score beside the stars is Mwakete purple',
      JSON.stringify(rgb(c.ratingValue)) === JSON.stringify(PURPLE), c.ratingValue);
    ok('the big average is Mwakete purple',
      JSON.stringify(rgb(c.avgValue)) === JSON.stringify(PURPLE), c.avgValue);
    ok('distribution row digits are purple',
      JSON.stringify(rgb(c.barNum)) === JSON.stringify(PURPLE), c.barNum);
    ok('distribution row stars are yellow',
      JSON.stringify(rgb(c.barStar)) === JSON.stringify(GOLD), c.barStar);
    ok('unfilled stars keep their old grey (not recoloured)',
      JSON.stringify(rgb(c.starsEmpty)) !== JSON.stringify(GOLD), c.starsEmpty);
    await ctx.close();
  }

  // The purple must be the token already in :root, not a new shade.
  const css = fs.readFileSync('/home/user/simple-kiri-shop/assets/css/styles.css', 'utf8');
  ok('purple comes from the existing --color-purple token, not a literal',
    /\.rating-value \{[^}]*var\(--color-purple\)/.test(css) &&
    /\.reviews-average-value \{[^}]*var\(--color-purple\)/.test(css));
  ok('no new purple hex was invented',
    (css.match(/#332d63/gi) || []).length === 1, String((css.match(/#332d63/gi) || []).length));

  await browser.close();
  let f = 0;
  console.log('\n--- More… relocation + rating colours ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
