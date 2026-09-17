/**
 * The home search box: three rotating prompts, a purple outline, and the
 * footers that lost their links.
 *
 * THE ASSERTIONS THAT MATTER MOST are the two that stop the rotation being a
 * problem rather than a flourish:
 *
 * 1. THE ACCESSIBLE NAME DOES NOT ROTATE. A placeholder is part of what a
 *    screen reader announces for a field. If it rotated, the field would
 *    rename itself every 3.5s while someone was still deciding what to type.
 *    The aria-label is set once and checked against the browser's own
 *    accessibility tree, not against the markup.
 *
 * 2. IT STOPS WHEN THEY ENGAGE, and never starts under prefers-reduced-motion.
 *    Text that changes on its own is motion.
 *
 * Also checked: the box cannot change size as the prompt changes (that would
 * be a layout shift on every tick), and the payments statement that left the
 * home footer actually arrived at checkout rather than simply vanishing.
 */
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const REPO = '/home/user/simple-kiri-shop/';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

const PROMPTS = ['What is on your mind?', 'Ask Mwakete…', 'Try using Kiribati language.'];

async function open(browser, path, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: { width: opts.width || 390, height: 844 },
    reducedMotion: opts.reducedMotion || 'no-preference'
  });
  await ctx.route('**/macros/s/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, products: [], stores: [], tips: [] })
  }));
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
  await page.goto(BASE + path, { waitUntil: 'load' });
  return { ctx, page };
}

const ph = (page) => page.$eval('#search-input', (el) => el.placeholder);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- the three prompts, in order, on a 3.5s beat ---------------------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    ok('starts on the first prompt', (await ph(page)) === PROMPTS[0], await ph(page));

    // The markup carries it too, so the very first frame is never the old
    // wording waiting for a deferred script to run.
    const html = fs.readFileSync(REPO + 'index.html', 'utf8');
    ok('and the markup seeds it, so no frame shows the old placeholder',
      html.indexOf('placeholder="What is on your mind?"') !== -1
      && html.indexOf('Search products, services, rentals') === -1);

    // Sampled rather than waited on: read every 250ms for ~8s and check the
    // sequence that comes back, which does not depend on landing exactly on a
    // tick boundary.
    // ~14s, which is the shortest window that can contain three changes at a
    // 3.5s beat and therefore the shortest that can show the wrap back to the
    // first prompt. 8.5s only ever reached the third one, which proves the
    // sequence but not the modulo.
    const seen = [];
    for (let i = 0; i < 58; i++) {
      const p = await ph(page);
      if (seen[seen.length - 1] !== p) seen.push(p);
      await page.waitForTimeout(250);
    }
    ok('cycles through all three', PROMPTS.every((p) => seen.indexOf(p) !== -1), seen.join(' | '));
    ok('in the order given, and wraps back round',
      seen.slice(0, 4).join('|') === PROMPTS.concat([PROMPTS[0]]).join('|'), seen.join(' | '));
    ok('and changes about every 3.5s, not faster',
      seen.length >= 3 && seen.length <= 6, (seen.length - 1) + ' changes in ~14.5s');
    await ctx.close();
  }

  /* ---- what a screen reader gets ---------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    const nameOf = async () => {
      const snap = await page.accessibility.snapshot();
      let found = null;
      (function walk(n) {
        if (!n) return;
        if ((n.role === 'searchbox' || n.role === 'textbox') && !found) found = n.name;
        (n.children || []).forEach(walk);
      })(snap);
      return found;
    };
    const first = await nameOf();
    await page.waitForTimeout(4200);
    const second = await nameOf();
    const changed = await ph(page);
    ok('the visible prompt has moved on by now', changed !== PROMPTS[0], changed);
    ok('THE ACCESSIBLE NAME DID NOT MOVE WITH IT',
      !!first && first === second, first + ' -> ' + second);
    ok('and that name says what the field is for',
      /search/i.test(first || ''), String(first));
    await ctx.close();
  }

  /* ---- it stops the moment they engage ---------------------------------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    await page.click('#search-input');
    const atFocus = await ph(page);
    await page.waitForTimeout(4200);
    ok('focusing the box freezes the prompt', (await ph(page)) === atFocus, atFocus + ' -> ' + await ph(page));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/index.html');
    await page.fill('#search-input', 'rice');
    await page.waitForTimeout(4200);
    ok('and typing never has the prompt change underneath',
      (await page.$eval('#search-input', (el) => el.value)) === 'rice');
    await ctx.close();
  }

  /* ---- reduced motion --------------------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/index.html', { reducedMotion: 'reduce' });
    const before = await ph(page);
    await page.waitForTimeout(4200);
    ok('prefers-reduced-motion gets one prompt and no rotation',
      before === PROMPTS[0] && (await ph(page)) === PROMPTS[0], before + ' -> ' + await ph(page));
    await ctx.close();
  }

  /* ---- the rotation cannot move the page -------------------------------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    const box = () => page.$eval('#search-input', (el) => {
      const b = el.getBoundingClientRect();
      return Math.round(b.width) + 'x' + Math.round(b.height) + '@' + Math.round(b.x) + ',' + Math.round(b.y);
    });
    // Settle first. An EMPTY search box collapses its submit button away
    // (.search-box.is-empty, added by helpers.js after load, with a 0.18s
    // transition), and the input widens into the space. That is pre-existing
    // and nothing to do with the prompt - but measuring across it would blame
    // the rotation for 23px that belong to the button.
    await page.waitForTimeout(700);
    const first = await box();
    await page.waitForTimeout(4200);
    ok('the box is the same size and place whichever prompt is showing',
      (await box()) === first, first + ' -> ' + await box());
    await ctx.close();
  }

  /* ---- purple outline on all four search boxes -------------------------- */
  for (const path of ['/index.html', '/categories.html', '/store.html?store=x', '/stores.html']) {
    const { ctx, page } = await open(browser, path);
    const r = await page.evaluate(() => {
      const el = document.querySelector('.search-box input');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { colour: cs.borderTopColor, width: cs.borderTopWidth, style: cs.borderTopStyle };
    });
    // --color-purple is #332d63.
    ok('thin purple outline: ' + path,
      r && r.colour === 'rgb(51, 45, 99)' && r.width === '1px' && r.style === 'solid',
      JSON.stringify(r));
    await ctx.close();
  }
  {
    // Scoped: it must not have turned every field on the site purple.
    const { ctx, page } = await open(browser, '/customer-login.html');
    const other = await page.evaluate(() => {
      const el = document.getElementById('login-email') || document.querySelector('input[type="email"]');
      return el ? getComputedStyle(el).borderTopColor : null;
    });
    ok('other inputs keep the ordinary grey border', other !== 'rgb(51, 45, 99)', String(other));
    await ctx.close();
  }

  /* ---- the grey band is gone -------------------------------------------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    const hero = await page.evaluate(() => {
      const el = document.querySelector('.hero');
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, img: cs.backgroundImage, pad: cs.paddingTop };
    });
    ok('the hero has no background of its own',
      hero.bg === 'rgba(0, 0, 0, 0)' && hero.img === 'none', JSON.stringify(hero));
    ok('but keeps its breathing room', parseFloat(hero.pad) > 0, hero.pad);
    await ctx.close();
  }

  /* ---- the footers ------------------------------------------------------ */
  for (const path of ['/index.html', '/customer-login.html']) {
    const { ctx, page } = await open(browser, path);
    const f = await page.evaluate(() => {
      const el = document.querySelector('footer.site-footer');
      if (!el) return null;
      return {
        links: Array.from(el.querySelectorAll('a')).map((a) => a.textContent.trim()),
        text: el.textContent.replace(/\s+/g, ' ').trim()
      };
    });
    ok('footer keeps only Terms and Privacy: ' + path,
      f && f.links.join('|') === 'Terms|Privacy', f ? f.links.join(' | ') : 'no footer');
    ok('and none of the removed links survive: ' + path,
      f && !/Browse All Stores|Vendor Login|Enquiry/.test(f.text), f && f.text);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '/index.html');
    ok('the payments line has left the home page',
      !/All payments/i.test(await page.evaluate(() => document.body.textContent)));
    await ctx.close();
  }

  /* ---- ...and arrived at checkout --------------------------------------- */
  {
    const checkout = fs.readFileSync(REPO + 'checkout.html', 'utf8');
    ok('checkout now states it, in correct English',
      /All payments are arranged directly between you and the seller/.test(checkout));
    ok('and it is not said twice on that page',
      (checkout.match(/All payments/g) || []).length === 1);
    ok('the line that was already there is kept, not replaced',
      /we'll email the store your details automatically/.test(checkout));
  }

  /* ---- the Search button is gone from home, and only from home --------- */
  {
    const { ctx, page } = await open(browser, '/index.html');
    ok('the home search box has no submit button',
      (await page.$$('#search-form button[type="submit"]')).length === 0);
    ok('and no magnifying glass is left behind',
      (await page.$$('#search-form .search-submit, #search-form .search-submit-icon')).length === 0);
    // Removing the button must not remove the ability to search.
    await page.fill('#search-input', 'rice');
    await page.press('#search-input', 'Enter');
    await page.waitForURL(/categories\.html\?q=rice/, { timeout: 6000 }).catch(() => {});
    ok('Enter still runs the search', /categories\.html\?q=rice/.test(page.url()), page.url());
    await ctx.close();
  }
  for (const path of ['/categories.html', '/store.html?store=x', '/stores.html']) {
    const { ctx, page } = await open(browser, path);
    ok('the other boxes keep their Search button: ' + path,
      (await page.$$('.search-box button[type="submit"]')).length === 1);
    await ctx.close();
  }

  /* ---- the microphone ---------------------------------------------------- */
  //
  // Playwright's Chromium has no working SpeechRecognition, so the API is
  // faked before any script runs. That is the point: it lets the whole flow be
  // exercised - reveal, listen, transcript, submit - rather than only checking
  // that a button exists.
  const FAKE = (transcript, errorKind) => `
    (function () {
      function R() { this.lang = ''; this._h = {}; }
      R.prototype.addEventListener = function (k, fn) { (this._h[k] = this._h[k] || []).push(fn); };
      R.prototype._fire = function (k, e) { (this._h[k] || []).forEach(function (fn) { fn(e || {}); }); };
      R.prototype.start = function () {
        var self = this;
        window.__voiceLang = this.lang;
        self._fire('start');
        setTimeout(function () {
          ${errorKind
            ? `self._fire('error', { error: ${JSON.stringify(errorKind)} }); self._fire('end');`
            : `self._fire('result', { results: [[{ transcript: ${JSON.stringify(transcript)} }]] }); self._fire('end');`}
        }, 60);
      };
      R.prototype.abort = function () { this._fire('end'); };
      window.SpeechRecognition = R;
    })();`;

  async function withVoice(transcript, errorKind) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, products: [], stores: [] })
    }));
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.addInitScript(FAKE(transcript, errorKind));
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    return { ctx, page };
  }

  {
    // No API at all: the button must never be shown.
    //
    // Headless Chromium DOES define webkitSpeechRecognition, so this has to
    // take it away explicitly - relying on the test browser not having it
    // would have asserted nothing.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/macros/s/**', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: '{"ok":true,"products":[],"stores":[]}'
    }));
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {}
      try {
        delete window.SpeechRecognition;
        delete window.webkitSpeechRecognition;
        Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
        Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
      } catch (e) {}
    });
    await page.goto(BASE + '/index.html', { waitUntil: 'load' });
    const hidden = await page.evaluate(() => {
      const b = document.getElementById('voice-search-btn');
      return b ? (b.hidden || getComputedStyle(b).display === 'none') : null;
    });
    ok('WITHOUT speech support the mic stays hidden', hidden === true, String(hidden));
    ok('...and the search box still works without it',
      !!(await page.$('#search-input')));
    await ctx.close();
  }

  {
    const { ctx, page } = await withVoice('solar panel');
    ok('with speech support the mic is shown',
      await page.$eval('#voice-search-btn', (b) => !b.hidden));
    ok('and it says the language out loud in its name',
      /english/i.test(await page.$eval('#voice-search-btn', (b) => b.getAttribute('aria-label') || '')),
      await page.$eval('#voice-search-btn', (b) => b.getAttribute('aria-label')));
    ok('it starts not-pressed',
      (await page.$eval('#voice-search-btn', (b) => b.getAttribute('aria-pressed'))) === 'false');

    await page.click('#voice-search-btn');
    // encodeURIComponent, so a space is %20 - not the '+' a form GET would use.
    await page.waitForURL(/categories\.html\?q=solar%20panel/, { timeout: 6000 }).catch(() => {});
    ok('speaking fills the box and runs the search',
      /categories\.html\?q=solar%20panel/.test(page.url()), page.url());
    await ctx.close();
  }

  {
    const { ctx, page } = await withVoice('rice');
    const lang = await page.evaluate(async () => {
      document.getElementById('voice-search-btn').click();
      return window.__voiceLang;
    });
    ok('it listens in English, since Kiribati is not a language browsers offer',
      lang === 'en-GB', String(lang));
    await ctx.close();
  }

  {
    // A blocked microphone is one mis-tap on a permission sheet, so it is the
    // common case, not an edge case. The button must not stay stuck looking live.
    const { ctx, page } = await withVoice('', 'not-allowed');
    await page.click('#voice-search-btn');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      pressed: document.getElementById('voice-search-btn').getAttribute('aria-pressed'),
      listening: document.getElementById('voice-search-btn').classList.contains('is-listening'),
      said: document.getElementById('voice-search-status').textContent
    }));
    ok('a blocked microphone resets the button', after.pressed === 'false' && after.listening === false,
      JSON.stringify(after));
    ok('and says what went wrong, out loud', /microphone blocked/i.test(after.said), after.said);
    ok('and does not navigate anywhere', /index\.html$/.test(page.url()), page.url());
    await ctx.close();
  }

  {
    // Listening must be announced, not only drawn red.
    const { ctx, page } = await withVoice('rice');
    await page.evaluate(() => document.getElementById('voice-search-btn').click());
    const live = await page.evaluate(() => ({
      status: document.getElementById('voice-search-status').textContent,
      role: document.getElementById('voice-search-status').getAttribute('aria-live'),
      pressed: document.getElementById('voice-search-btn').getAttribute('aria-pressed'),
      red: document.getElementById('voice-search-btn').classList.contains('is-listening')
    }));
    ok('listening is announced, not just coloured',
      /listening/i.test(live.status) && live.role === 'polite', JSON.stringify(live));
    ok('and the pressed state matches what is drawn',
      live.pressed === 'true' && live.red === true, JSON.stringify(live));
    await ctx.close();
  }

  {
    // The live state cannot be signalled by hue alone.
    const { ctx, page } = await withVoice('rice');
    const diff = await page.evaluate(() => {
      const b = document.getElementById('voice-search-btn');
      const before = getComputedStyle(b);
      const idle = { bg: before.backgroundColor, shadow: before.boxShadow };
      b.classList.add('is-listening');
      const on = getComputedStyle(b);
      return { idle: idle, live: { bg: on.backgroundColor, shadow: on.boxShadow } };
    });
    ok('the live state changes fill AND adds a ring, not just colour',
      diff.idle.bg !== diff.live.bg && diff.idle.shadow !== diff.live.shadow, JSON.stringify(diff));
    await ctx.close();
  }

  {
    // A long query must not run underneath the button.
    const { ctx, page } = await withVoice('rice');
    const r = await page.evaluate(() => {
      const input = document.getElementById('search-input');
      const btn = document.getElementById('voice-search-btn');
      const pad = parseFloat(getComputedStyle(input).paddingRight);
      const ib = input.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      return { pad: pad, btnW: Math.round(bb.width), btnH: Math.round(bb.height),
        insideRight: bb.right <= ib.right + 1, insideLeft: bb.left >= ib.left };
    });
    ok('the mic sits inside the bar at its right edge', r.insideRight && r.insideLeft, JSON.stringify(r));
    ok('and the field reserves room so text cannot run under it', r.pad >= r.btnW, JSON.stringify(r));
    ok('the mic is a reasonable tap target', r.btnW >= 32 && r.btnH >= 32, r.btnW + 'x' + r.btnH);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
