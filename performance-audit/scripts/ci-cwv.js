#!/usr/bin/env node
/**
 * Secondary performance gate: Core Web Vitals on headless Chromium vs a LOCAL
 * gzip server, median of repeats, against the generous ceilings in
 * performance-audit/budgets.json (cwv section).
 *
 * This is a BACKSTOP, not the primary gate. The deterministic byte gate
 * (check-budgets.js) is what normally catches regressions; this catches the
 * ones bytes alone cannot — a new render-blocking resource, or an un-reserved
 * section that shifts layout. Ceilings sit well above measured lab values so
 * ordinary lab noise never flaps them, and it reports the median of N runs.
 *
 * LAB, NOT FIELD. The backend is mocked, the network/CPU are emulated, and the
 * document is served from localhost. These numbers say nothing about real
 * GitHub Pages TTFB from Kiribati — that is the owner-run PageSpeed/CrUX
 * process in PERFORMANCE_MONITORING.md.
 *
 * Usage: node performance-audit/scripts/ci-cwv.js [--report]
 *   --report prints the medians and never fails (for local baselining).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
// Portable Playwright resolution: the local sandbox keeps Playwright at a fixed
// global path with Chromium at /opt/pw-browsers; CI installs it into node_modules
// and lets Playwright manage its own browser. Work in both.
let chromium;
try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
catch (e) { ({ chromium } = require('playwright')); }
const CHROMIUM_EXE = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'performance-audit', 'budgets.json'), 'utf8')).cwv;
const REPORT = process.argv.includes('--report');
const PORT = 8100;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = { w: 390, h: 844, cpu: 4, net: { down: 4e6 / 8, up: 3e6 / 8, lat: 70 } }; // mobile-4g

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: 'pantry', description: 'A thing for sale.',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', storeSlug: 'bong',
  storeName: 'Bong Store', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 6 + i }], rating: 4.3, reviewCount: 7 }));
const STORES = Array.from({ length: 12 }, (_, i) => ({
  storeSlug: 's' + i, storeName: 'Shop ' + i, phone: '7300' + i, island: 'South Tarawa', village: 'Bairiki',
  logoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 }));
function payloadFor(a) {
  const store = { storeName: 'Bong Store', storeSlug: 'bong', phone: '73001224', island: 'South Tarawa',
    village: 'Bairiki', logoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', isOpen: true,
    deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 };
  if (a === 'getHomePageData') return { ok: true, products: PRODUCTS, stores: STORES };
  if (a === 'getProduct') return { ok: true, product: PRODUCTS[0], store };
  if (a === 'listProductReviews') return { ok: true, reviews: [], average: 4.3, count: 7, distribution: [0,1,1,2,3] };
  return { ok: true, products: PRODUCTS, stores: STORES, tips: [], conversations: [], store,
    storeName: 'Bong Store', storeOpen: true, storeLogoUrl: store.logoUrl,
    storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5 };
}

const OBSERVERS = () => {
  window.__cls = 0; window.__lcp = null;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
    .observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { const es = l.getEntries(); const last = es[es.length - 1];
    if (last) window.__lcp = last.renderTime || last.loadTime || last.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
};

function waitForServer(ms = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => http.get(BASE + '/index.html', (r) => { r.destroy(); resolve(); })
      .on('error', () => (Date.now() - t0 > ms ? reject(new Error('server did not start')) : setTimeout(tick, 150)));
    tick();
  });
}

async function once(browser, pagePath) {
  const ctx = await browser.newContext({ viewport: { width: PROFILE.w, height: PROFILE.h },
    userAgent: 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' });
  await ctx.route('**/macros/s/**', async (route) => {
    let a = ''; try { a = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = route.request().postDataJSON(); if (j && j.action) a = j.action; } catch (e) {}
    if (cfg.apiLatencyMs) await new Promise((r) => setTimeout(r, cfg.apiLatencyMs));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payloadFor(a)) });
  });
  await ctx.route(/res\.cloudinary\.com|lh3\.googleusercontent\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (PROFILE.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpu });
  if (PROFILE.net) await cdp.send('Network.emulateNetworkConditions', { offline: false,
    downloadThroughput: PROFILE.net.down, uploadThroughput: PROFILE.net.up, latency: PROFILE.net.lat });
  await page.addInitScript(OBSERVERS);
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + pagePath, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  const m = await page.evaluate(() => ({ lcp: window.__lcp ? Math.round(window.__lcp) : null,
    cls: window.__cls ? Number(window.__cls.toFixed(4)) : 0 }));
  await ctx.close();
  return m;
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const i = s.length >> 1;
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
const PATHS = { 'index.html': '/index.html', 'store.html': '/store.html?store=bong',
  'product.html': '/product.html?store=bong&product=p0' };

(async () => {
  const server = spawn('node', [path.join(ROOT, 'performance-audit', 'scripts', 'gzip-server.js')], { stdio: 'ignore' });
  let failed = 0;
  try {
    await waitForServer();
    const browser = await chromium.launch(CHROMIUM_EXE ? { executablePath: CHROMIUM_EXE } : {});
    console.log(`\nCore Web Vitals — lab, median of ${cfg.repeats}, mobile-4g, ${cfg.apiLatencyMs}ms mocked API`);
    console.log('  ' + 'page'.padEnd(16) + 'LCP(med)'.padStart(9) + 'ceil'.padStart(7) +
      'CLS(med)'.padStart(10) + 'ceil'.padStart(7) + '  status');
    for (const [page, budget] of Object.entries(cfg.pages)) {
      const lcps = [], clss = [];
      for (let i = 0; i < cfg.repeats; i++) { const m = await once(browser, PATHS[page]); lcps.push(m.lcp || 0); clss.push(m.cls); }
      const lcp = median(lcps), cls = Number(median(clss.map((c) => c * 1e4)) / 1e4);
      const breaches = [];
      if (budget.maxLcpMs && lcp > budget.maxLcpMs) breaches.push('LCP');
      if (budget.maxCls && cls > budget.maxCls) breaches.push('CLS');
      if (breaches.length) failed++;
      console.log('  ' + page.replace('.html', '').padEnd(16) + String(lcp).padStart(9) +
        String(budget.maxLcpMs).padStart(7) + String(cls).padStart(10) + String(budget.maxCls).padStart(7) +
        '  ' + (breaches.length ? 'OVER: ' + breaches.join(',') : 'ok') +
        `   [runs lcp ${lcps.join('/')} cls ${clss.join('/')}]`);
    }
    await browser.close();
  } finally { server.kill(); }

  if (REPORT) { console.log(`\n[report] ${failed} would breach. (report mode never fails)`); process.exit(0); }
  if (failed) { console.log(`\n❌ CWV GATE: ${failed} page(s) over a Core Web Vitals ceiling (lab).`); process.exit(1); }
  console.log('\n✅ Core Web Vitals within lab ceilings.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
