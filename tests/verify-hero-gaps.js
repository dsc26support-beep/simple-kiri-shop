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
    const typeChip = r('#listing-type-strip .chip-strip-item');
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
    ok(`search: ${WANT}px from the type chips to the category chips`, gapTypeToCat === WANT, String(gapTypeToCat));
    ok('search: both gaps are equal, so the three read as a rhythm',
      gapBoxToType === gapTypeToCat, `${gapBoxToType} vs ${gapTypeToCat}`);
    ok('search: the strips are still inside the hero (the rule has something to match)',
      g.heroInHero === true);
    // The strips bleed to the screen edge with negative margins; a flex/gap
    // rewrite of the container would silently undo that alignment.
    ok('search: the first chip still lines up with the search field',
      g.typeChipLeft === g.inputLeft, `chip ${g.typeChipLeft} vs input ${g.inputLeft}`);

    // The focus ring was the visible symptom: it drew over the chips.
    await page.fill('#search-input', 'rice');
    await page.waitForTimeout(250);
    const ring = await page.evaluate(() => {
      const input = document.querySelector('.search-box input[type="search"]');
      input.focus();
      const ib = input.getBoundingClientRect();
      const chip = document.querySelector('#listing-type-strip .chip-strip-item').getBoundingClientRect();
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
    ok('home: the chip rows keep theirs', gapTypeToCat > 60, String(gapTypeToCat));
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
