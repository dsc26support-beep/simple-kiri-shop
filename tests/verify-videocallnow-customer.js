/**
 * Video Call Now, customer side - the instant-call trigger inside the
 * lazy-loaded meetings-ui.js panel, and the lightweight, NOT-lazy-loaded
 * incoming-call banner in chat-window.js that a signed-out or panel-never-
 * opened customer still needs to see a vendor-initiated ring through.
 *
 * THE CLAIM THAT MATTERS MOST, same family as verify-meetings-customer.js:
 * the incoming-call banner must render and be fully usable (Accept/Decline)
 * WITHOUT ever fetching meetings-ui.min.js - it rides the chat window's own
 * existing getConversation poll and talks to the backend with plain Api
 * calls. Only accepting (which promotes to the full panel for Join/End)
 * may trigger the lazy load.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

function mockRoute(state) {
  return async (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (action === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Bong Store', storeSlug: 'bong' } });
    if (action === 'getConversation') {
      return J({ ok: true, conversation: null, messages: [], hasMoreBefore: false, incomingCall: state.incomingCall });
    }
    if (action === 'startVideoCallNow') {
      const m = {
        meetingId: 'now-1', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor',
        purpose: 'Video call', notes: '', requestedDate: '', requestedTime: '', status: 'RINGING',
        meetingUrl: '', meetFailed: false, ringingSecondsLeft: 45, createdAt: new Date().toISOString()
      };
      state.list = [m];
      return J({ ok: true, meeting: m });
    }
    if (action === 'listMeetingsForConversation') return J({ ok: true, meetings: state.list || [] });
    if (action === 'respondToMeeting') {
      const m = (state.list || []).find((x) => x.meetingId === body.meetingId) || state.incomingCall;
      if (body.accept) { m.status = 'READY'; m.meetingUrl = 'https://example-video.test/room/now'; }
      else { m.status = 'DECLINED'; }
      state.list = [m];
      state.incomingCall = null;
      return J({ ok: true, meeting: m });
    }
    if (action === 'searchProducts') return J({ ok: true, products: [] });
    return J({ ok: true, products: [], stores: [] });
  };
}

async function openChat(browser, opts) {
  opts = opts || {};
  const requested = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctx.on('request', (r) => { if (/meetings-ui/.test(r.url())) requested.push(r.url()); });
  await ctx.route('**/macros/s/**', mockRoute(opts.state || { list: [] }));
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

  /* ---- starting a call from the panel ---- */
  {
    const state = { list: [] };
    const { ctx, page } = await openChat(browser, { loggedIn: true, state });
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('.meeting-trigger-row');
    const labels = await page.$$eval('.meeting-trigger-row button', (els) => els.map((e) => e.textContent.trim()));
    ok('both Video Call Now and Request Meeting are offered', labels.includes('Video Call Now') && labels.includes('Request Meeting'), labels.join(','));

    await page.click('.meeting-trigger-row button:has-text("Video Call Now")');
    await page.waitForSelector('.meeting-card--ringing');
    const cardText = await page.$eval('.meeting-card--ringing', (e) => e.textContent);
    ok('starting a call shows a RINGING card with a countdown', /Ringing/.test(cardText) && /\d+s\)/.test(cardText), cardText);

    const triggerGone = await page.$('.meeting-trigger-row button:has-text("Video Call Now")');
    ok('the trigger hides itself while a call is already active', triggerGone === null);
    await ctx.close();
  }

  /* ---- signed-out customer: no Video Call Now trigger either ---- */
  {
    const { ctx, page } = await openChat(browser, { loggedIn: false });
    await page.click('#chat-video-call-btn');
    await page.waitForSelector('#meeting-panel-host .meeting-request-signin-hint');
    const anyButtons = await page.$$('.meeting-trigger-row');
    ok('a signed-out customer sees no trigger row at all (same bar as Request Meeting)', anyButtons.length === 0);
    await ctx.close();
  }

  /* ---- incoming call banner: lightweight, lazy-load NOT triggered ---- */
  {
    const state = {
      incomingCall: {
        meetingId: 'in-1', conversationId: 'c1', requesterType: 'vendor', recipientType: 'customer',
        purpose: 'Video call', status: 'RINGING', meetingUrl: '', ringingSecondsLeft: 40
      }
    };
    const { ctx, page, requested } = await openChat(browser, { loggedIn: true, state });
    await page.waitForSelector('#meeting-panel-host:not(.hidden)');
    ok('the incoming-call banner appears without ever opening the panel manually', true);
    ok('...and WITHOUT loading meetings-ui.js', requested.length === 0, JSON.stringify(requested));
    const bannerText = await page.$eval('#meeting-panel-host', (e) => e.textContent);
    ok('the banner says Incoming Video Call, in Mwakete-native terms', /Incoming Video Call/.test(bannerText), bannerText);
    const btns = await page.$$eval('#meeting-panel-host button', (els) => els.map((e) => e.textContent.trim()));
    ok('Accept and Decline are both offered', btns.includes('Accept') && btns.includes('Decline'), btns.join(','));

    // Accepting promotes to the full (lazy) panel.
    await page.click('#meeting-panel-host button:has-text("Accept")');
    await page.waitForSelector('a:has-text("Join Video Call")');
    ok('accepting from the lightweight banner loads the full panel and shows Join Video Call', requested.length === 1, JSON.stringify(requested));
    const href = await page.$eval('a:has-text("Join Video Call")', (a) => a.href);
    ok('...with the real meeting URL', href === 'https://example-video.test/room/now', href);
    await ctx.close();
  }

  /* ---- incoming call banner: decline dismisses it ---- */
  {
    const state = {
      incomingCall: {
        meetingId: 'in-2', conversationId: 'c1', requesterType: 'vendor', recipientType: 'customer',
        purpose: 'Video call', status: 'RINGING', meetingUrl: '', ringingSecondsLeft: 40
      }
    };
    const { ctx, page, requested } = await openChat(browser, { loggedIn: true, state });
    await page.waitForSelector('#meeting-panel-host:not(.hidden)');
    await page.click('#meeting-panel-host button:has-text("Decline")');
    await page.waitForTimeout(300);
    ok('declining does not load the full lazy module either', requested.length === 0, JSON.stringify(requested));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
