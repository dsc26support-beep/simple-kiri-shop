/**
 * My Account: the "My Messages" and "My Store" buttons.
 *
 * Three things are load-bearing here.
 *
 * SECURITY. The backend answers "does this person own a store" for the
 * AUTHENTICATED customer's own address only. Written the obvious way - taking
 * an email in the body - it would be an enumeration endpoint anyone could walk
 * to learn which addresses belong to vendors. Asserted at the source, because
 * it is the kind of thing a later refactor makes "more flexible" by accident.
 *
 * NO MOVEMENT. My Store is revealed after first paint, so its box is reserved
 * in the markup and only its visibility changes. A button that appeared would
 * push My Messages sideways, and horizontal shifts count towards CLS exactly as
 * vertical ones do. Asserted by measuring My Messages with and without the
 * reveal, and by reading the browser's own layout-shift entries.
 *
 * NOT OFFERED IS NOT MERELY UNSEEN. While it is hidden the link must be out of
 * the tab order and out of the accessibility tree - otherwise it is invisible
 * to sighted users and present for everyone else, which is the worst of both.
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

const CUST = { customerId: 'c1', name: 'Aroita', email: 'a@example.com', phone: '73012345' };
const PURPLE = 'rgb(51, 45, 99)'; // --color-purple #332d63

/** opts: { delayMs, sellerToken, width } */
async function openDash(browser, storeReply, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 } });
  const seen = [];
  await ctx.route('**/script.google.com/**', async (r) => {
    let body = {}; try { body = r.request().postDataJSON() || {}; } catch (e) {}
    if (body.action) seen.push(body);
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'getCustomerProfile') return J({ ok: true, customer: CUST });
    if (body.action === 'getCustomerStore') {
      if (opts.delayMs) await new Promise((s) => setTimeout(s, opts.delayMs));
      if (storeReply === 'error') return r.fulfill({ status: 500, body: 'boom' });
      return J(storeReply);
    }
    return J({ ok: true, orders: [], bookings: [] });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((seller) => { try {
    localStorage.setItem('skiri_customer_token', 't');
    localStorage.setItem('skiri_cookie_consent', 'true');
    if (seller) localStorage.setItem('skiri_owner_token', 'ot');
  } catch (e) {} }, !!opts.sellerToken);
  await page.addInitScript(() => {
    window.__cls = 0;
    // Each shift's SOURCE nodes, not just the total. The total on this page is
    // dominated by the orders and bookings lists arriving, which has nothing to
    // do with this button - see the note at the shift assertions below.
    window.__shiftSources = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__cls += e.value;
        for (const src of (e.sources || [])) {
          const n = src.node;
          if (!n || !n.tagName) continue;
          window.__shiftSources.push({
            value: e.value,
            id: n.id || '',
            cls: typeof n.className === 'string' ? n.className : '',
            tag: n.tagName
          });
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(BASE + '/customer-dashboard.html', { waitUntil: 'load' });
  await page.waitForTimeout(2400);
  return { ctx, page, seen };
}

const linkInfo = (page) => page.evaluate(() => {
  const l = document.getElementById('store-link');
  const cs = getComputedStyle(l);
  const msgs = document.querySelector('.dash-links a[href="customer-messages.html"]').getBoundingClientRect();
  return { label: l.textContent.trim(), href: l.getAttribute('href'), title: l.getAttribute('title'),
    shown: l.classList.contains('is-visible'),
    visibility: cs.visibility, opacity: cs.opacity,
    width: Math.round(l.getBoundingClientRect().width),
    color: cs.color, borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
    bg: cs.backgroundColor,
    // Where the button BESIDE it sits, and how tall the row is: the two numbers
    // that would move if the reveal were done by adding an element.
    msgsX: Math.round(msgs.x), msgsWidth: Math.round(msgs.width),
    rowHeight: Math.round(document.querySelector('.dash-links').getBoundingClientRect().height),
    cls: window.__cls };
});

(async () => {
  // ---------- source: the endpoint must not be an enumeration oracle --------
  const customers = fs.readFileSync(REPO + 'apps-script/Customers.gs', 'utf8');
  const fn = (customers.match(/function actionGetCustomerStore[\s\S]*?\n}/) || [''])[0];
  ok('the store lookup exists', fn.length > 0);
  ok('it authenticates the caller', /requireCustomerAuth\(body\.token\)/.test(fn));
  ok('it reads the email from the AUTHENTICATED customer, not the request body',
    /normalizeEmail\(customer\.Email\)/.test(fn) && !/body\.email/.test(fn));
  // isStoreBrowsable is 'active' or 'standby' - which is exactly ownerCanLogIn.
  // The only status it excludes is 'closed', the soft delete from Settings,
  // where the owner is locked out and their sessions revoked. Sending them to
  // owner/dashboard.html would dead-end at a login that refuses them, so this
  // filter is the right one and must stay.
  ok('a deleted store does not count as having one', /isStoreBrowsable/.test(fn));
  const auth = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
  const canLogIn = (auth.match(/function ownerCanLogIn[\s\S]*?\n}/) || [''])[0];
  const browsable = (auth.match(/function isStoreBrowsable[\s\S]*?\n}/) || [''])[0];
  const bodyOf = (f) => f.replace(/^function \w+\(owner\) \{/, '').replace(/\s+/g, ' ').trim();
  ok('and "browsable" still means the same statuses as "can log in" - which is '
    + 'what makes My Store a link they can actually follow',
    bodyOf(canLogIn) === bodyOf(browsable) && bodyOf(browsable).length > 0, bodyOf(browsable));
  const code = fs.readFileSync(REPO + 'apps-script/Code.gs', 'utf8');
  ok('the action is routed', /case 'getCustomerStore'/.test(code));

  // ---------- Create Store is gone from this page --------------------------
  // Comments stripped first: the markup explains WHY Create Store is not here,
  // and naming it in a comment is not offering it.
  const dashHtml = fs.readFileSync(REPO + 'customer-dashboard.html', 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  ok('My Account no longer offers Create Store', !/Create Store/.test(dashHtml));
  ok('and the duplicate "Go to seller dashboard" link is gone too',
    !/seller-link/.test(dashHtml) && !/seller-link/.test(fs.readFileSync(REPO + 'assets/js/customer-dashboard.js', 'utf8')));
  // It has to stay reachable SOMEWHERE, or new sellers have no route in.
  ok('Create Store still lives in the header menu',
    /label: 'Create Store'/.test(fs.readFileSync(REPO + 'assets/js/header-menu.js', 'utf8')));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- no store: nothing is offered ---------------------------------
  let noStore;
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false });
    noStore = await linkInfo(page);
    ok('with no store the button is not shown', noStore.shown === false && noStore.visibility === 'hidden',
      noStore.visibility);
    ok('and it is out of the tab order', await page.evaluate(() => {
      const l = document.getElementById('store-link');
      l.focus();
      return document.activeElement !== l;
    }));
    ok('and out of the accessibility tree', await page.evaluate(() => {
      const l = document.getElementById('store-link');
      // checkVisibility ignores visibility:hidden unless asked - the default
      // only covers display:none and content-visibility.
      return l.checkVisibility({ visibilityProperty: true, opacityProperty: true }) === false;
    }));
    ok('nothing on the page says Create Store',
      await page.evaluate(() => !/Create Store/.test(document.body.textContent)));
    ok('My Messages is still there and unaffected', noStore.msgsWidth > 0);
    await ctx.close();
  }

  // ---------- has a store ---------------------------------------------------
  let withStore;
  {
    const { ctx, page, seen } = await openDash(browser,
      { ok: true, hasStore: true, storeSlug: 'bong', storeName: 'Bong Store' });
    withStore = await linkInfo(page);
    ok('with a store it appears, reading My Store', withStore.shown && withStore.label === 'My Store',
      withStore.label);
    ok('visible for real, not just class-flagged',
      withStore.visibility === 'visible' && withStore.opacity === '1',
      withStore.visibility + ' / ' + withStore.opacity);
    ok('pointing at the seller dashboard', withStore.href === 'owner/dashboard.html', withStore.href);
    ok('and it names the store on hover', withStore.title === 'Bong Store', String(withStore.title));
    ok('outline only - transparent fill', withStore.bg === 'rgba(0, 0, 0, 0)', withStore.bg);
    ok('purple border', withStore.borderColor === PURPLE && withStore.borderWidth === '1px',
      withStore.borderColor + ' ' + withStore.borderWidth);
    ok('purple text', withStore.color === PURPLE, withStore.color);
    ok('it is a real tap target', await page.evaluate(() => {
      const l = document.getElementById('store-link');
      l.focus();
      return document.activeElement === l
        && Math.round(l.getBoundingClientRect().height) >= 44;
    }));
    ok('the lookup sent the session token, not an email',
      seen.some((b) => b.action === 'getCustomerStore' && b.token === 't' && !b.email),
      JSON.stringify(seen.find((b) => b.action === 'getCustomerStore') || {}));
    await ctx.close();
  }

  // ---------- revealing it moves nothing -----------------------------------
  ok('My Messages sits in exactly the same place either way',
    noStore.msgsX === withStore.msgsX && noStore.msgsWidth === withStore.msgsWidth,
    `x ${noStore.msgsX} vs ${withStore.msgsX}, w ${noStore.msgsWidth} vs ${withStore.msgsWidth}`);
  ok('the row is the same height either way, so nothing below it moves',
    noStore.rowHeight === withStore.rowHeight, noStore.rowHeight + ' vs ' + withStore.rowHeight);
  ok('the reserved box is the width the button ends up at',
    noStore.width === withStore.width, noStore.width + ' vs ' + withStore.width);
  // THE SHIFT IS MEASURED AT THE BUTTON, not at the page.
  //
  // The obvious check - compare this page's total CLS with the button and
  // without - does not work here, and finding out why was worth more than the
  // check. This page shifts on its own while the orders and bookings lists
  // arrive, and that shift is BIMODAL: 0.0103 on one load and 0.0219 on the
  // next, on identical code, depending on which list lands first. Comparing
  // one run against one run is comparing two samples of a coin flip. Taking
  // the minimum of three per side - the trick that worked on the homepage,
  // where the race was rare - does not rescue it either: at roughly even odds,
  // all three runs come up high about one time in eight, and the suite fails
  // for a reason that has nothing to do with the code under test.
  //
  // So: ask the browser WHICH ELEMENTS moved. A reveal that costs nothing can
  // never appear as a shift source, whatever else the page is doing, and that
  // is the actual guarantee - reserved box, visibility only, nothing reflows.
  {
    const sourcesOf = (page) => page.evaluate(() => window.__shiftSources.filter(
      (s) => s.id === 'store-link' || /dash-links/.test(s.cls) || /dash-links/.test(s.id)));

    const { ctx, page } = await openDash(browser,
      { ok: true, hasStore: true, storeSlug: 'bong', storeName: 'Bong' });
    const guilty = await sourcesOf(page);
    ok('revealing My Store moves nothing: it is never a layout-shift source',
      guilty.length === 0, JSON.stringify(guilty));
    // Proof the instrument works on this page at all - something did shift, so
    // an empty result above means "not this element", not "nothing observed".
    ok('(and the page did record shifts, so that is a real answer)',
      (await page.evaluate(() => window.__cls)) > 0,
      String(await page.evaluate(() => window.__cls)));
    await ctx.close();

    const seller = await openDash(browser, { ok: true, hasStore: false }, { sellerToken: true });
    ok('and neither does the instant, device-token reveal',
      (await sourcesOf(seller.page)).length === 0,
      JSON.stringify(await sourcesOf(seller.page)));
    await seller.ctx.close();
  }

  // ---------- a slow or broken lookup must not guess ------------------------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: true }, { delayMs: 3000 });
    const i = await linkInfo(page);
    ok('a slow lookup leaves the button hidden rather than flashing it', i.shown === false);
    await ctx.close();
  }
  {
    const { ctx, page } = await openDash(browser, 'error');
    const i = await linkInfo(page);
    ok('a failed lookup leaves it hidden rather than guessing', i.shown === false);
    await ctx.close();
  }

  // ---------- the device signal: a seller signed in here --------------------
  // This is the case the removed "Go to seller dashboard" link existed for: a
  // store registered under a different address from the shopper account, so the
  // email lookup says no. It has to keep working, and it costs no request.
  {
    const { ctx, page, seen } = await openDash(browser, { ok: true, hasStore: false },
      { sellerToken: true });
    const i = await linkInfo(page);
    ok('a seller token on this device shows My Store even when the email lookup says no',
      i.shown === true && i.label === 'My Store', JSON.stringify({ shown: i.shown, label: i.label }));
    ok('pointing at the seller dashboard', i.href === 'owner/dashboard.html', i.href);
    ok('and the backend is never asked at all in that case',
      !seen.some((b) => b.action === 'getCustomerStore'),
      seen.map((b) => b.action).join(','));
    // Its shift is covered by the min-of-three comparison above, where it can
    // be measured against a floor instead of a single noisy sample.
    await ctx.close();
  }

  // ---------- the reserved slot must not wrap on the narrowest phone -------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false }, { width: 320 });
    const rows = await page.evaluate(() => {
      const kids = [...document.querySelector('.dash-links').children];
      return new Set(kids.map((k) => Math.round(k.getBoundingClientRect().y))).size;
    });
    ok('at 320px both buttons still sit on one row, so the empty slot adds no band',
      rows === 1, rows + ' row(s)');
    await ctx.close();
  }

  // ---------- My Messages is the same kind of button ------------------------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false });
    const msgs = await page.evaluate(() => {
      const a = document.querySelector('.dash-links a[href="customer-messages.html"]');
      if (!a) return null;
      const cs = getComputedStyle(a);
      return { text: a.textContent.trim(), bg: cs.backgroundColor, border: cs.borderTopColor };
    });
    ok('My Messages sits alongside it', msgs && /My Messages/.test(msgs.text), JSON.stringify(msgs));
    ok('and is the same outline button', msgs && msgs.bg === 'rgba(0, 0, 0, 0)' && msgs.border === PURPLE,
      JSON.stringify(msgs));
    await ctx.close();
  }

  // ---------- purple separators, and ONLY on this page ---------------------
  {
    const { ctx, page } = await openDash(browser, { ok: true, hasStore: false });
    const cols = await page.evaluate(() => {
      const sec = document.querySelector('.dash-section');
      return { section: sec ? getComputedStyle(sec).borderTopColor : null,
               sectionWidth: sec ? getComputedStyle(sec).borderTopWidth : null };
    });
    ok('the section cards are outlined in purple', cols.section === PURPLE, String(cols.section));
    ok('and only the COLOUR changed - the border is still 1px, so nothing reflows',
      cols.sectionWidth === '1px', String(cols.sectionWidth));
    await ctx.close();
  }

  // .dash-section and .dash-item are shared with owner/admin.html and
  // customer-messages.html. Recolouring the base class would have repainted
  // both as a side effect of a change asked for on My Account, so the rule is
  // scoped to .page-account - and that scoping is the thing worth guarding.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/script.google.com/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, orders: [], bookings: [], conversations: [],
        customer: { name: 'A', email: 'a@b.c', phone: '1' } }) }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try {
      localStorage.setItem('skiri_customer_token', 't');
      localStorage.setItem('skiri_owner_token', 't');
      localStorage.setItem('skiri_cookie_consent', 'true');
    } catch (e) {} });
    for (const other of ['customer-messages.html', 'owner/admin.html']) {
      await page.goto(BASE + '/' + other, { waitUntil: 'load' });
      await page.waitForTimeout(1400);
      const c = await page.evaluate(() => {
        const sec = document.querySelector('.dash-section');
        return sec ? getComputedStyle(sec).borderTopColor : 'none';
      });
      ok(other + ' keeps its grey borders - the purple did not leak',
        c !== PURPLE, String(c));
    }
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
