/**
 * Video Call (meeting requests), customer side - assets/js/meetings-ui.js
 * mounted into the floating chat widget via assets/js/chat-window.js.
 *
 * THE CLAIM THAT MATTERS MOST: meetings-ui.min.js is never fetched just
 * because a chat widget exists on the page, or even just because the chat
 * panel was opened - only clicking the Video Call button may load it. That is
 * the whole point of the lazy-load design (see chat-window.js's
 * loadMeetingsUi), and it is the one thing a code read alone can't prove -
 * a regression here would silently turn every chat page load into a heavier
 * one for a feature almost nobody uses yet.
 *
 * Second: branding. No response body, card, form or link in this file's
 * scope may ever mention the underlying video provider by name - the whole
 * point of "Video Call" as Mwakete's own term for it.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

function mockRoute(meetingsState) {
  return async (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}

    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (action === 'listMeetingsForConversation') return J({ ok: true, meetings: meetingsState.list });

    if (action === 'requestMeeting') {
      const m = {
        meetingId: 'new-' + (meetingsState.list.length + 1),
        conversationId: 'c1',
        requesterType: 'customer',
        recipientType: 'vendor',
        purpose: body.purpose,
        notes: body.notes || '',
        requestedDate: body.requestedDate,
        requestedTime: body.requestedTime,
        status: 'REQUESTED',
        meetingUrl: '',
        meetFailed: false,
        createdAt: new Date().toISOString()
      };
      meetingsState.list.push(m);
      return J({ ok: true, meeting: m });
    }

    if (action === 'respondToMeeting') {
      const m = meetingsState.list.find((x) => x.meetingId === body.meetingId);
      if (m) {
        if (body.accept) {
          m.status = 'READY';
          m.meetingUrl = 'https://example-video.test/room/xyz';
        } else {
          m.status = 'DECLINED';
        }
      }
      return J({ ok: true, meeting: m });
    }

    if (action === 'retryMeetingSpace') {
      const m = meetingsState.list.find((x) => x.meetingId === body.meetingId);
      if (m) { m.status = 'READY'; m.meetingUrl = 'https://example-video.test/room/retry'; m.meetFailed = false; }
      return J({ ok: true, meeting: m });
    }

    if (action === 'cancelMeeting') {
      const m = meetingsState.list.find((x) => x.meetingId === body.meetingId);
      if (m) m.status = 'CANCELLED';
      return J({ ok: true });
    }

    if (action === 'endMeeting') {
      const m = meetingsState.list.find((x) => x.meetingId === body.meetingId);
      if (m) m.status = 'ENDED';
      return J({ ok: true });
    }

    if (action === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Bong Store', storeSlug: 'bong' } });
    if (action === 'getConversation') return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false });
    if (action === 'searchProducts') return J({ ok: true, products: [] });

    return J({ ok: true, products: [], stores: [] });
  };
}

async function openChat(browser, opts) {
  opts = opts || {};
  const requested = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctx.on('request', (r) => { if (/meetings-ui/.test(r.url())) requested.push(r.url()); });
  await ctx.route('**/macros/s/**', mockRoute(opts.meetingsState || { list: [] }));
  const page = await ctx.newPage();
  await page.addInitScript((loggedIn) => {
    try {
      localStorage.setItem('skiri_cookie_consent', 'true');
      localStorage.setItem('skiri_chat_name_bong', 'Test Customer');
      if (loggedIn) {
        localStorage.setItem('skiri_customer_token', 'faketoken');
        localStorage.setItem('skiri_customer_profile', JSON.stringify({ customerId: 'cust1', name: 'Test Customer' }));
      }
    } catch (e) {}
  }, !!opts.loggedIn);
  await page.goto(BASE + '/store.html?store=bong', { waitUntil: 'load' });
  await page.waitForSelector('#chat-fab');
  await page.click('#chat-fab');
  await page.waitForSelector('#chat-window.chat-window--open');
  await page.waitForTimeout(300);
  return { ctx, page, requested };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- lazy load: never fetched until the button is clicked ---- */
  {
    const { ctx, page, requested } = await openChat(browser, { loggedIn: true });
    ok('meetings-ui is NOT fetched just from opening the chat panel', requested.length === 0, JSON.stringify(requested));
    ok('the Video Call button exists in the chat header', await page.$('#chat-video-call-btn') !== null);
    await page.click('#chat-video-call-btn');
    await page.waitForTimeout(400);
    ok('clicking Video Call fetches meetings-ui exactly once', requested.length === 1, JSON.stringify(requested));
    ok('the panel is now visible', !(await page.$eval('#meeting-panel-host', (e) => e.classList.contains('hidden'))));
    await ctx.close();
  }

  /* ---- signed out: no form, a sign-in hint instead ---- */
  {
    const { ctx, page } = await openChat(browser, { loggedIn: false });
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('#meeting-panel-host .meeting-empty-state, #meeting-panel-host .meeting-request-signin-hint');
    const hasForm = await page.$('#meeting-panel-host .meeting-request-trigger') !== null;
    const hint = await page.$eval('#meeting-panel-host', (e) => e.textContent);
    ok('signed-out customer gets no Request Meeting trigger', !hasForm);
    ok('...and sees a sign-in explanation instead', /sign in/i.test(hint), hint);
    await ctx.close();
  }

  /* ---- signed in: request a meeting end to end ---- */
  {
    const state = { list: [] };
    const { ctx, page } = await openChat(browser, { loggedIn: true, meetingsState: state });
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('.meeting-request-trigger');
    await page.click('.meeting-request-trigger');
    await page.waitForSelector('.meeting-request-form');

    // empty submit is rejected client-side, no request sent
    await page.click('.meeting-request-submit');
    await page.waitForTimeout(150);
    ok('empty request is rejected before hitting the network', state.list.length === 0, JSON.stringify(state.list));
    ok('...and shows an inline error', !(await page.$eval('.meeting-request-error', (e) => e.classList.contains('hidden'))));

    await page.fill('.meeting-request-form textarea', 'Discuss a custom order');
    const tomorrow = new Date(Date.now() + 86400000);
    const dateStr = tomorrow.toISOString().slice(0, 10);
    await page.fill('.meeting-request-form input[type="date"]', dateStr);
    await page.fill('.meeting-request-form input[type="time"]', '14:30');
    await page.click('.meeting-request-submit');
    await page.waitForTimeout(300);

    ok('submitting a filled form sends the request', state.list.length === 1, JSON.stringify(state.list));
    const cardText = await page.$eval('.meeting-list', (e) => e.textContent);
    ok('the new meeting appears in the list as Requested', /Requested/.test(cardText), cardText);
    ok('...with the purpose shown', /Discuss a custom order/.test(cardText), cardText);
    await ctx.close();
  }

  /* ---- a vendor-initiated request awaiting this customer's answer ---- */
  {
    const state = { list: [{
      meetingId: 'm1', conversationId: 'c1', requesterType: 'vendor', recipientType: 'customer',
      purpose: 'Quick chat about delivery', notes: '', requestedDate: '2027-01-01', requestedTime: '10:00',
      status: 'REQUESTED', meetingUrl: '', meetFailed: false, createdAt: '2026-01-01T00:00:00Z'
    }] };
    const { ctx, page } = await openChat(browser, { loggedIn: true, meetingsState: state });
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('.meeting-card');
    const buttons = await page.$$eval('.meeting-card-actions button', (els) => els.map((e) => e.textContent.trim()));
    ok('a vendor-initiated request offers Accept and Decline', buttons.includes('Accept') && buttons.includes('Decline'), buttons.join(','));

    await page.click('.meeting-card-actions button:has-text("Accept")');
    await page.waitForSelector('a:has-text("Join Video Call")');
    const join = await page.$eval('a:has-text("Join Video Call")', (a) => ({ href: a.href, target: a.target, rel: a.rel }));
    ok('accepting shows a Join Video Call link to the real meeting URL', join.href === 'https://example-video.test/room/xyz', JSON.stringify(join));
    ok('...opened in a new tab, without leaking window.opener', join.target === '_blank' && /noopener/.test(join.rel), JSON.stringify(join));

    const panelText = await page.$eval('#meeting-panel-host', (e) => e.textContent);
    ok('no provider branding is exposed anywhere in the panel', !/google/i.test(panelText), panelText);
    await ctx.close();
  }

  /* ---- a failed Meet setup offers Retry, never a false "ready" ---- */
  {
    const state = { list: [{
      meetingId: 'm2', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor',
      purpose: 'Follow-up', notes: '', requestedDate: '2027-01-02', requestedTime: '11:00',
      status: 'ACCEPTED', meetingUrl: '', meetFailed: true, createdAt: '2026-01-01T00:00:00Z'
    }] };
    const { ctx, page } = await openChat(browser, { loggedIn: true, meetingsState: state });
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('.meeting-card');
    const before = await page.$eval('.meeting-card', (e) => e.textContent);
    ok('a failed setup never shows a Join Video Call button', !/Join Video Call/.test(before), before);
    ok('...and offers Retry instead', /Retry/.test(before), before);

    await page.click('button:has-text("Retry")');
    await page.waitForSelector('a:has-text("Join Video Call")');
    ok('retrying succeeds and reveals Join Video Call', true);
    await ctx.close();
  }

  /* ---- cancel ---- */
  {
    const state = { list: [{
      meetingId: 'm3', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor',
      purpose: 'To be cancelled', notes: '', requestedDate: '2027-01-03', requestedTime: '09:00',
      status: 'REQUESTED', meetingUrl: '', meetFailed: false, createdAt: '2026-01-01T00:00:00Z'
    }] };
    const { ctx, page } = await openChat(browser, { loggedIn: true, meetingsState: state });
    ctx.on('dialog', (d) => d.accept());
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('.meeting-card');
    await page.click('button:has-text("Cancel Meeting")');
    await page.waitForTimeout(300);
    ok('cancelling reaches the backend and updates the card', state.list[0].status === 'CANCELLED', state.list[0].status);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
