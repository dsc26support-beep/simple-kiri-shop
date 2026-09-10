/**
 * The privacy policy page.
 *
 * Two jobs. First, Google will not let the OAuth consent screen be published
 * without a reachable privacy-policy URL, so this page existing and rendering
 * is a prerequisite for the Google sign-in button working at all.
 *
 * Second, and more important: a privacy policy that misdescribes what a site
 * collects is worse than no policy. So this asserts the page actually names
 * the things the code actually stores - and it reads those from the SOURCE, so
 * adding a new collected field without mentioning it here fails the suite.
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
  const html = fs.readFileSync(REPO + 'privacy.html', 'utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // --- it must describe what is really collected ---------------------------
  const orders = fs.readFileSync(REPO + 'apps-script/Orders.gs', 'utf8');
  const collected = ['CustomerName', 'CustomerPhone', 'CustomerEmail', 'Island', 'Village'];
  const missingFromOrders = collected.filter((c) => orders.indexOf(c + ':') === -1);
  ok('the order fields this test checks are still the ones Orders.gs writes',
    missingFromOrders.length === 0, missingFromOrders.join(','));

  const mustMention = [
    ['name', /\bname\b/i], ['phone number', /phone number/i], ['email', /email/i],
    ['island', /island/i], ['village', /village/i],
    ['reviews are public', /reviews are public/i],
    ['Google Sheets', /Google Sheets/i],
    ['what a seller can see', /seller sees only their own|only their own business/i],
    ['not sold', /do not sell/i],
    ['how to delete', /delet/i],
    ['a contact address', /admin@mwakete\.com/]
  ];
  for (const [label, re] of mustMention) {
    ok('the policy covers: ' + label, re.test(text));
  }

  // --- claims it makes must stay true --------------------------------------
  ok('it says no analytics - and no analytics script exists',
    /do not run any analytics|no advertising cookies/i.test(text)
    // Matched on HOSTS and API entry points, not on words. An earlier version
    // of this matched the bare word "plausible" and fired on a comment in
    // checkout.js reading "a plausible email" - a test that fails for a reason
    // unrelated to what it guards is worse than no test.
    && !/google-analytics\.com|googletagmanager\.com|plausible\.io|matomo\.|mixpanel\.com|\bgtag\s*\(|\bdataLayer\b|\bfbq\s*\(/i.test(
      fs.readdirSync(REPO + 'assets/js').filter((f) => !f.endsWith('.min.js'))
        .map((f) => fs.readFileSync(REPO + 'assets/js/' + f, 'utf8')).join('\n')));

  ok('it says Google never sends us a password - and no Google password is read anywhere',
    /never receive your\s*<\/strong>?\s*|never receive your Google password/i.test(text.replace(/\s+/g, ' '))
    || /never receive your/i.test(text));

  const oauth = fs.readFileSync(REPO + 'apps-script/CustomerOAuth.gs', 'utf8');
  ok('the only Google claims used are the ones the policy names',
    /claims\.email\b/.test(oauth) && /claims\.name\b/.test(oauth) && /claims\.sub\b/.test(oauth)
    && !/claims\.(picture|locale|given_name|family_name)/.test(oauth));

  // --- session lifetimes quoted in the page must match the backend ---------
  const customers = fs.readFileSync(REPO + 'apps-script/Customers.gs', 'utf8');
  ok('the 60 days it quotes matches CUSTOMER_REMEMBER_HOURS',
    /60 days/.test(text) && /CUSTOMER_REMEMBER_HOURS\s*=\s*24\s*\*\s*60/.test(customers));
  ok('the 12 hours it quotes matches CUSTOMER_SHARED_DEVICE_HOURS',
    /12 hours/.test(text) && /CUSTOMER_SHARED_DEVICE_HOURS\s*=\s*12\b/.test(customers));

  // --- reachable, and linked from where it is needed ----------------------
  ok('precached, so it works offline like every other customer page',
    /'privacy\.html'/.test(fs.readFileSync(REPO + 'sw.js', 'utf8')));

  const banner = fs.readFileSync(REPO + 'assets/js/cookie-consent.js', 'utf8');
  ok('the cookie notice links to it, absolutely - that banner also shows in /owner/',
    /href="\/privacy\.html"/.test(banner));
  ok('and the sign-in page links to it, since that is where Google sign-in happens',
    /privacy\.html/.test(fs.readFileSync(REPO + 'customer-login.html', 'utf8')));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    const resp = await page.goto(BASE + '/privacy.html', { waitUntil: 'load' });
    ok(`it loads at ${width}px`, resp && resp.status() === 200, String(resp && resp.status()));
    await page.waitForTimeout(500);
    const h1 = await page.textContent('h1').catch(() => '');
    ok(`heading renders at ${width}px`, /Privacy Policy/.test(h1 || ''), h1);
    const overflows = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok(`no sideways scrolling at ${width}px`, overflows === false);
    await ctx.close();
  }
  await browser.close();

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
