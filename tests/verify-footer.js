// Footer: only the homepage and the login pages still carry one.
//
// Rendered rather than grepped where it matters: a page whose markup lost its
// </footer> but kept the <footer> would still "not contain a footer block" by
// string search while rendering a broken page, so the browser's own parse is
// the assertion that counts.
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

const KEEP = ['index.html', 'customer-login.html', 'owner/login.html', 'owner/forgot-password.html'];

const DROP = ['store.html?store=bong', 'categories.html?q=x', 'stores.html', 'cart.html',
  'checkout.html', 'categories.html', 'my-carts.html', 'customer-tips.html',
  'customer-dashboard.html', 'customer-messages.html',
  'product.html?store=bong&product=p1',
  'owner/dashboard.html', 'owner/products.html', 'owner/orders.html',
  'owner/bookings.html', 'owner/messages.html', 'owner/settings.html'];

const MOCK = {
  ok: true, products: [], stores: [], tips: [], conversations: [], orders: [], bookings: [],
  storeName: 'Bong', storeOpen: true,
  store: { storeName: 'Bong', storeSlug: 'bong', isOpen: true,
    deliveryTruck: true, deliveryShip: false, deliveryAirCargo: false, deliveryPickPay: true,
    deliveryTruckCost: 5, deliveryShipCost: null, deliveryAirCargoCost: null }
};

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_active_store', 'bong');
  });
  await page.goto(BASE + '/' + path, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { ctx, page };
}

const probe = (page) => page.evaluate(() => {
  const f = document.querySelector('footer.site-footer');
  const here = location.pathname.replace(/^.*\//, '');
  const main = document.querySelector('main');
  return {
    hasFooter: !!f,
    footerText: f ? f.textContent.replace(/\s+/g, ' ').trim() : '',
    // A page that lost its closing tag would swallow the scripts into the
    // footer; counting them where they belong catches that.
    here,
    // The owner pages and the customer dashboard bounce to a login page when
    // there is no session. That login page legitimately keeps its footer, so a
    // probe that ignored the redirect would be reading the wrong document.
    redirectedToLogin: /login\.html$/.test(here),
    scripts: document.querySelectorAll('body > script').length,
    mainOk: !!main && main.getBoundingClientRect().height > 0,
    bodyBottom: document.body.getBoundingClientRect().bottom
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const p of KEEP) {
    const { ctx, page } = await open(browser, p);
    const r = await probe(page);
    ok(`${p}: still has a footer`, r.hasFooter);
    ok(`${p}: footer still says who owns the site`, /MainKT/.test(r.footerText), r.footerText.slice(0, 60));
    await ctx.close();
  }

  for (const p of DROP) {
    const { ctx, page } = await open(browser, p);
    const r = await probe(page);
    if (r.redirectedToLogin) {
      // Nothing to assert about this page's own footer from here; the source
      // checks below cover it. Assert the redirect itself so a page that
      // silently stopped gating would show up as a change, not as a pass.
      ok(`${p}: gated - bounced to ${r.here}, which keeps its footer`, r.hasFooter);
    } else {
      ok(`${p}: no footer`, !r.hasFooter);
      ok(`${p}: page still renders`, r.mainOk);
      ok(`${p}: scripts still direct children of body`, r.scripts > 0, `scripts=${r.scripts}`);
    }
    await ctx.close();
  }

  // --- Terms | Privacy sit on the copyright line, and actually go somewhere ---
  {
    // Derived from KEEP, not hand-listed. A hand-listed set of three missed
    // customer-login.html entirely - it has a footer, but its links row has no
    // Enquiry link, so the edit that added Terms|Privacy skipped it and this
    // suite never looked. Every page that is supposed to HAVE a footer is now
    // checked for the line, so the two lists cannot drift apart again.
    const pages = KEEP.map((f) => [f, f.indexOf('/') === -1 ? '' : '../']);
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx2.route('**/script.google.com/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page2 = await ctx2.newPage();
    for (const [file, prefix] of pages) {
      await page2.goto(BASE + '/' + file, { waitUntil: 'load' });
      await page2.waitForTimeout(700);
      const line = (await page2.textContent('.copyright') || '').replace(/\s+/g, ' ').trim();
      ok(`${file}: copyright line reads as asked`,
        line === '©MainKT Enterprises Terms | Privacy', line);
      const hrefs = await page2.$$eval('.copyright a', (as) => as.map((a) => a.getAttribute('href')));
      ok(`${file}: Terms then Privacy, both linked`,
        hrefs.length === 2 && hrefs[0] === prefix + 'terms.html' && hrefs[1] === prefix + 'privacy.html',
        JSON.stringify(hrefs));
      // The separator is decoration; a screen reader should not read "bar".
      const sepHidden = await page2.$eval('.copyright span',
        (el) => el.getAttribute('aria-hidden') === 'true').catch(() => false);
      ok(`${file}: the | is hidden from screen readers`, sepHidden);
    }
    // And they resolve - a footer link to a 404 is worse than no link.
    for (const dest of ['terms.html', 'privacy.html']) {
      await page2.goto(BASE + '/index.html', { waitUntil: 'load' });
      await page2.waitForTimeout(500);
      await page2.click(`.copyright a[href="${dest}"]`);
      await page2.waitForTimeout(800);
      ok(`clicking it opens /${dest}`, page2.url().endsWith('/' + dest), page2.url());
    }
    await ctx2.close();
  }

  await browser.close();

  // Source-level checks the DOM cannot make.
  for (const p of DROP) {
    const file = p.split('?')[0];
    const html = fs.readFileSync(REPO + file, 'utf8');
    ok(`${file}: no stray <footer or </footer> left behind`,
      html.indexOf('<footer') === -1 && html.indexOf('</footer>') === -1);
    ok(`${file}: </main> and the first <script> are one blank line apart`,
      /<\/main>\n\n  <script/.test(html) || /<\/div>\n\n  <script/.test(html),
      html.slice(html.indexOf('</main>'), html.indexOf('</main>') + 40).replace(/\n/g, '\\n'));
  }

  const sw = fs.readFileSync(REPO + 'sw.js', 'utf8');
  const main = require('child_process').execSync('git -C ' + REPO + ' show origin/main:sw.js').toString();
  const v = (s) => (s.match(/mwakete-v(\d+)/) || [])[1];
  ok('sw.js cache bumped past main (cached HTML changed)',
    Number(v(sw)) > Number(v(main)), `${v(main)} -> ${v(sw)}`);

  let f = 0;
  console.log('\n--- Footer only on home and the login pages ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})();
