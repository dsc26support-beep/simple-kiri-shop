const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8100';
const PAGES = ['/index.html', '/store.html?store=bong', '/product.html?store=bong&product=p0',
  '/search.html?q=rice', '/stores.html', '/categories.html', '/cart.html', '/checkout.html',
  '/customer-dashboard.html', '/customer-messages.html', '/customer-tips.html', '/my-carts.html'];
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const out = [];
  for (const auth of [false, true]) {
    for (const path of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const seen = [];
      await ctx.route('**/macros/s/**', async (r) => {
        let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
        try { const j = r.request().postDataJSON(); if (j && j.action) a = j.action; } catch (e) {}
        seen.push({ action: a, method: r.request().method(), at: Date.now() });
        await new Promise((x) => setTimeout(x, 600));
        const store = { storeName: 'Bong', storeSlug: 'bong', phone: '73001224', island: 'South Tarawa',
          village: 'Bairiki', logoUrl: '', isOpen: true, deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 };
        await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true,
          products: [], stores: [], tips: [], conversations: [], orders: [], bookings: [], messages: [],
          store, storeName: 'Bong', storeOpen: true, reviews: [], average: 0, count: 0, distribution: [0,0,0,0,0],
          customer: { name: 'Me', email: 'me@example.com', phone: '73011111' } }) });
      });
      const page = await ctx.newPage();
      await page.addInitScript((li) => {
        localStorage.setItem('skiri_cookie_consent', 'true');
        localStorage.setItem('skiri_active_store', 'bong');
        localStorage.setItem('skiri_chat_token_bong', 'tok');
        if (li) {
          localStorage.setItem('skiri_customer_token', 'tok');
          localStorage.setItem('skiri_customer', JSON.stringify({ name: 'Me', email: 'me@example.com', phone: '73011111' }));
        }
      }, auth);
      await page.goto(BASE + path, { waitUntil: 'load' }).catch(() => {});
      await page.waitForTimeout(2600);
      const t0 = seen.length ? Math.min(...seen.map((s) => s.at)) : 0;
      out.push({ path, auth, count: seen.length,
        actions: seen.map((s) => `${s.action || '(unknown)'}${s.method === 'POST' ? '*' : ''}+${s.at - t0}ms`) });
      await ctx.close();
    }
  }
  await browser.close();
  fs.writeFileSync('/home/user/simple-kiri-shop/performance-audit/data/api-per-page.json', JSON.stringify(out, null, 2));
  console.log('=== API CALLS DURING INITIAL LOAD (* = POST, +Nms = offset from first call) ===');
  for (const r of out) {
    console.log(`${(r.path + (r.auth ? ' [logged-in]' : '')).padEnd(46)} ${String(r.count).padStart(2)}  ${r.actions.join('  ')}`);
  }
})();
