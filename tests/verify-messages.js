const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open({ signedIn, backendOk }) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(backendOk ? { ok: true, conversations: [] } : { ok: false, error: 'boom' }),
    }));
    const page = await ctx.newPage();
    await page.addInitScript((s) => {
      localStorage.setItem('skiri_cookie_consent', 'true');
      // A chat thread must exist on the device or the page short-circuits.
      localStorage.setItem('skiri_chat_token_bong', 'tok-1');
      if (s) localStorage.setItem('skiri_customer_token', 'ct');
    }, signedIn);
    await page.goto(BASE + '/customer-messages.html', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    return { ctx, page };
  }

  const read = (page) => page.evaluate(() => {
    const el = document.getElementById('messages-status');
    const a = el.querySelector('a');
    return {
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      linkText: a ? a.textContent.trim() : null,
      linkHref: a ? a.getAttribute('href') : null,
      hasStaticDots: !!el.querySelector('.static-dots'),
    };
  });

  // Signed out + load failure -> the new wording
  let { ctx, page } = await open({ signedIn: false, backendOk: false });
  let s = await read(page);
  ok('signed out: offers account creation', /Create Your Account now or refresh page/.test(s.text), s.text);
  ok('signed out: "Create Your Account now" is a link', s.linkText === 'Create Your Account now', s.linkText);
  ok('signed out: link points at customer-login.html', s.linkHref === 'customer-login.html', s.linkHref);
  ok('signed out: keeps the static-dots failed treatment', s.hasStaticDots === true);
  await ctx.close();

  // Signed in + load failure -> unchanged shared wording
  ({ ctx, page } = await open({ signedIn: true, backendOk: false }));
  s = await read(page);
  ok('signed in: plain "Refresh page" retained', /^Refresh page$/.test(s.text), s.text);
  ok('signed in: no account link', s.linkText === null, String(s.linkText));
  await ctx.close();

  // Successful load with no threads -> untouched empty state
  ({ ctx, page } = await open({ signedIn: false, backendOk: true }));
  s = await read(page);
  ok('successful empty load still says "No messages yet."', s.text === 'No messages yet.', s.text);
  await ctx.close();

  // The shared helper must be unchanged for every other page
  const helpers = require('fs').readFileSync('/home/user/simple-kiri-shop/assets/js/helpers.js', 'utf8');
  ok('shared loadFailedMessageHtml left untouched', /return 'Refresh page' \+ STATIC_DOTS_HTML;/.test(helpers));

  await browser.close();
  let f = 0;
  console.log('\n--- Messages inbox failed state ---');
  for (const [st, n, e] of R) { if (st === 'FAIL') f++; console.log(`${st}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
