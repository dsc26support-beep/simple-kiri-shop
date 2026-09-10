const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

function mock(ctx) {
  return ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    let body = { ok: true };
    if (action === 'listProducts') body = { ok: true, storeName: 'Bong', storeIsland: 'South Tarawa', products: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

// Seed a cart of N distinct products (one line each) and run the resting-state
// applier, returning the button's classes + computed position.
const stateFor = (n) => {
  const cart = [];
  for (let i = 0; i < n; i++) cart.push({ variantId: 'v' + i, productId: 'P' + i, label: 'x', unitPrice: 1, qty: 1 });
  localStorage.setItem('skiri_cart_bong', JSON.stringify(cart));
  updateCartCount();
  const el = document.getElementById('cart-link');
  const cs = getComputedStyle(el);
  return {
    bold: el.classList.contains('cart-fab--bold'),
    corner: el.classList.contains('cart-fab--corner'),
    left: cs.left, right: cs.right, top: cs.top, bottom: cs.bottom,
    bg: cs.backgroundColor,
  };
};

const results = [];
const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // --- Main pass ---
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await mock(ctx);
  const page = await ctx.newPage();
  await page.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof currentSlug !== 'undefined' && currentSlug === 'bong', null, { timeout: 5000 });
  await page.exposeBinding; // noop guard
  await page.addScriptTag({ content: 'window.__stateFor = ' + stateFor.toString() + ';' });

  const s0 = await page.evaluate(() => window.__stateFor(0));
  const s1 = await page.evaluate(() => window.__stateFor(1));
  const s2 = await page.evaluate(() => window.__stateFor(2));

  const DEEP_BLUE = 'rgb(0, 63, 135)'; // --color-blue #003f87
  ok('empty: no bold, no corner', !s0.bold && !s0.corner, JSON.stringify(s0));
  ok('empty: resting bottom-left (bottom & left anchored 16px)', s0.bottom === '16px' && s0.left === '16px', `${s0.left}/${s0.bottom}`);
  ok('empty: NOT bold deep-blue bg', s0.bg !== DEEP_BLUE, s0.bg);
  ok('1 item: bold, not corner', s1.bold && !s1.corner, JSON.stringify(s1));
  ok('1 item: still bottom-left', s1.bottom === '16px' && s1.left === '16px', `${s1.left}/${s1.bottom}`);
  ok('1 item: background is deep brand blue', s1.bg === DEEP_BLUE, s1.bg);
  ok('2 items: bold AND corner', s2.bold && s2.corner, JSON.stringify(s2));
  ok('2 items: top-right (top & right anchored 16px)', s2.top === '16px' && s2.right === '16px', `T${s2.top} R${s2.right}`);
  ok('2 items: still deep brand blue', s2.bg === DEEP_BLUE, s2.bg);

  // Animation: crossing to 3 => flash2; further add at >=3 => blink
  const anim = await page.evaluate(() => {
    const el = document.getElementById('cart-link');
    window.__stateFor(3);                 // now 3 distinct in cart
    animateCartOnAdd(2, 3);               // just crossed 3
    const flash = el.classList.contains('cart-fab--flash2') && !el.classList.contains('cart-fab--blink');
    el.classList.remove('cart-fab--flash2', 'cart-fab--blink');
    window.__stateFor(4);                 // 4 distinct
    animateCartOnAdd(3, 4);               // already >=3
    const blink = el.classList.contains('cart-fab--blink') && !el.classList.contains('cart-fab--flash2');
    // below 3: no animation class
    el.classList.remove('cart-fab--flash2', 'cart-fab--blink');
    animateCartOnAdd(0, 1);
    const none = !el.classList.contains('cart-fab--flash2') && !el.classList.contains('cart-fab--blink');
    return { flash, blink, none };
  });
  ok('crossing to 3 items => flash2 (not blink)', anim.flash);
  ok('add at >=3 => single blink (not flash2)', anim.blink);
  ok('add below 3 => no flash/blink', anim.none);
  await ctx.close();

  // --- Reload/revert pass: 2 products pre-seeded before any script runs ---
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await mock(ctx2);
  const page2 = await ctx2.newPage();
  await page2.addInitScript(() => {
    try {
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([
        { variantId: 'v0', productId: 'P0', label: 'x', unitPrice: 1, qty: 1 },
        { variantId: 'v1', productId: 'P1', label: 'x', unitPrice: 1, qty: 1 },
      ]));
    } catch (e) {}
  });
  await page2.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await page2.waitForFunction(() => typeof currentSlug !== 'undefined' && currentSlug === 'bong', null, { timeout: 5000 });
  const reload = await page2.evaluate(() => {
    const el = document.getElementById('cart-link');
    return {
      bold: el.classList.contains('cart-fab--bold'),
      corner: el.classList.contains('cart-fab--corner'),
      anim: el.classList.contains('cart-fab--flash2') || el.classList.contains('cart-fab--blink'),
    };
  });
  ok('reload w/ 2 items: bold+corner on load, NO animation', reload.bold && reload.corner && !reload.anim, JSON.stringify(reload));
  await ctx2.close();

  // --- Reduced-motion pass ---
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' });
  await mock(ctx3);
  const page3 = await ctx3.newPage();
  await page3.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await page3.waitForFunction(() => typeof currentSlug !== 'undefined' && currentSlug === 'bong', null, { timeout: 5000 });
  const rm = await page3.evaluate(() => {
    const el = document.getElementById('cart-link');
    el.classList.add('cart-fab--flash2');
    const animName = getComputedStyle(el).animationName;
    el.classList.remove('cart-fab--flash2');
    el.classList.add('cart-fab--bold', 'cart-fab--corner');
    const cs = getComputedStyle(el);
    return { animName, bg: cs.backgroundColor, top: cs.top, right: cs.right };
  });
  ok('reduced-motion: flash animation is none', rm.animName === 'none', rm.animName);
  ok('reduced-motion: bold/corner static still apply',
    rm.bg === 'rgb(0, 63, 135)' && rm.top === '16px' && rm.right === '16px', JSON.stringify(rm));
  await ctx3.close();

  await browser.close();
  let failed = 0;
  console.log('\n--- Cart FAB reactive states ---');
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
