const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();

  // Mock every Apps Script POST: getOwnerProfile (auth guard) + listOwnerProducts.
  await ctx.route('**/macros/s/**', (route) => {
    let action = '';
    try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
    let body = { ok: true };
    if (action === 'getOwnerProfile') body = { ok: true, owner: { storeName: 'Test Store' } };
    else if (action === 'listOwnerProducts') body = { ok: true, products: [], total: 0, hasMore: false };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const page = await ctx.newPage();
  // Seed the owner token before any script runs so guardOwnerAuth proceeds.
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 'test-token'); } catch (e) {} });
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });

  const results = [];
  const ok = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, extra || '']);

  // Open the Add form
  await page.click('#add-product-btn');
  await page.waitForSelector('#product-form-section:not(.hidden)');

  ok('category select is required', await page.getAttribute('#product-category', 'required') !== null);
  ok('category opens with no selection (value="")', (await page.$eval('#product-category', el => el.value)) === '');
  // 'general' became 'other' in the new taxonomy. The guarantee that matters is
  // unchanged and is what this now asserts: there is ALWAYS a fallback category,
  // so no listing can be un-fileable.
  ok('Other is always selectable as a fallback',
    (await page.$$eval('#product-category option', os => os.map(o => o.value))).includes('other'));
  ok('the retired legacy ids are no longer offered to sellers',
    !(await page.$$eval('#product-category option', os => os.map(o => o.value)))
      .some((v) => ['general', 'pantry', 'clothing', 'household', 'rentals'].includes(v)));

  const sectionLabel = () => page.$eval('#varieties-label', el => el.textContent.trim());
  const firstRowLabel = () => page.$eval('#variant-rows .variant-row .variant-label', el => el.closest('.field').querySelector('label').textContent.trim());

  // Default (goods) - before choosing, placeholder value '' => goods labels
  ok('default section label', (await sectionLabel()) === 'Varieties & Prices', await sectionLabel());
  // The "(e.g. ...)" examples moved into each input's placeholder, so the label
  // is now the noun alone. verify-variety.js covers the placeholders.
  ok('default row label', (await firstRowLabel()) === 'Variety', await firstRowLabel());

  // The variety labels used to be driven by the category ('rentals'/'services').
  // Those became listing types, so the labels follow the type select now - the
  // category no longer decides how a listing behaves.
  async function pick(listingType) {
    await page.selectOption('#product-listing-type', listingType);
  }

  await pick('rental');
  ok('rentals section label', (await sectionLabel()) === 'Rental Durations & Prices', await sectionLabel());
  ok('rentals row label', (await firstRowLabel()) === 'Duration', await firstRowLabel());

  // Add a second row while on rentals - it should also be labelled Duration
  await page.click('#add-variant-btn');
  const rowLabels = await page.$$eval('#variant-rows .variant-row .variant-label', els => els.map(e => e.closest('.field').querySelector('label').textContent.trim()));
  ok('new row on rentals also Duration', rowLabels.length === 2 && rowLabels.every(t => t.startsWith('Duration')), JSON.stringify(rowLabels));

  await pick('service');
  ok('services section label', (await sectionLabel()) === 'Services & Prices', await sectionLabel());
  ok('services row label', (await firstRowLabel()) === 'Service Name', await firstRowLabel());
  const svcLabels = await page.$$eval('#variant-rows .variant-row .variant-label', els => els.map(e => e.closest('.field').querySelector('label').textContent.trim()));
  ok('all existing rows relabelled on switch', svcLabels.every(t => t.startsWith('Service Name')), JSON.stringify(svcLabels));

  await pick('product');
  ok('goods revert section label', (await sectionLabel()) === 'Varieties & Prices', await sectionLabel());
  ok('goods revert row label', (await firstRowLabel()) === 'Variety', await firstRowLabel());

  await browser.close();

  console.log('\n--- owner product form verification ---');
  let failed = 0;
  for (const [st, name, extra] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
