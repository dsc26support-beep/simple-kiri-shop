// The audit's findings, re-tested after the fixes.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8100';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const STORE = { storeName: 'Bong Restaurant', storeSlug: 'bong', phone: '73001224',
  island: 'South Tarawa', village: 'Bairiki', logoUrl: '', isOpen: true,
  deliveryTruck: true, deliveryShip: true, deliveryAirCargo: true, deliveryPickPay: true,
  deliveryTruckCost: 5, deliveryShipCost: 3, deliveryAirCargoCost: 9 };
const PRODUCTS = Array.from({ length: 8 }, (_, i) => ({
  productId: 'p' + i, name: 'Product ' + i, category: 'pantry', description: 'A thing.',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  imageUrl2: i === 0 ? 'https://res.cloudinary.com/demo/image/upload/sample2.jpg' : '',
  storeSlug: 'bong', storeName: 'Bong Restaurant', storeIsland: 'South Tarawa', storeVillage: 'Bairiki',
  variants: [{ variantId: 'v' + i, label: '1kg', price: 6 + i }], rating: 4.3, reviewCount: 7 }));

async function open(browser, path, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: { width: o.w || 390, height: 844 } });
  const calls = [];
  await ctx.route('**/macros/s/**', async (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (j && j.action) a = j.action; } catch (e) {}
    calls.push(a);
    await new Promise((x) => setTimeout(x, o.latency === undefined ? 600 : o.latency));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true,
      store: STORE, storeName: STORE.storeName, storePhone: STORE.phone, storeOpen: true, storeLogoUrl: '',
      storeDeliveryTruck: true, storeDeliveryShip: true, storeDeliveryAirCargo: true, storeDeliveryPickPay: true,
      storeDeliveryTruckCost: 5, storeDeliveryShipCost: 3, storeDeliveryAirCargoCost: 9,
      products: PRODUCTS, stores: [], tips: [], conversations: o.conversations || [], messages: [],
      orders: [], bookings: [], reviews: [], average: 4.3, count: 7, distribution: [0,1,1,2,3],
      customer: { name: 'Me', email: 'me@example.com', phone: '73011111' } }) });
  });
  await ctx.route(/res\.cloudinary\.com|lh3\.googleusercontent\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
  });
  await page.addInitScript((seed) => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_active_store', 'bong');
    localStorage.setItem('skiri_chat_token_bong', 'tok');
    Object.entries(seed || {}).forEach(([k, v]) => localStorage.setItem(k, v));
  }, o.seed);
  await page.goto(BASE + path, { waitUntil: 'load' });
  return { ctx, page, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- P0: the layout shift ---- */
  for (const path of ['/product.html?store=bong&product=p0', '/store.html?store=bong', '/cart.html', '/checkout.html']) {
    const { ctx, page } = await open(browser, path);
    const early = await page.evaluate(() => {
      const e = document.querySelector('.store-branding-info');
      return e ? Math.round(e.getBoundingClientRect().height) : null;
    });
    await page.waitForTimeout(2600);
    const m = await page.evaluate(() => ({
      cls: Number(window.__cls.toFixed(4)),
      h: Math.round(document.querySelector('.store-branding-info').getBoundingClientRect().height)
    }));
    ok(`${path.split('?')[0]}: CLS is now good (<0.1)`, m.cls < 0.1, `CLS=${m.cls}`);
    ok(`${path.split('?')[0]}: header height reserved from first paint`, early === m.h,
      `${early} -> ${m.h}`);
    await ctx.close();
  }

  /* ---- P2: duplicate API calls ---- */
  {
    const { ctx, page, calls } = await open(browser, '/checkout.html');
    await page.waitForTimeout(3000);
    const counts = {};
    calls.forEach((a) => { counts[a] = (counts[a] || 0) + 1; });
    ok('checkout no longer duplicates getStorePublicInfo', (counts.getStorePublicInfo || 0) <= 1,
      JSON.stringify(counts));
    ok('checkout no longer duplicates getConversation', (counts.getConversation || 0) <= 1, JSON.stringify(counts));
    ok('checkout no longer duplicates getCustomerInbox', (counts.getCustomerInbox || 0) <= 1, JSON.stringify(counts));
    ok('checkout total API calls cut from 6', calls.length <= 4, `${calls.length}: ${calls.join(',')}`);
    await ctx.close();
  }
  {
    const { ctx, page, calls } = await open(browser, '/customer-messages.html');
    await page.waitForTimeout(3000);
    const n = calls.filter((a) => a === 'getCustomerInbox').length;
    ok('messages page requests the inbox once, not twice', n === 1, `${n}: ${calls.join(',')}`);
    await ctx.close();
  }

  /* ---- writes must NOT be coalesced ---- */
  {
    const { ctx, page } = await open(browser, '/index.html', { latency: 50 });
    const sent = await page.evaluate(async () => {
      let n = 0;
      const orig = window.fetch;
      window.fetch = (url, init) => {
        if (init && typeof init.body === 'string' && init.body.indexOf('WRITE-PROBE') !== -1) n++;
        return orig(url, init);
      };
      // Two identical writes issued together are two things the user meant.
      await Promise.all([
        Api.post('recordStoreVisit', { storeSlug: 'WRITE-PROBE' }),
        Api.post('recordStoreVisit', { storeSlug: 'WRITE-PROBE' })
      ]);
      return n;
    });
    ok('identical concurrent WRITES are still sent twice', sent === 2, String(sent));

    const reads = await page.evaluate(async () => {
      let n = 0;
      const orig = window.fetch;
      // Count only the request under test: this page's own nav badge and
      // homepage data are still in flight and would otherwise be counted too.
      window.fetch = (url, init) => {
        if (init && typeof init.body === 'string' && init.body.indexOf('"UNIQUE-TOKEN-XYZ"') !== -1) n++;
        return orig(url, init);
      };
      await Promise.all([
        Api.post('getCustomerInbox', { stores: [{ storeSlug: 'bong', customerToken: 'UNIQUE-TOKEN-XYZ' }] }),
        Api.post('getCustomerInbox', { stores: [{ storeSlug: 'bong', customerToken: 'UNIQUE-TOKEN-XYZ' }] })
      ]);
      return n;
    });
    ok('identical concurrent READS are coalesced into one', reads === 1, String(reads));

    const seq = await page.evaluate(async () => {
      let n = 0;
      const orig = window.fetch;
      window.fetch = (url, init) => {
        if (String(url).indexOf('SEQ-PROBE') !== -1) n++;
        return orig(url, init);
      };
      // Sequential, not concurrent: this is not a cache, so it must go again.
      await Api.get('getStorePublicInfo', { storeSlug: 'SEQ-PROBE' });
      await Api.get('getStorePublicInfo', { storeSlug: 'SEQ-PROBE' });
      return n;
    });
    ok('a later identical read is NOT served stale - it goes to the network', seq === 2, String(seq));

    const diff = await page.evaluate(async () => {
      let n = 0;
      const orig = window.fetch;
      window.fetch = (url, init) => {
        if (String(url).indexOf('DIFF-PROBE') !== -1) n++;
        return orig(url, init);
      };
      await Promise.all([
        Api.get('getStorePublicInfo', { storeSlug: 'DIFF-PROBE-a' }),
        Api.get('getStorePublicInfo', { storeSlug: 'DIFF-PROBE-b' })
      ]);
      return n;
    });
    ok('different reads are not confused with each other', diff === 2, String(diff));
    await ctx.close();
  }

  /* ---- srcset ---- */
  {
    const { ctx, page } = await open(browser, '/store.html?store=bong');
    await page.waitForSelector('.product-card .product-image');
    const img = await page.evaluate(() => {
      const i = document.querySelector('.product-card .product-image');
      return { srcset: i.getAttribute('srcset'), sizes: i.getAttribute('sizes'),
               chosen: i.currentSrc, lazy: i.getAttribute('loading') };
    });
    ok('store cards emit a srcset with three candidates',
      !!img.srcset && (img.srcset.match(/\s\d+w(,|$)/g) || []).length === 3, String(img.srcset));
    ok('with a sizes hint', !!img.sizes, String(img.sizes));
    ok('and each candidate carries a real width descriptor',
      /200w/.test(img.srcset) && /400w/.test(img.srcset) && /520w/.test(img.srcset), String(img.srcset));
    ok('lazy loading is unchanged', img.lazy === 'lazy', String(img.lazy));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/categories.html');
    await page.waitForSelector('.category-tile-image', { timeout: 8000 }).catch(() => {});
    const t = await page.evaluate(() => {
      const i = document.querySelector('.category-tile-image');
      return i ? { srcset: i.getAttribute('srcset'), sizes: i.getAttribute('sizes') } : null;
    });
    ok('browse tiles emit a srcset too', t && !!t.srcset, JSON.stringify(t));
    ok('with the narrower tile sizes hint', t && /31vw/.test(t.sizes || ''), JSON.stringify(t));
    await ctx.close();
  }
  {
    // A host the optimizer cannot resize must get no srcset rather than three
    // copies of the same URL.
    const { ctx, page } = await open(browser, '/index.html');
    const none = await page.evaluate(() => imageSrcset('https://example.com/photo.jpg'));
    ok('an unresizable host gets no srcset', none === '', JSON.stringify(none));
    await ctx.close();
  }

  /* ---- badge paints before the network ---- */
  {
    const { ctx, page } = await open(browser, '/index.html',
      { latency: 2500, seed: { skiri_unread_total: '7' } });
    // Read it while the inbox request is still in flight.
    await page.waitForTimeout(400);
    const early = await page.evaluate(() => {
      const b = document.querySelector('.bottom-nav-badge[data-badge="messages"]');
      return b ? { text: b.textContent, hidden: b.hidden } : null;
    });
    ok('badge shows the last known count before the network answers',
      early && early.hidden === false && early.text === '7', JSON.stringify(early));
    await ctx.close();
  }
  {
    // ...and the network result corrects it, including down to nothing.
    const { ctx, page } = await open(browser, '/index.html',
      { latency: 100, seed: { skiri_unread_total: '7' }, conversations: [] });
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const b = document.querySelector('.bottom-nav-badge[data-badge="messages"]');
      return { hidden: b ? b.hidden : null, stored: localStorage.getItem('skiri_unread_total') };
    });
    ok('a stale badge is cleared when the real count is zero', after.hidden === true, JSON.stringify(after));
    ok('and the stored count is corrected', after.stored === '0', JSON.stringify(after));
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Audit fixes ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
