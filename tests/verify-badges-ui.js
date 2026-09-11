/**
 * The seller-badge component: metadata, rendering, disclosure, accessibility.
 *
 * Nothing is wired into a page yet (that is a later section), so the module is
 * injected onto a page that already has helpers.js and exercised there.
 *
 * THE ASSERTIONS THAT MATTER MOST
 *
 * 1. COLOUR IS NEVER THE DIFFERENCE. A screenshot in greyscale, a
 *    forced-colours display, or a shopper who cannot separate the blue from
 *    the purple must still see four different things. So the four tiers are
 *    checked for differing SHAPE - border width, border radius, fill - and not
 *    merely differing hue.
 *
 * 2. THE PANEL STAYS ON SCREEN. A badge near the right edge of a 390px phone
 *    opening a 288px panel half off the screen is worse than one that does not
 *    open: the text is there and unreadable. Measured, not assumed.
 *
 * 3. OPENING ONE MOVES NOTHING. A panel that pushed the page down on every tap
 *    would be a layout shift on interaction, which is the same defect as one
 *    on load. A sibling's box is measured before and after.
 *
 * 4. NO BUTTON INSIDE A LINK. Product cards are a single <a>; a <button> in
 *    one is invalid and navigates instead of explaining. interactive:false is
 *    what makes card badges safe, and it is asserted to emit no button.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const ALL = ['recommended', 'top', 'verified', 'responsive', 'delivery', 'favourite', 'popular', 'new'];

async function open(browser, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 844 } });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.addScriptTag({ path: REPO + 'assets/js/badges.js' });
  // A host for the rendered markup, outside the page's own layout so nothing
  // it does can be mistaken for the page's behaviour.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'badge-host';
    host.style.padding = '16px';
    document.body.appendChild(host);
  });
  return { ctx, page };
}

const render = (page, ids, opts) => page.evaluate(([i, o]) => {
  const host = document.getElementById('badge-host');
  host.innerHTML = '<p id="sibling-above">above</p>'
    + renderSellerBadges(i, o) + '<p id="sibling-below">below</p>';
  wireSellerBadges(host);
  return host.innerHTML;
}, [ids, opts || {}]);

const box = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---- metadata is complete and internally consistent ---------------------
  {
    const { ctx, page } = await open(browser);
    const meta = await page.evaluate(() => ({
      order: SELLER_BADGE_ORDER,
      keys: Object.keys(SELLER_BADGES),
      entries: SELLER_BADGE_ORDER.map((id) => {
        const b = SELLER_BADGES[id] || {};
        return { id: id, label: b.label, explain: b.explain, tier: b.tier,
                 category: b.category, hasIcon: !!b.icon };
      })
    }));
    ok('the priority order is the eight badges, highest first',
      meta.order.join(',') === ALL.join(','), meta.order.join(','));
    ok('every ordered id has metadata and vice versa',
      meta.keys.slice().sort().join(',') === ALL.slice().sort().join(','), meta.keys.join(','));
    meta.entries.forEach((e) => {
      ok(e.id + ': has a text label, a sentence and an icon',
        !!e.label && !!e.explain && e.explain.length > 20 && e.hasIcon,
        JSON.stringify(e.label));
    });
    // The wording is contractual - these sentences were specified.
    const want = {
      verified: 'Store verified by Mwakete.',
      top: 'Consistently strong seller performance on Mwakete.',
      recommended: 'Recommended by Mwakete based on seller performance and customer experience.',
      responsive: 'Usually responds quickly to customer messages.',
      delivery: 'Strong record of successful fulfilment.',
      favourite: 'Popular with returning and satisfied customers.',
      popular: 'Currently receiving strong customer interest.',
      new: 'Recently joined Mwakete.'
    };
    const byId = {};
    meta.entries.forEach((e) => { byId[e.id] = e; });
    Object.keys(want).forEach((id) => {
      ok(id + ': the explanation is the agreed wording', byId[id].explain === want[id], byId[id].explain);
    });
    ok('Mwakete Recommended is labelled exactly that',
      byId.recommended.label === 'Mwakete Recommended', byId.recommended.label);
    await ctx.close();
  }

  // ---- sorting and unknown ids --------------------------------------------
  {
    const { ctx, page } = await open(browser);
    const r = await page.evaluate(() => ({
      reordered: sortSellerBadges(['new', 'verified', 'recommended']),
      unknown: sortSellerBadges(['verified', 'paid-placement', '', null, 'top']),
      dupes: sortSellerBadges(['top', 'top', 'top']),
      notArray: sortSellerBadges('top'),
      empty: sortSellerBadges([]),
      renderUnknown: renderSellerBadges(['definitely-not-a-badge'], {})
    }));
    ok('badges come back in priority order, not the order given',
      r.reordered.join(',') === 'recommended,verified,new', r.reordered.join(','));
    // Priority order, so 'top' leads - not the order they were passed in.
    ok('an id this build does not know is dropped, not rendered raw',
      r.unknown.join(',') === 'top,verified', r.unknown.join(','));
    ok('duplicates collapse', r.dupes.join(',') === 'top');
    ok('a non-array is not a crash', Array.isArray(r.notArray) && r.notArray.length === 0);
    ok('no badges renders nothing at all, not an empty container',
      r.empty.length === 0 && r.renderUnknown === '', JSON.stringify(r.renderUnknown));
    await ctx.close();
  }

  // ---- every badge keeps its text at both sizes ---------------------------
  for (const size of ['chip', 'detail']) {
    const { ctx, page } = await open(browser, 1280);
    await render(page, ALL, { size: size, interactive: false });
    const texts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.seller-badge-label')).map((e) => e.textContent.trim()));
    ok(size + ': all eight labels are present as visible text',
      texts.length === 8 && texts.every((t) => t.length > 3), texts.join(' | '));
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.seller-badge-label'))
        .every((e) => e.getBoundingClientRect().width > 10));
    ok(size + ': and none of them is collapsed to nothing', visible);
    ok(size + ': every icon is hidden from screen readers, so the label is the name',
      await page.evaluate(() => Array.from(document.querySelectorAll('.seller-badge svg, .seller-badge-emoji'))
        .every((e) => e.getAttribute('aria-hidden') === 'true')));
    await ctx.close();
  }

  // ---- shape, not colour --------------------------------------------------
  {
    const { ctx, page } = await open(browser, 1280);
    await render(page, ['recommended', 'verified', 'top', 'popular'], { size: 'detail', interactive: false });
    const styles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.seller-badge')).map((e) => {
        const cs = getComputedStyle(e);
        return {
          cls: e.className,
          radius: cs.borderTopLeftRadius,
          width: cs.borderTopWidth,
          left: cs.borderLeftWidth,
          bg: cs.backgroundColor,
          weight: cs.fontWeight
        };
      }));
    // Looked up by class, never by position: renderSellerBadges re-sorts into
    // priority order, so the array does not come back in the order passed in.
    const pick = (c) => styles.filter((s) => s.cls.indexOf('seller-badge--' + c) !== -1)[0];
    const rec = pick('recommended'), ver = pick('verified'),
          top = pick('top'), pop = pick('popular');
    ok('Recommended is the only filled badge', rec.bg !== pop.bg && ver.bg === pop.bg,
      JSON.stringify([rec.bg, ver.bg, pop.bg]));
    ok('Recommended is bolder than the rest', Number(rec.weight) > Number(pop.weight),
      rec.weight + ' vs ' + pop.weight);
    ok('Recommended and Verified are square; the others are pills',
      parseFloat(rec.radius) < 10 && parseFloat(ver.radius) < 10 && parseFloat(pop.radius) > 10,
      JSON.stringify([rec.radius, ver.radius, pop.radius]));
    ok('Verified carries a thicker left stripe than its other edges',
      parseFloat(ver.left) > parseFloat(ver.width), ver.left + ' vs ' + ver.width);
    ok('Top Seller has a heavier border than a plain chip',
      parseFloat(top.width) > parseFloat(pop.width), top.width + ' vs ' + pop.width);
    // The point of all of the above: strip the colour and they are still four
    // distinguishable things.
    const shapes = styles.map((s) => s.radius + '/' + s.width + '/' + s.left + '/' + s.weight);
    ok('so the four treatments differ without reference to any colour',
      new Set(shapes).size === 4, shapes.join('  '));
    await ctx.close();
  }

  // ---- overflow -----------------------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await render(page, ALL, { size: 'chip', max: 2, interactive: false });
    const r = await page.evaluate(() => ({
      shown: Array.from(document.querySelectorAll('.seller-badge:not(.seller-badge--more) .seller-badge-label'))
        .map((e) => e.textContent.trim()),
      more: (document.querySelector('.seller-badge--more') || {}).textContent,
      moreAria: (document.querySelector('.seller-badge--more') || {}).getAttribute
        ? document.querySelector('.seller-badge--more').getAttribute('aria-label') : null
    }));
    ok('a capped row shows the two HIGHEST-priority badges, not the first two given',
      r.shown.join(' | ') === 'Mwakete Recommended | Top Seller', r.shown.join(' | '));
    ok('the rest collapse into one counter', (r.more || '').trim() === '+6', r.more);
    ok('and a screen reader hears what is behind it, not just "+6"',
      /6 more seller badges: Verified Seller, Responsive Seller/.test(r.moreAria || ''), r.moreAria);
    await ctx.close();
  }

  // ---- interactive:false is safe to put inside a link ---------------------
  {
    const { ctx, page } = await open(browser);
    await render(page, ALL, { size: 'chip', max: 3, interactive: false });
    const r = await page.evaluate(() => ({
      buttons: document.querySelectorAll('#badge-host button').length,
      pops: document.querySelectorAll('#badge-host .info-pop').length,
      group: (document.querySelector('.seller-badges') || {}).getAttribute
        ? document.querySelector('.seller-badges').getAttribute('aria-label') : null
    }));
    ok('a card row emits NO button - a button inside an <a> navigates instead of explaining',
      r.buttons === 0, String(r.buttons));
    ok('and no orphan popovers with it', r.pops === 0, String(r.pops));
    ok('the row is announced as a group', r.group === 'Seller badges', r.group);
    await ctx.close();
  }

  // ---- the disclosure -----------------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await render(page, ['recommended', 'verified'], { size: 'detail' });

    const wiring = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button.seller-badge')).map((b) => {
        const pop = document.getElementById(b.getAttribute('aria-controls'));
        return { expanded: b.getAttribute('aria-expanded'), hasPop: !!pop,
                 hidden: pop ? pop.hidden : null, text: pop ? pop.textContent : '' };
      }));
    ok('each badge is a button pointing at a real panel', wiring.length === 2
      && wiring.every((w) => w.hasPop), JSON.stringify(wiring));
    ok('shut to begin with, and said to be shut',
      wiring.every((w) => w.hidden === true && w.expanded === 'false'));
    ok('and the panel holds that badge\'s own sentence',
      wiring[0].text === 'Recommended by Mwakete based on seller performance and customer experience.',
      wiring[0].text);

    const before = await box(page, '#sibling-below');
    await page.click('button.seller-badge >> nth=0');
    await page.waitForTimeout(150);
    const after = await box(page, '#sibling-below');
    ok('tapping it opens the panel',
      await page.locator('.seller-badge-pop >> nth=0').isVisible());
    ok('and says so', (await page.getAttribute('button.seller-badge >> nth=0', 'aria-expanded')) === 'true');
    ok('opening it moves NOTHING on the page',
      before && after && before.y === after.y, JSON.stringify([before, after]));

    // Two panels overlapping at 390px is unreadable.
    await page.click('button.seller-badge >> nth=1');
    await page.waitForTimeout(150);
    const openCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.seller-badge-pop')).filter((p) => !p.hidden).length);
    ok('opening a second one shuts the first', openCount === 1, String(openCount));

    await page.click('#sibling-above');
    await page.waitForTimeout(150);
    ok('tapping anywhere else shuts it',
      await page.evaluate(() => Array.from(document.querySelectorAll('.seller-badge-pop'))
        .every((p) => p.hidden)));
    await ctx.close();
  }

  // ---- keyboard -----------------------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await render(page, ['top', 'new'], { size: 'detail' });
    await page.focus('button.seller-badge >> nth=0');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    ok('Enter opens it', await page.locator('.seller-badge-pop >> nth=0').isVisible());

    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('Escape shuts it', await page.locator('.seller-badge-pop >> nth=0').isHidden());
    ok('and focus comes back to the badge rather than being stranded',
      await page.evaluate(() => document.activeElement
        && document.activeElement.classList.contains('seller-badge')));

    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    ok('Space opens it too', await page.locator('.seller-badge-pop >> nth=0').isVisible());
    await ctx.close();
  }

  // ---- the panel stays on screen -----------------------------------------
  for (const w of [390, 768]) {
    const { ctx, page } = await open(browser, w);
    // Eight detail badges wrap across several rows, so some sit hard against
    // the left edge and some against the right - both cases in one pass.
    await render(page, ALL, { size: 'detail' });
    const n = await page.evaluate(() => document.querySelectorAll('button.seller-badge').length);
    let worst = null;
    for (let i = 0; i < n; i++) {
      // Escape first. An open panel overlaps the badge beside it, so a tap
      // there lands on the panel and dismisses it - correct behaviour for a
      // popover, and the reason a real shopper's second tap opens rather than
      // swaps. The test has to dismiss deliberately or it just fights that.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(40);
      await page.click(`button.seller-badge >> nth=${i}`);
      await page.waitForTimeout(60);
      const r = await page.evaluate(() => {
        const p = Array.from(document.querySelectorAll('.seller-badge-pop')).find((x) => !x.hidden);
        if (!p) return null;
        const b = p.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right), vw: window.innerWidth };
      });
      if (!r) continue;
      if (r.left < 0 || r.right > r.vw) worst = r;
    }
    ok(w + 'px: every badge\'s panel opens fully on screen', worst === null, JSON.stringify(worst));
    await ctx.close();
  }

  // ---- the row wraps instead of overflowing -------------------------------
  {
    const { ctx, page } = await open(browser, 390);
    await render(page, ALL, { size: 'chip', interactive: false });
    const r = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      rows: new Set(Array.from(document.querySelectorAll('.seller-badge'))
        .map((e) => Math.round(e.getBoundingClientRect().top))).size,
      widest: Math.max.apply(null, Array.from(document.querySelectorAll('.seller-badge'))
        .map((e) => Math.round(e.getBoundingClientRect().width)))
    }));
    ok('at 390px eight chips wrap onto several rows', r.rows > 1, String(r.rows));
    ok('and the page does not scroll sideways because of them',
      r.docWidth <= r.vw + 1, r.docWidth + ' vs ' + r.vw);
    ok('no single badge is wider than the screen', r.widest < r.vw, String(r.widest));
    await ctx.close();
  }

  // ---- the legend ---------------------------------------------------------
  {
    const { ctx, page } = await open(browser, 390);
    await page.evaluate(() => {
      document.getElementById('badge-host').innerHTML = renderBadgeLegend();
    });
    const r = await page.evaluate(() => ({
      terms: document.querySelectorAll('.badge-legend dt').length,
      defs: Array.from(document.querySelectorAll('.badge-legend dd')).map((e) => e.textContent.trim()),
      buttons: document.querySelectorAll('.badge-legend button').length,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
    }));
    ok('the legend explains all eight', r.terms === 8 && r.defs.length === 8, String(r.terms));
    ok('each with its own sentence', r.defs.every((d) => d.length > 20) && new Set(r.defs).size === 8);
    ok('and no popovers in it - the panel IS the explanation', r.buttons === 0, String(r.buttons));
    ok('it fits a 390px screen', r.overflow);
    await ctx.close();
  }

  // ---- nothing breaks on the page it was injected into --------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ ok: true, products: [], stores: [] }) }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.goto(BASE + '/customer-login.html', { waitUntil: 'load' });
    await page.waitForTimeout(900);
    ok('customer-login still loads with no JS errors after wireInfoDot moved to helpers',
      errs.length === 0, errs.join(' | '));
    await page.click('#guest-info-btn');
    await page.waitForTimeout(200);
    ok('and its info dot still opens', await page.locator('#guest-info').isVisible());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('and still closes on Escape', await page.locator('#guest-info').isHidden());
    await ctx.close();
  }

  await browser.close();

  // ---- read from the source: things a runtime test cannot see -------------
  const css = fs.readFileSync(REPO + 'assets/css/styles.css', 'utf8');
  ok('there is a forced-colours block, so high contrast keeps the shape differences',
    /@media \(forced-colors: active\)[\s\S]{0,1200}seller-badge--ribbon/.test(css));
  ok('and a reduced-motion block',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.seller-badge \{\s*transition: none/.test(css));
  // Importance must not be carried by movement.
  const badgeCss = css.slice(css.indexOf('.seller-badges {'), css.indexOf('---- Legal pages'));
  ok('no badge animates - nothing in this set communicates by movement',
    !/animation:/.test(badgeCss) && !/@keyframes/.test(badgeCss));
  ok('the only transition is on colour', (badgeCss.match(/transition:/g) || []).length === 2
    && /transition: border-color .12s ease, background-color .12s ease/.test(badgeCss));

  const js = fs.readFileSync(REPO + 'assets/js/badges.js', 'utf8');
  ok('no badge loads an image or an icon font - the icons are inline',
    !/<img/.test(js) && !/url\(/.test(js) && !/\.svg["']/.test(js));
  ok('labels and explanations go through escapeHtml',
    (js.match(/escapeHtml\(b\.label\)/g) || []).length >= 1
    && (js.match(/escapeHtml\(b\.explain\)/g) || []).length >= 1);

  // The component must not have quietly re-introduced the duplicate it replaced.
  const login = fs.readFileSync(REPO + 'assets/js/customer-login.js', 'utf8');
  const helpers = fs.readFileSync(REPO + 'assets/js/helpers.js', 'utf8');
  ok('wireInfoDot exists in exactly one place',
    /function wireInfoDot/.test(helpers) && !/function wireInfoDot/.test(login));
  ok('and so does closeAllInfoPops',
    /function closeAllInfoPops/.test(helpers) && !/function closeAllInfoPops/.test(login));

  ok('the new module is precached, or returning visitors get old markup',
    /assets\/js\/badges\.min\.js/.test(fs.readFileSync(REPO + 'sw.js', 'utf8')));

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
