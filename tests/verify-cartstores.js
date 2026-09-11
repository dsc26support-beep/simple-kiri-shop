// Cart-first stores directory + the cart-page closed-store fix.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

// The main directory page deliberately does NOT contain shopC - that is the
// case the whole fetch-by-slug design exists for.
const PAGE1 = ['shopA', 'shopB', 'shopD'].map((slug, i) => ({
  storeSlug: slug, storeName: 'Store ' + slug, phone: '73000' + i,
  island: 'South Tarawa', village: 'Bairiki', logoUrl: '',
  deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
  deliveryTruckCost: 5, deliveryShipCost: null, deliveryAirCargoCost: null
}));
const info = (slug) => ({ storeName: 'Store ' + slug, storeSlug: slug, phone: '730999',
  messenger: '', logoUrl: '', island: 'South Tarawa', village: 'Bairiki', isOpen: true,
  deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
  deliveryTruckCost: 5, deliveryShipCost: null, deliveryAirCargoCost: null });
const line = { variantId: 'v1', productId: 'p1', label: 'Rice', unitPrice: 6, qty: 2 };

async function openStores(browser, carts, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const asked = [];
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; let p = null;
    try { const u = new URL(r.request().url()); a = u.searchParams.get('action') || ''; p = u.searchParams.get('storeSlug'); } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'listStores') return J({ ok: true, stores: PAGE1, hasMore: !!opts.hasMore, total: opts.hasMore ? 9 : PAGE1.length });
    if (a === 'getStorePublicInfo') {
      asked.push(p);
      if ((opts.failSlugs || []).indexOf(p) !== -1) return J({ ok: false, error: 'Store not found' });
      return J({ ok: true, store: info(p) });
    }
    J({ ok: true });
  });
  const page = await ctx.newPage();
  await page.addInitScript((c) => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    Object.keys(c).forEach((k) => localStorage.setItem('skiri_cart_' + k, JSON.stringify(c[k])));
  }, carts);
  await page.goto(BASE + '/stores.html', { waitUntil: 'load' });
  await page.waitForTimeout(1400);
  return { ctx, page, asked };
}

const snapshot = (page) => page.evaluate(() => ({
  sectionHidden: getComputedStyle(document.getElementById('cart-stores')).display === 'none',
  rootFlag: document.documentElement.classList.contains('has-cart-stores'),
  reservedRows: document.documentElement.style.getPropertyValue('--cart-store-rows'),
  pinned: [...document.querySelectorAll('#cart-store-list .store-card')].map((c) => c.dataset.storeSlug),
  pinnedText: document.getElementById('cart-store-list').textContent.replace(/\s+/g, ' ').trim(),
  marked: [...document.querySelectorAll('#store-list .store-card.is-in-cart')].map((c) => c.dataset.storeSlug),
  flags: [...document.querySelectorAll('#store-list .store-card-cart-flag')].map((f) => f.textContent),
  listed: [...document.querySelectorAll('#store-list .store-card')].map((c) => c.dataset.storeSlug)
}));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* No carts: the page must be exactly as it was. */
  let { ctx, page } = await openStores(browser, {});
  let s = await snapshot(page);
  ok('no carts: pinned section stays hidden', s.sectionHidden === true);
  ok('no carts: nothing pinned', s.pinned.length === 0);
  ok('no carts: no markers in the directory', s.marked.length === 0);
  ok('no carts: directory itself unchanged', s.listed.join(',') === 'shopA,shopB,shopD', s.listed.join(','));
  await ctx.close();

  /* An empty cart array is not a cart. */
  ({ ctx, page } = await openStores(browser, { shopA: [] }));
  s = await snapshot(page);
  ok('empty cart array does not pin a store', s.sectionHidden === true && s.pinned.length === 0);
  await ctx.close();

  /* Two carts, one of them NOT on the loaded directory page. */
  ({ ctx, page } = await openStores(browser, { shopA: [line], shopC: [line] }, { hasMore: true }));
  s = await snapshot(page);
  ok('two carts: section shown', s.sectionHidden === false);
  ok('two carts: both pinned', s.pinned.sort().join(',') === 'shopA,shopC', s.pinned.join(','));
  ok('a cart store absent from the directory page is still pinned',
    s.pinned.indexOf('shopC') !== -1 && s.listed.indexOf('shopC') === -1, s.listed.join(','));
  ok('pinned card offers Continue shopping', /Continue shopping/.test(s.pinnedText), s.pinnedText.slice(0, 120));
  ok('pinned card shows no item count or total',
    !/\b\d+\s*items?\b/i.test(s.pinnedText) && s.pinnedText.indexOf('$') === -1, s.pinnedText.slice(0, 120));
  ok('the cart store that IS listed is marked inline', s.marked.join(',') === 'shopA', s.marked.join(','));
  ok('marker carries a visible label, not just colour',
    s.flags.length === 1 && s.flags[0] === 'In your cart', JSON.stringify(s.flags));
  await ctx.close();

  /* A failed lookup drops that card and never touches the cart. */
  ({ ctx, page } = await openStores(browser, { shopA: [line], shopB: [line] }, { failSlugs: ['shopB'] }));
  s = await snapshot(page);
  ok('failed lookup: the other card still renders', s.pinned.join(',') === 'shopA', s.pinned.join(','));
  ok('failed lookup: section still shown', s.sectionHidden === false);
  const kept = await page.evaluate(() => localStorage.getItem('skiri_cart_shopB'));
  ok('failed lookup: the cart is NOT cleared', !!kept && JSON.parse(kept).length === 1, String(kept));
  await ctx.close();

  /* Markers must survive a search re-render and Load More. */
  ({ ctx, page } = await openStores(browser, { shopA: [line] }, { hasMore: true }));
  ok('marked before search', (await snapshot(page)).marked.join(',') === 'shopA');
  await page.evaluate(() => {
    const i = document.getElementById('stores-search-input');
    i.value = 'tarawa'; i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  s = await snapshot(page);
  ok('marker survives a search re-render', s.marked.join(',') === 'shopA', s.marked.join(','));
  ok('search re-render does not duplicate the flag', s.flags.length === 1, String(s.flags.length));
  await page.click('#stores-load-more');
  await page.waitForTimeout(700);
  s = await snapshot(page);
  ok('marker survives Load More', s.marked.join(',') === 'shopA', s.marked.join(','));
  ok('Load More does not duplicate the flag', s.flags.length === 1, String(s.flags.length));
  await ctx.close();

  /* Only the cart stores are fetched - one request each, no directory-wide fan-out. */
  let asked;
  ({ ctx, page, asked } = await openStores(browser, { shopA: [line], shopC: [line] }));
  ok('exactly one lookup per cart store', asked.sort().join(',') === 'shopA,shopC', asked.join(','));
  await ctx.close();

  /* cart-page.js now publishes store openness (the PR #15 gap). */
  for (const [isOpen, want, label] of [[true, true, 'open'], [false, false, 'closed']]) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.route('**/macros/s/**', (r) => {
      let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
      const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (a === 'getStorePublicInfo') return J({ ok: true, store: Object.assign(info('bong'), { isOpen }) });
      if (a === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
      J({ ok: true });
    });
    const p = await c.newPage();
    await p.addInitScript((l) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_active_store', 'bong');
      localStorage.setItem('skiri_cart_bong', JSON.stringify([l]));
    }, line);
    await p.goto(BASE + '/cart.html', { waitUntil: 'load' });
    await p.waitForTimeout(1200);
    const st = await p.evaluate(async () => {
      const f = document.getElementById('chat-fab'); if (f) f.click();
      await new Promise((r) => setTimeout(r, 350));
      const e = document.querySelector('.chat-vendor-status');
      return { open: window.__storeOpen, text: e ? e.textContent.trim() : '', closed: e ? e.classList.contains('is-closed') : null };
    });
    ok(`cart page (${label}): __storeOpen is ${want}`, st.open === want, String(st.open));
    ok(`cart page (${label}): chat header reads ${want ? 'Online' : 'Closed'}`,
      st.text === (want ? 'Online' : 'Closed'), st.text);
    ok(`cart page (${label}): closed styling ${want ? 'absent' : 'present'}`, st.closed === !want);
    await c.close();
  }

  /* The reservation is only worth anything if it happens before first paint,
     and only correct if its pixel constants still match a rendered card. */
  ({ ctx, page } = await openStores(browser, { shopA: [line], shopC: [line] }));
  const geom = await page.evaluate(() => {
    const list = document.getElementById('cart-store-list');
    const card = list.querySelector('.store-card');
    return { card: Math.round(card.getBoundingClientRect().height),
             gap: getComputedStyle(list).rowGap,
             rows: document.documentElement.style.getPropertyValue('--cart-store-rows') };
  });
  ok('reservation counted both carts', geom.rows === '2', geom.rows);
  ok('card height still 147px (pins the CSS calc)', geom.card === 147, String(geom.card));
  ok('grid row gap still 16px (pins the CSS calc)', geom.gap === '16px', geom.gap);
  await ctx.close();

  // Reserved height must be in place while the lookups are still in flight -
  // i.e. before any card exists - or the row shoves the directory down later.
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.route('**/macros/s/**', async (r) => {
      let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      if (a === 'getStorePublicInfo') await new Promise((x) => setTimeout(x, 4000)); // never lands in time
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stores: PAGE1, hasMore: false, total: 3 }) });
    });
    const p = await c.newPage();
    await p.addInitScript((l) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_cart_shopA', JSON.stringify([l]));
      localStorage.setItem('skiri_cart_shopC', JSON.stringify([l]));
    }, line);
    await p.goto(BASE + '/stores.html', { waitUntil: 'domcontentloaded' });
    const held = await p.evaluate(() => {
      const list = document.getElementById('cart-store-list');
      return { cards: list.children.length, h: Math.round(list.getBoundingClientRect().height),
               visible: getComputedStyle(document.getElementById('cart-stores')).display !== 'none' };
    });
    ok('row is visible before any card has loaded', held.visible === true);
    ok('space is held with zero cards rendered', held.cards === 0 && held.h >= 300,
      `cards=${held.cards} h=${held.h}`);
    await c.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Cart-first stores directory ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
