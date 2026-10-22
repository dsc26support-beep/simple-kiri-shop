/**
 * Product form layout (owner request, Oct 2026, after a template the owner
 * liked): the form opens as its own view with "Back to products", each
 * section is a card, a big photo tile, "$" inside the price box, one solid
 * main button, the buttons pinned to the bottom of the screen (above the
 * phone tab bar), two columns for Quick add on a wide screen, and no
 * sideways scroll at any width.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 400);

const PRODUCTS = [
  { productId: 'p_rice', name: 'Jasmine rice 1kg', description: 'Long grain', category: 'food', listingType: 'product', status: 'active', productType: 'single',
    images: [], details: { netQuantity: '1kg' }, variants: [{ variantId: 'v_rice', label: 'Standard', price: 3, stockQty: 10, status: 'active' }] }
];
const OWNER = { ownerId: 'o1', storeName: 'Bong Store', storeType: 'retailer', island: 'Abaiang', deliveryPickPay: true, deliveryTruck: true, deliveryTruckCost: 5 };

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const posted = [];
  await ctx.route('**/macros/s/**', (route) => {
    let b = {}; try { b = route.request().postDataJSON() || {}; } catch (e) {}
    if (b.action) posted.push(b);
    const reply = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (b.action === 'getOwnerProfile') return reply({ ok: true, owner: Object.assign({}, OWNER, opts.owner || {}) });
    if (b.action === 'listOwnerProducts') return reply({ ok: true, products: PRODUCTS, total: PRODUCTS.length, hasMore: false, photoMax: 6 });
    if (b.action === 'findSimilarProducts') return reply({ ok: true, similar: /rice/i.test(b.name) && !/25kg/i.test(b.name) ? [{ productId: 'p_rice', name: 'Jasmine rice 1kg', status: 'active' }] : [] });
    if (b.action === 'createProduct') return reply({ ok: true, productId: 'p_new', notes: [] });
    if (b.action === 'updateProduct') return reply({ ok: true, productId: b.productId, notes: [] });
    return reply({ ok: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((pref) => { try {
    localStorage.setItem('skiri_owner_token', 'test-token'); localStorage.setItem('skiri_cookie_consent', 'true');
    if (pref) localStorage.setItem('mwk_pform_mode', pref);
  } catch (e) {} }, opts.pref || '');
  await page.goto(BASE + '/owner/products.html', { waitUntil: 'load' });
  await page.waitForSelector('.owner-product-row', { timeout: 6000 });
  return { ctx, page, posted, errors };
}
const cont = async (page) => { await page.click('#pf-next'); await page.waitForFunction(() => !document.getElementById('pf-next').disabled); await page.waitForTimeout(60); };
const visibleSteps = (page) => page.$$eval('.pf-step', (els) => els.filter((e) => !e.hidden).map((e) => Number(e.dataset.step)));
const shown = (page, sel) => page.locator(sel).isVisible();
const fillBasics = async (page, name, cat) => {
  await page.fill('#product-name', name);
  await page.selectOption('#product-listing-type', 'product');
  await page.selectOption('#product-category', cat || 'food');
};

const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- phone: its own view, the tile, $, the pinned buttons ----------
  {
    const { ctx, page, errors } = await open(browser, { pref: 'steps' });
    await page.click('#add-product-btn'); await page.waitForTimeout(300);
    const v = await page.evaluate(() => ({ list: !!document.getElementById('owner-product-list').offsetParent, h1: !!document.querySelector('#products-main > h1').offsetParent,
      add: !!document.getElementById('add-product-btn').offsetParent, back: document.getElementById('cancel-product-btn').textContent.trim(), heading: document.getElementById('product-form-heading').textContent }));
    ok('Add opens the form as its own view: the list, title and Add buttons step aside', !v.list && !v.h1 && !v.add && v.heading === 'Add Product', J(v));
    ok('...with "Back to products" at the top', /Back to products/.test(v.back) && (await box(page, '#cancel-product-btn')).b <= (await box(page, '#product-form-heading')).t + 1, J(v));
    const card = await page.$eval('#pf-step-1', (el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, border: c.borderTopWidth, radius: c.borderTopLeftRadius }; });
    const legendIn = (await box(page, '#pf-step-1 .pf-step-title')).t > (await box(page, '#pf-step-1')).t + 4;
    ok('each section is a white card, its title inside it', card.bg === 'rgb(255, 255, 255)' && card.border === '1px' && card.radius !== '0px' && legendIn, J(card));
    const bar = await box(page, '.pf-actions');
    ok('the buttons are pinned just above the tab bar', Math.abs(bar.b - (844 - 56)) <= 2, J(bar));
    const btns = await page.evaluate(() => ['pf-next', 'save-product-btn'].map((id) => { const c = getComputedStyle(document.getElementById(id)); return { bg: c.backgroundColor, color: c.color }; }));
    ok('Continue is the one solid button; Save is quieter until Review', btns[0].bg === 'rgb(55, 48, 107)' || (btns[0].bg !== 'rgb(255, 255, 255)' && btns[0].color === 'rgb(255, 255, 255)'), J(btns));
    ok('...and Save is outlined, not solid', btns[1].color !== 'rgb(255, 255, 255)', J(btns));
    const barOneRow = await page.evaluate(() => { const bs = Array.from(document.querySelectorAll('.pf-actions .btn')).filter((b) => b.offsetParent); return new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size === 1; });
    ok('...on one row', barOneRow);
    const tab = await page.$eval('.pf-progress-btn[data-go="3"]', (b) => ({ text: b.innerText.trim(), cut: b.scrollWidth > b.clientWidth + 1 }));
    ok('the step tab reads "Price", not "Price &…"', tab.text === 'Price' && !tab.cut, J(tab));
    await page.fill('#product-name', 'Jasmine rice 25kg'); await page.selectOption('#product-listing-type', 'product'); await page.selectOption('#product-category', 'food');
    await page.click('#pf-next'); await page.waitForTimeout(400);
    const tile = await box(page, '#photo-add-row');
    ok('Photos: a big tile while there are none', tile.h >= 185 && tile.w > 300, J(tile));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.mouse.click(tile.l + 20, tile.b - 15)]);
    ok('...a tap anywhere on it opens the photo picker, several at once', !!chooser && chooser.isMultiple(), String(!!chooser));
    await page.click('#pf-next'); await page.waitForTimeout(300);
    await page.check('input[name="productType"][value="single"]').catch(() => {});
    const sign = await box(page, '#single-fields .input-money-sign'); const input = await box(page, '#single-price');
    ok('Price: "$" sits inside the box, before the number', sign.l > input.l && sign.r < input.l + 40 && sign.t > input.t && sign.b < input.b, J({ sign, input }));
    await page.click('label[for="single-price"]');
    ok('...and the label still focuses the box', await page.evaluate(() => document.activeElement.id === 'single-price'));
    await page.fill('#single-price', '24.50');
    await page.click('#pf-next'); await page.click('#pf-next'); await page.waitForTimeout(300);
    const save = await page.$eval('#save-product-btn', (b) => getComputedStyle(b).color);
    ok('On Review, Save Product is the solid (green) button', save === 'rgb(255, 255, 255)', save);
    await page.click('#cancel-product-btn'); await page.waitForTimeout(200);
    const back = await page.evaluate(() => ({ list: !!document.getElementById('owner-product-list').offsetParent, form: !document.getElementById('product-form-section').classList.contains('hidden'), y: scrollY }));
    ok('Back to products shows the list again, from the top', back.list && !back.form && back.y === 0, J(back));
    await page.click('.owner-product-row [data-action="edit"]'); await page.waitForTimeout(300);
    ok('Edit opens the same way', await page.evaluate(() => !document.getElementById('owner-product-list').offsetParent && /^Edit:/.test(document.getElementById('product-form-heading').textContent)));
    ok('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  }

  // ---------- computer: two columns for Quick add, pinned bar at the bottom ----------
  {
    const { ctx, page } = await open(browser, { viewport: { width: 1366, height: 900 }, pref: 'page' });
    await page.click('#add-product-btn'); await page.waitForTimeout(300);
    const s = {}; for (const i of [1, 2, 3, 4, 5]) s[i] = await box(page, '#pf-step-' + i);
    ok('1366px Quick add: Basics, Price and Details on the left; Photos and Review on the right',
      s[2].l > s[1].r && s[5].l > s[3].r && Math.abs(s[2].t - s[1].t) < 2 && s[5].t < s[3].t && s[3].t > s[1].b && s[4].t > s[3].b, J(s));
    ok('...the right column is narrower', s[2].w < s[1].w, J([s[1].w, s[2].w]));
    const bar = await box(page, '.pf-actions');
    ok('...the buttons are pinned to the bottom of the screen', Math.abs(bar.b - 900) <= 2, J(bar));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, { viewport: { width: 1366, height: 900 }, pref: 'steps' });
    await page.click('#add-product-btn'); await page.waitForTimeout(300);
    const form = await box(page, '#product-form');
    const cut = await page.$$eval('.pf-progress-btn', (bs) => bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent));
    ok('1366px Step by step: one readable column, step names in full', form.w <= 770 && cut.length === 0
      && await page.$eval('.pf-progress-btn[data-go="3"]', (b) => b.innerText.trim()) === 'Price & stock', J({ w: form.w, cut }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, { viewport: { width: 1024, height: 768 }, pref: 'page' });
    await page.click('#add-product-btn'); await page.waitForTimeout(300);
    const a = await box(page, '#pf-step-1'), b = await box(page, '#pf-step-2');
    ok('1024px Quick add: one column (too narrow for two)', b.t > a.b && Math.abs(a.l - b.l) < 2, J({ a, b }));
    await ctx.close();
  }

  // ---------- no sideways scroll ----------
  for (const w of [360, 390, 768, 1024, 1366, 1920]) {
    for (const pref of ['steps', 'page']) {
      const { ctx, page } = await open(browser, { viewport: { width: w, height: 900 }, pref });
      await page.click('#add-product-btn'); await page.waitForTimeout(250);
      await page.selectOption('#product-listing-type', 'product'); await page.selectOption('#product-category', 'food');
      if (pref === 'steps') { await page.fill('#product-name', 'Rice'); await page.click('#pf-next'); await page.waitForTimeout(300); await page.click('#pf-next'); await page.waitForTimeout(200); }
      await page.check('input[name="productType"][value="options"]').catch(() => {});
      const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      ok(`${w}px ${pref}: no sideways scroll`, !over);
      await ctx.close();
    }
  }

  await browser.close();
  let f = 0; console.log('\n--- product form layout ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e && st === 'FAIL' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
