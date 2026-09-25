/**
 * Video Call (meeting requests), vendor side - assets/js/meetings-ui.js
 * mounted into owner/messages.html's conversation detail pane via
 * assets/js/owner-messages.js.
 *
 * Same two claims as the customer-side suite (verify-meetings-customer.js):
 * the module is never fetched until Video Call is actually clicked, and the
 * panel is closed - not left showing stale data - the moment the vendor
 * switches to a different conversation, since meetingsUi stays mounted
 * across that switch rather than being torn down and rebuilt.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

function mockRoute(meetingsByConv) {
  return async (route) => {
    let action = '', body = {};
    try { body = route.request().postDataJSON() || {}; action = body.action; } catch (e) {}
    try { if (!action) action = new URL(route.request().url()).searchParams.get('action') || ''; } catch (e) {}
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (action === 'getOwnerProfile') return J({ ok: true, owner: { storeName: 'Bong', storeSlug: 'bong', status: 'active' } });
    if (action === 'getVendorConversations') return J({
      ok: true, hasMore: false,
      conversations: [
        { conversationId: 'c1', customerName: 'Alice', lastMessagePreview: 'Hi', lastMessageAt: '2026-01-01T00:00:00Z', unreadByVendor: false, status: 'open' },
        { conversationId: 'c2', customerName: 'Bob', lastMessagePreview: 'Hello', lastMessageAt: '2026-01-01T00:00:00Z', unreadByVendor: false, status: 'open' }
      ]
    });
    if (action === 'getConversation') return J({ ok: true, conversation: { conversationId: body.conversationId }, messages: [], hasMoreBefore: false });
    if (action === 'listMeetingsForConversation') return J({ ok: true, meetings: meetingsByConv[body.conversationId] || [] });
    if (action === 'respondToMeeting') {
      for (const conv in meetingsByConv) {
        const m = meetingsByConv[conv].find((x) => x.meetingId === body.meetingId);
        if (m) {
          if (body.accept) { m.status = 'READY'; m.meetingUrl = 'https://example-video.test/room/vendor'; }
          else m.status = 'DECLINED';
          return J({ ok: true, meeting: m });
        }
      }
      return J({ ok: false, error: 'not found' });
    }
    return J({ ok: true });
  };
}

async function openMessages(browser, meetingsByConv) {
  const requested = [];
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  ctx.on('request', (r) => { if (/meetings-ui/.test(r.url())) requested.push(r.url()); });
  await ctx.route('**/macros/s/**', mockRoute(meetingsByConv));
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('skiri_owner_token', 't'); } catch (e) {} });
  await page.goto(BASE + '/owner/messages.html', { waitUntil: 'load' });
  await page.waitForSelector('.conversation-list-item');
  return { ctx, page, requested };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- lazy load + a customer-initiated request awaiting the vendor ---- */
  {
    const meetingsByConv = {
      c1: [{
        meetingId: 'm1', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor',
        purpose: 'Discuss bulk order', notes: '', requestedDate: '2027-02-01', requestedTime: '15:00',
        status: 'REQUESTED', meetingUrl: '', meetFailed: false, createdAt: '2026-01-01T00:00:00Z'
      }],
      c2: []
    };
    const { ctx, page, requested } = await openMessages(browser, meetingsByConv);
    await page.click('.conversation-list-item[data-conversation-id="c1"]');
    await page.waitForSelector('#conversation-detail:not(.hidden)');
    ok('the Video Call button exists in the conversation actions', await page.$('#video-call-btn') !== null);
    ok('meetings-ui is not fetched just from opening a conversation', requested.length === 0, JSON.stringify(requested));

    await page.click('#video-call-btn');
    await page.waitForSelector('.meeting-card');
    ok('clicking Video Call fetches meetings-ui exactly once', requested.length === 1, JSON.stringify(requested));

    const buttons = await page.$$eval('.meeting-card-actions button', (els) => els.map((e) => e.textContent.trim()));
    ok('a customer-initiated request offers the vendor Accept/Decline', buttons.includes('Accept') && buttons.includes('Decline'), buttons.join(','));

    await page.click('.meeting-card-actions button:has-text("Accept")');
    await page.waitForSelector('a:has-text("Join Video Call")');
    const href = await page.$eval('a:has-text("Join Video Call")', (a) => a.href);
    ok('accepting reveals Join Video Call with the real URL', href === 'https://example-video.test/room/vendor', href);

    // --- switching conversations must not leave c1's panel showing over c2 ---
    await page.click('.conversation-list-item[data-conversation-id="c2"]');
    await page.waitForTimeout(150);
    const hidden = await page.$eval('#meeting-panel-host', (e) => e.classList.contains('hidden'));
    ok('switching conversations closes the meetings panel rather than leaving it stale', hidden);

    await ctx.close();
  }

  await browser.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
