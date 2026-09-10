// Spacing in the search page's hero.
//
// The search box and both chip strips live in one .hero container, and nothing
// separated them: the box's bottom edge and the first chip's top edge were at
// exactly the same y. That is why the field's focus ring drew on top of the
// chips. 24px between each of the three now.
//
// The trap this guards is reach: index.html keeps its strips in their own
// sections OUTSIDE the hero, already 88px and 99px clear. A rule that leaked
// onto the homepage would add space where there is plenty and push the trending
// products off the first screen.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const WANT = 24;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: [], stores: [] })
  }));

  const geometry = () => {
    const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const box = r('.search-box');
    // The listing-type strip that used to sit here is gone, so the first chip
    // below the search box is now the category one. The gap being measured is
    // the same gap - it just has a different neighbour.
    const typeChip = r('#category-strip .chip-strip-item');
    const catChip = r('#category-strip .chip-strip-item');
    const input = r('.search-box input[type="search"]');
    return {
      boxBottom: box && box.bottom,
      typeTop: typeChip && typeChip.top,
      typeBottom: typeChip && typeChip.bottom,
      catTop: catChip && catChip.top,
      inputLeft: input && Math.round(input.left),
      typeChipLeft: typeChip && Math.round(typeChip.left),
      heroInHero: !!document.querySelector('.hero .chip-strip')
    };
  };

  // ---------------- search page ----------------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html', { waitUntil: 'load' });
    await page.waitForSelector('#category-strip .chip-strip-item', { timeout: 6000 });
    await page.waitForTimeout(300);
    const g = await page.evaluate(geometry);

    const gapBoxToType = Math.round(g.typeTop - g.boxBottom);
    const gapTypeToCat = Math.round(g.catTop - g.typeBottom);

    ok('search: the box no longer touches the chips', gapBoxToType > 0, String(gapBoxToType));
    ok(`search: ${WANT}px from the search box to the type chips`, gapBoxToType === WANT, String(gapBoxToType));
    // There used to be a second assertion here for the gap between the
    // listing-type chips and the category chips, and a third that the two gaps
    // matched so box/types/categories read as one rhythm. The type strip is
    // gone, so there is one gap left and nothing to rhyme it with.
    ok('search: the strips are still inside the hero (the rule has something to match)',
      g.heroInHero === true);
    // The strip bleeds to the screen edge with a negative margin and matching
    // padding, and scroll-padding-left keeps snapping from undoing that. This
    // used to fail: a strip wide enough to scroll snapped its first chip flush
    // to x=0 while the field above kept its 16px gutter. It went unnoticed
    // because the assertion pointed at the listing-type strip, which was narrow
    // enough never to scroll or snap.
    const aligned = await page.evaluate(() => {
      const strip = document.getElementById('category-strip');
      const chip = strip.querySelector('.chip-strip-item').getBoundingClientRect();
      const input = document.querySelector('.search-box input[type="search"]').getBoundingClientRect();
      return { chip: Math.round(chip.left), input: Math.round(input.left), scrollable: strip.scrollWidth > strip.clientWidth };
    });
    ok('search: the strip really is wide enough to scroll, so snapping applies',
      aligned.scrollable, 'strip does not overflow - assertion below is vacuous');
    ok('search: the first chip still lines up with the search field',
      aligned.chip === aligned.input, `chip ${aligned.chip} vs input ${aligned.input}`);

    // The focus ring was the visible symptom: it drew over the chips.
    await page.fill('#search-input', 'rice');
    await page.waitForTimeout(250);
    const ring = await page.evaluate(() => {
      const input = document.querySelector('.search-box input[type="search"]');
      input.focus();
      const ib = input.getBoundingClientRect();
      const chip = document.querySelector('#category-strip .chip-strip-item').getBoundingClientRect();
      const w = parseFloat(getComputedStyle(input).outlineWidth) || 0;
      const off = parseFloat(getComputedStyle(input).outlineOffset) || 0;
      return { ringBottom: ib.bottom + w + off, chipTop: chip.top };
    });
    ok('search: a focused field\'s ring clears the chips below it',
      ring.ringBottom <= ring.chipTop, JSON.stringify(ring));
    await page.close();
  }

  // ---------------- home page must not move ----------------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('#category-strip .chip-strip-item', { timeout: 6000 });
    await page.waitForTimeout(300);
    const g = await page.evaluate(geometry);
    const gapBoxToType = Math.round(g.typeTop - g.boxBottom);
    const gapTypeToCat = Math.round(g.catTop - g.typeBottom);

    ok('home: its strips are NOT inside the hero, so the rule cannot reach them',
      g.heroInHero === false, String(g.heroInHero));
    // Section-level spacing, unchanged: generous and nothing to fix.
    ok('home: the search box keeps its existing room (well over 24px)',
      gapBoxToType > 60, String(gapBoxToType));
    // Was: the gap between the two chip rows on the homepage. One row now.
    await page.close();
  }

  // ---------------- desktop ----------------
  {
    const wide = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await wide.route('**/macros/s/**', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: [], stores: [] })
    }));
    const page = await wide.newPage();
    await page.goto(BASE + '/search.html', { waitUntil: 'load' });
    await page.waitForSelector('#category-strip .chip-strip-item', { timeout: 6000 });
    await page.waitForTimeout(300);
    const g = await page.evaluate(geometry);
    ok('desktop: the search page gets the same separation, not a phone-only patch',
      Math.round(g.typeTop - g.boxBottom) === WANT, String(Math.round(g.typeTop - g.boxBottom)));
    await wide.close();
  }

  await browser.close();
  console.log('\n--- Search hero spacing ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
