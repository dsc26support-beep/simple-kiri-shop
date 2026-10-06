/**
 * Meeting requests + Google Meet integration (apps-script/Meetings.gs), run
 * against the REAL functions from Meetings.gs, Chat.gs (resolveChatRequest
 * and the conversation data layer it composes), Auth.gs (requireAuth) and
 * Customers.gs (requireCustomerAuth) - the exact composition Meetings.gs
 * itself is built on, not a re-implementation of it.
 *
 * Everything Google/Sheets is stubbed: an in-memory table per sheet name
 * (mirroring the real header-mapped-object shape Db.gs produces), a
 * controllable UrlFetchApp.fetch for the one live Meet API call, and a
 * simple Map-backed CacheService/getCached. The point of grabbing the real
 * source rather than mocking the business logic itself is that a real bug
 * in the authorization/transition logic shows up here exactly as it would
 * in production.
 */
const fs = require('fs');
const vm = require('vm');
const R = []; const ok_ = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const meetingsSrc = fs.readFileSync(REPO + 'apps-script/Meetings.gs', 'utf8');
const chatSrc = fs.readFileSync(REPO + 'apps-script/Chat.gs', 'utf8');
const authSrc = fs.readFileSync(REPO + 'apps-script/Auth.gs', 'utf8');
const customersSrc = fs.readFileSync(REPO + 'apps-script/Customers.gs', 'utf8');
const productsSrc = fs.readFileSync(REPO + 'apps-script/Products.gs', 'utf8');
const utilsSrc = fs.readFileSync(REPO + 'apps-script/Utils.gs', 'utf8');

const grab = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '\\b[\\s\\S]*?\\n}'));
  if (!m) throw new Error('could not find function ' + name);
  return m[0];
};
const grabAllVars = (src, names) => names.map((n) => {
  const m = src.match(new RegExp('^var ' + n + ' = [\\s\\S]*?;$', 'm'));
  if (!m) throw new Error('could not find var ' + n);
  return m[0];
}).join('\n');

/* ---------- the fake spreadsheet ---------- */
let DB;
function seedDb() {
  DB = { Owners: [], Sessions: [], Customers: [], CustomerSessions: [], Conversations: [], Meetings: [] };
}
function row(table, obj) {
  const r = Object.assign({}, obj);
  DB[table].push(r);
  r.__row = DB[table].length + 1;
  return r;
}

/* ---------- environment shared by every test run ---------- */
function makeContext() {
  seedDb();
  const cache = new Map();
  const sentEmails = [];
  const logs = [];
  let meetApiCallCount = 0;
  // 'success' | 'fail' | 'malformed' - flips mid-test to exercise retry.
  let meetApiMode = 'success';

  const box = {
    Object, Math, String, Number, JSON, Date, RegExp, Array, console,
    __meetApi: { get callCount() { return meetApiCallCount; }, get mode() { return meetApiMode; }, set mode(v) { meetApiMode = v; } },
    __sentEmails: sentEmails,
    __db: DB,

    // ---- Sheets I/O, stubbed to the same header-mapped-object contract
    // Db.gs's real functions produce, per-table in-memory instead of via
    // SpreadsheetApp. ----
    getSheet: (name) => {
      if (!(name in DB)) throw new Error('Sheet tab not found: ' + name);
      return { name };
    },
    sheetToObjects: (sheet) => DB[sheet.name].map((r) => Object.assign({}, r)),
    findRowById: (sheet, idField, idValue) => {
      const found = DB[sheet.name].find((r) => String(r[idField]) === String(idValue));
      return found ? Object.assign({}, found) : null;
    },
    findRowBySecret: (sheet, idField, idValue) => {
      const found = DB[sheet.name].find((r) => String(r[idField]) === String(idValue));
      return found ? Object.assign({}, found) : null;
    },
    appendRowFromObject: (sheet, obj) => { row(sheet.name, obj); },
    updateRowFromObject: (sheet, rowNumber, patch) => {
      const r = DB[sheet.name].find((x) => x.__row === rowNumber);
      if (r) Object.assign(r, patch);
    },

    // ---- cache/lock ----
    getCached: (key, ttl, producer) => {
      if (cache.has(key)) return cache.get(key);
      const v = producer();
      cache.set(key, v);
      return v;
    },
    invalidateCache: (keys) => { (keys || []).forEach((k) => cache.delete(k)); },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cache.has('raw:' + k) ? cache.get('raw:' + k) : null,
        put: (k, v) => { cache.set('raw:' + k, v); }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },

    // ---- Google Meet API + Apps Script identity ----
    ScriptApp: { getOAuthToken: () => 'fake-script-oauth-token' },
    Session: { getScriptTimeZone: () => 'Pacific/Tarawa' },
    UrlFetchApp: {
      fetch: (url, opts) => {
        meetApiCallCount++;
        if (meetApiMode === 'fail') {
          return { getResponseCode: () => 403, getContentText: () => 'insufficient authentication scope' };
        }
        if (meetApiMode === 'malformed') {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ nothingUseful: true }) };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            name: 'spaces/fake-space-' + meetApiCallCount,
            meetingUri: 'https://meet.example/fake-' + meetApiCallCount
          })
        };
      }
    },
    Logger: { log: (msg) => logs.push(msg) },
    Utilities: {
      getUuid: () => 'uuid-' + Math.random().toString(16).slice(2),
      computeDigest: () => [1, 2, 3],
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },

    // ---- helpers real code calls that touch nothing above ----
    sendAppEmail: (to, subject, body) => { sentEmails.push({ to, subject, body }); return true; },
    siteBaseUrl: () => '',
    isStoreBrowsable: (owner) => !!owner && (owner.Status === 'active' || owner.Status === 'standby'),
    ownerCanLogIn: (owner) => !!owner && (owner.Status === 'active' || owner.Status === 'standby')
  };
  vm.createContext(box);

  vm.runInContext([
    grab(utilsSrc, 'newId'),
    grab(utilsSrc, 'nowIso'),
    grab(utilsSrc, 'capLength'),
    "function ok(data) { return Object.assign({ ok: true }, data); }",
    "function fail(msg) { return { ok: false, error: msg }; }",
    grab(productsSrc, 'getOwnerBySlug'),
    grab(authSrc, 'requireAuth'),
    grab(customersSrc, 'requireCustomerAuth'),
    grab(chatSrc, 'findConversation'),
    grab(chatSrc, 'createConversation'),
    grab(chatSrc, 'findOrCreateConversation'),
    grab(chatSrc, 'getConversationById'),
    grab(chatSrc, 'resolveChatRequest'),
    meetingsSrc
  ].join('\n\n'), box);

  return box;
}

/* ---------- fixtures shared by most tests ---------- */
function seedOwnerAndCustomer(box) {
  row('Owners', { OwnerId: 'own1', StoreSlug: 'bong', StoreName: 'Bong Store', Status: 'active', Email: 'bong@example.com' });
  row('Owners', { OwnerId: 'own2', StoreSlug: 'other', StoreName: 'Other Store', Status: 'active', Email: 'other@example.com' });
  row('Sessions', { Token: 'owner-tok-1', OwnerId: 'own1', ExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
  row('Sessions', { Token: 'owner-tok-2', OwnerId: 'own2', ExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
  row('Customers', { CustomerId: 'cust1', Name: 'Alice', Email: 'alice@example.com' });
  row('CustomerSessions', { Token: 'cust-tok-1', CustomerId: 'cust1', ExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
}

const futureDate = () => {
  const d = new Date(Date.now() + 24 * 3600e3);
  return d.toISOString().slice(0, 10);
};
const baseFields = () => ({ purpose: 'Discuss my order', requestedDate: futureDate(), requestedTime: '14:00' });

/* ============================================================ */
/* 1. Customer -> Vendor: request, field validation, sign-in gate */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);

  const res = box.actionRequestMeeting(Object.assign(baseFields(), {
    storeSlug: 'bong', customerToken: 'anon-abc', customerAuthToken: 'cust-tok-1', customerName: 'Alice'
  }));
  ok_('customer->vendor request succeeds', res.ok === true, JSON.stringify(res));
  ok_('status starts REQUESTED', res.ok && res.meeting.status === 'REQUESTED');
  const stored = box.__db.Meetings[0];
  ok_('RequesterType is customer', stored && stored.RequesterType === 'customer');
  ok_('RequesterId is the REAL CustomerId, not the anonymous chat token', stored && stored.RequesterId === 'cust1', JSON.stringify(stored && stored.RequesterId));
  ok_('RecipientType is vendor', stored && stored.RecipientType === 'vendor');
  ok_('RecipientId is the store owner', stored && stored.RecipientId === 'own1');
  ok_('timezone is read from the script, not hardcoded/client-supplied', stored && stored.Timezone === 'Pacific/Tarawa');
  ok_('a conversation was created for this store+customer', box.__db.Conversations.length === 1);
  ok_('the meeting is anchored to that conversation', stored && stored.ConversationId === box.__db.Conversations[0].ConversationId);

  const noSignIn = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'anon-xyz' }));
  ok_('a customer with NO auth token cannot request a meeting', noSignIn.ok === false, JSON.stringify(noSignIn));
  ok_('...with a clear sign-in message, not a raw auth error', /sign in/i.test(noSignIn.error), noSignIn.error);

  const badToken = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'anon-xyz', customerAuthToken: 'not-a-real-token' }));
  ok_('an invalid auth token is rejected the same way', badToken.ok === false);

  const noPurpose = box.actionRequestMeeting({ storeSlug: 'bong', customerToken: 'a', customerAuthToken: 'cust-tok-1', requestedDate: futureDate(), requestedTime: '14:00' });
  ok_('missing purpose is rejected', noPurpose.ok === false && /about/i.test(noPurpose.error));

  const noDate = box.actionRequestMeeting({ storeSlug: 'bong', customerToken: 'a', customerAuthToken: 'cust-tok-1', purpose: 'x' });
  ok_('missing date/time is rejected', noDate.ok === false);

  const badDate = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a', customerAuthToken: 'cust-tok-1', requestedDate: 'not-a-date' }));
  ok_('a malformed date is rejected', badDate.ok === false);

  const pastDate = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a', customerAuthToken: 'cust-tok-1', requestedDate: '2020-01-01' }));
  ok_('a past date is rejected', pastDate.ok === false && /passed/i.test(pastDate.error));

  const farFuture = box.actionRequestMeeting(Object.assign(baseFields(), {
    storeSlug: 'bong', customerToken: 'a', customerAuthToken: 'cust-tok-1',
    requestedDate: new Date(Date.now() + 10 * 365 * 24 * 3600e3).toISOString().slice(0, 10)
  }));
  ok_('an absurdly far-future date is rejected', farFuture.ok === false);

  const tooLongPurpose = box.actionRequestMeeting(Object.assign(baseFields(), {
    storeSlug: 'bong', customerToken: 'a', customerAuthToken: 'cust-tok-1', purpose: 'x'.repeat(600)
  }));
  ok_('an over-length purpose is rejected', tooLongPurpose.ok === false);
}

/* ============================================================ */
/* 2. Vendor -> Customer: request, and the anonymous-recipient design */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  // The conversation exists first, same as a real vendor replying in an
  // already-open thread.
  const conv = box.findOrCreateConversation({ OwnerId: 'own1' }, 'bong', 'anon-cust-1', 'Bob');

  const res = box.actionRequestMeeting(Object.assign(baseFields(), { token: 'owner-tok-1', conversationId: conv.ConversationId }));
  ok_('vendor->customer request succeeds', res.ok === true, JSON.stringify(res));
  const stored = box.__db.Meetings[0];
  ok_('RequesterType is vendor', stored && stored.RequesterType === 'vendor');
  ok_('RequesterId is the real OwnerId', stored && stored.RequesterId === 'own1');
  ok_('RecipientType is customer', stored && stored.RecipientType === 'customer');
  ok_('RecipientId is the conversation\'s own anonymous identity, not a fabricated CustomerId',
    stored && stored.RecipientId === 'anon-cust-1', JSON.stringify(stored && stored.RecipientId));

  const wrongVendor = box.actionRequestMeeting(Object.assign(baseFields(), { token: 'owner-tok-2', conversationId: conv.ConversationId }));
  ok_('a different vendor cannot request a meeting on someone else\'s conversation', wrongVendor.ok === false);

  const noAuth = box.actionRequestMeeting(Object.assign(baseFields(), { token: 'not-a-real-session', conversationId: conv.ConversationId }));
  ok_('an invalid vendor session is rejected', noAuth.ok === false);
}

/* ============================================================ */
/* 3. Accept -> ACCEPTED, and no video room is ever created       */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const created = box.actionRequestMeeting(Object.assign(baseFields(), {
    storeSlug: 'bong', customerToken: 'anon-1', customerAuthToken: 'cust-tok-1'
  }));
  const meetingId = created.meeting.meetingId;

  const accepted = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId, accept: true });
  ok_('vendor accept succeeds', accepted.ok === true, JSON.stringify(accepted));
  ok_('status settles at ACCEPTED - nothing follows it now', accepted.meeting.status === 'ACCEPTED', accepted.meeting.status);
  ok_('no Meet API call is made (video was removed)', box.__meetApi.callCount === 0, String(box.__meetApi.callCount));
  ok_('no meeting link of any kind is returned', !('meetingUrl' in accepted.meeting) && !('meetFailed' in accepted.meeting), JSON.stringify(accepted.meeting));
  ok_('AcceptedAt was recorded', !!box.__db.Meetings[0].AcceptedAt);

  const doubleAccept = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId, accept: true });
  ok_('accepting an already-accepted meeting again is rejected', doubleAccept.ok === false);
}

/* ============================================================ */
/* 4. Decline, and that it is terminal                             */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const created = box.actionRequestMeeting(Object.assign(baseFields(), {
    storeSlug: 'bong', customerToken: 'anon-1', customerAuthToken: 'cust-tok-1'
  }));
  const meetingId = created.meeting.meetingId;

  const declined = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId, accept: false });
  ok_('vendor decline succeeds', declined.ok === true);
  ok_('status is DECLINED', declined.meeting.status === 'DECLINED');
  ok_('no Meet space was ever created for a declined meeting', box.__meetApi.callCount === 0);

  const acceptAfterDecline = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId, accept: true });
  ok_('a declined meeting cannot later be accepted', acceptAfterDecline.ok === false);
}

/* ============================================================ */
/* 5. The video actions are gone - both refuse plainly           */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);

  const now = box.actionStartVideoCallNow({ storeSlug: 'bong', customerToken: 'anon-1', customerAuthToken: 'cust-tok-1' });
  ok_('startVideoCallNow is refused', now.ok === false && /no longer available/i.test(now.error), JSON.stringify(now));
  ok_('...and writes no row', box.__db.Meetings.length === 0);

  const m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'anon-1', customerAuthToken: 'cust-tok-1' })).meeting;
  box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m.meetingId, accept: true });
  const retry = box.actionRetryMeetingSpace({ token: 'owner-tok-1', meetingId: m.meetingId });
  ok_('retryMeetingSpace is refused', retry.ok === false && /no longer available/i.test(retry.error), JSON.stringify(retry));
  ok_('...and never reaches the Meet API', box.__meetApi.callCount === 0);
  ok_('the accepted meeting is untouched by it', box.__db.Meetings[0].Status === 'ACCEPTED');
}

/* ============================================================ */
/* 7. Cancel: which states allow it, which don't                   */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);

  let m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1' })).meeting;
  let c = box.actionCancelMeeting({ storeSlug: 'bong', customerToken: 'a1', meetingId: m.meetingId });
  ok_('cancel from REQUESTED succeeds', c.ok === true);

  m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a2', customerAuthToken: 'cust-tok-1' })).meeting;
  box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m.meetingId, accept: true });
  c = box.actionCancelMeeting({ token: 'owner-tok-1', meetingId: m.meetingId });
  ok_('cancel from ACCEPTED succeeds', c.ok === true);

  // A READY row can only exist from before video was removed.
  m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a3', customerAuthToken: 'cust-tok-1' })).meeting;
  box.__db.Meetings.find((r) => r.MeetingId === m.meetingId).Status = 'READY';
  c = box.actionCancelMeeting({ storeSlug: 'bong', customerToken: 'a3', meetingId: m.meetingId });
  ok_('cancel from a legacy READY row succeeds', c.ok === true);

  m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a4', customerAuthToken: 'cust-tok-1' })).meeting;
  box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m.meetingId, accept: false });
  c = box.actionCancelMeeting({ storeSlug: 'bong', customerToken: 'a4', meetingId: m.meetingId });
  ok_('cancel from DECLINED is rejected - already terminal', c.ok === false);
}

/* ============================================================ */
/* 8. End meeting: only a legacy READY row                          */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1' })).meeting;

  ok_('cannot end a meeting that was never accepted', box.actionEndMeeting({ storeSlug: 'bong', customerToken: 'a1', meetingId: m.meetingId }).ok === false);
  box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m.meetingId, accept: true });
  ok_('cannot "end" an ACCEPTED meeting either - there is no call to end', box.actionEndMeeting({ storeSlug: 'bong', customerToken: 'a1', meetingId: m.meetingId }).ok === false);

  box.__db.Meetings[0].Status = 'READY';
  ok_('a legacy READY row can still be closed off', box.actionEndMeeting({ storeSlug: 'bong', customerToken: 'a1', meetingId: m.meetingId }).ok === true);
  ok_('status is ENDED', box.__db.Meetings[0].Status === 'ENDED');
}

/* ============================================================ */
/* 9. Unauthorized access - every mutating action                   */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1' })).meeting;

  const otherVendorRespond = box.actionRespondToMeeting({ token: 'owner-tok-2', meetingId: m.meetingId, accept: true });
  ok_('a different vendor cannot respond to this meeting', otherVendorRespond.ok === false);

  const otherCustomerRespond = box.actionRespondToMeeting({ storeSlug: 'bong', customerToken: 'someone-elses-browser', meetingId: m.meetingId, accept: true });
  ok_('a different anonymous customer token cannot respond either (no conversation match)', otherCustomerRespond.ok === false);

  const otherVendorCancel = box.actionCancelMeeting({ token: 'owner-tok-2', meetingId: m.meetingId });
  ok_('a different vendor cannot cancel this meeting', otherVendorCancel.ok === false);

  const wrongStoreConversation = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'other', customerToken: 'a1', customerAuthToken: 'cust-tok-1' }));
  const crossStore = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: wrongStoreConversation.meeting.meetingId, accept: true });
  ok_('a vendor cannot respond to a meeting on a DIFFERENT store\'s conversation, even authenticated', crossStore.ok === false);
}

/* ============================================================ */
/* 10. listMeetingsForConversation - both sides, and the empty case */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1' })).meeting;

  const asCustomer = box.actionListMeetingsForConversation({ storeSlug: 'bong', customerToken: 'a1' });
  ok_('customer can list meetings on their own conversation', asCustomer.ok === true && asCustomer.meetings.length === 1);

  const convId = box.__db.Meetings[0].ConversationId;
  const asVendor = box.actionListMeetingsForConversation({ token: 'owner-tok-1', conversationId: convId });
  ok_('vendor can list meetings on the same conversation', asVendor.ok === true && asVendor.meetings.length === 1);

  const noConvoYet = box.actionListMeetingsForConversation({ storeSlug: 'bong', customerToken: 'brand-new-browser' });
  ok_('a customer with no conversation yet gets an empty list, not an error - matches getConversation\'s own convention',
    noConvoYet.ok === true && Array.isArray(noConvoYet.meetings) && noConvoYet.meetings.length === 0, JSON.stringify(noConvoYet));

  const otherVendorList = box.actionListMeetingsForConversation({ token: 'owner-tok-2', conversationId: convId });
  ok_('a different vendor cannot list another store\'s meetings', otherVendorList.ok === false);
}

/* ============================================================ */
/* 11. Notifications - vendor reachable, anonymous customer is not  */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);

  // Customer requests -> vendor (reachable) is emailed.
  const m1 = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1', customerName: 'Alice' })).meeting;
  ok_('vendor is emailed when a customer requests a meeting', box.__sentEmails.length === 1);
  ok_('the email names the real customer', /Alice/.test(box.__sentEmails[0].body), box.__sentEmails[0].body);

  // Vendor requests -> anonymous customer cannot be emailed (no email on file for them).
  const conv = box.findOrCreateConversation({ OwnerId: 'own1' }, 'bong', 'anon-9', 'Bob');
  box.actionRequestMeeting(Object.assign(baseFields(), { token: 'owner-tok-1', conversationId: conv.ConversationId }));
  ok_('requesting as the vendor sends no email (nothing to tell the vendor about their own action, customer unreachable)', box.__sentEmails.length === 1);

  // Customer accepts the vendor's request -> vendor gets told.
  const vendorReqMeetingId = box.__db.Meetings[1].MeetingId;
  box.actionRespondToMeeting({ storeSlug: 'bong', customerToken: 'anon-9', meetingId: vendorReqMeetingId, accept: true });
  ok_('vendor is emailed when the customer accepts their request', box.__sentEmails.length === 2);

  // Vendor accepts a customer's request -> customer (unreachable) gets no email, vendor (self) gets none either.
  box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m1.meetingId, accept: true });
  ok_('vendor accepting their own inbound request does not email themselves', box.__sentEmails.length === 2);
}

/* ============================================================ */
/* 12. No meeting link is ever exposed, at any stage                */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1' })).meeting;
  ok_('no meetingUrl on a freshly requested meeting', !('meetingUrl' in m));
  box.__db.Meetings[0].Status = 'READY';
  box.__db.Meetings[0].GoogleMeetUrl = 'https://meet.example/old-room';
  const asCustomer = box.actionListMeetingsForConversation({ storeSlug: 'bong', customerToken: 'a1' });
  ok_('even a legacy READY row with a stored link never hands it out', !/meet\.example/.test(JSON.stringify(asCustomer)), JSON.stringify(asCustomer));
}

/* ============================================================ */
/* 13. A legacy RINGING row still settles to MISSED on read        */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);
  const m = box.actionRequestMeeting(Object.assign(baseFields(), { storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1' })).meeting;
  const row = box.__db.Meetings[0];
  row.Status = 'RINGING'; row.RequestedDate = ''; row.RequestedTime = '';
  const convId = row.ConversationId;
  ok_('while inside its 45s window the vendor poll still sees it (Chat.gs unchanged)', !!box.activeIncomingCall(convId, 'vendor'));

  row.CreatedAt = new Date(Date.now() - 46 * 1000).toISOString();
  const late = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m.meetingId, accept: true });
  ok_('accepting it once expired is refused', late.ok === false, JSON.stringify(late));
  ok_('...because it was settled to MISSED on that read', row.Status === 'MISSED', row.Status);
  ok_('and it no longer shows as incoming', box.activeIncomingCall(convId, 'vendor') === null);
}

/* ============================================================ */
/* 19. Chat.gs wiring - static check that the poll responses         */
/*     still surface activeIncomingCall (now only legacy rows)       */
/* ============================================================ */
{
  ok_('Chat.gs\'s getConversation surfaces activeIncomingCall in its response',
    /incomingCall:\s*activeIncomingCall\(/.test(chatSrc));
  ok_('Chat.gs\'s getVendorConversations surfaces ringingConversationIdsForVendor per row',
    /ringingConversationIdsForVendor\(/.test(chatSrc) && /hasIncomingCall/.test(chatSrc));
}

/* ============================================================ */
/* 20. reloadMeetingOrFallback / actionRespondToMeeting degrade      */
/*     safely if a reload-right-after-write ever comes back empty,   */
/*     instead of throwing - "never throws" was already this file's  */
/*     own documented contract for attemptMeetSpaceCreation, this    */
/*     just actually holds it everywhere a reload happens            */
/* ============================================================ */
{
  const box = makeContext();
  seedOwnerAndCustomer(box);

  const fallback = { MeetingId: 'does-not-exist', Status: 'ACCEPTED' };
  const reloaded = box.reloadMeetingOrFallback('does-not-exist', fallback);
  ok_('reloadMeetingOrFallback returns the fallback rather than null when nothing matches', reloaded === fallback, JSON.stringify(reloaded));

  const m = box.actionRequestMeeting(Object.assign(baseFields(), {
    storeSlug: 'bong', customerToken: 'a1', customerAuthToken: 'cust-tok-1'
  })).meeting;
  // Simulate the reload-after-write coming back empty (whatever the real
  // cause on the deployed backend - this is the "should be unreachable"
  // branch of actionRespondToMeeting) by deleting the row the instant it
  // gets patched to ACCEPTED, before the code re-reads it.
  const realUpdate = box.updateRowFromObject;
  let patched = false;
  box.updateRowFromObject = (sheet, rowNumber, patch) => {
    realUpdate(sheet, rowNumber, patch);
    if (patch.Status === 'ACCEPTED' && !patched) {
      patched = true;
      const idx = box.__db.Meetings.findIndex((r) => r.__row === rowNumber);
      if (idx !== -1) box.__db.Meetings.splice(idx, 1);
    }
  };

  const accepted = box.actionRespondToMeeting({ token: 'owner-tok-1', meetingId: m.meetingId, accept: true });
  ok_('a failed reload after ACCEPTED never throws - it degrades to a normal ok() response', accepted.ok === true, JSON.stringify(accepted));
  ok_('...never calls the Meet API on a row it could not confirm', box.__meetApi.callCount === 0, String(box.__meetApi.callCount));
}

/* ---------- report ---------- */
const failed = R.filter((r) => r[0] === 'FAIL');
R.forEach((r) => console.log(r[0] + '  ' + r[1] + (r[2] ? '   -> ' + r[2] : '')));
console.log('\n' + (R.length - failed.length) + '/' + R.length + (failed.length ? '  ** ' + failed.length + ' FAILED **' : '  ALL PASS'));
process.exit(failed.length ? 1 : 0);
