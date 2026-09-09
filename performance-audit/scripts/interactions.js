// Interaction responsiveness. Uses the Event Timing API (the same source INP is
// computed from) plus a click->next-paint wall measurement, at 4x CPU throttle
// on a 390px viewport.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8100';
const PRODUCTS = Array.from({ length: 30 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: 'pantry', description: 'A thing.',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', storeSlug: 'bong',
  storeName: 'Bong Store', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 6 + i }], rating: 4.3, reviewCount: 7 }));

const CASES = [
  { name: 'Homepage: open category shortcut', path: '/index.html', wait: '.category-btn', sel: '.category-btn' },
  { name: 'Browse: switch category in rail', path: '/categories.html', wait: '.category-rail-item', sel: '.category-rail-item:nth-child(3)' },
  { name: 'Browse: More… (page next 12)', path: '/categories.html', wait: '#category-more', sel: '#category-more' },
  { name: 'Store: add to cart', path: '/store.html?store=bong', wait: '.add-to-cart-btn', sel: '.add-to-cart-btn' },
  { name: 'Store: open chat', path: '/store.html?store=bong', wait: '#chat-fab', sel: '#chat-fab' },
  { name: 'Store: filter products (type)', path: '/store.html?store=bong', wait: '#products-search-input', sel: '#products-search-input', type: 'rice' },
  { name: 'Stores: open a store card', path: '/stores.html', wait: '.store-card', sel: '.store-card' }
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const out = [];
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', async (r) => {
      await new Promise((x) => setTimeout(x, 600));
      const store = { storeName: 'Bong Store', storeSlug: 'bong', phone: '73001224', island: 'South Tarawa',
        village: 'Bairiki', logoUrl: '', isOpen: true, deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 };
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true,
        products: PRODUCTS, stores: PRODUCTS.map((p, i) => ({ storeSlug: 's' + i, storeName: 'Shop ' + i,
          island: 'South Tarawa', village: 'Bairiki', deliveryTruck: true, deliveryPickPay: true })),
        tips: [], conversations: [], messages: [], store, storeName: 'Bong Store', storeOpen: true,
        storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5,
        hasMore: false, total: 30, reviews: [], average: 4.3, count: 7, distribution: [0,1,1,2,3] }) });
    });
    await ctx.route(/res\.cloudinary\.com|lh3\.googleusercontent\.com/, (r) =>
      r.fulfill({ status: 200, contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      window.__ev = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            window.__ev.push({ name: e.name, dur: e.duration,
              delay: e.processingStart - e.startTime,
              proc: e.processingEnd - e.processingStart,
              present: e.startTime + e.duration - e.processingEnd });
          }
        }).observe({ type: 'event', durationThreshold: 16, buffered: true });
      } catch (err) {}
    });
    await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await page.goto(BASE + c.path, { waitUntil: 'load' });
    try { await page.waitForSelector(c.wait, { timeout: 8000 }); } catch (e) {
      out.push({ name: c.name, error: 'target not found: ' + c.wait }); await ctx.close(); continue;
    }
    await page.waitForTimeout(600);

    const t0 = Date.now();
    if (c.type) { await page.click(c.sel); await page.type(c.sel, c.type, { delay: 40 }); }
    else { await page.click(c.sel).catch(() => {}); }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const wall = Date.now() - t0;
    await page.waitForTimeout(900);
    const ev = await page.evaluate(() => window.__ev);
    const worst = ev.slice().sort((a, b) => b.dur - a.dur)[0] || null;
    out.push({ name: c.name, path: c.path, clickToPaintMs: wall,
      worstEventMs: worst ? Math.round(worst.dur) : null,
      inputDelayMs: worst ? Math.round(worst.delay) : null,
      processingMs: worst ? Math.round(worst.proc) : null,
      presentationMs: worst ? Math.round(worst.present) : null,
      eventsOver16ms: ev.length });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync('/home/user/simple-kiri-shop/performance-audit/data/interactions.json', JSON.stringify(out, null, 2));
  console.log('=== INTERACTION RESPONSIVENESS (390px, 4x CPU throttle, API 600ms) ===');
  console.log('interaction'.padEnd(38) + 'click→paint  worstEvent  inputDelay  processing');
  for (const r of out) {
    if (r.error) { console.log(r.name.padEnd(38) + r.error); continue; }
    console.log(r.name.padEnd(38) + String(r.clickToPaintMs).padStart(9) + 'ms' +
      String(r.worstEventMs === null ? 'n/a' : r.worstEventMs).padStart(11) +
      String(r.inputDelayMs === null ? 'n/a' : r.inputDelayMs).padStart(12) +
      String(r.processingMs === null ? 'n/a' : r.processingMs).padStart(12));
  }
})();
