/**
 * Video Call Now - a double-tap on "Video Call Now" (easy to trigger on
 * mobile with any network lag) must never send two startVideoCallNow
 * requests. Before this guard, the first request created the RINGING call
 * and the second hit the backend's own one-call-per-conversation guard,
 * surfacing a spurious "There is already an active video call on this
 * conversation." alert for what the customer experienced as one tap - see
 * meetings-ui.js's callNowPending guard.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_customer_token', 'tok-1');
    localStorage.setItem('skiri_customer_profile', JSON.stringify({ email: 'a@b.com', name: 'Ana' }));
  });
  let startCalls = 0;
  let started = false;
  await ctx.route('**/macros/s/**', async (r) => {
    let body = {};
    try { body = r.request().postDataJSON() || {}; } catch (e) {}
    const action = body.action;
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (action === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Tenana Car Rentals', storeSlug: 'tenana' } });
    if (action === 'getConversation') return J({ ok: true, conversation: { conversationId: 'c1' }, messages: [], hasMoreBefore: false, incomingCall: null });
    if (action === 'startVideoCallNow') {
      startCalls++;
      // A little simulated latency - the exact window a double-tap races into.
      await new Promise((res) => setTimeout(res, 400));
      if (started) return J({ ok: false, error: 'There is already an active video call on this conversation.' });
      started = true;
      return J({ ok: true, meeting: { meetingId: 'm1', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor', purpose: 'Video call', status: 'RINGING', requestedDate: '', requestedTime: '', ringingSecondsLeft: 45, createdAt: new Date().toISOString(), meetingUrl: '', meetFailed: false } });
    }
    if (action === 'listMeetingsForConversation') {
      return J({ ok: true, meetings: started ? [{ meetingId: 'm1', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor', purpose: 'Video call', status: 'RINGING', requestedDate: '', requestedTime: '', ringingSecondsLeft: 45, createdAt: new Date().toISOString(), meetingUrl: '', meetFailed: false }] : [] });
    }
    return J({ ok: true, products: [], stores: [] });
  });
  let dialogSeen = false;
  const p = await ctx.newPage();
  p.on('dialog', (d) => { dialogSeen = true; d.accept(); });
  await p.goto(BASE + '/store.html?store=tenana', { waitUntil: 'load' });
  await p.waitForSelector('#chat-window', { state: 'attached' });
  await p.click('#chat-fab');
  await p.waitForTimeout(150);
  await p.click('#chat-video-call-btn');
  await p.waitForSelector('.meeting-trigger-row');
  const btn = await p.$('.meeting-trigger-row button:has-text("Video Call Now")');
  await btn.click();
  await btn.click({ force: true }).catch(() => {}); // may already be gone from the DOM by the 2nd click - also a pass
  await p.waitForTimeout(900);
  ok('exactly one startVideoCallNow request was sent for a double-tap', startCalls === 1, 'startCalls=' + startCalls);
  ok('no "already an active call" alert was shown to the customer', !dialogSeen);
  await p.waitForSelector('.meeting-card--ringing');
  const cardText = await p.$eval('.meeting-card--ringing', (e) => e.textContent);
  ok('the call still rings normally after the guarded double-tap', /Ringing/.test(cardText), cardText);

  await browser.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
