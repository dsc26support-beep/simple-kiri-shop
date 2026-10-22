/**
 * ☰ in the seller top bar, left of the store name (owner request, Oct 2026):
 * on phones and tablets it opens the same store menu as "More"; on a wide
 * screen (menu always shown) it is hidden. Every seller page, keyboard and
 * focus handled, More still there.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const open = async (w, page, admin) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, serviceWorkers: 'block' });
    const profile = { ownerId: 'o1', storeName: admin ? 'ADMIN' : 'Tiritobwa Store', storeSlug: 'tiri', storeType: 'retailer', status: 'active', isAdmin: !!admin };
    await ctx.addInitScript((p) => { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_cookie_consent', 'true'); localStorage.setItem('skiri_owner_profile', JSON.stringify(p)); }, profile);
    await ctx.route('**/macros/s/**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, owner: profile, products: [], orders: [], total: 0, conversations: [], stores: [], jobs: [], connections: [], connectors: [] }) }));
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(BASE + '/owner/' + page, { waitUntil: 'load' });
    await p.waitForSelector('.seller-sidebar', { state: 'attached', timeout: 6000 });
    await p.waitForTimeout(300);
    return { ctx, p, errors };
  };

  // ---- phone: the button, its place, and what it opens ----
  {
    const { ctx, p, errors } = await open(390, 'dashboard.html');
    const g = await p.evaluate(() => {
      const b = document.querySelector('.owner-topbar .seller-menu-btn');
      const name = document.getElementById('store-name-label');
      if (!b || !name) return null;
      const r = b.getBoundingClientRect(), n = name.getBoundingClientRect();
      return { left: r.left, w: r.width, h: r.height, nameLeft: n.left, sameRow: Math.abs((r.top + r.height / 2) - (n.top + n.height / 2)) < 6,
        label: b.getAttribute('aria-label'), controls: b.getAttribute('aria-controls'), expanded: b.getAttribute('aria-expanded'), name: name.textContent.trim() };
    });
    ok('Dashboard: a ☰ sits left of the store name, on the same line', g && g.left < g.nameLeft && g.sameRow && g.left < 30, J(g));
    ok('...44x44 tap target, named "Store menu", controls the store menu', g && g.w >= 44 && g.h >= 44 && g.label === 'Store menu' && g.controls === 'seller-sidebar' && g.expanded === 'false', J(g));
    await p.click('.seller-menu-btn');
    await p.waitForTimeout(350);
    const o = await p.evaluate(() => ({ open: document.body.classList.contains('seller-drawer-open'), exp: document.querySelector('.seller-menu-btn').getAttribute('aria-expanded'),
      moreExp: document.querySelector('.seller-tab-more').getAttribute('aria-expanded'), focus: document.activeElement.classList.contains('seller-link'),
      links: Array.from(document.querySelectorAll('.seller-sidebar .seller-link-label')).map((s) => s.textContent),
      inView: document.querySelector('.seller-sidebar').getBoundingClientRect().left >= -1 }));
    ok('tapping ☰ slides in the full store menu', o.open && o.inView && o.exp === 'true' && o.moreExp === 'true', J(o));
    ok('...with every page in it, keyboard focus on the first', o.focus && J(o.links) === J(['Dashboard', 'Products', 'Inventory', 'Orders', 'Bookings', 'Messages', 'Feature products', 'My Campaigns', 'Invoices', 'Settings']), J(o.links));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    ok('Escape closes it and focus goes back to ☰', await p.evaluate(() => !document.body.classList.contains('seller-drawer-open')
      && document.activeElement.classList.contains('seller-menu-btn') && document.querySelector('.seller-menu-btn').getAttribute('aria-expanded') === 'false'));
    await p.click('.seller-menu-btn');
    await p.waitForTimeout(300);
    await p.click('.seller-scrim', { position: { x: 370, y: 400 } });
    await p.waitForTimeout(250);
    ok('tapping outside closes it too', await p.evaluate(() => !document.body.classList.contains('seller-drawer-open')));
    await p.click('.seller-tab-more');
    await p.waitForTimeout(300);
    ok('"More" in the bottom bar still opens the same menu', await p.evaluate(() => document.body.classList.contains('seller-drawer-open')));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    ok('...and closing it returns focus to More', await p.evaluate(() => document.activeElement.classList.contains('seller-tab-more')));
    ok('no sideways scroll; no page errors', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---- every seller page ----
  for (const page of ['orders.html', 'products.html', 'messages.html', 'settings.html', 'inventory.html', 'invoices.html', 'campaigns.html', 'bookings.html', 'feature.html']) {
    const { ctx, p } = await open(360, page);
    const g = await p.evaluate(() => {
      const b = document.querySelector('.owner-topbar .seller-menu-btn');
      const lead = b && b.parentElement;
      return { has: !!b, first: lead && lead.parentElement.firstElementChild === lead, nextIsTitle: !!(b && b.nextElementSibling && /STRONG|H1|SPAN/.test(b.nextElementSibling.tagName)) };
    });
    ok(`${page}: ☰ is first in the top bar, before the store name`, g.has && g.first && g.nextIsTitle, J(g));
    await ctx.close();
  }
  {
    const { ctx, p } = await open(390, 'admin.html', true);
    await p.click('.seller-menu-btn');
    await p.waitForTimeout(300);
    ok('Admin page: ☰ is there and the menu includes Admin', await p.evaluate(() => Array.from(document.querySelectorAll('.seller-link-label')).some((s) => s.textContent === 'Admin')));
    await ctx.close();
  }

  // ---- wide screens: the menu is always shown, so no ☰ ----
  for (const w of [768, 1024, 1366]) {
    const { ctx, p } = await open(w, 'dashboard.html');
    const shown = await p.isVisible('.seller-menu-btn');
    ok(`${w}px: ☰ ${w >= 1024 ? 'hidden (menu always on screen)' : 'shown (menu is a drawer)'}`, shown === (w < 1024), String(shown));
    await ctx.close();
  }

  await browser.close();
  let f = 0; console.log('\n--- seller ☰ menu button ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e && s === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
