// Browser measurement of the V1 frontend.
//
// HONESTY NOTE, carried into the report: this serves the production tree from
// a LOCAL static server, so document TTFB here is localhost TTFB and says
// nothing about GitHub Pages. What it does measure truthfully is everything
// the browser does with the bytes: parse, script execution, layout, paint,
// request count, transferred weight, and how those respond to CPU and network
// throttling. The Apps Script backend is mocked at a CONFIGURABLE latency so
// backend time can be separated from frontend time rather than guessed at.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';

const PROFILES = {
  'desktop-fast':  { w: 1366, h: 900, cpu: 1, net: null },
  'desktop-slow':  { w: 1366, h: 900, cpu: 1, net: { down: 1.6e6 / 8, up: 750e3 / 8, lat: 150 } },
  'mobile-4g':     { w: 390,  h: 844, cpu: 4, net: { down: 4e6 / 8, up: 3e6 / 8, lat: 70 } },
  'mobile-slow3g': { w: 390,  h: 844, cpu: 6, net: { down: 400e3 / 8, up: 400e3 / 8, lat: 400 } }
};

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: 'pantry', description: 'A thing for sale.',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  storeSlug: 'bong', storeName: 'Bong Store', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 6 + i }], rating: 4.3, reviewCount: 7
}));
const STORES = Array.from({ length: 12 }, (_, i) => ({
  storeSlug: 's' + i, storeName: 'Shop ' + i, phone: '7300' + i, island: 'South Tarawa', village: 'Bairiki',
  logoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5
}));

function payloadFor(action) {
  const store = { storeName: 'Bong Store', storeSlug: 'bong', phone: '73001224', island: 'South Tarawa',
    village: 'Bairiki', logoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', isOpen: true,
    deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
    deliveryTruckCost: 5, deliveryShipCost: null, deliveryAirCargoCost: null };
  switch (action) {
    case 'getHomePageData': return { ok: true, products: PRODUCTS, stores: STORES };
    case 'listProducts': return { ok: true, storeName: 'Bong Store', storePhone: '73001224', storeOpen: true,
      storeLogoUrl: store.logoUrl, storeDeliveryTruck: true, storeDeliveryPickPay: true,
      storeDeliveryTruckCost: 5, products: PRODUCTS };
    case 'listStores': return { ok: true, stores: STORES, hasMore: false, total: STORES.length };
    case 'searchProducts': return { ok: true, products: PRODUCTS, hasMore: false, total: PRODUCTS.length };
    case 'getStorePublicInfo': return { ok: true, store };
    case 'getTips': return { ok: true, tips: [] };
    case 'listProductReviews': return { ok: true, reviews: [], average: 4.3, count: 7, distribution: [0,1,1,2,3] };
    case 'getCustomerProfile': return { ok: true, customer: { name: 'Me', email: 'me@example.com', phone: '73011111' } };
    case 'listCustomerOrders': return { ok: true, orders: [] };
    case 'listCustomerBookings': return { ok: true, bookings: [] };
    case 'getCustomerInbox': return { ok: true, conversations: [] };
    case 'getConversation': return { ok: true, conversation: null, messages: [], hasMoreBefore: false };
    default: return { ok: true, products: PRODUCTS, stores: STORES, tips: [], conversations: [], store };
  }
}

const METRICS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paint = performance.getEntriesByType('paint');
  const fcp = (paint.find((p) => p.name === 'first-contentful-paint') || {}).startTime || null;
  const res = performance.getEntriesByType('resource');
  const byType = {};
  let transferred = 0, decoded = 0;
  for (const r of res) {
    const t = r.initiatorType || 'other';
    byType[t] = byType[t] || { n: 0, transfer: 0, decoded: 0, dur: 0 };
    byType[t].n++; byType[t].transfer += r.transferSize || 0;
    byType[t].decoded += r.decodedBodySize || 0; byType[t].dur += r.duration;
    transferred += r.transferSize || 0; decoded += r.decodedBodySize || 0;
  }
  const slowest = res.slice().sort((a, b) => b.duration - a.duration).slice(0, 20).map((r) => ({
    name: r.name.replace(location.origin, ''), type: r.initiatorType,
    dur: Math.round(r.duration), transfer: r.transferSize || 0, decoded: r.decodedBodySize || 0
  }));
  return {
    ttfbLocal: nav.responseStart ? Math.round(nav.responseStart - nav.requestStart) : null,
    domContentLoaded: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadEvent: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
    fcp: fcp === null ? null : Math.round(fcp),
    lcp: window.__lcp ? Math.round(window.__lcp.time) : null,
    lcpElement: window.__lcp ? window.__lcp.el : null,
    cls: window.__cls ? Number(window.__cls.toFixed(4)) : 0,
    longTasks: window.__lt ? window.__lt.length : 0,
    longTaskMs: window.__lt ? Math.round(window.__lt.reduce((n, d) => n + d, 0)) : 0,
    requests: res.length, transferred, decoded, byType, slowest
  };
})()`;

const OBSERVERS = () => {
  window.__cls = 0; window.__lt = []; window.__lcp = null;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      const es = l.getEntries();
      const last = es[es.length - 1];
      if (last) window.__lcp = { time: last.renderTime || last.loadTime || last.startTime,
        el: last.element ? (last.element.tagName.toLowerCase() +
          (last.element.className ? '.' + String(last.element.className).split(' ').filter(Boolean).slice(0,2).join('.') : '')) : null };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
};

async function run(browser, { page: pagePath, profile, apiLatency, warm, loggedIn }) {
  const p = PROFILES[profile];
  const ctx = await browser.newContext({ viewport: { width: p.w, height: p.h },
    userAgent: p.w < 500 ? 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' : undefined });

  let apiCalls = 0; let apiBytes = 0;
  await ctx.route('**/macros/s/**', async (route) => {
    let action = '';
    try { action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = route.request().postDataJSON(); if (j && j.action) action = j.action; } catch (e) {}
    apiCalls++;
    const body = JSON.stringify(payloadFor(action));
    apiBytes += body.length;
    if (apiLatency) await new Promise((r) => setTimeout(r, apiLatency));
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  // Cloudinary/Drive photos are cross-origin and unreachable here; serve a tiny
  // stand-in so the request still happens and is counted, without pretending to
  // measure a real photo's bytes (the image audit covers real sizes separately).
  await ctx.route(/res\.cloudinary\.com|lh3\.googleusercontent\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));

  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (p.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
  if (p.net) await cdp.send('Network.emulateNetworkConditions', { offline: false,
    downloadThroughput: p.net.down, uploadThroughput: p.net.up, latency: p.net.lat });

  await page.addInitScript(OBSERVERS);
  await page.addInitScript((li) => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (li) {
        localStorage.setItem('skiri_customer_token', 'tok');
        localStorage.setItem('skiri_customer', JSON.stringify({ name: 'Me', email: 'me@example.com', phone: '73011111' }));
      }
    } catch (e) {}
  }, !!loggedIn);

  if (warm) { await page.goto(BASE + pagePath, { waitUntil: 'load' }); await page.waitForTimeout(1200); }
  const t0 = Date.now();
  await page.goto(BASE + pagePath, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  const wall = Date.now() - t0;

  const m = await page.evaluate(METRICS);
  const perf = {};
  for (const e of (await cdp.send('Performance.getMetrics')).metrics) perf[e.name] = e.value;

  await ctx.close();
  return Object.assign(m, {
    page: pagePath, profile, apiLatency, warm: !!warm, loggedIn: !!loggedIn,
    wallMs: wall, apiCalls, apiBytes,
    scriptDurationMs: Math.round((perf.ScriptDuration || 0) * 1000),
    layoutDurationMs: Math.round((perf.LayoutDuration || 0) * 1000),
    recalcStyleMs: Math.round((perf.RecalcStyleDuration || 0) * 1000),
    taskDurationMs: Math.round((perf.TaskDuration || 0) * 1000)
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const PAGES = ['/index.html', '/store.html?store=bong', '/product.html?store=bong&product=p0',
    '/search.html?q=rice', '/stores.html', '/categories.html', '/cart.html', '/customer-dashboard.html'];

  // 1. Every page, mobile 4G, realistic backend latency, cold.
  for (const pg of PAGES) results.push(await run(browser, { page: pg, profile: 'mobile-4g', apiLatency: 600 }));

  // 2. Homepage + store across all four profiles.
  for (const profile of Object.keys(PROFILES)) {
    for (const pg of ['/index.html', '/store.html?store=bong']) {
      results.push(await run(browser, { page: pg, profile, apiLatency: 600 }));
    }
  }

  // 3. Backend-latency sensitivity: how much of the wait is the API, not the frontend?
  for (const lat of [0, 300, 600, 1200, 2500]) {
    results.push(await run(browser, { page: '/index.html', profile: 'mobile-4g', apiLatency: lat }));
  }

  // 4. Cold vs warm cache.
  for (const pg of ['/index.html', '/store.html?store=bong']) {
    results.push(await run(browser, { page: pg, profile: 'mobile-4g', apiLatency: 600, warm: true }));
  }

  // 5. Logged out vs logged in.
  results.push(await run(browser, { page: '/index.html', profile: 'mobile-4g', apiLatency: 600, loggedIn: true }));

  await browser.close();
  fs.writeFileSync(REPO + 'performance-audit/data/' + (process.env.AUDIT_OUT || 'measurements') + '.json', JSON.stringify(results, null, 2));
  console.log('runs: ' + results.length);
  console.log('\npage'.padEnd(40) + 'profile'.padEnd(15) + 'api  FCP   LCP   CLS  req   KB  api#  script  longTask');
  for (const r of results) {
    console.log((r.page + (r.warm ? ' [warm]' : '') + (r.loggedIn ? ' [auth]' : '')).padEnd(40) +
      r.profile.padEnd(15) + String(r.apiLatency).padStart(4) +
      String(r.fcp).padStart(6) + String(r.lcp).padStart(6) + String(r.cls).padStart(7) +
      String(r.requests).padStart(5) + (r.transferred / 1024).toFixed(0).padStart(6) +
      String(r.apiCalls).padStart(5) + String(r.scriptDurationMs).padStart(8) + String(r.longTaskMs).padStart(9));
  }
})();
