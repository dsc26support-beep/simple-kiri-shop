/**
 * The Seller Badges section of the admin page.
 *
 * THE ASSERTIONS THAT MATTER MOST
 *
 * 1. A NON-ADMIN SEES NOTHING. The page already gates on owner.isAdmin; the
 *    badge section must sit inside that gate, not beside it.
 *
 * 2. AUTO AWARDED vs ADMIN OVERRIDE IS READABLE WITHOUT COLOUR. It is the most
 *    important distinction on the page - whether a store earned a badge or
 *    someone granted it - so it is spelled out in words, not shown as a hue.
 *
 * 3. AN OVERRIDE CAN BE UNDONE. Three states, not two: granted, removed, and
 *    back to automatic.
 *
 * 4. THE SAME COMPONENT AS THE STOREFRONT. An admin checking what a shopper
 *    sees should not have to translate between two visual languages.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('PASS  ' + n + (e ? '  [' + e + ']' : '')); }
  else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); }
};

const SELLERS = [
  { ownerId: 'o1', storeName: 'Bong Store', storeSlug: 'bong', status: 'active',
    badges: ['top', 'delivery'], autoBadges: ['top', 'delivery'],
    source: { top: 'auto', delivery: 'auto' },
    why: { top: 'Score 80, 4.6 average over 12 reviews', delivery: '97% of 30 orders fulfilled' },
    suppressed: false, overrides: { verified: '', recommended: '' }, score: 80,
    metrics: { orders: 30, fulfilled: 29, cancelled: 1, reviews: 12, rating: 4.6,
               medianReplyMinutes: 40, repeatCustomers: 6, customers: 20 },
    updatedAt: '2026-09-16T00:00:00Z' },
  { ownerId: 'o2', storeName: 'Tabon Store', storeSlug: 'tabon', status: 'active',
    badges: ['verified'], autoBadges: ['recommended'],
    source: { verified: 'admin' }, why: { recommended: 'Score 91' },
    suppressed: false, overrides: { verified: 'true', recommended: 'false' }, score: 91,
    metrics: { orders: 40, fulfilled: 40, cancelled: 0, reviews: 20, rating: 4.9 },
    updatedAt: '2026-09-16T00:00:00Z' },
  { ownerId: 'o3', storeName: 'Quiet Store', storeSlug: 'quiet', status: 'active',
    badges: [], autoBadges: [], source: {}, why: {},
    suppressed: false, overrides: { verified: '', recommended: '' }, score: null,
    metrics: {}, updatedAt: '2026-09-16T00:00:00Z' }
];

async function open(browser, opts) {
  opts = opts || {};
  const posted = [];
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 900 } });
  await ctx.route('**/macros/s/**', (route) => {
    let b = {};
    try { b = route.request().postDataJSON() || {}; } catch (e) {}
    if (b.action) posted.push(b);
    let body = { ok: true };
    if (b.action === 'getOwnerProfile') {
      body = { ok: true, owner: { storeName: 'Boss', isAdmin: opts.admin !== false } };
    } else if (b.action === 'listSellerBadges') {
      body = { ok: true, sellers: SELLERS, badgeIds: ['recommended', 'top', 'verified',
        'responsive', 'delivery', 'favourite', 'popular', 'new'],
        config: { 'newSellerDays': '30', 'enabled.new': 'true', 'weight.ratings': '30',
                  'top.score': '75', 'complaints.useLowStarProxy': 'false' } };
    } else if (b.action === 'listFeatured') body = { ok: true, featured: [] };
    else if (b.action === 'setSellerBadgeOverride') body = opts.failWrite
      ? { ok: false, error: 'Not authorized' } : { ok: true };
    else if (b.action === 'setBadgeConfig') body = { ok: true };
    else if (b.action === 'recomputeBadges') body = { ok: true, sellers: 3 };
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(Object.assign({ ok: true, stores: [], products: [] }, body)) });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(() => { try {
    localStorage.setItem('skiri_owner_token', 't');
    localStorage.setItem('skiri_cookie_consent', 'true');
  } catch (e) {} });
  await page.goto(BASE + '/owner/admin.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  return { ctx, page, posted, errs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---------- a non-admin sees none of it ---------- */
  {
    const { ctx, page, posted } = await open(browser, { admin: false });
    ok('a non-admin is refused', await page.locator('#admin-denied').isVisible());
    ok('and the badge section is inside the gate, not beside it',
      await page.locator('#admin-tools').isHidden());
    ok('and the page never even asks for the badge data',
      posted.filter((b) => b.action === 'listSellerBadges').length === 0);
    await ctx.close();
  }

  /* ---------- the admin view ---------- */
  {
    const { ctx, page, errs } = await open(browser);
    ok('no JS errors', errs.length === 0, errs.join(' | '));
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.badge-admin-row')).map((r) => ({
        id: r.dataset.ownerId,
        text: r.textContent.replace(/\s+/g, ' ').trim(),
        badges: Array.from(r.querySelectorAll('.seller-badge-label')).map((e) => e.textContent.trim()),
        sources: Array.from(r.querySelectorAll('.badge-admin-source')).map((e) => e.textContent.trim()),
        selects: Array.from(r.querySelectorAll('[data-badge-field]')).map((e) => e.dataset.badgeField + '=' + e.value),
        buttons: r.querySelectorAll('button').length
      })));
    ok('every store is listed', rows.length === 3, String(rows.length));
    ok('badges render with the SHARED component, not admin-only markup',
      rows[0].badges.join(',') === 'Top Seller,Reliable Delivery', rows[0].badges.join(','));

    ok('an earned badge is labelled AUTO AWARDED',
      rows[0].sources.every((t) => t === 'AUTO AWARDED'), rows[0].sources.join(' | '));
    ok('a granted one is labelled ADMIN OVERRIDE',
      rows[1].sources.indexOf('ADMIN OVERRIDE') !== -1, rows[1].sources.join(' | '));
    ok('and the difference is WORDS, not a colour', /AUTO AWARDED/.test(rows[0].text));

    // The case an admin most needs spelled out.
    ok('a badge EARNED but hidden by an override is still shown, marked as such',
      rows[1].sources.indexOf('EARNED, NOT SHOWN') !== -1
      && rows[1].badges.indexOf('Mwakete Recommended') !== -1,
      rows[1].sources.join(' | ') + ' // ' + rows[1].badges.join(','));
    ok('with the reason it is not showing', /Removed by an admin/.test(rows[1].text));

    ok('the score and the figures behind it are shown - admin-only information',
      /80 score/.test(rows[0].text) && /30 orders/.test(rows[0].text)
      && /12 reviews/.test(rows[0].text) && /40 min median reply/.test(rows[0].text),
      rows[0].text.slice(0, 200));
    ok('a store with nothing to score says so rather than showing a zero',
      /Not enough data to score/.test(rows[2].text), rows[2].text.slice(0, 120));
    ok('and a store with no badges says that too', /No badges/.test(rows[2].text));

    ok('each store has three override states, not two',
      rows[0].selects.join(' ') === 'verified= recommended=', rows[0].selects.join(' '));
    const options = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-badge-field]')[0].options).map((o) => o.value + ':' + o.text));
    ok('granted, removed, and back to automatic',
      options.join(' | ') === ':Automatic | true:Granted | false:Removed', options.join(' | '));
    ok('and the stored state is preselected, not guessed',
      (await page.evaluate(() => {
        const r = document.querySelector('[data-owner-id="o2"]');
        return r.querySelector('[data-badge-field="verified"]').value + '/'
             + r.querySelector('[data-badge-field="recommended"]').value;
      })) === 'true/false');

    ok('the snapshot date is shown, so a stale table is visible as stale',
      /Last worked out/.test(await page.textContent('#badge-updated')));
    await ctx.close();
  }

  /* ---------- writing ---------- */
  {
    const { ctx, page, posted } = await open(browser);
    await page.selectOption('[data-owner-id="o1"] [data-badge-field="verified"]', 'true');
    await page.waitForTimeout(700);
    const sent = posted.filter((b) => b.action === 'setSellerBadgeOverride').pop();
    ok('verifying a store sends exactly the three fields the backend accepts',
      sent && sent.ownerId === 'o1' && sent.field === 'verified' && sent.value === 'true',
      JSON.stringify(sent));
    ok('with the admin token', !!(sent && sent.token));
    ok('and the table is reloaded, because a relative badge can move between stores',
      posted.filter((b) => b.action === 'listSellerBadges').length >= 2,
      String(posted.filter((b) => b.action === 'listSellerBadges').length));

    await page.selectOption('[data-owner-id="o2"] [data-badge-field="recommended"]', '');
    await page.waitForTimeout(700);
    const cleared = posted.filter((b) => b.action === 'setSellerBadgeOverride').pop();
    ok('and an override can be CLEARED back to automatic', cleared && cleared.value === '',
      JSON.stringify(cleared));

    await page.check('[data-owner-id="o1"] [data-badge-suppress]');
    await page.waitForTimeout(700);
    const sup = posted.filter((b) => b.action === 'setSellerBadgeOverride').pop();
    ok('a store can be hidden from every badge at once',
      sup && sup.field === 'suppressed' && sup.value === 'true', JSON.stringify(sup));

    await page.click('#badge-recompute-btn');
    await page.waitForTimeout(700);
    ok('and rebuilt on demand',
      posted.filter((b) => b.action === 'recomputeBadges').length === 1);
    await ctx.close();
  }

  /* ---------- a refused write says so ---------- */
  {
    const { ctx, page } = await open(browser, { failWrite: true });
    await page.selectOption('[data-owner-id="o1"] [data-badge-field="verified"]', 'true');
    await page.waitForTimeout(700);
    ok('a refused change is reported, not swallowed',
      /Not authorized/.test(await page.textContent('#badge-error')),
      await page.textContent('#badge-error'));
    ok('and the control is usable again rather than left disabled',
      await page.isEnabled('[data-owner-id="o1"] [data-badge-field="verified"]'));
    await ctx.close();
  }

  /* ---------- settings ---------- */
  {
    const { ctx, page, posted } = await open(browser);
    await page.click('.badge-config-panel > summary');
    await page.waitForTimeout(200);
    const fields = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-config-key]')).map((e) => ({
        key: e.dataset.configKey, tag: e.tagName, value: e.value })));
    ok('every setting is listed', fields.length === 5, String(fields.length));
    ok('a number is a number field and a switch is a dropdown',
      fields.filter((f) => f.tag === 'INPUT').length === 3
      && fields.filter((f) => f.tag === 'SELECT').length === 2,
      JSON.stringify(fields.map((f) => f.key + ':' + f.tag)));

    await page.fill('[data-config-key="newSellerDays"]', '45');
    await page.dispatchEvent('[data-config-key="newSellerDays"]', 'change');
    await page.waitForTimeout(700);
    const cfg = posted.filter((b) => b.action === 'setBadgeConfig').pop();
    ok('changing one sends the key and value', cfg && cfg.key === 'newSellerDays' && cfg.value === '45',
      JSON.stringify(cfg));
    await ctx.close();
  }

  /* ---------- it fits a phone ---------- */
  for (const w of [390, 1100]) {
    const { ctx, page } = await open(browser, { width: w });
    const r = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      tapTargets: Array.from(document.querySelectorAll('.badge-admin-controls select, .badge-admin-controls input'))
        .map((e) => Math.round(e.getBoundingClientRect().height))
    }));
    ok(w + 'px: the admin table does not scroll sideways', !r.overflow);
    ok(w + 'px: every control is tappable',
      r.tapTargets.length > 0 && r.tapTargets.every((h) => h >= 20), JSON.stringify(r.tapTargets));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
