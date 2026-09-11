// The cart FAB's top-right "corner" variant, at 2+ items.
//
// It sets `bottom: auto` because it lives at the TOP of the screen. The mobile
// rule that lifts floating buttons above the bottom nav bar is more specific
// (0,3,1 vs 0,2,0), so it put `bottom` back - and a fixed element with both
// `top` and `bottom` resolved stretches between them. The 133x48 pill became a
// 133x760 blue column down the middle of the phone.
//
// Height is the assertion that matters. Everything else can look right while
// this one number is catastrophically wrong.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const PRODUCTS = [{ productId: 'p1', name: 'Necklace', category: 'fashion', listingType: 'product',
  imageUrls: [], variants: [{ variantId: 'v1', label: 'Red Ruby', price: 500 }] }];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  for (const width of [390, 834, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => {
      let a = '';
      try { a = (r.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let body = { ok: true };
      if (a === 'listProducts') body = { ok: true, storeName: 'Burabonita', storeSlug: 'bura',
        storeOpen: true, storePhone: '73011629', products: PRODUCTS };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/store.html?store=bura', { waitUntil: 'load' });
    await page.waitForSelector('#cart-link', { timeout: 6000 });
    await page.waitForTimeout(300);

    // Bottom-left state first: it must STILL clear the bottom nav bar, which is
    // what the lift rule is for. Breaking that to fix the blob is no fix.
    const low = await page.evaluate(() => {
      const e = document.getElementById('cart-link');
      e.classList.remove('cart-fab--corner');
      const r = e.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav');
      return { h: Math.round(r.height), bottom: Math.round(r.bottom),
               navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
               navPresent: !!nav };
    });
    ok(`${width}px: bottom-left cart is a normal pill`, low.h > 30 && low.h < 70, String(low.h));
    if (low.navPresent && width <= 700) {
      ok(`${width}px: bottom-left cart still sits ABOVE the bottom nav bar`,
        low.bottom <= low.navTop, `btn ${low.bottom} vs nav ${low.navTop}`);
    }

    const corner = await page.evaluate(() => {
      const e = document.getElementById('cart-link');
      e.classList.add('cart-fab--corner');
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top),
               right: Math.round(r.right), vw: window.innerWidth,
               cssBottom: cs.bottom, cssTop: cs.top };
    });

    ok(`${width}px: corner cart is a pill, not a full-height column`,
      corner.h > 30 && corner.h < 70, `${corner.w}x${corner.h}`);
    ok(`${width}px: it never spans the viewport`, corner.h < 200, String(corner.h));
    // NOT getComputedStyle().bottom - that reports the USED value (a resolved
    // px distance), never the 'auto' that was specified, so it says 780px on a
    // perfectly healthy 48px pill. The height against the un-cornered pill is
    // what actually proves nothing stretched it.
    ok(`${width}px: corner is the same height as the normal pill - no stretch`,
      corner.h === low.h, `corner ${corner.h} vs normal ${low.h}`);
    ok(`${width}px: it sits at the top`, corner.top < 40, String(corner.top));
    ok(`${width}px: and on the right`, corner.vw - corner.right < 40,
      `${corner.vw - corner.right}px from edge`);
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- Cart FAB corner variant ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
