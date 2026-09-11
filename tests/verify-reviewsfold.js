// The reviews block on product.html folds away.
//
// It is shut on arrival, which is the risky part: collapsing reviews hides the
// most persuasive thing on a product page. So the assertions come in two
// halves - it really is small when shut, AND the score is still readable
// without opening it. A tidy page that hides "4.5 from 12 people" is a worse
// page.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const P = [{ productId: 'p1', name: 'Brocolli Chop with Noodle', description: 'Aio are nai kangkang',
  category: 'food', listingType: 'product', imageUrls: [], storeSlug: 'a', storeName: 'A',
  variants: [{ variantId: 'v1', label: 'small', price: 8 }] }];
const REVIEWS = [
  { rating: 5, customerName: 'Teiti', comment: 'Very good', createdAt: '2026-09-01T00:00:00Z', verifiedPurchase: true },
  { rating: 4, customerName: 'Nei Bwaie', comment: 'Nice', createdAt: '2026-09-02T00:00:00Z' }
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(rating, width = 390) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => {
      let a = '';
      try { a = (r.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let body = { ok: true };
      if (a === 'listProducts') body = { ok: true, storeName: 'A', storeSlug: 'a', storeOpen: true, products: P };
      else if (a === 'listProductReviews') body = Object.assign({}, rating, { reviews: rating.count ? REVIEWS : [] });
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/product.html?store=a&product=p1', { waitUntil: 'load' });
    await page.waitForSelector('#reviews-section:not([hidden])', { timeout: 6000 });
    await page.waitForTimeout(400);
    return { ctx, page, errors };
  }

  const state = () => {
    const d = document.getElementById('reviews-section');
    const sum = document.querySelector('.reviews-toggle');
    const score = document.getElementById('reviews-toggle-score');
    const form = document.querySelector('.review-form, .review-signin-prompt');
    // NOT height > 0. Chrome hides a closed <details>'s contents with
    // content-visibility, so the children keep a layout box and measure
    // non-zero while being invisible and unreachable. checkVisibility is the
    // one that answers "can a person see this".
    const vis = (e) => !!e && e.checkVisibility({
      contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true
    });
    return {
      open: d.open,
      height: Math.round(d.getBoundingClientRect().height),
      toggleHeight: Math.round(sum.getBoundingClientRect().height),
      title: document.querySelector('.reviews-toggle-title').textContent.trim(),
      score: score.textContent.trim(),
      formVisible: vis(form),
      listVisible: vis(document.querySelector('.review-item')),
      // How far the "no reviews"/summary line sits below the toggle.
      gapUnderToggle: (() => {
        const first = document.querySelector('.reviews-body .helper-text, .reviews-average');
        if (!first) return null;
        return Math.round(first.getBoundingClientRect().top - sum.getBoundingClientRect().bottom);
      })()
    };
  };

  // ---------------- a product with no reviews ----------------
  {
    const { ctx, page, errors } = await open({ ok: true, average: 0, count: 0 });
    const shut = await page.evaluate(state);
    ok('empty: the section starts shut', shut.open === false, JSON.stringify(shut));
    ok('empty: shut, it is one row, not a panel', shut.height < 70, String(shut.height));
    ok('empty: the toggle is a comfortable tap target', shut.toggleHeight >= 44, String(shut.toggleHeight));
    ok('empty: the toggle says there are no reviews', /No reviews yet/i.test(shut.score), shut.score);
    ok('empty: the form is not on screen', shut.formVisible === false, String(shut.formVisible));

    await page.click('.reviews-toggle');
    await page.waitForTimeout(250);
    const opened = await page.evaluate(state);
    ok('empty: tapping opens it', opened.open === true && opened.height > shut.height, JSON.stringify(opened));
    ok('empty: and the sign-in prompt appears', opened.formVisible === true);
    ok('empty: the heading and the first line sit tight together',
      opened.gapUnderToggle !== null && opened.gapUnderToggle <= 8, String(opened.gapUnderToggle));
    // The toggle already says it - saying it twice is the thing to avoid.
    const body = await page.textContent('.reviews-body');
    ok('empty: "No reviews yet" is not repeated inside the body',
      !/No reviews yet/i.test(body), body.trim().slice(0, 60));
    ok('empty: but the body still invites a first review',
      /Be the first to review/i.test(body), body.trim().slice(0, 60));

    await page.click('.reviews-toggle');
    await page.waitForTimeout(250);
    const reshut = await page.evaluate(state);
    ok('empty: tapping again shuts it', reshut.open === false, JSON.stringify(reshut));
    ok('empty: no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---------------- a product WITH reviews ----------------
  {
    const { ctx, page } = await open({ ok: true, average: 4.5, count: 12, distribution: [0, 0, 1, 4, 7] });
    const shut = await page.evaluate(state);

    ok('rated: still starts shut', shut.open === false, JSON.stringify(shut));
    // THE ONE THAT MATTERS.
    ok('rated: the score is readable WITHOUT opening it',
      /4\.5/.test(shut.score) && /12 review/.test(shut.score), shut.score);
    ok('rated: shut is still one row', shut.height < 70, String(shut.height));
    ok('rated: the reviews themselves are not on screen while shut',
      shut.listVisible === false, String(shut.listVisible));

    await page.click('.reviews-toggle');
    await page.waitForTimeout(250);
    const opened = await page.evaluate(state);
    ok('rated: opening reveals the individual reviews', opened.listVisible === true);
    ok('rated: and the rating bars', opened.gapUnderToggle !== null, String(opened.gapUnderToggle));
    const seen = await page.textContent('.reviews-list');
    ok('rated: a reviewer name and comment render', /Teiti/.test(seen) && /Very good/.test(seen));
    await ctx.close();
  }

  // ---------------- the browser's default triangle is gone ----------------
  {
    const { ctx, page } = await open({ ok: true, average: 0, count: 0 });
    const marker = await page.evaluate(() => {
      const s = document.querySelector('.reviews-toggle');
      return { listStyle: getComputedStyle(s).listStyleType,
               after: getComputedStyle(s, '::after').content };
    });
    ok('the default disclosure triangle is suppressed', marker.listStyle === 'none', marker.listStyle);
    ok('and a chevron is drawn instead', marker.after !== 'none', marker.after);
    await ctx.close();
  }

  // ---------------- desktop gets the same treatment ----------------
  {
    const { ctx, page } = await open({ ok: true, average: 4.5, count: 12, distribution: [0, 0, 1, 4, 7] }, 1280);
    const shut = await page.evaluate(state);
    ok('desktop: shut too, with the score on the row',
      shut.open === false && /4\.5/.test(shut.score), JSON.stringify(shut));
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- Reviews fold ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
