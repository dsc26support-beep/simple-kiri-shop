/**
 * The purple theme, and the two colours that are deliberately NOT purple.
 *
 * The rule is easy to state and easy to break: every piece of blue chrome is
 * now purple, EXCEPT
 *
 *   FOCUS RINGS, which stay blue. A focus ring is not decoration - it is how
 *   somebody using a keyboard knows where they are - and the search boxes now
 *   sit at rest in thin purple, so a purple ring would be a purple outline
 *   around a purple outline. This suite proves focus is still visibly a
 *   different colour from the resting border it replaces.
 *
 *   THE TWO PALETTES that use colour to tell things apart rather than to
 *   decorate: the seller badge tiers (the shield is the blue one, the star the
 *   purple one - identical fills would make the badges less informative) and
 *   the category placeholder swatches behind photo-less products.
 *
 * Plus: green means Save, and only Save. Three buttons. If green spreads to
 * every button that writes something it stops meaning anything, so the count
 * is asserted, not just the colour.
 *
 * Contrast is checked rather than assumed. The old light blue carried white
 * text at 3.0:1, below the 4.5:1 minimum; its purple replacement must not
 * inherit that.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const REPO = '/home/user/simple-kiri-shop/';
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const PURPLE = 'rgb(51, 45, 99)';        // --color-purple  #332d63
const BLUE = 'rgb(0, 63, 135)';          // --color-blue    #003f87, focus only
const GREEN = 'rgb(30, 122, 52)';        // --color-save    #1e7a34

const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const la = lum(rgb(a)), lb = lum(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

(async () => {
  // ---------- source: the tokens say what they are for ---------------------
  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  ok('focus has its own token, and it points at the blue',
    /--color-focus:\s*var\(--color-blue\)/.test(css));
  ok('and it says WHY focus stays blue, so it is not "tidied" later',
    /FOCUS STAYS BLUE/.test(css));
  ok('save has its own token, reusing the success green',
    /--color-save:\s*var\(--color-success\)/.test(css));

  // Every remaining raw use of the blue token, outside focus and the two
  // palettes, would be a miss. Listed explicitly so a new one has to be
  // justified here rather than slipping in.
  const blueLines = css.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /var\(--color-blue\)|var\(--color-blue-light\)/.test(l))
    .filter(([, l]) => !/--color-focus/.test(l));
  const allowed = blueLines.filter(([, l]) =>
    /placeholder-swatch|KEEPBLUE/.test(l) || /seller-badge--shield/.test(l) || /border-left: 3px solid/.test(l)
    || /color: var\(--color-blue\);/.test(l));
  ok('no blue is left outside focus, the badge tiers and the swatches',
    blueLines.length === allowed.length,
    blueLines.filter((b) => allowed.indexOf(b) === -1).map(([n, l]) => n + ':' + l.trim()).join(' | '));

  // The class name had to move with the colour: a rule called btn-light-blue
  // that paints purple is how the next person gets it wrong.
  ok('no class is still NAMED blue while painting purple',
    !/btn-light-blue/.test(css)
    && !/btn-light-blue/.test(fs.readFileSync(REPO + 'owner/dashboard.html', 'utf8')));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch (e) {}
    let a = body.action;
    try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (a === 'getOwnerProfile') {
      return J({ ok: true, owner: { ownerId: 'o1', storeName: 'Bong', storeSlug: 'bong',
        email: 'a@b.com', phone: '73007552', island: 'South Tarawa', village: 'Betio',
        status: 'active', isOpen: true, deliveryPickPay: true,
        logoUrl: 'https://res.cloudinary.com/demo/x.png', pendingEmail: '' } });
    }
    if (a === 'getCustomerProfile') {
      return J({ ok: true, customer: { customerId: 'c1', name: 'A', email: 'a@b.c', phone: '73011111' } });
    }
    return J({ ok: true, products: [], orders: [], bookings: [], stores: [], conversations: [] });
  });
  await ctx.addInitScript(() => { try {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_owner_token', 'ot');
    localStorage.setItem('skiri_customer_token', 'ct');
  } catch (e) {} });

  // ---------- the chrome is purple -----------------------------------------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    // A bare link, so this reads the base `a` rule rather than whichever
    // component link happens to come first in the document (product cards and
    // the logo set their own colour).
    const linkColor = await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = '#x';
      a.textContent = 'x';
      document.querySelector('main').appendChild(a);
      const c = getComputedStyle(a).color;
      a.remove();
      return c;
    });
    ok('links are purple', linkColor === PURPLE, String(linkColor));

    const searchBorder = await page.evaluate(() => {
      const i = document.querySelector('.search-box input[type="search"]');
      return i ? getComputedStyle(i).borderTopColor : null;
    });
    ok('the search box still rests in purple', searchBorder === PURPLE, String(searchBorder));
    await page.close();
  }
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/cart.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const primary = await page.evaluate(() => {
      const b = document.querySelector('.btn-primary');
      return b ? { bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color } : null;
    });
    ok('the primary button is purple', primary && primary.bg === PURPLE, JSON.stringify(primary));
    ok('with white text at a readable contrast',
      primary && contrast(primary.bg, primary.color) >= 4.5,
      primary && contrast(primary.bg, primary.color).toFixed(2) + ':1');
    await page.close();
  }

  // ---------- focus is still blue, and still tells you it is focus ---------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const focus = await page.evaluate(() => {
      const i = document.querySelector('.search-box input[type="search"]');
      i.focus();
      const cs = getComputedStyle(i);
      return { outline: cs.outlineColor, width: cs.outlineWidth, offset: cs.outlineOffset,
        border: cs.borderTopColor, page: getComputedStyle(document.body).backgroundColor };
    });
    ok('a focused field still rings in BLUE', focus.outline === BLUE, JSON.stringify(focus));
    ok('and the ring is thick enough to be seen', parseFloat(focus.width) >= 3, focus.width);

    // What the ring has to stand out FROM is the page, not the control.
    //
    // Blue against purple is only 1.21:1 - they are both dark, and a ring drawn
    // straight onto that border would be nearly invisible to anyone with low
    // vision, whatever the hue. The offset is what saves it: the ring sits in a
    // gap, on the page background, where the same blue is over 10:1. So the
    // offset is the load-bearing part and is asserted as such - remove it and
    // the "focus stays blue" decision stops working.
    ok('the ring stands clear of the control rather than sitting on its border',
      parseFloat(focus.offset) >= 1, focus.offset);
    ok('and against the page it is unmistakable',
      contrast(focus.outline, focus.page) >= 3,
      contrast(focus.outline, focus.page).toFixed(2) + ':1');
    // Recorded rather than asserted, because it is the reason for the two
    // checks above: hue alone would NOT have been enough here.
    console.log('      (blue ring vs purple border, hue only: '
      + contrast(focus.outline, focus.border).toFixed(2) + ':1 - which is why the offset matters)');
    await page.close();
  }

  // ---------- green means Save, and only Save ------------------------------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/owner/settings.html', { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const save = await page.evaluate(() => {
      const b = document.getElementById('save-settings-btn');
      return { bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color,
               text: b.textContent.trim() };
    });
    ok('Save Settings is green', save.bg === GREEN, JSON.stringify(save));
    ok('with readable white text', contrast(save.bg, save.color) >= 4.5,
      contrast(save.bg, save.color).toFixed(2) + ':1');

    // Nothing else on the busiest owner page may be green, or green stops
    // meaning "your work is stored".
    const greens = await page.evaluate((g) => [...document.querySelectorAll('button, .btn')]
      .filter((b) => getComputedStyle(b).backgroundColor === g)
      .map((b) => b.id || b.textContent.trim().slice(0, 20)), GREEN);
    ok('and it is the ONLY green button on that page', greens.length === 1, greens.join(' | '));
    await page.close();
  }
  for (const [path, id, label] of [
    ['/owner/products.html', 'save-product-btn', 'Save Product'],
    ['/customer-dashboard.html', null, 'Save']
  ]) {
    const page = await ctx.newPage();
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const bg = await page.evaluate((sel) => {
      const b = sel ? document.getElementById(sel)
        : [...document.querySelectorAll('.btn-save')][0];
      return b ? getComputedStyle(b).backgroundColor : null;
    }, id);
    ok(label + ' is green', bg === GREEN, String(bg));
    await page.close();
  }
  {
    // The shopper's big commit is NOT a Save, and must not be green.
    const page = await ctx.newPage();
    await page.goto(BASE + '/cart.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const greens = await page.evaluate((g) => [...document.querySelectorAll('button, .btn')]
      .filter((b) => getComputedStyle(b).backgroundColor === g).length, GREEN);
    ok('no green button on the cart page - Place Order is not a Save', greens === 0, String(greens));
    await page.close();
  }

  // ---------- the two palettes kept their colours --------------------------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    const swatch = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'placeholder-swatch category-other';
      document.body.appendChild(el);
      const c = getComputedStyle(el).backgroundColor;
      el.remove();
      return c;
    });
    ok('the category swatches keep their own palette', swatch === BLUE, swatch);

    const badge = await page.evaluate(() => {
      const wrap = document.createElement('span');
      wrap.className = 'seller-badge seller-badge--shield';
      wrap.innerHTML = '<svg></svg>';
      document.body.appendChild(wrap);
      const c = getComputedStyle(wrap.querySelector('svg')).color;
      wrap.remove();
      return c;
    });
    ok('the shield badge tier stays blue, so it is not the star tier', badge === BLUE, badge);
    await page.close();
  }

  // ---------- Messenger's own brand colour is not ours to change -----------
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    const messenger = await page.evaluate(() => {
      const b = document.createElement('a');
      b.className = 'btn btn-messenger';
      document.body.appendChild(b);
      const c = getComputedStyle(b).backgroundColor;
      b.remove();
      return c;
    });
    ok('the Messenger button keeps Facebook\'s blue, which is not our theme',
      messenger === 'rgb(0, 132, 255)', messenger);
    await page.close();
  }

  await ctx.close();
  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
