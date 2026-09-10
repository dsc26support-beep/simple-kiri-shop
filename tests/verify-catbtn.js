// Was: the amber/green colour-coding on the homepage's Rentals and Services
// category buttons. Those two stopped being categories - they are listing types
// now, and a rental can sit in any category - so the buttons they tested no
// longer exist.
//
// The suite is repointed rather than deleted: its purpose was "a shopper can
// see and reach the rent/hire affordance from the homepage and the search
// page", and that is still true, via the listing-type strip.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const rgb = (s) => s.replace(/\s+/g, '');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));

  async function check(pageName, url) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#listing-type-strip .chip-strip-item');

    const strip = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#listing-type-strip .chip-strip-item')];
      return items.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }));
    });
    ok(`${pageName}: strip is All + the three listing types`,
      strip.map((i) => i.text).join('|') === 'All|Products|Rentals|Services', JSON.stringify(strip.map((i) => i.text)));
    ok(`${pageName}: Rentals links to a type-filtered search`,
      /type=rental(&|$)/.test(strip[2].href), strip[2].href);
    ok(`${pageName}: Services links to a type-filtered search`,
      /type=service(&|$)/.test(strip[3].href), strip[3].href);
    ok(`${pageName}: All carries no type filter`, !/type=/.test(strip[0].href), strip[0].href);

    const cats = await page.evaluate(() =>
      [...document.querySelectorAll('#category-strip .chip-strip-item')].map((a) => a.textContent.trim()));
    ok(`${pageName}: a category strip is present too`, cats.length > 0, JSON.stringify(cats));
    ok(`${pageName}: rentals/services are NOT offered as categories`,
      !cats.some((t) => t === 'Rentals'), JSON.stringify(cats));

    await page.close();
  }

  await check('home', BASE + '/index.html');
  await check('search', BASE + '/search.html');

  // The active chip is marked, and in the same purple the nav uses for "here".
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html?type=rental', { waitUntil: 'load' });
    await page.waitForSelector('#listing-type-strip .chip-strip-item');
    const active = await page.evaluate(() => {
      const el = document.querySelector('#listing-type-strip .chip-strip-item.is-active');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { text: el.textContent.trim(), bg: cs.backgroundColor, color: cs.color,
               current: el.getAttribute('aria-current') };
    });
    ok('the chosen type is the marked chip', active && active.text === 'Rentals', JSON.stringify(active));
    ok('marked in Mwakete purple', active && rgb(active.bg) === 'rgb(51,45,99)', active && active.bg);
    ok('white text on it', active && rgb(active.color) === 'rgb(255,255,255)', active && active.color);
    ok('and announced as the current page', active && active.current === 'page', active && active.current);
    await page.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Listing-type strip (was: category button colours) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
