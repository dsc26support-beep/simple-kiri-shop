const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // --- vendor settings: Fixed vs To Be Negotiated ---
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const owner = {
      ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong', email: 'o@b.com', phone: '73001224',
      island: 'South Tarawa', village: 'Betio', status: 'active', logoUrl: 'https://res.cloudinary.com/x/l.png',
      deliveryTruck: true, deliveryShip: true, deliveryAirCargo: false, deliveryPickPay: true,
      deliveryTruckCost: 15, deliveryShipCost: null, deliveryAirCargoCost: null, twoFAEnabled: false,
    };
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, owner }) }));
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_owner_token', 'tok');
    });
    await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
    await page.waitForTimeout(400);

    const m = await page.evaluate(() => {
      const radios = [...document.querySelectorAll('#delivery-truck-mode input[type="radio"]')];
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      const labels = [...document.querySelectorAll('#delivery-truck-mode .delivery-fee-mode-choice')];
      return {
        fixed: box(radios[0]),
        negotiated: box(radios[1]),
        labelHeights: labels.map((l) => Math.round(l.getBoundingClientRect().height)),
        negotiatedWraps: labels[1].getBoundingClientRect().height > labels[0].getBoundingClientRect().height,
      };
    });
    ok('Fixed and To Be Negotiated radios are the same width', m.fixed.w === m.negotiated.w, `${m.fixed.w} vs ${m.negotiated.w}`);
    ok('...and the same height', m.fixed.h === m.negotiated.h, `${m.fixed.h} vs ${m.negotiated.h}`);
    ok('radios are a sane 18px, not stretched', m.fixed.w === 18 && m.fixed.h === 18, JSON.stringify(m.fixed));
    ok('size holds even though the labels differ in height',
      m.negotiatedWraps ? m.fixed.h === m.negotiated.h : true, JSON.stringify(m.labelHeights));
    await ctx.close();
  }

  // --- product page: review star radios (same latent bug) ---
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; let body = null;
      try { action = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { body = r.request().postDataJSON(); if (!action && body) action = body.action; } catch (e) {}
      if (action === 'listProducts') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, storeName: 'Bong', products: [{ productId: 'p1', name: 'Rice', category: 'pantry', variants: [{ variantId: 'v1', label: '1kg', price: 6 }], rating: null, reviewCount: 0 }] }) });
      if (action === 'listProductReviews') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, reviews: [], average: null, count: 0, distribution: [0,0,0,0,0] }) });
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_customer_token', 'ct');
      localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Ana' }));
    });
    await page.goto(BASE + '/product.html?store=bong&product=p1', { waitUntil: 'load' });
    // The reviews block is a <details> that starts shut (PR #28), so everything
    // inside it is invisible until opened. Opened here so the assertions below
    // stay about what they were written for; verify-reviewsfold.js owns the
    // folding behaviour.
    await page.evaluate(() => {
      const d = document.getElementById('reviews-section');
      if (d) d.open = true;
    });
    await page.waitForTimeout(200);
    await page.waitForSelector('#review-form');
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('.review-star-choice input[type="radio"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return Math.round(r.width) + 'x' + Math.round(r.height);
      }));
    ok('all five star radios identical and 18px', sizes.every((s) => s === '18x18'), sizes.join(' '));
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Radio sizing ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
