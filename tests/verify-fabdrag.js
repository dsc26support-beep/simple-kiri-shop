// A draggable chat button, similar-products carousel, and the store link.
//
// The assertion that matters most is the boring one: a TAP must still open the
// chat. A drag implementation that swallows taps is worse than no drag at all,
// because chatting with the store is how orders actually get placed here.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const mk = (id, cat) => ({
  productId: id, name: 'Item ' + id, category: cat || 'food', description: 'tasty',
  listingType: 'product', imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store',
  storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + id, label: 'small', price: 8 }],
  rating: null, reviewCount: 0, views: 1, createdAt: '2026-01-01'
});

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 390, height: 844 },
    hasTouch: true
  });
  const calls = [];
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; let cat = null;
    try {
      const u = new URL(r.request().url());
      a = u.searchParams.get('action') || ''; cat = u.searchParams.get('category');
    } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    calls.push(a);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listProducts') {
      return J({ ok: true, storeName: 'Bong Store', storeOpen: true, storePhone: '73007552',
        storeDeliveryPickPay: true, products: [mk('p1'), mk('p2')] });
    }
    if (a === 'searchProducts') {
      const n = opts.relatedCount === undefined ? 6 : opts.relatedCount;
      return J({ ok: true, products: [mk('p1')].concat(
        Array.from({ length: n }, (_, i) => mk('r' + i))) });
    }
    if (a === 'listProductReviews') return J({ ok: true, reviews: [], average: null, count: 0, distribution: [0,0,0,0,0] });
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + '/product.html?store=bong&product=p1', { waitUntil: 'load' });
  await page.waitForSelector('#chat-fab');
  await page.waitForTimeout(1400);
  return { ctx, page, errs, calls };
}

// Open is .chat-window--open plus aria-expanded on the button - NOT `hidden`.
// Checking `hidden` returns true whether the chat is open or shut, which made
// the tap assertion below pass without proving anything.
const isChatOpen = (page) => page.evaluate(() => {
  const w = document.getElementById('chat-window');
  const f = document.getElementById('chat-fab');
  return !!w && w.classList.contains('chat-window--open')
    && f.getAttribute('aria-expanded') === 'true';
});

const box = (page) => page.evaluate(() => {
  const r = document.getElementById('chat-fab').getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
           bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
           vw: window.innerWidth, vh: window.innerHeight };
});

// A real gesture: press, several moves, release. One big jump would not
// exercise the threshold, which is the thing being tested.
async function drag(page, toX, toY) {
  const b = await box(page);
  const fromX = b.left + b.w / 2;
  const fromY = b.top + b.h / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(fromX + (toX - fromX) * i / 8, fromY + (toY - fromY) * i / 8);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- the button still works as a button ---------- */
  {
    const { ctx, page, errs } = await open(browser);
    const before = await box(page);
    // A tap with a tiny wobble, under the threshold - a real thumb, not a robot.
    await page.mouse.move(before.left + before.w / 2, before.top + before.h / 2);
    await page.mouse.down();
    await page.mouse.move(before.left + before.w / 2 + 3, before.top + before.h / 2 + 2);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const chatOpen = await isChatOpen(page);
    ok('a tap still opens the chat', chatOpen, 'chat did not open');
    const after = await box(page);
    ok('and a tap does NOT move the button',
      after.left === before.left && after.top === before.top, JSON.stringify({ before, after }));
    ok('no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- dragging ---------- */
  {
    const { ctx, page } = await open(browser);
    const before = await box(page);
    await drag(page, 60, 300);
    const after = await box(page);
    ok('dragging moves the button', after.left !== before.left || after.top !== before.top,
      JSON.stringify({ before, after }));
    ok('on release it snaps to the nearer side (left here)',
      after.left < after.vw / 2 - after.w, JSON.stringify(after));
    ok('it stays fully on screen',
      after.left >= 0 && after.right <= after.vw && after.top >= 0 && after.bottom <= after.vh,
      JSON.stringify(after));

    // A drag must NOT be read as "open the chat".
    ok('a drag does NOT open the chat', !(await isChatOpen(page)), 'chat opened on a drag');
    await ctx.close();
  }

  /* ---------- it must never hide under the bottom nav ---------- */
  {
    const { ctx, page } = await open(browser);
    await drag(page, 200, 900);   // aim below the bottom of the screen
    const after = await box(page);
    const navTop = await page.evaluate(() => {
      const n = document.querySelector('.bottom-nav');
      return n ? Math.round(n.getBoundingClientRect().top) : window.innerHeight;
    });
    ok('dragged to the bottom, it stops above the bottom nav',
      after.bottom <= navTop + 1, `fab bottom ${after.bottom} vs nav top ${navTop}`);
    await ctx.close();
  }

  /* ---------- the position is remembered ---------- */
  {
    const { ctx, page } = await open(browser);
    await drag(page, 60, 400);
    const moved = await box(page);
    const saved = await page.evaluate(() => localStorage.getItem('mwakete_fab_pos'));
    ok('the position is saved', !!saved && /left|right/.test(saved), String(saved));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#chat-fab');
    await page.waitForTimeout(900);
    const restored = await box(page);
    ok('and restored on the next visit',
      Math.abs(restored.left - moved.left) <= 2 && Math.abs(restored.bottom - moved.bottom) <= 2,
      JSON.stringify({ moved, restored }));
    await ctx.close();
  }

  /* ---------- a saved position from a taller screen must not strand it ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 500 }, hasTouch: true });
    await ctx.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      // As if saved on a much taller phone.
      localStorage.setItem('mwakete_fab_pos', JSON.stringify({ side: 'left', bottom: 2000 }));
    });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, storeName: 'Bong', storeOpen: true, products: [], reviews: [] }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/product.html?store=bong&product=p1', { waitUntil: 'load' });
    await page.waitForSelector('#chat-fab');
    await page.waitForTimeout(700);
    const b = await box(page);
    ok('a position saved on a taller screen is re-clamped, not left off-screen',
      b.top >= 0 && b.bottom <= b.vh, JSON.stringify(b));
    await ctx.close();
  }

  /* ---------- similar products ---------- */
  {
    const { ctx, page, calls, errs } = await open(browser);
    const section = page.locator('#related-section');
    ok('the carousel appears', await section.isVisible(), 'hidden');
    const cards = page.locator('#related-list .related-card');
    ok('it shows the other products', await cards.count() === 6, String(await cards.count()));
    const hasSelf = await page.evaluate(() =>
      !!document.querySelector('#related-list a[href*="product=p1"]'));
    ok('and never the product being viewed', !hasSelf, 'the current product is in its own carousel');

    ok('it cost exactly one extra request',
      calls.filter((c) => c === 'searchProducts').length === 1, calls.join(','));

    const scrolls = await page.evaluate(() => {
      const el = document.getElementById('related-list');
      return { scrollable: el.scrollWidth > el.clientWidth + 2, overflow: getComputedStyle(el).overflowX };
    });
    ok('it scrolls sideways rather than wrapping', scrolls.scrollable && scrolls.overflow === 'auto',
      JSON.stringify(scrolls));
    const pageOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > window.innerWidth + 1);
    ok('and does not make the page scroll sideways', !pageOverflow, 'page overflows');
    ok('no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- an empty shelf must not appear ---------- */
  {
    const { ctx, page } = await open(browser, { relatedCount: 0 });
    ok('with nothing similar, the heading stays off the page',
      await page.locator('#related-section').isHidden(), 'empty carousel shown');
    await ctx.close();
  }

  /* ---------- order on the page ---------- */
  {
    const { ctx, page } = await open(browser);
    const order = await page.evaluate(() => {
      const y = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect().top + window.scrollY : null;
      };
      return { detail: y('#product-detail'), related: y('#related-section'),
               reviews: y('#reviews-section'), store: y('#view-store-link') };
    });
    ok('similar products sit under the buy box', order.related > order.detail,
      JSON.stringify(order));
    ok('and above the reviews', order.related < order.reviews, JSON.stringify(order));
    ok('the store link stays directly beneath the reviews', order.store > order.reviews,
      JSON.stringify(order));
    const inline = fs.readFileSync(REPO + 'product.html', 'utf8');
    ok('the store link no longer carries an inline margin',
      !/id="view-store-link"[\s\S]{0,80}style=/.test(inline)
      && /class="view-store-row"/.test(inline));
    await ctx.close();
  }

  await browser.close();

  /* ---------- wiring ---------- */
  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  ok('fab-drag.js is precached', /assets\/js\/fab-drag\.js/.test(sw));
  ['cart.html', 'checkout.html', 'product.html', 'store.html'].forEach((f) => {
    const h = fs.readFileSync(REPO + f, 'utf8');
    ok(`${f} has a chat button and loads the drag script`,
      /id="chat-fab"/.test(h) && /fab-drag\.js/.test(h));
  });
  const drag_js = fs.readFileSync(REPO + 'assets/js/fab-drag.js', 'utf8');
  // Check each call site individually. A private window, cleared site data, or
  // a browser set to block storage makes the ACCESSOR ITSELF throw, so an
  // unguarded call takes the whole script - and with it the chat button - down.
  const unguarded = drag_js.split(/localStorage\./).slice(0, -1)
    .filter((before) => !/try\s*\{[^}]*$/.test(before.split('\n').slice(-4).join('\n')));
  // Split on `localStorage.` so the word appearing in a comment is not counted.
  ok('every localStorage access is inside a try', unguarded.length === 0,
    `${unguarded.length} unguarded`);

  const { execSync } = require('child_process');
  let gs = '';
  try { gs = execSync('git -C ' + REPO + ' diff --name-only origin/main -- apps-script/', { encoding: 'utf8' }).trim(); } catch (e) {}
  ok('no backend change', gs === '', gs);

  let pass = 0;
  for (const [s, n, e] of R) { if (s === 'PASS') pass++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
