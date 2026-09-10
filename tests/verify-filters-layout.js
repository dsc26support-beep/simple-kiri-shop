// Results toolbar + filter panel layout on phone and tablet.
//
// Two changes: the sort select matches the Filters button's height (it stood
// 44px beside a 36px button) while keeping its width, and Price / Delivery put
// their label BESIDE the control instead of stacked above it.
//
// The trap worth guarding is the delivery row. Beside a label there is only
// ~180px left on a 390px phone, so wrapped chips landed one per line and made
// the panel TALLER than the stacked version. It scrolls in one row instead, and
// this suite pins the row height so that regression cannot come back quietly.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const PRODUCTS = [{
  productId: 'p1', name: 'Necklace', description: 'Gold', category: 'fashion',
  listingType: 'product', imageUrls: [], storeSlug: 'a', storeName: 'A',
  variants: [{ variantId: 'v1', label: 'One', price: 20 }],
  storeDeliveryTruck: true, storeDeliveryShip: true, storeDeliveryAirCargo: true
}];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function openPanel(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route('**/macros/s/**', (route) => {
      let a = '';
      try { a = (route.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!a) a = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let body = { ok: true, products: [], stores: [] };
      if (a === 'searchProducts') body = { ok: true, products: PRODUCTS };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html?category=fashion', { waitUntil: 'load' });
    await page.waitForSelector('#results-toolbar:not([hidden])', { timeout: 6000 });
    await page.click('#filters-toggle');
    await page.waitForSelector('#filters-panel:not([hidden])');
    await page.waitForTimeout(300);
    return { ctx, page };
  }

  const probe = () => {
    const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const chips = [...document.querySelectorAll('#filter-delivery .filter-chip')]
      .map((c) => c.getBoundingClientRect());
    const strip = document.getElementById('filter-delivery');
    const btn = r('#filters-toggle'), sel = r('#results-sort');
    const pl = r('#price-range-label'), pr = r('.price-range');
    const dl = r('#delivery-filter-label');
    const panel = r('#filters-panel');
    return {
      btnH: Math.round(btn.height), selH: Math.round(sel.height), selW: Math.round(sel.width),
      toolbarW: Math.round(r('#results-toolbar').width),
      priceLabelRight: Math.round(pl.right), priceCtrlLeft: Math.round(pr.left),
      priceRowsAligned: Math.abs(pl.top - pr.top) < 44,
      delLabelRight: Math.round(dl.right),
      chipLefts: chips.map((c) => Math.round(c.left)),
      chipTops: chips.map((c) => Math.round(c.top)),
      chipCount: chips.length,
      deliveryRowH: Math.round(r('#filter-delivery-row').height),
      panelH: Math.round(panel.height),
      sliderFull: (() => {
        const sl = document.getElementById('filter-price-max');
        const p = document.getElementById('filters-panel');
        if (!sl || !p) return null;
        // Panel padding is var(--space-3) = 16px each side.
        return Math.round(sl.getBoundingClientRect().width) >= Math.round(p.getBoundingClientRect().width) - 36;
      })(),
      scrollable: strip ? strip.scrollWidth > strip.clientWidth + 1 : null,
      // Price and Delivery controls must start at the same x - that is the
      // point of using one grid column for both labels.
      ctrlColumnsAligned: Math.round(pr.left) === Math.round(chips.length ? chips[0].left : pr.left)
    };
  };

  // ---------------- phone ----------------
  {
    const { ctx, page } = await openPanel(390);
    const g = await page.evaluate(probe);

    ok('phone: the sort select is the same height as the Filters button',
      g.selH === g.btnH, `select ${g.selH} vs button ${g.btnH}`);
    ok('phone: and it is the button height, not the old 44px input height',
      g.selH === 36, String(g.selH));
    ok('phone: the select keeps its width - it still fills the rest of the row',
      g.selW > 200 && g.selW < g.toolbarW, `${g.selW} of ${g.toolbarW}`);

    // The price row STACKS now, deliberately: label and value share the line
    // above so the bar gets the panel's full width. Between them they were
    // taking ~220px of a 358px row, leaving the bar shorter than its own label.
    ok('phone: the price slider is under its label and takes the full width',
      g.priceCtrlLeft < g.priceLabelRight + 8 && g.sliderFull === true, JSON.stringify(g));
    ok('phone: the delivery chips sit beside their label too',
      g.chipCount > 0 && g.chipLefts[0] > g.delLabelRight, JSON.stringify(g));
    // Price no longer shares the delivery row's label column - it has no label
    // column at all - so the two controls are not expected to align.
    ok('phone: the delivery label column is narrow now "Delivery" is one word',
      g.delLabelRight < 140, String(g.delLabelRight));

    // The regression this exists to catch, restated. The chips were pill
    // BUTTONS and had to scroll sideways because three could not fit; as plain
    // checkboxes they wrap onto at most two short lines. What must never come
    // back is one-chip-per-line, which made the panel taller than the stacked
    // version it replaced - and nothing may be hidden behind a swipe again.
    ok('phone: the delivery chips share lines - never one per line',
      g.chipTops.length === 3 && new Set(g.chipTops).size <= 2, JSON.stringify(g.chipTops));
    ok('phone: so the delivery row costs at most two chips of height',
      g.deliveryRowH <= 110, String(g.deliveryRowH));
    ok('phone: nothing is hidden behind a sideways swipe any more',
      g.scrollable === false, String(g.scrollable));
    ok('phone: the whole panel fits well inside the screen',
      g.panelH < 320, String(g.panelH));
    await ctx.close();
  }

  // ---------------- tablet ----------------
  {
    const { ctx, page } = await openPanel(900);
    const g = await page.evaluate(probe);
    ok('tablet: same treatment - select matches the button',
      g.selH === g.btnH && g.selH === 36, `${g.selH} vs ${g.btnH}`);
    ok('tablet: delivery label still beside its checkboxes, price still full width',
      g.chipLefts[0] > g.delLabelRight && g.sliderFull === true, JSON.stringify(g));
    await ctx.close();
  }

  // ---------------- desktop is untouched ----------------
  {
    const { ctx, page } = await openPanel(1200);
    const g = await page.evaluate(probe);
    ok('desktop: the select keeps its full 44px input height',
      g.selH === 44, String(g.selH));
    ok('desktop: the delivery label stays stacked above its checkboxes',
      g.chipLefts[0] <= g.delLabelRight,
      JSON.stringify({ dl: g.delLabelRight, c: g.chipLefts[0] }));
    ok('desktop: the chips wrap freely rather than scrolling',
      g.scrollable === false, String(g.scrollable));
    ok('desktop: the price bar is full width here too', g.sliderFull === true, String(g.sliderFull));
    await ctx.close();
  }

  // ---------------- chip labels never break mid-phrase ----------------
  {
    const { ctx, page } = await openPanel(390);
    const wrap = await page.evaluate(() => {
      const chip = [...document.querySelectorAll('#filter-delivery .filter-chip')]
        .find((c) => /Boat/.test(c.textContent));
      if (!chip) return null;
      const cs = getComputedStyle(chip);
      const text = chip.lastChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      return { nowrap: cs.whiteSpace === 'nowrap', lines: range.getClientRects().length,
               label: chip.textContent.trim() };
    });
    ok('"Boat / Ship" stays on one line inside its pill',
      wrap && wrap.nowrap && wrap.lines === 1, JSON.stringify(wrap));
    await ctx.close();
  }

  await browser.close();
  console.log('\n--- Results toolbar + filter panel layout ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
