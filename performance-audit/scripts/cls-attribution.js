// Attributes each layout shift on a page to the elements that moved.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8100';

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: 'pantry', description: 'A thing for sale.',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  storeSlug: 'bong', storeName: 'Bong Store', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 6 + i }], rating: 4.3, reviewCount: 7 }));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const out = [];
  for (const path of ['/product.html?store=bong&product=p0', '/store.html?store=bong', '/index.html']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', async (r) => {
      let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { const j = r.request().postDataJSON(); if (j && j.action) a = j.action; } catch (e) {}
      await new Promise((x) => setTimeout(x, 600));
      const store = { storeName: 'Bong Store', storeSlug: 'bong', phone: '73001224', island: 'South Tarawa',
        village: 'Bairiki', logoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', isOpen: true,
        deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 };
      const body = a === 'listProductReviews'
        ? { ok: true, reviews: Array.from({length:5},(_,i)=>({reviewId:'r'+i,customerName:'A',rating:5,comment:'Good product, arrived quickly and well packed.',createdAt:'2026-09-01T00:00:00Z',verifiedPurchase:true})), average: 4.3, count: 7, distribution: [0,1,1,2,3] }
        : { ok: true, products: PRODUCTS, stores: [], tips: [], store, storeName: 'Bong Store', storeOpen: true,
            storeLogoUrl: store.logoUrl, storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5 };
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await ctx.route(/res\.cloudinary\.com|lh3\.googleusercontent\.com/, (r) =>
      r.fulfill({ status: 200, contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      window.__shifts = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__shifts.push({
            value: e.value, at: Math.round(e.startTime),
            sources: (e.sources || []).map((s) => ({
              node: s.node ? (s.node.tagName ? s.node.tagName.toLowerCase() +
                (s.node.id ? '#' + s.node.id : '') +
                (s.node.className ? '.' + String(s.node.className).split(' ').filter(Boolean).slice(0, 2).join('.') : '') : 'text') : '?',
              from: s.previousRect ? [Math.round(s.previousRect.y), Math.round(s.previousRect.height)] : null,
              to: s.currentRect ? [Math.round(s.currentRect.y), Math.round(s.currentRect.height)] : null
            }))
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    const shifts = await page.evaluate(() => window.__shifts);
    const total = shifts.reduce((n, s) => n + s.value, 0);
    out.push({ path, total: Number(total.toFixed(4)), shifts });
    console.log(`\n=== ${path}  CLS=${total.toFixed(4)} (${shifts.length} shifts) ===`);
    shifts.sort((a, b) => b.value - a.value).slice(0, 8).forEach((s) => {
      console.log(`  ${s.value.toFixed(4)} @ ${String(s.at).padStart(5)}ms  ` +
        s.sources.map((x) => `${x.node} y${x.from ? x.from[0] : '?'}->${x.to ? x.to[0] : '?'} h${x.from ? x.from[1] : '?'}->${x.to ? x.to[1] : '?'}`).join(' | '));
    });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync('/home/user/simple-kiri-shop/performance-audit/data/cls-attribution.json', JSON.stringify(out, null, 2));
})();
