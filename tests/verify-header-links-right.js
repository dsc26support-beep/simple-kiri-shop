/**
 * Owner request, Oct 2026: on every page whose red bar has its own links
 * (Home, Browse Stores...), they sit together at the RIGHT edge of the bar -
 * just left of the cart / menu icon where a page shows one - at every width.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const PAGES = ['cart.html', 'categories.html', 'checkout.html', 'customer-dashboard.html', 'customer-login.html', 'customer-messages.html',
  'customer-tips.html', 'driver.html', 'help.html', 'my-carts.html', 'order-room.html', 'owner/forgot-password.html', 'owner/login.html',
  'privacy.html', 'product.html?id=p1', 'recent.html', 'store.html?store=bong', 'stores.html', 'terms.html'];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const w of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      // Checkout / My Account would otherwise send us off to sign in - but
      // the sign-in page and My Carts would send a signed-in shopper with one
      // cart onwards, so those two load as a guest with no cart.
      if (/customer-login|my-carts/.test(location.pathname)) { ['skiri_customer_token', 'skiri_cart_bong'].forEach((k) => localStorage.removeItem(k)); return; }
      localStorage.setItem('skiri_customer_token', 'tok'); localStorage.setItem('skiri_customer_profile', '{}');
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([{ variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 5, qty: 1 }]));
    } catch (e) {} });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: [], stores: [], orders: [], items: [], store: { storeName: 'Bong', storeSlug: 'bong' }, storeName: 'Bong' }) }));
    const page = await ctx.newPage();
    for (const pg of PAGES) {
      await page.goto(BASE + '/' + pg, { waitUntil: 'load' }).catch(() => {});
      await page.waitForTimeout(500);
      if (!new RegExp(pg.split('?')[0].replace('.', '\\.') + '$').test(new URL(page.url()).pathname)) {
        ok(`${w}px ${pg}: stayed on the page`, false, page.url()); continue;
      }
      const m = await page.evaluate(() => {
        const row = document.querySelector('header.site-header > .container:first-of-type');
        const nav = row && row.querySelector('nav.site-nav');
        const logo = row && row.querySelector('.header-logo-link');
        if (!nav) return null;
        const links = [...nav.querySelectorAll('a')].filter((a) => a.offsetParent).map((a) => a.getBoundingClientRect());
        if (!links.length) return { hiddenNav: true };
        const icons = [...row.querySelectorAll('.header-cart, .header-menu')].filter((e) => e.offsetParent || getComputedStyle(e).display !== 'none')
          .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
        const cs = getComputedStyle(row);
        const contentRight = row.getBoundingClientRect().right - parseFloat(cs.paddingRight);
        const edge = row.getBoundingClientRect().right - parseFloat(getComputedStyle(document.querySelector('.container')).paddingLeft);
        const lastRight = Math.max(...links.map((r) => r.right));
        const firstLeft = Math.min(...links.map((r) => r.left));
        const iconLeft = icons.length ? Math.min(...icons.map((r) => r.left)) : null;
        return { lastRight, firstLeft, logoRight: logo ? logo.getBoundingClientRect().right : row.getBoundingClientRect().left, contentRight, edge, iconLeft,
          overlap: icons.some((ic) => links.some((l) => l.right > ic.left && l.left < ic.right && l.bottom > ic.top && l.top < ic.bottom)),
          scroll: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      if (!m) { ok(`${w}px ${pg}: has a header with links`, false); continue; }
      if (m.hiddenNav) { ok(`${w}px ${pg}: links folded into the menu at this width`, true); continue; }
      // The row's padding is the room kept for the icons (and, wide, Tips /
      // My Account); the links end where that begins - or at the edge.
      const atRight = Math.abs(m.contentRight - m.lastRight) <= 2 && (m.iconLeft !== null || Math.abs(m.edge - m.contentRight) <= 2);
      ok(`${w}px ${pg}: links end at the right ${m.iconLeft !== null ? '(just left of the icons)' : '(at the edge)'}`, atRight, JSON.stringify(m));
      ok(`${w}px ${pg}: not crowding the logo`, m.firstLeft - m.logoRight >= 8, JSON.stringify(m));
      ok(`${w}px ${pg}: no overlap with icons, no sideways scroll`, !m.overlap && !m.scroll, JSON.stringify(m));
    }
    await ctx.close();
  }
  await browser.close();
  let f = 0;
  console.log('\n--- header links at the right ---');
  for (const [s, n, x] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
