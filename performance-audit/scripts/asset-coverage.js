/**
 * Per-page byte coverage for the two files that dominate every page:
 * assets/css/styles.css and assets/js/helpers.js.
 *
 * Uses Chromium's coverage API, which reports which byte ranges were actually
 * used. For CSS that means "a rule that matched something"; for JS it means "a
 * function that ran". Both are LOWER bounds on what a page needs - a rule that
 * only matches after a click, or a function only an error path calls, counts as
 * unused here. So this says where to LOOK, never what is safe to delete.
 *
 * Backend is mocked empty, same as the rest of the harness.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';

const PAGES = ['/index.html', '/store.html?store=bong', '/product.html?store=bong&product=p0',
  '/categories.html', '/categories.html?q=rice', '/stores.html', '/cart.html?store=bong', '/checkout.html?store=bong',
  '/customer-dashboard.html', '/customer-login.html', '/customer-messages.html',
  '/customer-tips.html', '/my-carts.html',
  '/owner/login.html', '/owner/dashboard.html', '/owner/products.html', '/owner/orders.html',
  '/owner/settings.html', '/owner/messages.html', '/owner/bookings.html', '/owner/admin.html',
  '/owner/forgot-password.html'];

const TRACK = ['styles.css', 'owner.css', 'helpers.js'];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const rows = [];
  // union[file] = Set of used byte offsets across every page
  const union = {};
  const WIDTHS = [390, 768, 1280];
  for (const path of PAGES) {
   const perPage = {};
   let redirected = false, landed = '';
   for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    await ctx.route('**/script.google.com/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
                  body: JSON.stringify({ ok: true, products: [], stores: [], tips: [] }) }));
    const page = await ctx.newPage();
    // Owner pages call guardOwnerAuth() and redirect to owner/login.html without
    // a token; the customer dashboard does the same. Unseeded, every one of them
    // measured the login page and reported byte-identical figures.
    // Seeding is per page, in both directions. Owner pages and the customer
    // dashboard redirect a logged-OUT visitor to login; the login pages redirect
    // a logged-IN one to the dashboard. Checkout with an empty cart bounces to
    // the cart. Each of those measures a page other than the one asked for.
    const isLogin = /login|forgot-password/.test(path);
    await page.addInitScript((seed) => {
      try {
        localStorage.setItem('skiri_cookie_consent', 'true');
        if (!seed.isLogin) {
          localStorage.setItem('skiri_owner_token', 't');
          localStorage.setItem('skiri_customer_token', 't');
        }
        // checkout.js reads the slug from skiri_active_store, not the query
        // string, and bounces to cart.html when the cart for it is empty.
        if (seed.cart) {
          localStorage.setItem('skiri_cart_bong', seed.cart);
          localStorage.setItem('skiri_active_store', 'bong');
        }
      } catch (e) {}
    }, { isLogin, cart: /checkout/.test(path)
      ? JSON.stringify([{ variantId: 'v0', productId: 'p0', label: 'Rice 1kg',
                          unitPrice: 5, qty: 1 }]) : null });
    await Promise.all([page.coverage.startCSSCoverage(), page.coverage.startJSCoverage()]);
    await page.goto(BASE + path, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(2500);
    landed = new URL(page.url()).pathname + new URL(page.url()).search;
    if (landed.split('?')[0] !== path.split('?')[0]) redirected = true;
    const [css, js] = await Promise.all([page.coverage.stopCSSCoverage(), page.coverage.stopJSCoverage()]);

    const row = perPage;
    for (const e of css) {
      const name = TRACK.find((t) => e.url.endsWith(t));
      if (!name) continue;
      row[name] = row[name] || { off: new Set(), total: e.text.length };
      union[name] = union[name] || new Set();
      for (const r of e.ranges) for (let i = r.start; i < r.end; i++) {
        row[name].off.add(i); union[name].add(i);
      }
    }
    for (const e of js) {
      const name = TRACK.find((t) => e.url.endsWith(t));
      if (!name) continue;
      // V8 reports NESTED ranges - a function's own range, plus a range for
      // each inner block. Summing them counts the same byte several times and
      // reports more than 100% used. Collect offsets into a set instead, the
      // same way the union does, so each byte counts once.
      // V8 nests ranges: a function's first range spans the whole function,
      // later ranges are sub-ranges that OVERRIDE it. helpers.js is one IIFE, so
      // its outermost range covers the entire file and does execute - taking
      // count>0 ranges alone marked all 59,247 bytes used on every page.
      // Add every executed range, then subtract every count===0 range, which is
      // what "this inner block never ran" actually means.
      const mine = new Set();
      for (const f of e.functions) for (const r of f.ranges) if (r.count > 0)
        for (let i = r.startOffset; i < r.endOffset; i++) mine.add(i);
      for (const f of e.functions) for (const r of f.ranges) if (r.count === 0)
        for (let i = r.startOffset; i < r.endOffset; i++) mine.delete(i);
      const off = union[name] = union[name] || new Set();
      row[name] = row[name] || { off: new Set(), total: (e.source || '').length };
      for (const i of mine) { off.add(i); row[name].off.add(i); }
    }
    await ctx.close();
   }
   const row = { path, redirected: redirected ? landed : null };
   for (const t of TRACK) if (perPage[t]) row[t] = { used: perPage[t].off.size, total: perPage[t].total };
   rows.push(row);
  }
  await browser.close();

  const pct = (u, t) => t ? Math.round((u / t) * 100) : 0;
  console.log('\nCoverage unioned across ' + WIDTHS.join('/') + 'px, so desktop-only rules are not scored as unused.');
  console.log('\npage'.padEnd(42) + 'styles.css used   owner.css used   helpers.js used');
  for (const r of rows) {
    const c = (k) => r[k] ? `${String(r[k].used).padStart(6)} / ${r[k].total} (${pct(r[k].used, r[k].total)}%)`.padEnd(24) : '-'.padEnd(24);
    console.log(r.path.padEnd(42) + c('styles.css') + c('owner.css') + c('helpers.js')
      + (r.redirected ? '  REDIRECTED -> ' + r.redirected : ''));
  }
  console.log('\n--- union across every page (a byte used by ANY page) ---');
  for (const t of TRACK) {
    const total = (rows.find((r) => r[t]) || {})[t];
    if (!total) continue;
    console.log(`${t.padEnd(14)} ${String(union[t].size).padStart(6)} / ${total.total} used by at least one page (${pct(union[t].size, total.total)}%)`);
  }
  fs.writeFileSync(process.env.AUDIT_OUT || 'performance-audit/data/asset-coverage.json',
    JSON.stringify({ rows, union: Object.fromEntries(TRACK.map((t) => [t, union[t] ? union[t].size : 0])) }, null, 2));
})();
