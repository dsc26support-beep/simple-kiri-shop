/**
 * The Terms of Service page.
 *
 * Like verify-privacy, the point is not that a page exists but that what it
 * SAYS matches what the code DOES. A terms page that describes a different
 * marketplace than the one running is worse than none - people rely on it
 * precisely when something has gone wrong.
 *
 * So the rules it states are checked against the source: the editable order
 * statuses, the booking conflict rule, and the fact that nothing charges a fee.
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

(async () => {
  const html = fs.readFileSync(REPO + 'terms.html', 'utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const customers = fs.readFileSync(REPO + 'apps-script/Customers.gs', 'utf8');
  const bookings = fs.readFileSync(REPO + 'apps-script/Bookings.gs', 'utf8');

  // --- the single most important term ---------------------------------------
  ok('it says Mwakete never handles money', /never handles your money|cannot issue\s*refunds/i.test(text));
  ok('and that it cannot refund', /cannot issue\s*<?\/?strong>?\s*refunds|cannot issue refunds/i.test(text.replace(/\s+/g, ' ')));
  ok('and that the sale is between buyer and seller', /between\s*you and that seller/i.test(text));
  ok('the site itself still says payment is arranged between the two parties',
    /payments is arranged between Customer and Seller/i.test(fs.readFileSync(REPO + 'index.html', 'utf8')));

  // --- rules quoted must match the backend ----------------------------------
  ok('"Pending Payment" is really the only editable order status',
    /CUSTOMER_EDITABLE_ORDER_STATUSES\s*=\s*\['Pending Payment'\]/.test(customers)
    && /Pending Payment/.test(text));
  ok('"Pending" is really the only editable booking status',
    /CUSTOMER_EDITABLE_BOOKING_STATUSES\s*=\s*\['Pending'\]/.test(customers)
    && /while it is\s*Pending/i.test(text));
  ok('the booking-clash rule described matches the code: blocks only CONFIRMED',
    /conflictsConfirmed/.test(bookings)
    && /already confirmed/i.test(text));
  ok('and it says plainly that pending is not booked', /Pending is not booked/i.test(text));

  // --- fees: the page says none, so none may exist --------------------------
  const gs = fs.readdirSync(REPO + 'apps-script').filter((f) => f.endsWith('.gs'))
    .map((f) => fs.readFileSync(REPO + 'apps-script/' + f, 'utf8')).join('\n');
  ok('it says no fees are charged',
    /charges nothing|no listing\s*fee, no commission/i.test(text));
  ok('and no commission or platform fee exists in the backend',
    !/commissionRate|platformFee|serviceFeePercent|takeRate/i.test(gs));

  // --- seller cannot buy placement ------------------------------------------
  ok('it says featured placement cannot be bought by a seller',
    /cannot be bought or set by a seller/i.test(text));
  const products = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
  ok('and no public seller-facing action writes a featured flag',
    !/function actionSetFeatured|isBestValue\s*=\s*body\./i.test(products));

  // --- other terms a marketplace needs --------------------------------------
  for (const [label, re] of [
    ['reviews are public and named', /public and show\s*the name|public and show the name/i],
    ['prohibited items', /illegal in Kiribati/i],
    ['disputes are between buyer and seller', /between the two of you/i],
    ['suspension of accounts', /suspend an account/i],
    ['age', /18 or older/i],
    ['governing law', /Republic of Kiribati/i],
    ['a contact address', /admin@mwakete\.com/],
    ['shared devices', /shared device/i]
  ]) ok('the terms cover: ' + label, re.test(text));

  // --- linked from where agreement actually happens -------------------------
  ok('linked from the customer sign-in page',
    /terms\.html/.test(fs.readFileSync(REPO + 'customer-login.html', 'utf8')));
  const ownerLogin = fs.readFileSync(REPO + 'owner/login.html', 'utf8');
  ok('and from the vendor registration form, at the submit button',
    /By creating a store you agree/.test(ownerLogin) && /\.\.\/terms\.html/.test(ownerLogin));
  ok('and cross-linked with the privacy policy',
    /terms\.html/.test(fs.readFileSync(REPO + 'privacy.html', 'utf8')));
  ok('precached, so it works offline', /'terms\.html'/.test(fs.readFileSync(REPO + 'sw.js', 'utf8')));

  // --- the callout must actually be styled, not silently dropped ------------
  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  const callout = (css.match(/\.legal-callout\s*\{[^}]*\}/) || [''])[0];
  ok('the key callout uses CSS variables that exist', callout.length > 0
    && (callout.match(/var\(--[a-z0-9-]+/g) || []).every((v) => {
      const name = v.slice(4);
      return new RegExp('\\' + name + ':').test(css);
    }), callout.replace(/\s+/g, ' '));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    const resp = await page.goto(BASE + '/terms.html', { waitUntil: 'load' });
    ok(`it loads at ${width}px`, resp && resp.status() === 200, String(resp && resp.status()));
    await page.waitForTimeout(400);
    const h1 = await page.textContent('h1').catch(() => '');
    ok(`heading renders at ${width}px`, /Terms of Service/.test(h1 || ''), h1);
    const overflows = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(`no sideways scrolling at ${width}px`, overflows === false);
    // The callout is the paragraph that must not be skim-read - prove it renders
    // visibly distinct rather than collapsing to plain text.
    const styled = await page.evaluate(() => {
      const el = document.querySelector('.legal-callout');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { border: cs.borderLeftWidth, bg: cs.backgroundColor };
    });
    ok(`the key callout is visually set apart at ${width}px`,
      styled && styled.border === '4px' && styled.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(styled));
    await ctx.close();
  }
  await browser.close();

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
