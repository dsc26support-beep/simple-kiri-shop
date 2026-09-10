const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const PRODUCT = (over) => Object.assign({
  productId: 'p1', name: 'Rice', category: 'pantry', description: 'Tasty', imageUrl: '',
  variants: [{ variantId: 'v1', label: '1kg', price: 6 }], rating: null, reviewCount: 0,
}, over);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function productPage({ product, reviews, signedIn = false, reviewsOk = true }) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const posted = [];
    await ctx.route('**/macros/s/**', (r) => {
      let action = ''; let body = null;
      try { action = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      try { body = r.request().postDataJSON(); if (!action && body) action = body.action; } catch (e) {}
      if (body) posted.push(body);
      if (action === 'listProducts') {
        return r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, storeName: 'Bong', storePhone: '73001224', products: [product] }) });
      }
      if (action === 'listProductReviews') {
        if (!reviewsOk) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'boom' }) });
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true }, reviews)) });
      }
      if (action === 'submitReview') {
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, submitted: true }) });
      }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const page = await ctx.newPage();
    await page.addInitScript((s) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      if (s) {
        localStorage.setItem('skiri_customer_token', 'ct');
        localStorage.setItem('skiri_customer_profile', JSON.stringify({ name: 'Ana', email: 'a@b.com' }));
      }
    }, signedIn);
    await page.goto(BASE + '/product.html?store=bong&product=p1', { waitUntil: 'load' });
    await page.waitForSelector('#reviews-section:not([hidden])');
    await page.waitForTimeout(200);
    // The block is a <details> that starts shut, so nothing inside it can be
    // read or typed into until it is opened. Opened AFTER the reviews have
    // rendered, not before - the slot is filled asynchronously and Playwright
    // will not type into a control it cannot see. verify-reviewsfold.js owns
    // the folding behaviour itself; every assertion below is about the review
    // flow.
    await page.waitForFunction(
      () => (document.getElementById('review-form-slot') || {}).children?.length > 0,
      null, { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => { document.getElementById('reviews-section').open = true; });
    await page.waitForTimeout(200);
    return { ctx, page, posted };
  }

  const EMPTY = { reviews: [], average: null, count: 0, distribution: [0,0,0,0,0] };
  const SOME = {
    reviews: [
      { reviewId: 'a', rating: 5, customerName: 'Bob', comment: 'Great', verifiedPurchase: true, createdAt: '2026-09-02T00:00:00Z' },
      { reviewId: 'b', rating: 4, customerName: 'Cara', comment: '', verifiedPurchase: false, createdAt: '2026-09-01T00:00:00Z' },
    ], average: 4.5, count: 2, distribution: [0,0,0,1,1],
  };

  // No reviews yet
  let { ctx, page } = await productPage({ product: PRODUCT(), reviews: EMPTY });
  let t = await page.textContent('#reviews-summary');
  // "No reviews yet" moved to the fold's toggle, where a shopper reads it
  // without opening anything; repeating it in the body said the same thing
  // twice on one screen. Both halves are still asserted - the empty state must
  // never be a zero-star score, which reads as a bad product rather than a new
  // one.
  const toggleText = await page.textContent('#reviews-toggle-score');
  ok('no reviews -> the toggle says so explicitly', /No reviews yet/.test(toggleText), toggleText.trim());
  ok('no reviews -> the body invites the first one', /Be the first to review/.test(t), t.trim());
  ok('no reviews -> renders no stars at all', (await page.$$('#reviews-summary .rating')).length === 0);
  ok('signed out -> prompted to sign in', /Sign in or create an account/.test(await page.textContent('#review-form-slot')));
  ok('signed out -> no review form', (await page.$('#review-form')) === null);
  await ctx.close();

  // With reviews
  ({ ctx, page } = await productPage({ product: PRODUCT({ rating: 4.5, reviewCount: 2 }), reviews: SOME }));
  const sum = await page.evaluate(() => {
    const fill = document.querySelector('#reviews-summary .rating-stars-fill');
    return {
      avg: document.querySelector('.reviews-average-value').textContent,
      fillWidth: fill ? fill.style.width : null,
      label: document.querySelector('#reviews-summary .rating').getAttribute('aria-label'),
      bars: [...document.querySelectorAll('.rating-bar-row')].length,
    };
  });
  ok('average displayed to one decimal', sum.avg === '4.5', sum.avg);
  ok('star fill is fractional, not rounded up', sum.fillWidth === '90%', sum.fillWidth);
  ok('rating exposed to screen readers', /Rated 4.5 out of 5 from 2 reviews/.test(sum.label), sum.label);
  ok('distribution shows all five rows', sum.bars === 5, String(sum.bars));

  const list = await page.textContent('#reviews-list');
  ok('verified purchase badged', /Verified purchase/.test(list));
  ok('review comment shown', /Great/.test(list));
  ok('unverified review not badged as verified', (await page.$$('.review-verified')).length === 1, String((await page.$$('.review-verified')).length));
  await ctx.close();

  // Signed in -> form, and submit sends the right payload
  ({ ctx, page, posted: undefined } = await productPage({ product: PRODUCT(), reviews: EMPTY, signedIn: true }));
  ok('signed in -> form shown', (await page.$('#review-form')) !== null);
  await ctx.close();

  let res = await productPage({ product: PRODUCT(), reviews: EMPTY, signedIn: true });
  // force:true is gone on purpose. It skips actionability but still clicks the
  // element's coordinates, and with the reviews block folded the form sits
  // ~970px down an 844px viewport: the blind click landed on the fixed bottom
  // nav's Messages tab and navigated the whole test off the product page,
  // which then failed thirty seconds later looking for a field on the wrong
  // page. Without force, Playwright refuses a click that would hit something
  // else and says so immediately.
  const star4 = res.page.locator('#review-form input[value="4"]');
  await star4.scrollIntoViewIfNeeded();
  // Clear the fixed bottom bar, which overlays the last ~56px of the viewport.
  await res.page.mouse.wheel(0, 140);
  await res.page.waitForTimeout(150);
  await star4.click();
  await res.page.fill('#review-comment', 'Solid');
  await res.page.click('#review-submit');
  await res.page.waitForTimeout(300);
  const submit = res.posted.filter((b) => b && b.action === 'submitReview')[0];
  ok('submit posts the chosen rating', submit && submit.rating === 4, JSON.stringify(submit && submit.rating));
  ok('submit posts the comment', submit && submit.comment === 'Solid');
  ok('submit sends the customer token', submit && submit.token === 'ct');
  ok('submit does NOT send verifiedPurchase', submit && submit.verifiedPurchase === undefined);
  await res.ctx.close();

  // Reviews backend down -> product still usable
  ({ ctx, page } = await productPage({ product: PRODUCT(), reviews: EMPTY, reviewsOk: false }));
  ok('reviews failure does not break the product', (await page.$('#product-detail .product-card')) !== null);
  ok('reviews failure shows a failed state', /Refresh page/.test(await page.textContent('#reviews-status')));
  await ctx.close();

  // Cards: stars only when rated
  {
    const c = await browser.newContext();
    await c.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, products: [] }) }));
    const pg = await c.newPage();
    await pg.goto(BASE + '/categories.html', { waitUntil: 'load' });
    await pg.waitForFunction(() => typeof renderBrowseProductCard === 'function');
    const out = await pg.evaluate(() => ({
      rated: renderBrowseProductCard({ productId: 'p1', name: 'R', storeSlug: 'b', storeName: 'B', category: 'pantry', variants: [{ variantId: 'v', label: '1', price: 1 }], rating: 4.3, reviewCount: 7 }),
      unrated: renderBrowseProductCard({ productId: 'p2', name: 'R', storeSlug: 'b', storeName: 'B', category: 'pantry', variants: [{ variantId: 'v', label: '1', price: 1 }], rating: null, reviewCount: 0 }),
    }));
    ok('rated card shows stars', /rating-stars/.test(out.rated) && /86%/.test(out.rated), (out.rated.match(/width:[^"]*/) || [])[0]);
    ok('unrated card shows no stars', !/rating-stars/.test(out.unrated));
    await c.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Reviews & ratings (frontend) ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
