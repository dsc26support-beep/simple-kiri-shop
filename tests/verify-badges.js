const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

function mock(ctx, { orders, bookings, unread }) {
  return ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
    let body = { ok: true };
    if (action === 'getOwnerProfile') body = { ok: true, owner: { storeName: 'Test Store', storeSlug: 'x' } };
    else if (action === 'listOwnerProducts') body = { ok: true, products: [] };
    else if (action === 'listOwnerOrders') body = { ok: true, total: orders.length, hasMore: false, orders };
    else if (action === 'listOwnerBookings') body = { ok: true, total: bookings.length, hasMore: false, bookings };
    else if (action === 'getUnreadCount') body = { ok: true, unreadCount: unread };
    // The dashboard now asks the server for its counts in one request
    // (Dashboards.gs getSellerDashboard) - same numbers, computed server-side.
    else if (action === 'getSellerDashboard') body = { ok: true, period: 7, storeType: 'retailer', series: [], recentOrders: [], lowStock: [], problems: [], wholesale: null,
      kpis: { ordersToday: 0, ordersYesterday: 0, salesToday: 0, salesYesterday: 0, lowStock: 0, outOfStock: 0, openProblems: 0, roomUnread: 0,
        pendingPayment: orders.filter((o) => o.status === 'Pending Payment').length, needsAction: orders.filter((o) => o.status === 'Pending Payment').length,
        activeProducts: 0, heldProducts: 0, reviewWaiting: 0, periodSales: 0, periodOrders: orders.length,
        bookingsPending: bookings.filter((b) => b.status === 'Pending').length } };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const order = (s) => ({ orderId: 'o', status: s, total: 10 });
const booking = (s) => ({ bookingId: 'b', status: s });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function loadDash(viewport, data) {
    const ctx = await browser.newContext({ viewport });
    await mock(ctx, data);
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 't'); } catch (e) {} });
    await page.goto(BASE + '/owner/dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('.seller-tabbar, .seller-sidebar');
    // give the async count fetches a beat
    await page.waitForTimeout(600);
    return { ctx, page };
  }

  // The red counts now sit on the store menu: the bottom bar on phones and
  // tablets, the sidebar on a computer (the Quick actions box was removed).
  async function badge(page, where, name) {
    return page.evaluate(([w, n]) => {
      const b = document.querySelector(w + ' [data-seller-badge="' + n + '"]');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { hidden: b.hidden || cs.display === 'none', text: b.textContent.trim(), red: cs.backgroundColor, label: b.getAttribute('aria-label') };
    }, [where, name]);
  }

  // Counts present: orders 3 pending (+1 paid), bookings 2 pending (+1 confirmed), 5 unread
  {
    const { ctx, page } = await loadDash({ width: 390, height: 800 }, {
      orders: [order('Pending Payment'), order('Pending Payment'), order('Pending Payment'), order('Paid')],
      bookings: [booking('Pending'), booking('Pending'), booking('Confirmed')],
      unread: 5,
    });
    ok('phone: no Quick actions box', !(await page.$('.dashboard-quick-links')) && !(await page.$('#quick-heading')));
    for (const [n, want] of [['orders', '3'], ['messages', '5']]) {
      const b = await badge(page, '.seller-tabbar', n);
      ok('phone: bottom bar ' + n + ' shows ' + want, b && !b.hidden && b.text === want && /rgb\(/.test(b.red), JSON.stringify(b));
    }
    const bk = await badge(page, '.seller-sidebar', 'bookings');
    ok('phone: bookings count in the menu (More / menu)', bk && !bk.hidden && bk.text === '2' && /need attention/.test(bk.label), JSON.stringify(bk));
    // Another seller page in the same tab shows them without asking again.
    await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
    await page.waitForSelector('.seller-tabbar');
    const o2 = await badge(page, '.seller-tabbar', 'orders');
    ok('phone: the orders count stays on other seller pages', o2 && !o2.hidden && o2.text === '3', JSON.stringify(o2));
    await ctx.close();
  }
  {
    const { ctx, page } = await loadDash({ width: 1280, height: 800 }, {
      orders: [order('Pending Payment')], bookings: [booking('Pending')], unread: 2,
    });
    ok('computer: no Quick actions box', !(await page.$('.dashboard-quick-links')));
    for (const [n, want] of [['orders', '1'], ['bookings', '1'], ['messages', '2']]) {
      const b = await badge(page, '.seller-sidebar', n);
      ok('computer: sidebar ' + n + ' shows ' + want, b && !b.hidden && b.text === want, JSON.stringify(b));
    }
    await ctx.close();
  }

  // Zero counts => all badges hidden
  {
    const { ctx, page } = await loadDash({ width: 390, height: 800 }, {
      orders: [order('Paid'), order('Fulfilled')],
      bookings: [booking('Confirmed')],
      unread: 0,
    });
    for (const n of ['orders', 'bookings', 'messages']) {
      const b = await badge(page, '.seller-sidebar', n);
      ok('mobile: ' + n + ' hidden at zero', b && b.hidden, JSON.stringify(b));
    }
    await ctx.close();
  }

  // 99+ cap
  {
    const many = Array.from({ length: 150 }, () => order('Pending Payment'));
    const { ctx, page } = await loadDash({ width: 390, height: 800 }, { orders: many, bookings: [], unread: 0 });
    const b = await badge(page, '.seller-tabbar', 'orders');
    ok('cap: orders badge shows 99+', b && b.text === '99+', JSON.stringify(b));
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- dashboard notification badges ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
