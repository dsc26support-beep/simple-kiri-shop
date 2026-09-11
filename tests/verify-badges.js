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
    await page.waitForSelector('.dashboard-quick-links .btn');
    // give the async count fetches a beat
    await page.waitForTimeout(400);
    return { ctx, page };
  }

  async function badge(page, id) {
    return page.evaluate((bid) => {
      const b = document.getElementById(bid);
      if (!b) return null;
      const btn = b.closest('.btn');
      const cs = getComputedStyle(b);
      const bb = b.getBoundingClientRect();
      const rb = btn.getBoundingClientRect();
      return {
        hidden: b.classList.contains('hidden') || cs.display === 'none',
        text: b.textContent.trim(),
        red: cs.backgroundColor,
        pos: cs.position,
        // badge center should be in the button's top-right quadrant
        topRight: (bb.left + bb.width / 2) > (rb.left + rb.width / 2) && (bb.top + bb.height / 2) < (rb.top + rb.height / 2),
      };
    }, id);
  }

  // Counts present: orders 3 pending (+1 paid), bookings 2 pending (+1 confirmed), 5 unread
  {
    const { ctx, page } = await loadDash({ width: 900, height: 800 }, {
      orders: [order('Pending Payment'), order('Pending Payment'), order('Pending Payment'), order('Paid')],
      bookings: [booking('Pending'), booking('Pending'), booking('Confirmed')],
      unread: 5,
    });
    for (const [id, want] of [['nav-orders-badge', '3'], ['nav-bookings-badge', '2'], ['nav-messages-badge', '5']]) {
      const b = await badge(page, id);
      ok(`pc: ${id} shows ${want}`, b && !b.hidden && b.text === want, JSON.stringify(b));
      ok(`pc: ${id} red + corner`, b && /rgb\(/.test(b.red) && b.pos === 'absolute' && b.topRight, JSON.stringify(b));
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
    for (const id of ['nav-orders-badge', 'nav-bookings-badge', 'nav-messages-badge']) {
      const b = await badge(page, id);
      ok(`mobile: ${id} hidden at zero`, b && b.hidden, JSON.stringify(b));
    }
    await ctx.close();
  }

  // 99+ cap
  {
    const many = Array.from({ length: 150 }, () => order('Pending Payment'));
    const { ctx, page } = await loadDash({ width: 900, height: 800 }, { orders: many, bookings: [], unread: 0 });
    const b = await badge(page, 'nav-orders-badge');
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
