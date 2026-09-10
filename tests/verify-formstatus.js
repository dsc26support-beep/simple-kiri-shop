// Warnings on the booking form read as warnings.
//
// One <p> carries three kinds of message there - a warning the shopper must act
// on, a failure, and a success - and every one of them rendered in the same
// muted grey. Colour follows the KIND now.
//
// The trap this guards is the class leak: show a red warning, let the shopper
// fix it, submit - if the clear only wiped the text, the success line inherits
// the red and a shopper reading red concludes their booking failed.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';

const RENTAL = [{ productId: 'p1', name: 'White Toyota Vits', description: 'Automatic',
  category: 'vehicles', listingType: 'rental', imageUrls: [], storeSlug: 'a', storeName: 'A',
  variants: [{ variantId: 'v1', label: 'Per day', price: 60 }] }];

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

  async function open(path, bookingOk = true) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await ctx.route('**/macros/s/**', (r) => {
      let body = {};
      try { body = r.request().postDataJSON() || {}; } catch (e) {}
      let a = body.action;
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true, products: [], stores: [] };
      if (a === 'listProducts') res = { ok: true, storeName: 'A', storeSlug: 'a', storeOpen: true, products: RENTAL };
      else if (a === 'listProductReviews') res = { ok: true, reviews: [], average: 0, count: 0 };
      else if (a === 'createBookingRequest') {
        res = bookingOk ? { ok: true, bookingId: 'BK1' }
                        : { ok: false, error: 'That vehicle is already booked for those dates.' };
      }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const pg = await ctx.newPage();
    await pg.goto(BASE + path, { waitUntil: 'load' });
    await pg.waitForSelector('.request-booking-btn', { timeout: 6000 });
    await pg.waitForTimeout(300);
    return { ctx, pg };
  }

  const read = () => {
    const el = document.getElementById('booking-status-p1');
    const cs = getComputedStyle(el);
    const probe = (v) => {
      const d = document.createElement('div');
      d.style.color = `var(${v})`;
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    };
    return {
      text: el.textContent.trim(),
      color: cs.color,
      classes: el.className,
      danger: probe('--color-danger'),
      success: probe('--color-success'),
      muted: probe('--color-muted')
    };
  };

  for (const [label, path] of [['product page', '/product.html?store=a&product=p1'],
                               ['store page', '/store.html?store=a']]) {
    // ---- a warning ----
    {
      const { ctx, pg } = await open(path);
      await pg.click('.request-booking-btn');
      await pg.waitForTimeout(300);
      const g = await pg.evaluate(read);
      ok(`${label}: the missing-details warning is RED`,
        g.color === g.danger && /status-error/.test(g.classes), JSON.stringify(g));
      ok(`${label}: and it is not the old muted grey`, g.color !== g.muted, g.color);
      ok(`${label}: the words are unchanged`,
        /Please enter your name and phone number/.test(g.text), g.text);
      await ctx.close();
    }

    // ---- warning -> fixed -> success. THE TRAP. ----
    {
      const { ctx, pg } = await open(path);
      await pg.click('.request-booking-btn');
      await pg.waitForTimeout(250);
      const warned = await pg.evaluate(read);
      ok(`${label}: red shown first`, warned.color === warned.danger, warned.color);

      await pg.fill('#name-p1', 'Teakim Mote');
      await pg.fill('#phone-p1', '73011111');
      await pg.fill('#start-p1', iso(1));
      await pg.fill('#end-p1', iso(3));
      await pg.click('.request-booking-btn');
      await pg.waitForTimeout(600);
      const g = await pg.evaluate(read);

      ok(`${label}: THE ONE THAT MATTERS - success after a warning is GREEN, not leftover red`,
        g.color === g.success && /status-success/.test(g.classes) && !/status-error/.test(g.classes),
        JSON.stringify(g));
      ok(`${label}: and it says the request was sent`,
        /Booking request sent/.test(g.text), g.text);
      await ctx.close();
    }

    // ---- a backend refusal ----
    {
      const { ctx, pg } = await open(path, false);
      await pg.fill('#name-p1', 'Teakim Mote');
      await pg.fill('#phone-p1', '73011111');
      await pg.fill('#start-p1', iso(1));
      await pg.fill('#end-p1', iso(3));
      await pg.click('.request-booking-btn');
      await pg.waitForTimeout(600);
      const g = await pg.evaluate(read);
      ok(`${label}: a refusal from the backend is RED too`,
        g.color === g.danger && /status-error/.test(g.classes), JSON.stringify(g));
      ok(`${label}: and shows the vendor's actual reason`,
        /already booked/.test(g.text), g.text);
      await ctx.close();
    }
  }

  // ---- load failures and empty states stay grey ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => {
      let a = '';
      try { a = (r.request().postDataJSON() || {}).action; } catch (e) {}
      try { if (!a) a = new URL(r.request().url()).searchParams.get('action') || ''; } catch (e) {}
      let res = { ok: true, products: [], stores: [] };
      if (a === 'listProducts') res = { ok: true, storeName: 'A', storeSlug: 'a', storeOpen: true, products: [] };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
    const pg = await ctx.newPage();
    await pg.goto(BASE + '/store.html?store=a', { waitUntil: 'load' });
    await pg.waitForTimeout(800);
    const g = await pg.evaluate(() => {
      const el = document.getElementById('products-status');
      const d = document.createElement('div');
      d.style.color = 'var(--color-muted)';
      document.body.appendChild(d);
      const muted = getComputedStyle(d).color;
      d.remove();
      return { text: el.textContent.trim(), color: getComputedStyle(el).color,
               muted, classes: el.className };
    });
    ok('an empty store is NOT red - nobody did anything wrong',
      g.color === g.muted && !/status-error/.test(g.classes), JSON.stringify(g));
    await ctx.close();
  }

  // ---- the forms that were already right stay right ----
  {
    const fs = require('fs');
    const loginHtml = fs.readFileSync('/home/user/simple-kiri-shop/customer-login.html', 'utf8');
    const checkoutHtml = fs.readFileSync('/home/user/simple-kiri-shop/checkout.html', 'utf8');
    const css = fs.readFileSync('/home/user/simple-kiri-shop/assets/css/styles.css', 'utf8');
    ok('customer login still uses the red .form-error class',
      (loginHtml.match(/class="form-error"/g) || []).length >= 4);
    ok('checkout still uses it', /id="checkout-error" class="form-error"/.test(checkoutHtml));
    ok('.form-error is still the danger colour',
      /\.form-error \{[^}]*var\(--color-danger\)/.test(css));
    ok('.status-error is declared AFTER .helper-text, or grey would win',
      css.indexOf('.status-error') > css.indexOf('.helper-text {'));
  }

  await browser.close();
  console.log('\n--- Booking form status colours ---');
  let f = 0;
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
