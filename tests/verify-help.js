/**
 * Help Centre in a real browser: accordion, unified search, filters, deep
 * links, empty and zero-result states, keyboard, no-JS, XSS, layout at every
 * width the brief lists, and the rest of the site still reaching it.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(path, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({
      viewport: { width: opts.width || 390, height: 844 },
      javaScriptEnabled: opts.js !== false,
      reducedMotion: opts.reducedMotion || 'no-preference'
    });
    await ctx.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('dialog', (d) => { errs.push('DIALOG ' + d.message()); d.dismiss(); });
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(150);
    return { ctx, page, errs };
  }

  const panelState = (page, id) => page.evaluate((id) => {
    const btn = document.getElementById('faq-' + id + '-btn');
    const panel = document.getElementById('faq-' + id + '-panel');
    return {
      expanded: btn.getAttribute('aria-expanded'),
      visible: getComputedStyle(panel).visibility,
      height: panel.getBoundingClientRect().height,
      sub: getComputedStyle(btn.querySelector('.help-acc-sub')).display !== 'none'
        && btn.querySelector('.help-acc-sub').getBoundingClientRect().height > 0
    };
  }, id);

  /* ---------- accordion ---------- */
  {
    const { ctx, page, errs } = await open('/help.html');
    ok('no JS errors on load', errs.length === 0, errs.join(' | '));
    let s = await panelState(page, 'selling-how');
    ok('answers start closed (aria-expanded=false, hidden from AT)', s.expanded === 'false' && s.visible === 'hidden' && s.height < 2, JSON.stringify(s));
    ok('the subtitle is visible while closed', s.sub);
    await page.click('#faq-selling-how-btn');
    await page.waitForTimeout(300);
    s = await panelState(page, 'selling-how');
    ok('click opens it', s.expanded === 'true' && s.visible === 'visible' && s.height > 40, JSON.stringify(s));
    ok('subtitle still visible when open', s.sub);
    await page.click('#faq-buying-pay-btn');
    await page.waitForTimeout(300);
    ok('several can be open at once', (await panelState(page, 'selling-how')).expanded === 'true'
      && (await panelState(page, 'buying-pay')).expanded === 'true');
    await page.click('#faq-selling-how-btn');
    await page.waitForTimeout(300);
    s = await panelState(page, 'selling-how');
    ok('click again closes it', s.expanded === 'false' && s.visible === 'hidden', JSON.stringify(s));

    // keyboard: Tab to a question, Enter and Space toggle it
    await page.focus('#faq-general-what-btn');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    ok('Enter opens', (await panelState(page, 'general-what')).expanded === 'true');
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
    ok('Space closes', (await panelState(page, 'general-what')).expanded === 'false');
    const a11y = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.help-acc button.help-acc-btn'));
      return {
        allButtons: btns.every((b) => b.tagName === 'BUTTON' && b.type === 'button'),
        controls: btns.every((b) => { const p = document.getElementById(b.getAttribute('aria-controls')); return p && p.getAttribute('role') === 'region' && p.getAttribute('aria-labelledby') === b.id; }),
        inHeadings: btns.every((b) => /^H[2-6]$/.test(b.parentElement.tagName)),
        clickableDivs: document.querySelectorAll('div[onclick], span[onclick]').length,
        tapHeight: Math.min(...btns.slice(0, 10).map((b) => b.getBoundingClientRect().height))
      };
    });
    ok('every toggle is a real <button>', a11y.allButtons);
    ok('aria-controls -> region labelled by its button', a11y.controls);
    ok('each button sits in a heading', a11y.inHeadings);
    ok('no clickable divs', a11y.clickableDivs === 0);
    ok('touch targets at least 48px tall', a11y.tapHeight >= 48, a11y.tapHeight);
    const focusRing = await page.evaluate(() => {
      const b = document.getElementById('faq-general-what-btn'); b.focus();
      return getComputedStyle(b).outlineStyle;
    });
    ok('visible focus ring', focusRing !== 'none', focusRing);
    // related link opens its target
    await page.click('#faq-buying-pay-btn');   // closes
    await page.click('#faq-buying-pay-btn');   // reopens
    await page.waitForTimeout(250);
    await page.click('#faq-buying-pay-panel a[href="#faq-safety-payment-requests"]');
    await page.waitForTimeout(500);
    ok('a Related link opens the answer it points at', (await panelState(page, 'safety-payment-requests')).expanded === 'true');
    ok('...and updates the address for sharing', page.url().endsWith('#faq-safety-payment-requests'));
    await ctx.close();
  }

  /* ---------- reduced motion ---------- */
  {
    const { ctx, page } = await open('/help.html', { reducedMotion: 'reduce' });
    const t = await page.evaluate(() => getComputedStyle(document.getElementById('faq-selling-how-panel')).transitionDuration);
    ok('reduced motion: no accordion animation', t.split(',').every((d) => parseFloat(d) === 0), t);
    await ctx.close();
  }

  /* ---------- deep links ---------- */
  {
    const { ctx, page } = await open('/help.html#faq-delivery-time');
    await page.waitForTimeout(400);
    ok('help.html#faq-<id> opens that answer', (await panelState(page, 'delivery-time')).expanded === 'true');
    const inView = await page.evaluate(() => { const r = document.getElementById('faq-delivery-time').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
    ok('...scrolled into view', inView);
    await ctx.close();
  }

  /* ---------- search ---------- */
  {
    const { ctx, page, errs } = await open('/help.html');
    await page.fill('#help-q', 'How can I sell products?');
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({
      browseHidden: document.getElementById('help-browse').hidden,
      count: document.querySelectorAll('#help-results-list .help-result').length,
      types: Array.from(document.querySelectorAll('#help-results-list .help-type-badge')).map((b) => b.textContent),
      titles: Array.from(document.querySelectorAll('#help-results-list .help-result-title')).map((b) => b.textContent),
      status: document.getElementById('help-status').textContent,
      url: location.search
    }));
    ok('typing searches (debounced) and hides the browse view', r.browseHidden && r.count > 0, r.count);
    ok('FAQ and Guide results are both shown, labelled', r.types.indexOf('FAQ') !== -1 && r.types.indexOf('Guide') !== -1, r.types.join(','));
    ok('the selling answer is near the top', r.titles.slice(0, 3).indexOf('How do I sell on Mwakete?') !== -1, r.titles.slice(0, 3).join(' | '));
    ok('result count announced to screen readers', /results? for/.test(r.status), r.status);
    ok('the search is in the address, so it can be shared', /q=How/.test(r.url), r.url);

    // filters
    await page.click('[data-help-type="guide"]');
    await page.waitForTimeout(150);
    const g = await page.$$eval('#help-results-list .help-type-badge', (els) => els.map((e) => e.textContent));
    ok('Guides filter shows only guides', g.length > 0 && g.every((t) => t === 'Guide'), g.join(','));
    ok('filter state is announced (aria-pressed)', await page.$eval('[data-help-type="guide"]', (b) => b.getAttribute('aria-pressed')) === 'true');
    await page.click('[data-help-type="all"]');
    await page.fill('#help-q', 'pay');
    await page.waitForTimeout(350);
    await page.click('[data-help-topic="safety"]');
    await page.waitForTimeout(150);
    const cats = await page.$$eval('#help-results-list .help-result-meta', (els) => els.map((e) => e.textContent));
    ok('topic filter narrows results', cats.length > 0 && cats.every((c) => /Safety/.test(c)), cats.join(' | '));
    ok('no Blog filter while there are no blog posts', !(await page.$('[data-help-type="blog"]')));

    // a FAQ result opens its answer
    await page.click('[data-help-topic=""]');
    await page.fill('#help-q', 'scam');
    await page.waitForTimeout(350);
    await page.click('#help-results-list a[href="#faq-safety-scam"]');
    await page.waitForTimeout(500);
    ok('clicking a FAQ result opens that answer', (await panelState(page, 'safety-scam')).expanded === 'true');
    ok('...back in the browse view', await page.evaluate(() => !document.getElementById('help-browse').hidden));

    // zero results
    await page.fill('#help-q', 'qwertyzz');
    await page.waitForTimeout(350);
    const z = await page.evaluate(() => ({
      none: !document.getElementById('help-noresults').hidden,
      text: document.getElementById('help-noresults').textContent,
      chips: document.querySelectorAll('#help-noresults [data-help-search]').length,
      popular: document.querySelectorAll('#help-noresults .help-result').length,
      contact: !!document.querySelector('#contact a[href^="mailto:admin@mwakete.com"]')
    }));
    ok('zero results: never blank - says so', z.none && /couldn’t find an exact match/.test(z.text));
    ok('zero results: suggests other searches', z.chips >= 3);
    ok('zero results: shows popular questions', z.popular >= 3);
    ok('zero results: contact support is right there', z.contact);
    await page.click('#help-noresults [data-help-search="delivery"]');
    await page.waitForTimeout(200);
    ok('a suggestion runs that search', (await page.inputValue('#help-q')) === 'delivery'
      && (await page.$$('#help-results-list .help-result')).length > 0);

    // popular searches + clear + Escape
    await page.click('#help-q-clear');
    await page.waitForTimeout(150);
    ok('clear empties the box and brings back browse', (await page.inputValue('#help-q')) === ''
      && await page.evaluate(() => !document.getElementById('help-browse').hidden));
    await page.click('[data-help-search="Delivery"]');
    await page.waitForTimeout(200);
    ok('popular search chips search', (await page.$$('#help-results-list .help-result')).length > 0);
    await page.focus('#help-q');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('Escape clears the search', (await page.inputValue('#help-q')) === '');
    ok('no JS errors while searching', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  /* ---------- ?q= from a link, and hostile input ---------- */
  {
    const evil = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>';
    const { ctx, page, errs } = await open('/help.html?q=' + encodeURIComponent(evil));
    await page.waitForTimeout(300);
    const x = await page.evaluate(() => ({
      imgs: document.querySelectorAll('#help-results img, #help-noresults img').length,
      scripts: document.querySelectorAll('#help-results script').length,
      heading: document.getElementById('help-results-h').textContent
    }));
    ok('a hostile ?q= is shown as text, never run', x.imgs === 0 && x.scripts === 0 && errs.every((e) => !/DIALOG/.test(e)), JSON.stringify(x) + errs.join('|'));
    ok('...and the heading quotes it literally', x.heading.indexOf('<img') !== -1);
    await ctx.close();

    const t = await open('/help.html?q=delivery&topic=delivery');
    ok('?q= and ?topic= from a shared link are applied',
      (await t.page.inputValue('#help-q')) === 'delivery'
      && await t.page.$eval('[data-help-topic="delivery"]', (b) => b.getAttribute('aria-pressed')) === 'true');
    await t.ctx.close();
  }

  /* ---------- topic cards ---------- */
  {
    const { ctx, page } = await open('/help.html', { width: 1280 });
    await page.click('.help-cat[data-topic="rentals"]');
    await page.waitForTimeout(200);
    const v = await page.evaluate(() => ({
      shown: Array.from(document.querySelectorAll('.help-faq-group')).filter((g) => !g.hidden).map((g) => g.dataset.category),
      active: document.querySelector('.help-cat.is-active') && document.querySelector('.help-cat.is-active').dataset.topic
    }));
    ok('a topic card filters the FAQs to that topic', v.shown.length === 1 && v.shown[0] === 'rentals', v.shown.join(','));
    ok('...and shows which topic is chosen', v.active === 'rentals');
    await ctx.close();
  }

  /* ---------- no JavaScript ---------- */
  {
    const { ctx, page } = await open('/help.html', { js: false });
    const n = await page.evaluate(() => {
      const p = document.getElementById('faq-selling-how-panel');
      return { visible: getComputedStyle(p).visibility, h: p.getBoundingClientRect().height,
        deadButtons: !document.getElementById('help-filters') || document.getElementById('help-filters').hidden };
    });
    ok('without JavaScript every answer is readable', n.visible === 'visible' && n.h > 40, JSON.stringify(n));
    ok('without JavaScript no dead filter buttons show', n.deadButtons);
    await ctx.close();
  }

  /* ---------- every width in the brief ---------- */
  for (const w of [320, 360, 390, 412, 768, 1024, 1440]) {
    const { ctx, page, errs } = await open('/help.html', { width: w });
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      input: document.getElementById('help-q').getBoundingClientRect(),
      font: parseFloat(getComputedStyle(document.getElementById('help-q')).fontSize),
      smallText: Array.from(document.querySelectorAll('.help-acc-title, .help-cat-title, .help-acc-sub')).some((e) => parseFloat(getComputedStyle(e).fontSize) < 13)
    }));
    ok(w + 'px: no sideways scroll', !m.overflow);
    ok(w + 'px: search box is prominent and fits', m.input.width >= Math.min(300, w - 40) && m.input.height >= 44, Math.round(m.input.width) + 'x' + Math.round(m.input.height));
    ok(w + 'px: search text 16px (no iOS zoom), nothing tiny', m.font >= 16 && !m.smallText);
    ok(w + 'px: no errors', errs.length === 0, errs.join(' | '));
    if (w === 390) {
      await page.evaluate(() => window.scrollTo(0, 3000));
      await page.waitForTimeout(100);
      const top = await page.evaluate(() => document.querySelector('.help-searchbar').getBoundingClientRect().top);
      ok('390px: search stays reachable at the top while scrolling', Math.abs(top) < 2, top);
    }
    await ctx.close();
  }

  /* ---------- CLS: nothing jumps once scripts run ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(BASE + '/help.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const cls = await page.evaluate(() => window.__cls);
    ok('layout shift on load < 0.1', cls < 0.1, cls.toFixed(3));
    await ctx.close();
  }

  /* ---------- the rest of the site reaches it ---------- */
  {
    const { ctx, page } = await open('/index.html');
    await page.click('#header-menu-btn').catch(() => {});
    const href = await page.$eval('#header-menu-panel a.header-menu-item[href="help.html"]', (a) => a.textContent.trim()).catch(() => null);
    ok('header menu "Help & Support" opens the Help Centre', href && /Help & Support/.test(href), String(href));
    await ctx.close();
  }

  await browser.close();
  let f = 0;
  console.log('\n--- Help Centre (browser) ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
