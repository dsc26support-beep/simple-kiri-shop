// Listing checks in the browser: the seller form (live check, suggestions,
// submit for review, category request, no false success on a dropped
// connection) and the admin review queue (metrics from the backend, case
// detail, decisions sent with the case version). Backend mocked; the real
// rules run in the page from listing-rules.js.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const SHOT = process.env.SHOT_DIR || '';

async function setup(browser, handler) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const posted = [];
  await ctx.route('**/macros/s/**', (r) => {
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    try { if (!body.action) body.action = new URL(r.request().url()).searchParams.get('action'); } catch (e) {}
    posted.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    const out = handler(body, J, r);
    if (out !== undefined) return out;
    return J({ ok: true });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('skiri_owner_token', 'tok'); localStorage.setItem('skiri_cookie_consent', 'true'); });
  return { ctx, page, posted, errs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------------- seller form ---------------- */
  let createMode = 'refuse';
  let { ctx, page, posted, errs } = await setup(browser, (body, J, r) => {
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'o1', storeSlug: 'tst', storeName: 'Test Store', storeType: 'wholesaler' } });
    if (body.action === 'listOwnerProducts') return J({ ok: true, total: 1, hasMore: false, products: [{ productId: 'p9', name: 'Water', description: 'tuna', category: 'food',
      subcategoryId: 'food-bottled-water', listingType: 'product', status: 'review', imageUrl: '', variants: [{ variantId: 'v', label: '1', price: 1, status: 'active' }],
      review: { status: 'CORRECTION_REQUIRED', adminMessage: 'Name and description must match.' } }] });
    // listCategories gets a bare {ok:true}: the form must fall back to the built-in register.
    if (body.action === 'createProduct') {
      if (createMode === 'network') return r.abort();
      if (createMode === 'refuse') {
        return J({ ok: false, error: 'Possible product mismatch.', needsReview: true, canSubmitForReview: true,
          validation: { blocked: true, severity: 'high', issues: [{ code: 'NAME_DESCRIPTION_MISMATCH', severity: 'high', blocking: true,
            message: 'Possible product mismatch. Your product name says ‘Water’, but your description refers to tuna. Please correct the product details or choose a suitable category.' }],
          suggestions: [{ categoryId: 'food', subcategoryId: 'food-canned-fish', path: 'Food & Groceries → Canned Fish & Tuna' }] } });
      }
      return J({ ok: true, productId: 'p2', held: true, reviewId: 'rev1', notes: [] });
    }
    if (body.action === 'requestCategory') return J({ ok: true, reviewId: 'rev2', message: 'Sent. An admin will look at it.' });
    return undefined;
  });
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  ok('list: a held listing says "in review" and shows the admin’s correction request',
    /in review/.test(await page.textContent('.owner-product-row .status-badge')) && /Name and description must match/.test(await page.textContent('.listing-review-line')));

  await page.click('#add-product-btn');
  await page.waitForTimeout(200);
  await page.fill('#product-name', 'Water');
  await page.fill('#product-description', 'The cheapest tuna in a can.');
  await page.selectOption('#product-listing-type', 'product');
  await page.selectOption('#product-category', 'food');
  await page.waitForTimeout(100);
  ok('subcategories appear for the chosen category', await page.isVisible('#subcategory-field')
    && (await page.$$eval('#product-subcategory option', (o) => o.map((x) => x.textContent))).includes('Bottled Water'));
  await page.selectOption('#product-subcategory', 'food-bottled-water');
  await page.waitForTimeout(500);
  let panel = await page.textContent('#listing-check');
  ok('live check while typing: the mismatch is explained before Save', /name says ‘Water’, but your description refers to tuna/.test(panel), panel);
  ok('...with the suggested category in full', /Use Food & Groceries → Canned Fish & Tuna/.test(panel));
  ok('...marked as blocking', await page.$eval('#listing-check', (b) => b.classList.contains('listing-check--high')));
  if (SHOT) await page.screenshot({ path: SHOT + '/listing-check-live.png', fullPage: true });

  await page.click('[data-apply-sub="food-canned-fish"]');
  await page.waitForTimeout(200);
  ok('Apply suggestion sets category + subcategory', (await page.inputValue('#product-category')) === 'food' && (await page.inputValue('#product-subcategory')) === 'food-canned-fish');
  panel = await page.textContent('#listing-check');
  // Moving it is not enough while the NAME still says water - the re-check now
  // says so too. Applying a category never silently clears a real conflict.
  ok('...and re-checks at once: still blocked, now because the name says water', /description refers to tuna/.test(panel)
    && /‘Water’ looks like Food & Groceries → Bottled Water/.test(panel), panel);

  await page.fill('.variant-label', 'Can');
  await page.fill('.variant-price', '2');
  await page.click('#save-product-btn');
  await page.waitForTimeout(400);
  const create1 = posted.filter((p) => p.action === 'createProduct').pop();
  ok('Save sends the subcategory and a request id', create1 && create1.subcategoryId === 'food-canned-fish' && /^[A-Za-z0-9_-]{8,}$/.test(create1.requestId), JSON.stringify(create1));
  ok('a refused save offers Submit for review, form stays open', await page.isVisible('#listing-submit-review') && await page.isVisible('#product-form-section'));
  ok('...and says nothing was saved', /Not saved yet/.test(await page.textContent('#product-form-error')));

  createMode = 'network';
  await page.fill('#listing-review-note', 'It is water, tuna is a free gift');
  await page.click('#listing-submit-review');
  await page.waitForTimeout(500);
  const create2 = posted.filter((p) => p.action === 'createProduct').pop();
  ok('30 a dropped connection shows an error, never a success', /Network error/.test(await page.textContent('#product-form-error'))
    && !/sent for review/.test(await page.textContent('#products-status')), await page.textContent('#product-form-error'));
  ok('...nothing typed is lost', (await page.inputValue('#product-name')) === 'Water');
  createMode = 'held';
  await page.click('#listing-submit-review');
  await page.waitForTimeout(600);
  const create3 = posted.filter((p) => p.action === 'createProduct').pop();
  ok('the retry reuses the same request id (no duplicate product)', create3.requestId === create2.requestId && create2.requestId !== create1.requestId);
  ok('Submit for review sends the flag and the note', create3.submitForReview === true && create3.sellerNote === 'It is water, tuna is a free gift', JSON.stringify(create3));
  ok('held: the seller is told it is hidden until checked', /sent for review.*hidden from shoppers/.test(await page.textContent('#products-status')));

  await page.click('#add-product-btn');
  await page.click('#category-request summary');
  await page.fill('#cr-name', 'Baby Formula');
  await page.selectOption('#cr-parent', 'food');
  await page.fill('#cr-explanation', 'Milk powder for babies');
  await page.fill('#cr-examples', 'S26 Gold');
  await page.click('#cr-send');
  await page.waitForTimeout(300);
  const cr = posted.filter((p) => p.action === 'requestCategory').pop();
  ok('Request a new category: sent with name, parent, explanation, examples', cr && cr.proposedName === 'Baby Formula' && cr.parentId === 'food' && cr.examples === 'S26 Gold'
    && /Sent/.test(await page.textContent('#cr-status')), JSON.stringify(cr));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('phone width: no sideways scroll', wide);
  ok('seller page: no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  /* ---------------- admin queue ---------------- */
  ({ ctx, page, posted, errs } = await setup(browser, (body, J) => {
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'a1', storeSlug: 'adm', storeName: 'Admin', isAdmin: true } });
    if (body.action === 'listReviewCases') return J({ ok: true, total: 1, page: 0, pageSize: 20, hasMore: false,
      metrics: { pending: 3, highPriority: 2, categoryRequests: 1, disputed: 1, resolvedInPeriod: 7, periodDays: 30 },
      cases: [{ reviewId: 'rev1', caseType: 'LISTING', productId: 'p1', sellerId: 'o1', storeName: 'Teaube', productName: '<b>Water</b>', categoryPath: 'Food & Groceries → Bottled Water',
        issueType: 'NAME_DESCRIPTION_MISMATCH', severity: 'high', status: 'PENDING', disputed: true, reason: 'Your name says water', submittedAt: '2026-10-09T01:00:00Z', version: 4 }] });
    if (body.action === 'getReviewCase') return J({ ok: true, case: { reviewId: 'rev1', caseType: 'LISTING', status: 'PENDING', version: 4, storeName: 'Teaube', productName: 'Water',
      descriptionSnapshot: 'The cheapest tuna in a can.', categoryPath: 'Food & Groceries → Bottled Water', selectedCategoryId: 'food', selectedSubcategoryId: 'food-bottled-water',
      sellerNote: 'tuna is a gift', suggestions: [{ id: 'food-canned-fish', path: 'Food & Groceries → Canned Fish & Tuna' }],
      validationAtSubmit: { issues: [{ severity: 'high', message: 'Possible product mismatch.' }] }, currentValidation: { issues: [{ severity: 'high', message: 'Possible product mismatch.' }] },
      product: { productId: 'p1', name: 'Water', status: 'review', categoryId: 'food', subcategoryId: 'food-bottled-water', categoryPath: 'Food & Groceries → Bottled Water', variants: [{ label: '1', price: 1 }] },
      history: [{ at: '2026-10-09T01:00:00Z', role: 'seller', from: '', to: 'PENDING', note: 'Seller submitted for review' }], otherCases: [] } });
    if (body.action === 'reviewCaseAction') return J({ ok: false, error: 'This listing still fails a check: Possible product mismatch.' });
    if (body.action === 'listStores' || body.action === 'listFeatured') return J({ ok: true, stores: [], featured: [] });
    return undefined;
  }));
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const tiles = await page.$$eval('#lr-metrics .admin-stat', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('metrics are the backend’s numbers', tiles.join('|') === '3Pending|2High priority|1Category requests|1Disputed by seller|7Resolved, last 30 days', tiles.join('|'));
  ok('product names are shown as text, not markup', (await page.$$('#lr-list strong b')).length === 0 && /<b>Water<\/b>/.test(await page.textContent('#lr-list strong')));
  await page.selectOption('#lr-severity', 'high');
  await page.waitForTimeout(300);
  const q = posted.filter((p) => p.action === 'listReviewCases').pop();
  ok('filters go to the backend', q.severity === 'high' && q.status === 'open' && q.pageSize === 20, JSON.stringify(q));
  await page.click('[data-open="rev1"]');
  await page.waitForTimeout(400);
  const detail = await page.textContent('.lr-detail');
  ok('case detail: submitted text, seller note, both checks, history', /cheapest tuna/.test(detail) && /tuna is a gift/.test(detail) && /Checked again now/.test(detail) && /Seller submitted for review/.test(detail));
  if (SHOT) await page.locator('#listing-review').screenshot({ path: SHOT + '/listing-review-admin.png' });
  await page.click('.lr-detail [data-decision="approve"]');
  await page.waitForTimeout(400);
  const a = posted.filter((p) => p.action === 'reviewCaseAction').pop();
  ok('a decision is sent with the case version and a request id', a && a.decision === 'approve' && a.expectedVersion === 4 && a.requestId, JSON.stringify(a));
  ok('a refusal from the backend is shown, not a success', /still fails a check/.test(await page.textContent('.lr-detail .lr-msg')));
  ok('admin page: no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  /* non-admin */
  ({ ctx, page, posted } = await setup(browser, (body, J) => {
    if (body.action === 'getOwnerProfile') return J({ ok: true, owner: { ownerId: 'o1', storeSlug: 's', storeName: 'S', isAdmin: false } });
    return undefined;
  }));
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  ok('a non-admin sees no queue and the page asks for none', await page.isVisible('#admin-denied') && !posted.some((p) => p.action === 'listReviewCases'));
  await ctx.close();

  await browser.close();
  let f = 0;
  console.log('\n--- listing checks: seller form + admin queue ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
