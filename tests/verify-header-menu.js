/**
 * The three-dot overflow menu in the header.
 *
 * THE ASSERTION THAT MATTERS MOST is that the menu costs nothing in layout.
 * header-menu.js injects the button AND its panel at DOMContentLoaded, which
 * on a deferred script is after the first paint - the exact shape that has
 * produced every CLS regression in this codebase so far. Both are out of flow,
 * so the measurement here is CLS on the six pages that carry it, taken as a
 * DIFFERENCE against the same page with the script blocked, because the
 * homepage has a pre-existing header race that fires on roughly one load in
 * five and would otherwise be read as this menu's fault.
 *
 * Second most important: the two conditional items. Create Store has to
 * disappear for a device holding a seller token (that rule predates this menu
 * and is the reason the homepage nav had ids on it), and Recent Stores has to
 * stay away when there is no cart behind it.
 *
 * The rest is the behaviour a menu owes anyone using it: it opens, it closes on
 * Escape / outside click / tab-out, the arrow keys walk it, the corner is not
 * shared with the cart button, and every item is big enough to hit with a
 * thumb.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const PAGES = [
  { path: '/index.html', name: 'home' },
  { path: '/stores.html', name: 'stores' },
  { path: '/categories.html', name: 'categories' },
  { path: '/store.html?store=tabon', name: 'store' },
  { path: '/product.html?store=tabon&product=p1', name: 'product' },
  { path: '/customer-tips.html', name: 'tips' }
];

const PRODUCT = {
  productId: 'p1', name: 'Solar Lamp', description: 'Bright', category: 'electronics',
  status: 'active', imageUrl: '', listingType: 'product',
  variants: [{ variantId: 'v1', label: 'One size', price: 25, status: 'active' }]
};

const STORE = { storeSlug: 'tabon', storeName: 'Tabon Store', island: 'Tarawa', village: 'Bairiki' };

function mockBody(action) {
  if (action === 'listProducts') {
    return { ok: true, products: [PRODUCT], storeName: 'Tabon Store', storeOpen: true };
  }
  if (action === 'searchProducts') {
    return { ok: true, products: [Object.assign({}, PRODUCT, { storeSlug: 'tabon', storeName: 'Tabon Store' })] };
  }
  if (action === 'listStores') return { ok: true, stores: [STORE] };
  if (action === 'getStorePublicInfo') return { ok: true, store: STORE };
  if (action === 'listTips') return { ok: true, tips: [], stores: [], products: [] };
  if (action === 'listProductReviews') return { ok: true, reviews: [], count: 0, average: 0 };
  return { ok: true };
}

/**
 * opts.owner / opts.customer: seed the session tokens the menu reads.
 * opts.carts: slugs to give this device a cart for.
 * opts.block: refuse header-menu.min.js, for the CLS baseline side.
 */
async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(mockBody(action))
    });
  });
  if (opts.block) await ctx.route('**/header-menu.min.js', (route) => route.abort());
  const page = await ctx.newPage();
  await page.addInitScript((o) => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (o.owner) localStorage.setItem('skiri_owner_token', 'tok-owner');
      if (o.customer) localStorage.setItem('skiri_customer_token', 'tok-cust');
      (o.carts || []).forEach((s) => localStorage.setItem(
        'skiri_cart_' + s, JSON.stringify([{ productId: 'p1', qty: 1 }])
      ));
    } catch (e) {}
  }, { owner: !!opts.owner, customer: !!opts.customer, carts: opts.carts || [] });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(250);
  return { ctx, page };
}

const labels = (page) => page.$$eval('#header-menu-panel .header-menu-label',
  (els) => els.map((e) => e.textContent.trim()));

async function measureCLS(browser, path, opts) {
  const { ctx, page } = await open(browser, path, Object.assign({ skipSettle: true }, opts));
  const cls = await page.evaluate(() => new Promise((resolve) => {
    let total = 0;
    new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => { if (!e.hadRecentInput) total += e.value; });
    }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => resolve(total), 1200);
  }));
  await ctx.close();
  return cls;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- present on the six pages, absent from the rest ---------------------
  for (const p of PAGES) {
    const { ctx, page } = await open(browser, p.path);
    const has = await page.$('#header-menu-btn');
    ok('menu present: ' + p.name, !!has);
    if (has) {
      const attrs = await page.evaluate(() => {
        const b = document.getElementById('header-menu-btn');
        const panel = document.getElementById('header-menu-panel');
        return {
          expanded: b.getAttribute('aria-expanded'),
          haspopup: b.getAttribute('aria-haspopup'),
          controls: b.getAttribute('aria-controls'),
          label: b.getAttribute('aria-label'),
          role: panel && panel.getAttribute('role'),
          hidden: panel && panel.hidden,
          inHeader: !!b.closest('header.site-header')
        };
      });
      ok('closed at rest: ' + p.name, attrs.expanded === 'false' && attrs.hidden === true);
      ok('button is a menu button: ' + p.name,
        attrs.haspopup === 'true' && attrs.controls === 'header-menu-panel' && attrs.label === 'Menu');
      ok('panel is a menu: ' + p.name, attrs.role === 'menu');
      ok('lives in the header: ' + p.name, attrs.inHeader === true);
    }
    await ctx.close();
  }

  for (const path of ['/checkout.html', '/cart.html', '/customer-login.html', '/my-carts.html']) {
    const { ctx, page } = await open(browser, path);
    ok('no menu on ' + path, !(await page.$('#header-menu-btn')));
    await ctx.close();
  }

  // ---- the item list ------------------------------------------------------
  {
    const { ctx, page } = await open(browser, '/index.html');
    const got = await labels(page);
    ok('signed-out item list', JSON.stringify(got) === JSON.stringify(
      ['Stores', 'Categories', 'Create Store', 'Help & Support', 'Tips', 'My Account']
    ), got.join(' | '));

    const hrefs = await page.$$eval('#header-menu-panel .header-menu-item', (els) => els.map((e) => e.getAttribute('href')));
    ok('Stores -> stores.html', hrefs[0] === 'stores.html');
    ok('Categories -> categories.html', hrefs[1] === 'categories.html');
    ok('Create Store -> owner register', hrefs[2] === 'owner/login.html?tab=register');
    ok('Help & Support is the existing enquiry mailto',
      hrefs[3] === 'mailto:admin@mwakete.com?subject=Mwakete%20Enquiry', hrefs[3]);
    ok('Tips -> customer-tips.html', hrefs[4] === 'customer-tips.html');
    ok('signed-out My Account -> login', hrefs[5] === 'customer-login.html');

    const roles = await page.$$eval('#header-menu-panel .header-menu-item', (els) => els.map((e) => e.getAttribute('role')));
    ok('every item is a menuitem', roles.every((r) => r === 'menuitem'));

    // Every item carries an icon AND a text label - never the icon alone.
    const iconed = await page.$$eval('#header-menu-panel .header-menu-item', (els) => els.every(
      (e) => e.querySelector('.header-menu-icon svg') && e.querySelector('.header-menu-label').textContent.trim().length > 0
    ));
    ok('icon never stands alone', iconed);

    // The mailto must be exactly the link index.html already carried.
    const footer = await page.$eval('a[href^="mailto:admin@mwakete.com"]', (a) => a.getAttribute('href')).catch(() => null);
    ok('mailto matches the existing Enquiry link', footer === 'mailto:admin@mwakete.com?subject=Mwakete%20Enquiry', String(footer));
    await ctx.close();
  }

  // ---- Create Store disappears for a store owner --------------------------
  {
    const { ctx, page } = await open(browser, '/index.html', { owner: true });
    const got = await labels(page);
    ok('owner: no Create Store', got.indexOf('Create Store') === -1, got.join(' | '));
    ok('owner: everything else stays', got.length === 5 && got[0] === 'Stores' && got[4] === 'My Account');
    const chooser = await page.$('#header-menu-panel [data-login-chooser]');
    ok('owner without customer account gets the login chooser', !!chooser);
    await page.click('#header-menu-btn');
    await page.click('#header-menu-panel [data-login-chooser]');
    await page.waitForTimeout(80);
    ok('chooser opens and offers both logins', await page.evaluate(() => {
      const el = document.getElementById('login-chooser');
      return !!el && /Customer Login/.test(el.textContent) && /Seller Login/.test(el.textContent);
    }));
    ok('menu closed behind the chooser', await page.$eval('#header-menu-panel', (p) => p.hidden === true));
    await ctx.close();
  }

  // ---- signed-in customer -------------------------------------------------
  {
    const { ctx, page } = await open(browser, '/index.html', { customer: true });
    const hrefs = await page.$$eval('#header-menu-panel .header-menu-item', (els) => els.map((e) => e.getAttribute('href')));
    ok('customer: My Account -> dashboard', hrefs[hrefs.length - 1] === 'customer-dashboard.html', hrefs.join(' | '));
    ok('customer: no chooser', !(await page.$('#header-menu-panel [data-login-chooser]')));
    ok('customer who is not a seller still sees Create Store',
      (await labels(page)).indexOf('Create Store') !== -1);
    await ctx.close();
  }

  // ---- Recent Stores only when there is a cart ----------------------------
  {
    const { ctx, page } = await open(browser, '/index.html');
    ok('no carts: no Recent Stores', (await labels(page)).indexOf('Recent Stores') === -1);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/index.html', { carts: ['tabon'] });
    const got = await labels(page);
    ok('with a cart: Recent Stores appears', got.indexOf('Recent Stores') !== -1, got.join(' | '));
    ok('Recent Stores is last', got[got.length - 1] === 'Recent Stores');
    const href = await page.$eval('#header-menu-panel .header-menu-item:last-child', (e) => e.getAttribute('href'));
    ok('Recent Stores -> the pick-up-where-you-left-off row', href === 'stores.html#cart-stores', href);
    await ctx.close();
  }
  {
    // An EMPTY cart is not a cart. Same rule cartStoreSlugs() applies.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const page = await ctx.newPage();
    await page.addInitScript(() => { try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_cart_tabon', '[]');
    } catch (e) {} });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(250);
    ok('empty cart does not conjure Recent Stores',
      (await labels(page)).indexOf('Recent Stores') === -1);
    await ctx.close();
  }

  // ---- current page is marked, not hidden ---------------------------------
  {
    const { ctx, page } = await open(browser, '/stores.html');
    const cur = await page.$$eval('#header-menu-panel .header-menu-item', (els) => els
      .filter((e) => e.getAttribute('aria-current') === 'page')
      .map((e) => e.textContent.trim()));
    ok('stores.html marks its own entry', cur.length === 1 && /Stores/.test(cur[0]), cur.join());
    // Told apart by more than colour: weight plus an inset rule.
    const style = await page.$eval('#header-menu-panel .header-menu-item.is-current',
      (e) => { const s = getComputedStyle(e); return { w: s.fontWeight, shadow: s.boxShadow }; });
    ok('current entry differs by weight and shape, not colour alone',
      Number(style.w) >= 700 && style.shadow !== 'none', style.w + ' / ' + style.shadow);
    await ctx.close();
  }

  // ---- open / close behaviour --------------------------------------------
  {
    const { ctx, page } = await open(browser, '/index.html');
    await page.click('#header-menu-btn');
    ok('click opens', await page.evaluate(() => !document.getElementById('header-menu-panel').hidden
      && document.getElementById('header-menu-btn').getAttribute('aria-expanded') === 'true'));

    await page.click('#header-menu-btn');
    ok('click again closes', await page.$eval('#header-menu-panel', (p) => p.hidden === true));

    await page.click('#header-menu-btn');
    await page.keyboard.press('Escape');
    ok('Escape closes', await page.$eval('#header-menu-panel', (p) => p.hidden === true));
    ok('Escape returns focus to the button',
      await page.evaluate(() => document.activeElement && document.activeElement.id === 'header-menu-btn'));

    await page.click('#header-menu-btn');
    await page.mouse.click(30, 500);
    await page.waitForTimeout(60);
    ok('outside click closes', await page.$eval('#header-menu-panel', (p) => p.hidden === true));

    // Arrow keys walk the list, from the button and inside the panel.
    await page.focus('#header-menu-btn');
    await page.keyboard.press('ArrowDown');
    ok('ArrowDown on the button opens onto the first item', await page.evaluate(() =>
      !document.getElementById('header-menu-panel').hidden &&
      document.activeElement === document.querySelector('#header-menu-panel .header-menu-item')));
    await page.keyboard.press('ArrowDown');
    ok('ArrowDown moves down', await page.evaluate(() =>
      document.activeElement === document.querySelectorAll('#header-menu-panel .header-menu-item')[1]));
    await page.keyboard.press('ArrowUp');
    ok('ArrowUp moves back', await page.evaluate(() =>
      document.activeElement === document.querySelectorAll('#header-menu-panel .header-menu-item')[0]));
    await page.keyboard.press('ArrowUp');
    ok('ArrowUp from the top wraps to the bottom', await page.evaluate(() => {
      const l = document.querySelectorAll('#header-menu-panel .header-menu-item');
      return document.activeElement === l[l.length - 1];
    }));
    await page.keyboard.press('End');
    ok('End goes to the last item', await page.evaluate(() => {
      const l = document.querySelectorAll('#header-menu-panel .header-menu-item');
      return document.activeElement === l[l.length - 1];
    }));
    await page.keyboard.press('Home');
    ok('Home goes to the first item', await page.evaluate(() =>
      document.activeElement === document.querySelector('#header-menu-panel .header-menu-item')));

    // Tabbing out of the last item must not leave the panel open behind it.
    await page.keyboard.press('End');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    ok('tabbing out closes', await page.$eval('#header-menu-panel', (p) => p.hidden === true));
    await ctx.close();
  }

  // ---- geometry: corner, tap targets, on screen ---------------------------
  // stores.html is in here because its header row is a plain .container, not a
  // .header-top-row: without a position of its own the button would pin to the
  // window edge there and to the 1100px content column on the other five.
  for (const [pagePath, width] of [['/index.html', 320], ['/index.html', 390],
    ['/index.html', 1366], ['/stores.html', 1366], ['/stores.html', 390]]) {
    const { ctx, page } = await open(browser, pagePath, { width: width, carts: ['tabon'] });
    await page.click('#header-menu-btn');
    const g = await page.evaluate(() => {
      const b = document.getElementById('header-menu-btn').getBoundingClientRect();
      const p = document.getElementById('header-menu-panel').getBoundingClientRect();
      const cart = document.getElementById('header-cart-link');
      const c = cart && getComputedStyle(cart).display !== 'none' ? cart.getBoundingClientRect() : null;
      const items = Array.prototype.map.call(
        document.querySelectorAll('#header-menu-panel .header-menu-item'),
        (e) => e.getBoundingClientRect().height
      );
      // The corner it belongs in is the content column's, not the window's -
      // .header-top-row is position:relative and capped at 1100px, which is
      // why .header-cart has always sat there too. On a wide screen a button
      // pinned to the glass would be adrift from everything else on the page.
      const host = document.querySelector('header.site-header > .container').getBoundingClientRect();
      return { b: { x: b.x, y: b.y, w: b.width, h: b.height }, p: { l: p.left, r: p.right, t: p.top },
        c: c ? { l: c.left, r: c.right } : null, items: items, vw: innerWidth, hostR: host.right };
    });
    ok('button in the top-right corner @' + pagePath + ' ' + width,
      g.b.x + g.b.w > g.hostR - 24 && g.b.y < 80,
      Math.round(g.hostR - (g.b.x + g.b.w)) + 'px from the content edge');
    ok('button is a 40px target @' + pagePath + ' ' + width, g.b.w >= 40 && g.b.h >= 40, g.b.w + 'x' + g.b.h);
    ok('panel is fully on screen @' + pagePath + ' ' + width,
      g.p.l >= 0 && g.p.r <= g.vw + 0.5, Math.round(g.p.l) + '-' + Math.round(g.p.r) + ' of ' + g.vw);
    ok('panel hangs below the button @' + pagePath + ' ' + width, g.p.t >= g.b.y + g.b.h - 1);
    ok('every item is at least 44px tall @' + pagePath + ' ' + width,
      g.items.length > 0 && g.items.every((h) => h >= 43.5), Math.min.apply(null, g.items).toFixed(1));
    if (g.c) {
      ok('cart button does not sit under the menu @' + pagePath + ' ' + width, g.c.r <= g.b.x + 0.5,
        'cart right ' + Math.round(g.c.r) + ' vs menu left ' + Math.round(g.b.x));
    } else {
      ok('cart button is hidden at this width @' + pagePath + ' ' + width, true);
    }
    await ctx.close();
  }

  // ---- the panel is reachable: nothing paints over it ---------------------
  {
    const { ctx, page } = await open(browser, '/store.html?store=tabon', { width: 390 });
    await page.click('#header-menu-btn');
    await page.waitForTimeout(120);
    const hit = await page.evaluate(() => {
      const first = document.querySelector('#header-menu-panel .header-menu-item');
      const r = first.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(el && (el === first || first.contains(el)));
    });
    ok('first item is actually hittable on the store page (chat FAB stacking)', hit);
    await ctx.close();
  }

  // ---- the homepage nav row really is gone --------------------------------
  {
    const { ctx, page } = await open(browser, '/index.html');
    const leftovers = await page.evaluate(() => ({
      createLi: !!document.getElementById('nav-create-store'),
      signinLi: !!document.getElementById('nav-signin'),
      nav: !!document.querySelector('header.site-header nav.site-nav')
    }));
    ok('old homepage nav row removed', !leftovers.createLi && !leftovers.signinLi && !leftovers.nav);
    ok('logo link kept as the way home', !!(await page.$('header.site-header .header-logo-link')));
    await ctx.close();
  }

  // ---- CLS, measured as a difference --------------------------------------
  // Minimum of three per side: the homepage has a pre-existing header race that
  // fires intermittently, and one unlucky run on either side would otherwise
  // decide this.
  for (const p of PAGES) {
    const withs = [], withouts = [];
    for (let i = 0; i < 3; i++) {
      withs.push(await measureCLS(browser, p.path, {}));
      withouts.push(await measureCLS(browser, p.path, { block: true }));
    }
    const w = Math.min.apply(null, withs);
    const b = Math.min.apply(null, withouts);
    ok('menu adds no layout shift: ' + p.name, w - b < 0.005,
      'with ' + w.toFixed(4) + ' vs without ' + b.toFixed(4));
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
