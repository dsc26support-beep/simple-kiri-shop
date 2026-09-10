// The phone search bar's submit button: it arrives when you type.
//
// At rest there is nothing beside the field; the first keystroke fades in a
// purple disc with a magnifying glass. This replaces a ">" chevron that read as
// "next" rather than "search".
//
// Two things matter more than the animation. (1) The collapsed button must be
// out of the tab order - a zero-width focusable control is worse than none.
// (2) Search must still WORK from the keyboard alone at rest, because at rest
// there is no button to press.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const PAGES = [
  ['/index.html',  '#search-form',          '#search-input'],
  ['/search.html', '#search-form',          '#search-input'],
  ['/stores.html', '#stores-search-form',   '#stores-search-input'],
  ['/store.html?store=bong', '#products-search-form', '#products-search-input']
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (n, c, e) => results.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function makeCtx(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    await ctx.route('**/macros/s/**', (route) => {
      let action = '';
      try { action = (route.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let body = { ok: true };
      if (action === 'listProducts') {
        body = { ok: true, storeName: 'Bong', storeSlug: 'bong', storeOpen: true, storePhone: '73007552', products: [] };
      } else if (action === 'searchProducts') body = { ok: true, products: [] };
      else if (action === 'listStores') body = { ok: true, stores: [] };
      else if (action === 'getFeatured' || action === 'getTopStores') body = { ok: true, products: [], stores: [] };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return ctx;
  }

  // Playwright passes ONE argument to evaluate, so the two selectors travel
  // together in an object.
  const probe = ({ formSel, inputSel }) => {
    const form = document.querySelector(formSel);
    const input = document.querySelector(inputSel);
    const btn = form.querySelector('.search-submit');
    const label = btn.querySelector('.search-submit-label');
    const icon = btn.querySelector('.search-submit-icon');
    const fb = form.getBoundingClientRect();
    const ib = input.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    return {
      isEmpty: form.classList.contains('is-empty'),
      btnW: Math.round(bb.width),
      btnH: Math.round(bb.height),
      visibility: cs.visibility,
      opacity: Number(cs.opacity),
      radius: cs.borderTopLeftRadius,
      bg: cs.backgroundColor,
      iconShown: getComputedStyle(icon).display !== 'none',
      labelText: label.textContent.trim(),
      labelClipped: getComputedStyle(label).position === 'absolute',
      accName: btn.textContent.trim(),
      // How much of the row the field actually gets.
      inputW: Math.round(ib.width),
      formW: Math.round(fb.width),
      gap: getComputedStyle(form).columnGap
    };
  };

  // ---------------- phone: every page, at rest ----------------
  {
    const ctx = await makeCtx(390);
    for (const [path, formSel, inputSel] of PAGES) {
      const page = await ctx.newPage();
      await page.goto(BASE + path, { waitUntil: 'load' });
      await page.waitForSelector(`${formSel} .search-submit`, { timeout: 6000 });
      await page.waitForTimeout(350); // let the collapse transition settle
      const at = await page.evaluate(probe, { formSel, inputSel });
      const name = path.split('?')[0];

      ok(`${name}: at rest the form is marked empty`, at.isEmpty, JSON.stringify(at));
      ok(`${name}: at rest the button is collapsed to nothing`, at.btnW === 0, String(at.btnW));
      ok(`${name}: at rest the button is out of the a11y tree and tab order`,
        at.visibility === 'hidden', at.visibility);
      ok(`${name}: at rest the field takes the FULL row, gap and all`,
        at.inputW === at.formW, JSON.stringify({ input: at.inputW, form: at.formW, gap: at.gap }));
      await page.close();
    }
    await ctx.close();
  }

  // ---------------- phone: typing brings it back ----------------
  {
    const ctx = await makeCtx(390);
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('#search-form .search-submit', { timeout: 6000 });

    await page.fill('#search-input', 'r');
    await page.waitForTimeout(350);
    const typed = await page.evaluate(probe, { formSel: '#search-form', inputSel: '#search-input' });

    ok('one keystroke un-marks the form', !typed.isEmpty, JSON.stringify(typed));
    ok('the button is a 44px circle', typed.btnW === 44 && typed.btnH === 44,
      JSON.stringify({ w: typed.btnW, h: typed.btnH }));
    ok('it is round, not a pill corner', typed.radius === '999px' || parseInt(typed.radius, 10) >= 22, typed.radius);
    ok('it is Mwakete purple (#332d63)', typed.bg === 'rgb(51, 45, 99)', typed.bg);
    ok('it is fully visible and opaque', typed.visibility === 'visible' && typed.opacity === 1,
      JSON.stringify({ v: typed.visibility, o: typed.opacity }));
    ok('the magnifying glass is drawn', typed.iconShown, String(typed.iconShown));
    ok('the word "Search" is clipped, not deleted',
      typed.labelText === 'Search' && typed.labelClipped, JSON.stringify(typed));
    ok('so the button still announces as "Search"', typed.accName === 'Search', typed.accName);
    ok('the field gives up room for it', typed.inputW < typed.formW - 44, JSON.stringify({ i: typed.inputW, f: typed.formW }));

    // Clearing puts it away again.
    await page.fill('#search-input', '');
    await page.waitForTimeout(350);
    const cleared = await page.evaluate(probe, { formSel: '#search-form', inputSel: '#search-input' });
    ok('clearing the field collapses it again', cleared.isEmpty && cleared.btnW === 0, JSON.stringify(cleared));

    // Whitespace is not a search term.
    await page.fill('#search-input', '   ');
    await page.waitForTimeout(250);
    const spaces = await page.evaluate(probe, { formSel: '#search-form', inputSel: '#search-input' });
    ok('spaces alone do not summon the button', spaces.isEmpty, JSON.stringify(spaces));

    // The collapsed button must not be reachable by keyboard.
    await page.fill('#search-input', '');
    await page.waitForTimeout(250);
    const focusPath = await page.evaluate(() => {
      document.getElementById('search-input').focus();
      const before = document.activeElement.id;
      const btn = document.querySelector('#search-form .search-submit');
      btn.focus();
      return { before, landedOnButton: document.activeElement === btn };
    });
    ok('a collapsed button cannot even be focused programmatically',
      focusPath.before === 'search-input' && !focusPath.landedOnButton, JSON.stringify(focusPath));

    await ctx.close();
  }

  // ---------------- search still works with no button on screen ----------------
  {
    const ctx = await makeCtx(390);
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForSelector('#search-form .search-submit', { timeout: 6000 });
    // Type and press Enter without ever touching the button.
    await page.click('#search-input');
    await page.keyboard.type('rice');
    await page.keyboard.press('Enter');
    await page.waitForURL(/search\.html/, { timeout: 6000 }).catch(() => {});
    ok('Enter alone still runs the search - the button is never required',
      /search\.html/.test(page.url()) && /q=rice/.test(page.url()), page.url());
    await ctx.close();
  }

  // ---------------- arriving with ?q= shows it immediately ----------------
  {
    const ctx = await makeCtx(390);
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html?q=rice', { waitUntil: 'load' });
    await page.waitForSelector('#search-form .search-submit', { timeout: 6000 });
    const shifted = [];
    // A prefilled query must NOT flash the collapsed state and then pop in -
    // sample straight after load, before any transition could finish.
    const early = await page.evaluate(probe, { formSel: '#search-form', inputSel: '#search-input' });
    await page.waitForTimeout(350);
    const settled = await page.evaluate(probe, { formSel: '#search-form', inputSel: '#search-input' });
    ok('arriving at ?q=rice shows the button with no empty flash',
      !early.isEmpty && !settled.isEmpty, JSON.stringify({ early: early.isEmpty, settled: settled.isEmpty }));
    ok('and it is the 44px purple disc', settled.btnW === 44 && settled.bg === 'rgb(51, 45, 99)',
      JSON.stringify(settled));
    await ctx.close();
  }

  // ---------------- desktop is untouched ----------------
  {
    const ctx = await makeCtx(1100);
    const page = await ctx.newPage();
    await page.goto(BASE + '/search.html', { waitUntil: 'load' });
    await page.waitForSelector('#search-form .search-submit', { timeout: 6000 });
    await page.waitForTimeout(250);
    const wide = await page.evaluate(probe, { formSel: '#search-form', inputSel: '#search-input' });
    ok('desktop still shows the written "Search" pill even with an empty field',
      wide.btnW > 60 && wide.visibility === 'visible', JSON.stringify(wide));
    ok('desktop keeps the blue .btn-primary, not the phone purple',
      wide.bg === 'rgb(0, 63, 135)', wide.bg);
    ok('desktop draws no magnifier', !wide.iconShown, String(wide.iconShown));
    ok('desktop label is not clipped', !wide.labelClipped, String(wide.labelClipped));
    await ctx.close();
  }

  // ---------------- the old chevron is gone everywhere ----------------
  {
    const fs = require('fs');
    const css = fs.readFileSync('/home/user/simple-kiri-shop/assets/css/styles.css', 'utf8');
    ok('the ">" chevron rule is gone from the stylesheet', !/content:\s*">"/.test(css));
    ok('the font-size:0 label hack is gone', !/\.search-box button\[type="submit"\]/.test(css));
    ok('reduced motion is respected for BOTH states',
      /prefers-reduced-motion[\s\S]{0,200}\.search-box\.is-empty \.search-submit/.test(css));
  }

  await browser.close();
  console.log('\n--- Search submit: arrives when you type ---');
  let failed = 0;
  for (const [st, n, e] of results) { if (st === 'FAIL') failed++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
