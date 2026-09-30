/**
 * Video Call Now, vendor side - the instant-call trigger inside the
 * lazy-loaded panel, the lightweight incoming-call banner for the
 * currently-open conversation, and the inbox list's best-effort
 * hasIncomingCall hint for conversations the vendor hasn't opened yet.
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

    if (action === 'getOwnerProfile') return J({ ok: true, owner: { storeName: 'Bong', storeSlug: 'bong', status: 'active' } });
    if (action === 'getVendorConversations') return J({ ok: true, hasMore: false, conversations: state.conversations || [] });
    if (action === 'getConversation') {
      const incoming = body.conversationId === 'c1' ? state.incomingCall : null;
      return J({ ok: true, conversation: { conversationId: body.conversationId }, messages: [], hasMoreBefore: false, incomingCall: incoming });
    }
    if (action === 'startVideoCallNow') {
      const m = {
        meetingId: 'now-v1', conversationId: body.conversationId, requesterType: 'vendor', recipientType: 'customer',
        purpose: 'Video call', notes: '', requestedDate: '', requestedTime: '', status: 'RINGING',
        meetingUrl: '', meetFailed: false, ringingSecondsLeft: 45, createdAt: new Date().toISOString()
      };
      state.list = [m];
      return J({ ok: true, meeting: m });
    }
    if (action === 'listMeetingsForConversation') return J({ ok: true, meetings: state.list || [] });
    if (action === 'respondToMeeting') {
      const m = (state.list || []).find((x) => x.meetingId === body.meetingId) || state.incomingCall;
      if (body.accept) { m.status = 'READY'; m.meetingUrl = 'https://example-video.test/room/vendor-now'; }
      else { m.status = 'DECLINED'; }
      state.list = [m];
      state.incomingCall = null;
      return J({ ok: true, meeting: m });
    }
    return J({ ok: true });
  };
}

async function openMessages(browser, state) {
  const requested = [];
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  ctx.on('request', (r) => { if (/meetings-ui/.test(r.url())) requested.push(r.url()); });
  await ctx.route('**/macros/s/**', mockRoute(state));
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 't'); } catch (e) {} });
  await page.goto(BASE + '/owner/messages.html', { waitUntil: 'load' });
  await page.waitForSelector('.conversation-list-item');
  return { ctx, page, requested };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- starting a call from the panel ---- */
  {
    const state = { conversations: [{ conversationId: 'c1', customerName: 'Alice', lastMessagePreview: 'Hi', lastMessageAt: '2026-01-01T00:00:00Z', unreadByVendor: false, status: 'open' }], list: [] };
    const { ctx, page } = await openMessages(browser, state);
    await page.click('.conversation-list-item[data-conversation-id="c1"]');
    await page.waitForSelector('#conversation-detail:not(.hidden)');
    await page.click('#video-call-btn');
    await page.waitForSelector('.meeting-trigger-row');
    await page.click('.meeting-trigger-row button:has-text("Video Call Now")');
    await page.waitForSelector('.video-call-overlay:not(.hidden)');
    ok('the vendor can start a Video Call Now too', true);
    await ctx.close();
  }

  /* ---- incoming call banner on the OPEN conversation: no lazy load ---- */
  {
    const state = {
      conversations: [{ conversationId: 'c1', customerName: 'Alice', lastMessagePreview: 'Hi', lastMessageAt: '2026-01-01T00:00:00Z', unreadByVendor: false, status: 'open' }],
      incomingCall: {
        meetingId: 'in-v1', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor',
        purpose: 'Video call', status: 'RINGING', meetingUrl: '', ringingSecondsLeft: 40
      }
    };
    const { ctx, page, requested } = await openMessages(browser, state);
    await page.click('.conversation-list-item[data-conversation-id="c1"]');
    await page.waitForSelector('.video-call-overlay:not(.hidden)');
    ok('opening the conversation surfaces the incoming call without a manual click', true);
    ok('...and without loading meetings-ui.js', requested.length === 0, JSON.stringify(requested));
    const acceptBtn = await page.$('.video-call-overlay-round-btn--accept');
    const declineBtn = await page.$('.video-call-overlay-round-btn--decline');
    ok('Accept and Decline are offered', !!acceptBtn && !!declineBtn);

    await page.click('.video-call-overlay-round-btn--accept');
    await page.waitForSelector('a:has-text("Join Video Call")');
    ok('accepting promotes to the full panel', requested.length === 1, JSON.stringify(requested));
    const href = await page.$eval('a:has-text("Join Video Call")', (a) => a.href);
    ok('...with the real URL', href === 'https://example-video.test/room/vendor-now', href);
    await ctx.close();
  }

  /* ---- inbox list: best-effort hint for a call on an unopened conversation ---- */
  {
    const state = {
      conversations: [
        { conversationId: 'c1', customerName: 'Alice', lastMessagePreview: 'Hi', lastMessageAt: '2026-01-01T00:00:00Z', unreadByVendor: false, status: 'open', hasIncomingCall: true },
        { conversationId: 'c2', customerName: 'Bob', lastMessagePreview: 'Hello', lastMessageAt: '2026-01-01T00:00:00Z', unreadByVendor: false, status: 'open', hasIncomingCall: false }
      ]
    };
    const { ctx, page } = await openMessages(browser, state);
    const c1Classes = await page.$eval('.conversation-list-item[data-conversation-id="c1"]', (e) => e.className);
    const c2Classes = await page.$eval('.conversation-list-item[data-conversation-id="c2"]', (e) => e.className);
    ok('the ringing conversation is flagged in the list', /is-ringing/.test(c1Classes), c1Classes);
    ok('...and the non-ringing one is not', !/is-ringing/.test(c2Classes), c2Classes);
    const tag = await page.$eval('.conversation-list-item[data-conversation-id="c1"] .conversation-item-ringing-tag', (e) => e.textContent);
    ok('the tag reads "Incoming Video Call"', tag === 'Incoming Video Call', tag);
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
