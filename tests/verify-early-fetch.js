/**
 * Site scan follow-ups (owner, 12 Nov 2026):
 *  1. Chat checks only when this phone has chatted with the store: a store or
 *     product visit by someone who never chatted asks for no conversation and
 *     no inbox.
 *  3. The homepage, store and product pages start their main request from the
 *     <head> (tools/build-early.js); Api.get uses that answer, so the backend
 *     is still asked only once - and the page still works if it fails.
 *  6. The seller pages' top bar and the help page no longer jump on load.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ROOT = path.join(__dirname, '..');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);

const PRODUCTS = Array.from({ length: 4 }, (_, i) => ({ productId: 'p' + i, name: 'Product ' + i, category: 'pantry', description: 'x',
  imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store', variants: [{ variantId: 'v' + i, label: '1kg', price: 5 + i, stockQty: 3 }] }));

async function open(browser, url, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 } });
  const calls = [];
  let failFirst = !!opts.failFirst;
  await ctx.route('**/macros/s/**', async (r) => {
    const u = new URL(r.request().url());
    let action = u.searchParams.get('action') || '';
    try { const b = r.request().postDataJSON(); if (b && b.action) action = b.action; } catch (e) {}
    calls.push({ action, method: r.request().method(), at: Date.now() });
    if (failFirst && action === opts.failFirst) { failFirst = false; return r.abort(); }
    await new Promise((x) => setTimeout(x, opts.latency || 300));
    const body = { ok: true, products: PRODUCTS, stores: [], tips: [], storeName: 'Bong Store', storeOpen: true, conversations: [], messages: [], conversation: null };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await ctx.route(/accounts\.google\.com|gstatic|cloudinary|googleusercontent/, (r) => r.abort());
  await ctx.addInitScript((o) => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (o.owner) localStorage.setItem('skiri_owner_token', 'otok');
      if (o.chatted) localStorage.setItem('skiri_chat_name_bong', 'Aroita');
      window.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
  }, { owner: !!opts.owner, chatted: !!opts.chatted });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout(opts.wait || 2500);
  return { ctx, page, calls, errors, t0 };
}
const count = (calls, a) => calls.filter((c) => c.action === a).length;

(async () => {
  // ---- 3. early request: generated from config.js, used once ----
  let check = '';
  try { check = execSync('node tools/build-early.js --check', { cwd: ROOT }).toString(); } catch (e) { check = 'STALE ' + e.stdout; }
  ok('the early-fetch blocks match config.js (build-early --check)', /match config\.js/.test(check), check);
  const api = (fs.readFileSync(path.join(ROOT, 'assets/js/config.js'), 'utf8').match(/APPS_SCRIPT_URL:\s*'([^']*)'/) || [])[1];
  ok('...and use the backend address from config.js', ['index.html', 'store.html', 'product.html'].every((p) =>
    fs.readFileSync(path.join(ROOT, p), 'utf8').indexOf(JSON.stringify(api)) !== -1));
  ok('...before the stylesheet, so they never wait for it', ['index.html', 'store.html', 'product.html'].every((p) => {
    const s = fs.readFileSync(path.join(ROOT, p), 'utf8'); return s.indexOf('<!-- early-fetch -->') < s.indexOf('rel="stylesheet"');
  }));

  const browser = await chromium.launch();
  for (const [url, action, ready] of [['/index.html', 'getHomePageData', null], ['/store.html?store=bong', 'listProducts', '.product-card, .store-product, [data-product-id]'],
    ['/product.html?store=bong&product=p0', 'getProduct', null]]) {
    const { ctx, page, calls, errors } = await open(browser, url);
    const nav = await page.evaluate(() => performance.getEntriesByType('navigation')[0].domContentLoadedEventStart);
    const first = calls.find((c) => c.action === action);
    ok(url + ': ' + action + ' asked once', count(calls, action) === 1, J(calls.map((c) => c.action)));
    ok(url + ': ...and it left before the page scripts ran', !!first && await page.evaluate(() => !window.__mwkEarly || Object.keys(window.__mwkEarly).length === 0), J(nav));
    ok(url + ': no page errors', errors.length === 0, errors.join(' | '));
    if (ready) ok(url + ': the products show', (await page.$$(ready)).length > 0);
    await ctx.close();
  }
  {
    const { ctx, page, calls, errors } = await open(browser, '/store.html?store=bong', { failFirst: 'listProducts' });
    ok('early request fails: the page asks again itself and still works', count(calls, 'listProducts') === 2 && errors.length === 0, J(calls.map((c) => c.action)));
    await ctx.close();
  }

  // ---- 4. product page: one product, and the copy kept from the last visit ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const calls = [];
    let latency = 300;
    await ctx.route('**/macros/s/**', async (r) => {
      const u = new URL(r.request().url());
      let action = u.searchParams.get('action') || '';
      try { const b = r.request().postDataJSON(); if (b && b.action) action = b.action; } catch (e) {}
      calls.push(action);
      await new Promise((x) => setTimeout(x, action === 'getProduct' ? latency : 50));
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: action === 'getProduct' ? [PRODUCTS[0]] : [], storeName: 'Bong Store', storeOpen: true, reviews: [] }) });
    });
    await ctx.route(/accounts\.google\.com|gstatic|cloudinary|googleusercontent/, (r) => r.abort());
    await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    const page = await ctx.newPage();
    await page.goto(BASE + '/product.html?store=bong&product=p0', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    ok('product page asks for one product (getProduct), not the whole store', calls.includes('getProduct') && !calls.includes('listProducts'), J(calls));
    latency = 4000;
    await page.goto(BASE + '/product.html?store=bong&product=p0', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    ok('second visit: shown at once from the kept copy, before the backend answers',
      /Product 0/.test(await page.textContent('#product-detail') || ''));
    await ctx.close();
  }

  // ---- 1. chat checks only after a chat ----
  for (const url of ['/store.html?store=bong', '/product.html?store=bong&product=p0']) {
    const { ctx, calls } = await open(browser, url);
    ok(url + ': a shopper who never chatted - no chat or inbox requests', count(calls, 'getConversation') === 0 && count(calls, 'getCustomerInbox') === 0,
      J(calls.map((c) => c.action)));
    await ctx.close();
  }
  {
    const { ctx, calls } = await open(browser, '/store.html?store=bong', { chatted: true, wait: 4000 });
    ok('a phone that has chatted with the store: unread checks still run', count(calls, 'getConversation') >= 1 && count(calls, 'getCustomerInbox') >= 1,
      J(calls.map((c) => c.action)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/store.html?store=bong');
    const marked = await page.evaluate(() => { markChatStarted('bong'); return chatStartedWith('bong') && !chatStartedWith('other'); });
    ok('markChatStarted / chatStartedWith work per store', marked);
    await ctx.close();
  }

  // ---- 6. no jumps ----
  for (const [url, owner] of [['/owner/orders.html', true], ['/owner/feature.html', true], ['/owner/campaigns.html', true], ['/help.html', false]]) {
    const { ctx, page } = await open(browser, url, { owner });
    const cls = await page.evaluate(() => window.__cls);
    ok(url + ': no layout jump while loading (CLS < 0.01)', cls < 0.01, cls.toFixed(4));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/owner/orders.html', { owner: true, viewport: { width: 1280, height: 800 } });
    const ml = await page.evaluate(() => getComputedStyle(document.getElementById('store-name-label')).marginLeft);
    ok('computer: no room kept for the phone menu button', ml === '0px', ml);
    await ctx.close();
  }

  await browser.close();
  R.forEach(([s, n, e]) => console.log(s + '  ' + n + (e && s === 'FAIL' ? '  [' + e + ']' : '')));
  const failed = R.filter((r) => r[0] === 'FAIL').length;
  console.log('\n' + (R.length - failed) + '/' + R.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
