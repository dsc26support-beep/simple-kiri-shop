const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCTS = [{ productId: 'p1', name: 'Rice', category: 'pantry', description: 'x', imageUrl: '',
  variants: [{ variantId: 'v1', label: '1kg', price: 6 }], rating: null, reviewCount: 0 }];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(page_, { storeOpen, omitFlag = false }) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; let body = null;
      try { action = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { body = r.request().postDataJSON(); if (!action && body) action = body.action; } catch (e) {}
      const store = { storeName: 'Bong', storePhone: '73001224', products: PRODUCTS };
      if (!omitFlag) store.storeOpen = storeOpen;
      if (action === 'listProducts') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true }, store)) });
      if (action === 'getConversation') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, conversation: null, messages: [], hasMoreBefore: false }) });
      if (action === 'listProductReviews') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, reviews: [], average: null, count: 0, distribution: [0,0,0,0,0] }) });
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const pg = await ctx.newPage();
    await pg.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
    await pg.goto(BASE + page_, { waitUntil: 'load' });
    await pg.waitForTimeout(350);
    return { ctx, page: pg };
  }

  const chatState = (page) => page.evaluate(async () => {
    document.getElementById('chat-fab').click();
    await new Promise((r) => setTimeout(r, 250));
    const st = document.querySelector('.chat-vendor-status');
    return {
      text: st.textContent.trim(),
      isClosed: st.classList.contains('is-closed'),
      note: (document.getElementById('chat-closed-note') || {}).textContent || null,
      composerDisabled: !!(document.querySelector('#chat-window textarea, #chat-message-input') || {}).disabled,
    };
  });

  // OPEN store
  let { ctx, page } = await open('/store.html?store=bong', { storeOpen: true });
  ok('open: no closed banner', (await page.$('#store-closed-banner')) === null);
  ok('open: Add to Cart enabled', await page.evaluate(() => ![...document.querySelectorAll('.add-to-cart-btn')].some((b) => b.disabled)));
  let c = await chatState(page);
  ok('open: chat header reads Online', c.text === 'Online', c.text);
  ok('open: no closed styling', c.isClosed === false);
  ok('open: no closed note in chat', c.note === null);
  await ctx.close();

  // CLOSED store
  ({ ctx, page } = await open('/store.html?store=bong', { storeOpen: false }));
  ok('closed: banner shown', (await page.$('#store-closed-banner')) !== null);
  ok('closed: banner says Closed and explains', /Closed/.test(await page.textContent('#store-closed-banner')) && /still browse and chat/.test(await page.textContent('#store-closed-banner')));
  ok('closed: store still browsable (products rendered)', (await page.$$('.product-card')).length > 0);
  ok('closed: Add to Cart disabled', await page.evaluate(() => [...document.querySelectorAll('.add-to-cart-btn')].every((b) => b.disabled)));
  c = await chatState(page);
  ok('closed: chat header reads Closed', c.text === 'Closed', c.text);
  ok('closed: header carries the closed class (red)', c.isClosed === true);
  ok('closed: chat explains messages still go through', /still send a message/.test(c.note || ''), c.note);
  ok('closed: composer stays usable (can still send)', c.composerDisabled === false);
  await ctx.close();

  // Older backend that never sends storeOpen must NOT read as closed
  ({ ctx, page } = await open('/store.html?store=bong', { omitFlag: true }));
  ok('missing flag defaults to OPEN (no false "Closed")', (await page.$('#store-closed-banner')) === null);
  c = await chatState(page);
  ok('missing flag: chat still reads Online', c.text === 'Online', c.text);
  await ctx.close();

  // Product page
  ({ ctx, page } = await open('/product.html?store=bong&product=p1', { storeOpen: false }));
  await page.waitForSelector('#product-detail .product-card');
  ok('product page: closed notice shown', /Closed/.test(await page.textContent('#product-detail')));
  ok('product page: Add to Cart disabled', await page.evaluate(() => [...document.querySelectorAll('#product-detail .add-to-cart-btn')].every((b) => b.disabled)));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- Store availability on chat + storefront ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
