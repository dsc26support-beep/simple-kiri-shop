/**
 * Video Call - a call that stops being live (missed, declined, or
 * cancelled) must close the full-screen overlay immediately, with no
 * "No answer."/"Call declined."/"Call ended." flash. That terminal state
 * only ever shows as a small card in the history list below - see
 * meetings-ui.js's reconcileOverlay, which used to flash it full-screen
 * for ~2.2s before this was removed on request.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const BASE = 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
};

function baseMeeting(overrides) {
  return Object.assign({
    meetingId: 'm1', conversationId: 'c1', requesterType: 'customer', recipientType: 'vendor',
    purpose: 'Video call', requestedDate: '', requestedTime: '', meetingUrl: '', meetFailed: false,
    createdAt: new Date().toISOString()
  }, overrides);
}

async function openChatAndStartCall(browser, state) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    localStorage.setItem('skiri_customer_token', 'tok-1');
    localStorage.setItem('skiri_customer_profile', JSON.stringify({ email: 'a@b.com', name: 'Ana' }));
  });
  await ctx.route('**/macros/s/**', (r) => {
    let body = {};
    try { body = r.request().postDataJSON() || {}; } catch (e) {}
    const action = body.action;
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (action === 'getStorePublicInfo') return J({ ok: true, store: { storeName: 'Tenana Car Rentals', storeSlug: 'tenana' } });
    if (action === 'getConversation') return J({ ok: true, conversation: { conversationId: 'c1' }, messages: [], hasMoreBefore: false, incomingCall: null });
    if (action === 'startVideoCallNow') {
      state.meeting = baseMeeting({ status: 'RINGING', ringingSecondsLeft: 45 });
      return J({ ok: true, meeting: state.meeting });
    }
    if (action === 'listMeetingsForConversation') return J({ ok: true, meetings: state.meeting ? [state.meeting] : [] });
    if (action === 'cancelMeeting') {
      state.meeting = Object.assign({}, state.meeting, { status: 'CANCELLED' });
      return J({ ok: true, meeting: state.meeting });
    }
    return J({ ok: true, products: [], stores: [] });
  });
  const p = await ctx.newPage();
  await p.goto(BASE + '/store.html?store=tenana', { waitUntil: 'load' });
  await p.waitForSelector('#chat-window', { state: 'attached' });
  await p.click('#chat-fab');
  await p.waitForTimeout(150);
  await p.click('#chat-video-call-btn');
  await p.waitForSelector('.meeting-trigger-row');
  await p.click('.meeting-trigger-row button:has-text("Video Call Now")');
  await p.waitForSelector('.video-call-overlay:not(.hidden)');
  return { ctx, p };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  /* ---- cancelling closes the overlay immediately, no "Call ended." flash ---- */
  {
    const state = {};
    const { ctx, p } = await openChatAndStartCall(browser, state);
    await p.click('.video-call-overlay-round-btn--decline'); // the caller's hang-up button
    await p.waitForTimeout(300);
    const hidden = await p.$eval('.video-call-overlay', (e) => e.classList.contains('hidden'));
    ok('the overlay is hidden immediately after cancelling, not flashing a terminal message', hidden);
    const listText = await p.$eval('.meeting-list', (e) => e.textContent);
    ok('the cancelled call still shows as a card in the history list', /Cancelled/.test(listText), listText);
    await ctx.close();
  }

  /* ---- a call that times out to MISSED also closes the overlay immediately ---- */
  {
    const state = {};
    const { ctx, p } = await openChatAndStartCall(browser, state);
    // Simulate the 45s ring timing out server-side - the next ring-poll
    // (every 3s) picks up MISSED instead of RINGING.
    state.meeting = Object.assign({}, state.meeting, { status: 'MISSED', ringingSecondsLeft: null });
    await p.waitForTimeout(3300);
    const hidden = await p.$eval('.video-call-overlay', (e) => e.classList.contains('hidden'));
    ok('a MISSED call also closes the overlay with no "No answer." flash', hidden);
    const listText = await p.$eval('.meeting-list', (e) => e.textContent);
    ok('...and shows "No answer." + Call Again only in the history card', /No answer/.test(listText) && /Call Again/.test(listText), listText);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
