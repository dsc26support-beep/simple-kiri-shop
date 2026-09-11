// Store cards: photo and name link to the product's own page.
//
// The controls on the card are the point of the design - a store card is a
// buying card - so most of this suite is about what must NOT have changed.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCTS = [
  { productId: 'p1', name: 'Rice 10kg', category: 'pantry', description: 'A sack.',
    imageUrl: 'https://res.cloudinary.com/x/a.jpg', imageUrl2: 'https://res.cloudinary.com/x/b.jpg',
    variants: [{ variantId: 'v1', label: 'Sack', price: 25 }, { variantId: 'v2', label: 'Half', price: 13 }] },
  { productId: 'p2', name: 'Blue Shirt', category: 'clothing',
    imageUrl: 'https://res.cloudinary.com/x/c.jpg',
    variants: [{ variantId: 'v3', label: 'M', price: 10 }] },
  { productId: 'p3', name: 'No Photo Item', category: 'household',
    variants: [{ variantId: 'v4', label: 'One', price: 4 }] },
  { productId: 'p4', name: 'Kayak Hire', category: 'rentals', available: true,
    imageUrl: 'https://res.cloudinary.com/x/d.jpg',
    variants: [{ variantId: 'v5', label: 'Per day', price: 30 }] }
];

const STORE = {
  ok: true, storeName: 'Bong', storeSlug: 'bong', storeOpen: true, products: PRODUCTS,
  storeDeliveryTruck: true, storeDeliveryPickPay: true, storeDeliveryTruckCost: 5,
  store: { storeName: 'Bong', storeSlug: 'bong', isOpen: true,
    deliveryTruck: true, deliveryPickPay: true, deliveryTruckCost: 5 }
};

async function openStore(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(Object.assign({ tips: [], stores: [], conversations: [], reviews: [] }, STORE)) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('skiri_cookie_consent', 'true'));
  await page.goto(BASE + '/' + path, { waitUntil: 'load' });
  await page.waitForSelector('#product-list .product-card, #product-detail .product-card');
  await page.waitForTimeout(300);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- store.html: the links exist and point at the right product ----------
  {
    const { ctx, page } = await openStore(browser, 'store.html?store=bong');

    const cards = await page.evaluate(() => [...document.querySelectorAll('#product-list .product-card')].map((c) => {
      const name = c.querySelector('.product-name-link');
      const photos = [...c.querySelectorAll('.product-card-link:not(.product-name-link)')];
      return {
        pid: c.dataset.productId,
        nameHref: name ? name.getAttribute('href') : null,
        nameText: name ? name.textContent.trim() : null,
        photoHrefs: photos.map((a) => a.getAttribute('href')),
        photoTabIndexes: photos.map((a) => a.getAttribute('tabindex')),
        booking: c.classList.contains('product-card--booking')
      };
    }));

    ok('every card has a name link', cards.length === 4 && cards.every((c) => c.nameHref), JSON.stringify(cards.map((c) => c.nameHref)));
    ok('name link carries the product name', cards[0].nameText === 'Rice 10kg', cards[0].nameText);
    for (const c of cards) {
      ok(`${c.pid}: name link points at its own product page`,
        c.nameHref === `product.html?store=bong&product=${c.pid}`, c.nameHref);
    }

    ok('two-photo card links BOTH photos', cards[0].photoHrefs.length === 2, JSON.stringify(cards[0].photoHrefs));
    ok('single-photo card links its photo', cards[1].photoHrefs.length === 1, JSON.stringify(cards[1].photoHrefs));
    ok('photoless card links its placeholder swatch', cards[2].photoHrefs.length === 1, JSON.stringify(cards[2].photoHrefs));
    ok('photo links go to the same product page as the name',
      cards[0].photoHrefs.every((h) => h === cards[0].nameHref), JSON.stringify(cards[0].photoHrefs));
    ok('photo links are out of the tab order (name link is the one stop)',
      cards.every((c) => c.photoTabIndexes.every((t) => t === '-1')), JSON.stringify(cards.map((c) => c.photoTabIndexes)));

    // The rental card was included on purpose - user asked for goods and rentals alike.
    const kayak = cards.find((c) => c.pid === 'p4');
    ok('rental card is linked too', kayak.booking && !!kayak.nameHref, JSON.stringify(kayak));

    // ---------- what must NOT have changed ----------
    const controls = await page.evaluate(() => {
      const c = document.querySelector('.product-card[data-product-id="p1"]');
      const k = document.querySelector('.product-card[data-product-id="p4"]');
      return {
        select: !!c.querySelector('.variety-select'),
        selectOptions: c.querySelectorAll('.variety-select option').length,
        qty: !!c.querySelector('.qty-input'),
        addBtn: !!c.querySelector('.add-to-cart-btn'),
        thumbs: c.querySelectorAll('.product-gallery-thumb').length,
        bookingStart: !!k.querySelector('.booking-start-input'),
        bookingBtn: !!k.querySelector('.request-booking-btn'),
        // Nothing interactive may sit INSIDE a link - invalid HTML, and it
        // would swallow the control's own clicks.
        nestedControls: document.querySelectorAll(
          '.product-card-link select, .product-card-link input, .product-card-link button, .product-card-link textarea').length
      };
    });
    ok('variant select still there, with both options', controls.select && controls.selectOptions === 2, JSON.stringify(controls));
    ok('quantity input still there', controls.qty);
    ok('Add to Cart still there', controls.addBtn);
    ok('gallery thumbnails still there', controls.thumbs === 2, String(controls.thumbs));
    ok('booking form still there on the rental', controls.bookingStart && controls.bookingBtn, JSON.stringify(controls));
    ok('no control nested inside a link', controls.nestedControls === 0, String(controls.nestedControls));

    // ---------- the gallery still snaps to whole photos ----------
    // .product-gallery-track .product-image sets flex:0 0 100%, but the ANCHOR
    // is the flex item now. If the new rule were missing the panes would size
    // to content and this would not be one full track width.
    const gallery = await page.evaluate(() => {
      const track = document.querySelector('.product-card[data-product-id="p1"] .product-gallery-track');
      const panes = [...track.children];
      return {
        trackW: Math.round(track.clientWidth),
        paneWs: panes.map((p) => Math.round(p.getBoundingClientRect().width)),
        paneTags: panes.map((p) => p.tagName)
      };
    });
    ok('gallery panes are the anchors', gallery.paneTags.join(',') === 'A,A', gallery.paneTags.join(','));
    ok('each gallery pane is a full track wide',
      gallery.paneWs.every((w) => Math.abs(w - gallery.trackW) <= 1), JSON.stringify(gallery));

    // Tapping a thumb still scrolls the track, i.e. the anchors did not break it.
    await page.click('.product-card[data-product-id="p1"] .product-gallery-thumb[data-index="1"]');
    await page.waitForTimeout(500);
    const scrolled = await page.evaluate(() => {
      const t = document.querySelector('.product-card[data-product-id="p1"] .product-gallery-track');
      return { left: Math.round(t.scrollLeft), w: Math.round(t.clientWidth) };
    });
    ok('tapping thumb 2 still scrolls to photo 2', Math.abs(scrolled.left - scrolled.w) <= 2, JSON.stringify(scrolled));

    // Add to Cart still adds - the link must not have swallowed the click.
    await page.click('.product-card[data-product-id="p2"] .add-to-cart-btn');
    await page.waitForTimeout(400);
    const cart = await page.evaluate(() => ({
      url: location.pathname,
      stored: JSON.parse(localStorage.getItem('skiri_cart_bong') || '[]').length
    }));
    ok('Add to Cart still works and does NOT navigate', cart.stored === 1 && /store\.html$/.test(cart.url), JSON.stringify(cart));

    await ctx.close();
  }

  // ---------- clicking a photo actually goes to that product ----------
  {
    const { ctx, page } = await openStore(browser, 'store.html?store=bong');
    await page.click('.product-card[data-product-id="p2"] .product-card-link:not(.product-name-link)');
    await page.waitForTimeout(700);
    const url = page.url();
    ok('tapping a photo lands on that product page',
      /product\.html\?store=bong&product=p2$/.test(url), url);
    ok('same tab - one page in this context', ctx.pages().length === 1, String(ctx.pages().length));
    await ctx.close();
  }

  // ---------- clicking a name goes there too ----------
  {
    const { ctx, page } = await openStore(browser, 'store.html?store=bong');
    await page.click('.product-card[data-product-id="p4"] .product-name-link');
    await page.waitForTimeout(700);
    ok('tapping a rental name lands on that product page',
      /product\.html\?store=bong&product=p4$/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---------- product.html must NOT link its own card to itself ----------
  {
    const { ctx, page } = await openStore(browser, 'product.html?store=bong&product=p1');
    const detail = await page.evaluate(() => {
      const c = document.querySelector('#product-detail .product-card');
      return {
        links: c.querySelectorAll('.product-card-link').length,
        hasSelect: !!c.querySelector('.variety-select'),
        hasAdd: !!c.querySelector('.add-to-cart-btn'),
        name: c.querySelector('.product-name').textContent.trim()
      };
    });
    ok('product page card has NO self-link', detail.links === 0, JSON.stringify(detail));
    ok('product page card still shows the name', detail.name === 'Rice 10kg', detail.name);
    ok('product page card still buyable', detail.hasSelect && detail.hasAdd, JSON.stringify(detail));
    await ctx.close();
  }

  await browser.close();

  let f = 0;
  console.log('\n--- Store cards link to their product page ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
