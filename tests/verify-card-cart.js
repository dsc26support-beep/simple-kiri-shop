/**
 * Product cards (Oct 2026, from the owner's reference picture): one line of
 * description, price with a round cart button, stars, then place / delivery /
 * Verified / badges - on every product card, the store page included.
 *
 * The cart button: one option adds 1 at once; several open a picker on the
 * card; rentals and services have none. A tap anywhere else opens the product.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const mk = (o) => Object.assign({
  productId: 'p1', name: 'Solar Lamp', category: 'electronics', description: 'Bright solar lamp with USB charging port and hook',
  listingType: 'product', imageUrl: '', storeSlug: 'bong', storeName: 'Bong Store', storeIsland: 'Abaiang', storeVillage: '',
  variants: [{ variantId: 'v1', label: 'One', price: 25, stockQty: null }],
  rating: 4.5, reviewCount: 3, storeDeliveryTruck: true, storeDeliveryShip: true, sellerBadges: ['recommended', 'verified']
}, o);
const PRODUCTS = [
  mk({}),
  mk({ productId: 'p2', name: 'Rice', description: '', variants: [{ variantId: 'r1', label: '1kg', price: 2.5, stockQty: 5 },
    { variantId: 'r2', label: '5kg', price: 11, stockQty: 0 }, { variantId: 'r3', label: '25kg', price: 50, stockQty: null }], rating: null }),
  mk({ productId: 'p3', name: 'Car hire', listingType: 'rental', category: 'rentals', variants: [{ variantId: 'c1', label: 'Day', price: 80 }] }),
  mk({ productId: 'p4', name: 'Necklace', storeSlug: 'gold', storeName: 'Gold Shop', storeIsland: 'South Tarawa', storeVillage: 'Teaoraereke',
    variants: [{ variantId: 'n1', label: 'a', price: 219.99 }, { variantId: 'n2', label: 'b', price: 500 }] })
];

async function open(browser, path, w) {
  const ctx = await browser.newContext({ viewport: { width: w || 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let a = ''; try { a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    try { const j = r.request().postDataJSON(); if (!a && j) a = j.action; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'getHomePageData') return J({ ok: true, products: PRODUCTS, stores: [] });
    if (a === 'listProducts') {
      return J({ ok: true, storeName: 'Bong Store', storeOpen: true, storeIsland: 'Abaiang', storeVillage: '', storeDeliveryTruck: true,
        sellerBadges: ['verified'], products: PRODUCTS.slice(0, 3).map((p) => { const q = Object.assign({}, p);
          ['storeSlug', 'storeName', 'storeIsland', 'storeVillage', 'storeDeliveryTruck', 'storeDeliveryShip', 'sellerBadges'].forEach((k) => delete q[k]); return q; }) });
    }
    if (a === 'searchProducts') return J({ ok: true, products: [] });
    J({ ok: true, products: [], stores: [], reviews: [] });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => { errs.push('DIALOG ' + d.message()); d.dismiss(); });
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page, errs };
}

const cart = (page, slug) => page.evaluate((s) => JSON.parse(localStorage.getItem('skiri_cart_' + s) || '[]'), slug);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- layout ---------- */
  let { ctx, page, errs } = await open(browser, '/index.html');
  const card = await page.$eval('#trending-products-list .product-card[data-product-id="p1"]', (c) => {
    const kids = Array.from(c.querySelector('.product-card-body').children).map((k) => k.className.split(' ')[0]);
    const title = c.querySelector('.product-name');
    const price = c.querySelector('.product-price').getBoundingClientRect();
    const btn = c.querySelector('.card-cart-btn').getBoundingClientRect();
    const body = c.querySelector('.product-card-body').getBoundingClientRect();
    return {
      tag: c.tagName, kids,
      title: title.textContent.trim(), oneLine: getComputedStyle(title).whiteSpace === 'nowrap' && getComputedStyle(title).textOverflow === 'ellipsis',
      linkName: c.querySelector('.product-card-link').getAttribute('aria-label'),
      priceLeft: Math.abs(price.left - body.left) < 12, btnRight: Math.abs(btn.right - body.right) < 12,
      sameRow: Math.abs((price.top + price.bottom) / 2 - (btn.top + btn.bottom) / 2) < 6,
      btnLabel: c.querySelector('.card-cart-btn').getAttribute('aria-label'),
      meta: Array.from(c.querySelector('.product-card-meta').querySelectorAll('.product-card-place, .delivery-icons, .seller-badge'))
        .map((e) => e.classList.contains('product-card-place') ? 'place:' + e.textContent : e.classList.contains('delivery-icons') ? 'delivery'
          : (Array.from(e.classList).find((k) => /^seller-badge--(recommended|verified)$/.test(k)) || '').slice(14))
    };
  });
  ok('card is an <article> (a button can\'t live inside a link)', card.tag === 'ARTICLE', card.tag);
  ok('order: text line, price + cart, stars, place row, Verified row', card.kids.join(',') === 'product-name,product-card-buy,rating,product-card-meta,product-card-verified', card.kids.join(','));
  ok('text line: the description, on one line cut with …', card.title.startsWith('Bright solar lamp') && card.oneLine, card.title);
  ok('the link is named by the product and store for a screen reader', card.linkName === 'Solar Lamp, Bong Store', card.linkName);
  ok('price at the left, round cart button at the right, same row', card.priceLeft && card.btnRight && card.sameRow, JSON.stringify(card));
  ok('cart button says what it adds', card.btnLabel === 'Add Solar Lamp to cart');
  ok('place row: place, delivery, other badges (Verified has its own row)', card.meta.join(',') === 'place:Abaiang,delivery,recommended', card.meta.join(','));
  const vrow = await page.$eval('#trending-products-list .product-card[data-product-id="p1"] .product-card-verified', (r) => r.textContent.trim()).catch(() => null);
  ok('Verified alone on its own row at the bottom', /Verified/.test(vrow || '') && !/Recommended/.test(vrow || ''), String(vrow));
  const vf = await page.evaluate(() => {
    const mk = (o) => { const box = document.createElement('div'); box.innerHTML = renderBrowseProductCard(Object.assign({ productId: 'f', name: 'N', storeSlug: 's', storeName: 'S', variants: [{ variantId: 'v', label: 'a', price: 1 }] }, o)); return box; };
    const both = mk({ sellerBadges: ['verified'], featured: true });
    const onlyF = mk({ sellerBadges: [], featured: true });
    return {
      bothRow: !!both.querySelector('.product-card-verified .seller-badge--verified') && !!both.querySelector('.product-card-verified .featured-badge'),
      bothNotOnPlace: !both.querySelector('.product-card-meta .featured-badge'),
      onlyFeaturedOnPlace: !!onlyF.querySelector('.product-card-meta .featured-badge') && !onlyF.querySelector('.product-card-verified')
    };
  });
  ok('Verified + Featured share the bottom row when both exist', vf.bothRow && vf.bothNotOnPlace, JSON.stringify(vf));
  ok('Featured alone stays on the place row', vf.onlyFeaturedOnPlace, JSON.stringify(vf));
  ok('no Verified row for a seller who isn\'t verified', await page.evaluate(() => {
    const box = document.createElement('div');
    box.innerHTML = renderBrowseProductCard({ productId: 'nv', name: 'N', storeSlug: 's', storeName: 'S', variants: [{ variantId: 'v', label: 'a', price: 1 }], sellerBadges: ['recommended'] });
    return !box.querySelector('.product-card-verified') && !!box.querySelector('.product-card-meta .seller-badge--recommended');
  }));
  const noDesc = await page.$eval('.product-card[data-product-id="p2"] .product-name', (e) => e.textContent.trim());
  ok('no description -> the name', noDesc === 'Rice', noDesc);
  ok('a rental has no cart button', !(await page.$('.product-card[data-product-id="p3"] .card-cart-btn')));
  const fit = await page.$eval('.product-card[data-product-id="p4"] .product-price', (e) => ({ cut: e.scrollWidth > e.clientWidth + 1, text: e.textContent }));
  ok('a long price range is shrunk to fit, never cut', !fit.cut && fit.text === '$219.99-500.00', JSON.stringify(fit));

  /* ---------- one option: adds at once ---------- */
  await page.click('.product-card[data-product-id="p1"] .card-cart-btn');
  await page.waitForTimeout(200);
  let c1 = await cart(page, 'bong');
  ok('one option: tap adds 1 to that store\'s cart', c1.length === 1 && c1[0].variantId === 'v1' && c1[0].qty === 1 && c1[0].unitPrice === 25, JSON.stringify(c1));
  ok('...and stays on the page', page.url().endsWith('/index.html'));
  ok('...says so', /Added 1 × Solar Lamp to your Bong Store cart/.test(await page.textContent('#card-cart-toast')));
  ok('...button shows it was added', await page.$eval('.product-card[data-product-id="p1"] .card-cart-btn', (b) => b.classList.contains('card-cart-btn--added')));
  ok('...header cart badge counts it', (await page.textContent('#header-cart-badge')).trim() === '1');
  await page.click('.product-card[data-product-id="p1"] .card-cart-btn');
  await page.waitForTimeout(100);
  c1 = await cart(page, 'bong');
  ok('tapping again adds another', c1[0].qty === 2, JSON.stringify(c1));
  await page.click('.product-card[data-product-id="p4"] .card-cart-btn');
  await page.waitForTimeout(100);
  const picked4 = await page.$$eval('.card-cart-picker .card-cart-option', (o) => o.map((x) => x.textContent));
  await page.click('.card-cart-picker .card-cart-option');
  ok('a product from another store goes into that store\'s cart', (await cart(page, 'gold')).length === 1 && (await cart(page, 'bong')).length === 1, picked4.join('|'));

  /* ---------- several options: picker ---------- */
  await page.click('.product-card[data-product-id="p2"] .card-cart-btn');
  await page.waitForTimeout(150);
  const picker = await page.evaluate(() => {
    const p = document.querySelector('.product-card[data-product-id="p2"] .card-cart-picker');
    return p && { opts: Array.from(p.querySelectorAll('.card-cart-option')).map((o) => o.querySelector('span').textContent + ' ' + o.querySelector('strong').textContent + (o.disabled ? ' [off]' : '')),
      focus: document.activeElement.classList.contains('card-cart-option'),
      expanded: document.querySelector('.product-card[data-product-id="p2"] .card-cart-btn').getAttribute('aria-expanded') };
  });
  ok('several options: a picker opens on the card', !!picker && picker.opts.length === 3 && picker.expanded === 'true', JSON.stringify(picker));
  ok('...with each price, and sold-out options disabled', picker && picker.opts[0] === '1kg $2.50' && picker.opts[1] === '5kg Sold out [off]' && picker.opts[2] === '25kg $50.00', JSON.stringify(picker));
  ok('...focus moves into it', picker && picker.focus);
  ok('...nothing added yet', (await cart(page, 'bong')).length === 1);
  await page.keyboard.press('Escape');
  ok('Escape closes it, focus back on the button', !(await page.$('.card-cart-picker'))
    && await page.evaluate(() => document.activeElement.classList.contains('card-cart-btn')));
  await page.click('.product-card[data-product-id="p2"] .card-cart-btn');
  await page.click('.card-cart-option[data-variant-id="r3"]');
  await page.waitForTimeout(100);
  const c2 = (await cart(page, 'bong')).find((l) => l.variantId === 'r3');
  ok('choosing an option adds 1 of it and closes the picker', c2 && c2.qty === 1 && c2.label === 'Rice — 25kg' && !(await page.$('.card-cart-picker')), JSON.stringify(c2));
  ok('...toast names the option', /Rice \(25kg\)/.test(await page.textContent('#card-cart-toast')));

  /* ---------- the rest of the card opens the product ---------- */
  await Promise.all([page.waitForURL(/product\.html\?store=bong&product=p1/), page.click('.product-card[data-product-id="p1"] .product-price', { force: true })]);
  ok('tapping the price (not the button) opens the product', /product=p1/.test(page.url()));
  ok('no JS errors or alerts (home)', errs.length === 0, errs.join(' | '));
  await ctx.close();

  /* ---------- store page uses the same card ---------- */
  ({ ctx, page, errs } = await open(browser, '/store.html?store=bong'));
  const st = await page.evaluate(() => ({
    n: document.querySelectorAll('#product-list article.product-card .card-cart-btn').length,
    oldControls: document.querySelectorAll('#product-list .variety-select, #product-list .qty-input, #product-list .add-to-cart-btn').length,
    place: (document.querySelector('#product-list .product-card-place') || {}).textContent,
    badge: !!document.querySelector('#product-list .product-card-verified .seller-badge--verified'),
    href: document.querySelector('#product-list .product-card-link').getAttribute('href')
  }));
  ok('store page: the same card, with the round cart button (not on the rental)', st.n === 2 && st.oldControls === 0, JSON.stringify(st));
  ok('store page: the store\'s place, delivery and badges are on every card', st.place === 'Abaiang' && st.badge, JSON.stringify(st));
  ok('store page: cards link to the product page', st.href === 'product.html?store=bong&product=p1', st.href);
  await page.click('#product-list .product-card[data-product-id="p1"] .card-cart-btn');
  await page.waitForTimeout(200);
  ok('store page: the floating cart count updates', (await page.textContent('#cart-count')).trim() === '1');
  ok('no JS errors or alerts (store)', errs.length === 0, errs.join(' | '));
  await ctx.close();

  /* ---------- narrow phones ---------- */
  for (const w of [320, 360]) {
    ({ ctx, page, errs } = await open(browser, '/index.html', w));
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      cut: Array.from(document.querySelectorAll('.product-card .product-price')).some((e) => e.scrollWidth > e.clientWidth + 1),
      btn: (() => { const b = document.querySelector('.card-cart-btn').getBoundingClientRect(); return b.width >= 24 && b.height >= 24; })()
    }));
    ok(`${w}px: no sideways scroll, no price cut, button big enough to tap`, !m.overflow && !m.cut && m.btn, JSON.stringify(m));
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- product card + cart button ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
