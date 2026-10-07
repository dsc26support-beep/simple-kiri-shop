/**
 * A guest who has not given a name yet opens the chat on a store page and
 * taps Meetings. The "What's your name?" prompt fills the chat (flex: 1), and
 * the Meetings panel used to sit BELOW it - so on a phone "Request Meeting"
 * was off the bottom of the screen. Now the prompt steps aside while Meetings
 * is open, and comes back when it closes.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [w, h] of [[360, 560], [360, 640], [360, 740], [390, 844], [412, 915]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.route('**/macros/s/**', (route) => {
      let a = '';
      try { a = (route.request().postDataJSON() || {}).action || ''; } catch (e) {}
      if (!a) a = new URL(route.request().url()).searchParams.get('action') || '';
      const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (a === 'listMeetingsForConversation') return J({ ok: true, meetings: [] });
      if (a === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
      if (a === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Burabonita', storeSlug: 'bong' } });
      return J({ ok: true, products: [], stores: [], storeName: 'Burabonita' });
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    // Signed out, and no chat name stored: the name prompt shows.
    await page.addInitScript(() => { try { localStorage.setItem('skiri_cookie_consent', 'true'); } catch (e) {} });
    await page.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
    await page.click('#chat-fab');
    await page.waitForSelector('#chat-window.chat-window--open');
    await page.waitForTimeout(300);
    ok(w + 'px: the name prompt is showing', await page.isVisible('#chat-name-gate'));

    await page.click('#chat-video-call-btn');
    await page.waitForSelector('#meeting-panel-host .meeting-request-trigger');
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => {
      const b = document.querySelector('#meeting-panel-host .meeting-request-trigger').getBoundingClientRect();
      const body = document.getElementById('chat-window-body').getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, bodyBottom: body.bottom, vh: innerHeight,
        gate: getComputedStyle(document.getElementById('chat-name-gate')).display };
    });
    ok(w + 'px: Request Meeting is on screen without scrolling', m.top >= 0 && m.bottom <= Math.min(m.vh, m.bodyBottom), JSON.stringify(m));
    ok(w + 'px: the name prompt steps aside while Meetings is open', m.gate === 'none');
    // Right under the chat header, so nothing about the phone's bottom edge
    // (system bar, browser bar, installed-app quirks) can hide it.
    ok(w + 'px: Request Meeting sits near the top of the chat', m.top < 260, Math.round(m.top));

    await page.click('#chat-video-call-btn');
    await page.waitForTimeout(200);
    ok(w + 'px: closing Meetings brings the name prompt back', await page.isVisible('#chat-name-gate')
      && await page.$eval('#meeting-panel-host', (e) => e.classList.contains('hidden')));
    ok(w + 'px: no JS errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  await browser.close();
  let f = 0;
  console.log('\n--- Meetings vs the name prompt ---');
  for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e !== '' ? '  [' + e + ']' : ''}`); }
  console.log(`\n${R.length - f}/${R.length} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
