/**
 * Meeting requests + Google Meet video calls, integrated into the existing
 * Customer <-> Vendor chat. Scope for this phase, approved explicitly:
 * Customer<->Vendor only. Admin pairings (Customer<->Admin, Vendor<->Admin)
 * are NOT implemented - there is no existing admin conversation surface to
 * attach them to (Admin.gs's isOwnerAdmin is a flag on a vendor account,
 * not a participant type chat has ever modeled), and inventing one as a
 * side effect of this feature was explicitly declined. See the Stage 1
 * report in the session history for the full reasoning.
 *
 * Every meeting is anchored to exactly one chat conversation
 * (Chat.gs's Conversations row), reusing resolveChatRequest/
 * findOrCreateConversation rather than duplicating that identity logic -
 * "requesting a meeting" implicitly opens the same chat thread a first
 * message would, if one doesn't exist yet.
 *
 * IDENTITY, the one asymmetry worth stating plainly rather than hiding:
 *   - A CUSTOMER-INITIATED request always requires a real, signed-in
 *     customer account (requireCustomerAuth) - a stronger bar than chat
 *     itself has ever required, because a meeting is a scheduling
 *     commitment the vendor's dashboard will show, not an anonymous
 *     message. RequesterId is then a real CustomerId.
 *   - A VENDOR-INITIATED request's customer RECIPIENT cannot be tied to a
 *     real CustomerId, because chat's own Conversations row only ever
 *     stores an anonymous per-browser CustomerToken (see Chat.gs's header
 *     comment) - there is no existing link from a conversation to a real
 *     customer account. Responding to (accepting/declining) a
 *     vendor-initiated request is therefore authorized the same way
 *     replying in that chat thread already is: presenting the
 *     (storeSlug, customerToken) pair that resolves to that exact
 *     conversation. This does not weaken anything that exists today - it
 *     is the same trust boundary chat itself already operates at for that
 *     direction - and is recorded here rather than left implicit.
 *
 * Sheet: Meetings (see REQUIRED_TABS in Code.gs for the header row).
 */

var MEETING_PURPOSE_MAX_LEN = 500;
var MEETING_NOTE_MAX_LEN = 1000;

// See the header comment: requester/recipient are typed so a future admin
// pairing can be added without reshaping this sheet, but only these two are
// accepted anywhere in this phase.
var MEETING_PARTY_TYPES = ['customer', 'vendor'];

var VALID_MEETING_STATUSES = ['REQUESTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'READY', 'ENDED'];
// Mirrors Bookings.gs's BOOKING_TRANSITIONS exactly - same shape, same
// reasoning: an explicit map of what's legal is what keeps "decline a
// meeting that's already READY" from ever silently succeeding.
var MEETING_TRANSITIONS = {
  REQUESTED: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
  // ACCEPTED covers both "about to create the Meet space" and "creation
  // failed, retry available" - see actionRespondToMeeting/
  // actionRetryMeetingSpace. It never lingers user-visibly; a successful
  // create moves it straight to READY inside the same request.
  ACCEPTED: ['READY', 'CANCELLED'],
  READY: ['ENDED', 'CANCELLED']
  // DECLINED, CANCELLED, ENDED are terminal - no outgoing transitions.
};

function meetingCacheKey(conversationId) { return 'v1:meetings:conv:' + conversationId; }
var MEETINGS_CACHE_TTL_SECONDS = 10; // same order as chat's own message cache - see Chat.gs

/* ---------- validation ---------- */

/**
 * Half-hour granularity isn't enforced - purely "is this a real date/time
 * that isn't already in the past", the same bar validateBookingDates
 * (Bookings.gs) sets for its own date fields. Timezone is never taken from
 * the client: it is read once, server-side, from the Apps Script project's
 * own configured timezone (Session.getScriptTimeZone()) - the one timezone
 * value that already exists here without inventing or hardcoding one, and
 * the same value every date already sheet-wide implicitly assumes.
 */
function validateMeetingRequestFields(body) {
  var purpose = String(body.purpose || '').trim();
  if (!purpose) return fail('Please say what the meeting is about');
  var purposeErr = capLength(purpose, MEETING_PURPOSE_MAX_LEN, 'Purpose');
  if (purposeErr) return purposeErr;

  var noteErr = capLength(body.notes, MEETING_NOTE_MAX_LEN, 'Message');
  if (noteErr) return noteErr;

  var date = String(body.requestedDate || '').trim();
  var time = String(body.requestedTime || '').trim();
  if (!date || !time) return fail('Please choose a date and time');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Please provide a valid date');
  if (!/^\d{2}:\d{2}$/.test(time)) return fail('Please provide a valid time');

  var when = new Date(date + 'T' + time + ':00');
  if (isNaN(when.getTime())) return fail('Please provide a valid date and time');
  if (when.getTime() < Date.now() - 5 * 60 * 1000) return fail('That time has already passed');
  // Same abuse guard, same reasoning, as Bookings.gs's BOOKING_DATE_MAX_FUTURE_MS -
  // not a real product constraint, just a backstop against a nonsensical date.
  if (when.getTime() - Date.now() > 2 * 365 * 24 * 60 * 60 * 1000) return fail('That date is too far in the future');

  return null;
}

/* ---------- data layer ---------- */

function getMeetingById(meetingId) {
  if (!meetingId) return null;
  return findRowById(getSheet('Meetings'), 'MeetingId', meetingId);
}

function listMeetingsForConversationRaw(conversationId) {
  return getCached(meetingCacheKey(conversationId), MEETINGS_CACHE_TTL_SECONDS, function () {
    return sheetToObjects(getSheet('Meetings'))
      .filter(function (m) { return m.ConversationId === conversationId; })
      .sort(function (a, b) { return new Date(a.CreatedAt) - new Date(b.CreatedAt); });
  });
}

function touchMeetingCache(conversationId) {
  invalidateCache([meetingCacheKey(conversationId)]);
}

/** Shapes a raw Meetings row for the API - the Meet URL is included here, so every caller of this function MUST already be an authorized participant (enforced by the action handlers below, never by this function itself). */
function publicMeetingFields(meeting) {
  return {
    meetingId: meeting.MeetingId,
    conversationId: meeting.ConversationId,
    requesterType: meeting.RequesterType,
    recipientType: meeting.RecipientType,
    purpose: meeting.Purpose,
    notes: meeting.Notes || '',
    requestedDate: meeting.RequestedDate,
    requestedTime: meeting.RequestedTime,
    timezone: meeting.Timezone,
    status: meeting.Status,
    meetingUrl: meeting.Status === 'READY' ? (meeting.GoogleMeetUrl || '') : '',
    meetFailed: meeting.Status === 'ACCEPTED' && !!meeting.MeetFailureReason,
    createdAt: meeting.CreatedAt,
    acceptedAt: meeting.AcceptedAt || '',
    readyAt: meeting.ReadyAt || '',
    cancelledAt: meeting.CancelledAt || '',
    endedAt: meeting.EndedAt || ''
  };
}

/* ---------- actor resolution ----------
 *
 * Two different questions, two different resolvers - conflating them was an
 * earlier draft's mistake, caught by test-meetings.js rather than shipped:
 *
 *  - REQUESTING opens (or reuses) a conversation, so it legitimately needs
 *    resolveChatRequest's createIfMissing behaviour and whatever identity
 *    the requester brings (token, or storeSlug+customerToken).
 *  - EVERY OTHER ACTION (respond/retry/cancel/end/list) is about an EXISTING
 *    meeting, and meetingId already pins its conversation - making the
 *    caller separately supply conversationId too would be redundant, and
 *    was the actual bug: a vendor responding by meetingId alone had no
 *    conversationId to give resolveChatRequest's vendor branch, which
 *    requires one. The conversation is looked up server-side from the
 *    meeting record instead, and identity is checked against THAT
 *    conversation directly - no client-supplied conversationId needed or
 *    trusted for these actions at all.
 *
 * Both reuse requireAuth/requireCustomerAuth rather than re-implementing
 * either.
 */

/**
 * Only for actionRequestMeeting. body: everything resolveChatRequest needs
 * (token OR storeSlug+customerToken), plus body.customerAuthToken - a REAL
 * CustomerSessions token, separate from the anonymous chat token, required
 * whenever the requester is a customer (see the file header for why this
 * direction alone requires real sign-in; a vendor requester needs no
 * additional check beyond resolveChatRequest's own requireAuth).
 * Returns { ok, conversation, actorType, actorId, error }.
 */
function resolveRequestingActor(body) {
  var resolved = resolveChatRequest(body, { createIfMissing: true });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  if (resolved.senderType === 'vendor') {
    return { ok: true, conversation: resolved.conversation, actorType: 'vendor', actorId: resolved.conversation.OwnerId };
  }

  var customer;
  try {
    customer = requireCustomerAuth(body.customerAuthToken);
  } catch (e) {
    return { ok: false, error: 'Please sign in to your account to request a meeting.' };
  }
  return { ok: true, conversation: resolved.conversation, actorType: 'customer', actorId: customer.CustomerId };
}

/**
 * For every action on an EXISTING meeting. Looks the meeting up by
 * body.meetingId, resolves ITS conversation server-side, then checks the
 * caller's identity against that specific conversation - a vendor via
 * requireAuth(body.token) matched to conversation.OwnerId, a customer via
 * (body.storeSlug, body.customerToken) matched to
 * (conversation.StoreSlug, conversation.CustomerToken), the exact bar
 * replying in that chat thread already requires. Returns
 * { ok, meeting, conversation, actorType, actorId, error }; actorId is the
 * real OwnerId for a vendor, null for a customer (see the file header - a
 * vendor-initiated meeting's customer side has no real CustomerId to
 * offer, only the conversation match itself).
 */
function resolveActorForMeeting(body) {
  var meeting = getMeetingById(body.meetingId);
  if (!meeting) return { ok: false, error: 'Meeting not found' };
  var conversation = getConversationById(meeting.ConversationId);
  if (!conversation) return { ok: false, error: 'Meeting not found' };

  if (body.token) {
    var owner;
    try {
      owner = requireAuth(body.token);
    } catch (e) {
      return { ok: false, error: e.message || 'Not authenticated' };
    }
    if (owner.OwnerId !== conversation.OwnerId) return { ok: false, error: 'Meeting not found' };
    return { ok: true, meeting: meeting, conversation: conversation, actorType: 'vendor', actorId: owner.OwnerId };
  }

  if (!body.storeSlug || !body.customerToken ||
      body.storeSlug !== conversation.StoreSlug || body.customerToken !== conversation.CustomerToken) {
    return { ok: false, error: 'Meeting not found' };
  }
  return { ok: true, meeting: meeting, conversation: conversation, actorType: 'customer', actorId: null };
}

/* ==================== Backend API actions ==================== */

/**
 * Public action. Either side may request a meeting on an existing (or
 * brand-new, same as a first chat message) conversation. A vendor request
 * needs only body.token + body.conversationId (or storeSlug - either
 * resolves via resolveChatRequest). A customer request additionally needs
 * body.customerAuthToken - see resolveRequestingActor's header comment for
 * why this direction alone requires real sign-in.
 */
function actionRequestMeeting(body) {
  var fieldErr = validateMeetingRequestFields(body);
  if (fieldErr) return fieldErr;

  var actor = resolveRequestingActor(body);
  if (!actor.ok) return fail(actor.error);

  var conversation = actor.conversation;
  var recipientType = actor.actorType === 'vendor' ? 'customer' : 'vendor';
  // See the file header: a vendor-initiated meeting's customer recipient
  // has no real CustomerId to record, only the conversation itself - so the
  // recorded RecipientId is the conversation's own anonymous chat identity
  // in that case, and a real CustomerId is never available to record for it
  // in this phase. The vendor side is always a real OwnerId either way.
  var recipientId = recipientType === 'vendor' ? conversation.OwnerId : (conversation.CustomerToken || '');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var meeting;
  try {
    var meetingId = newId('meet');
    var now = nowIso();
    appendRowFromObject(getSheet('Meetings'), {
      MeetingId: meetingId,
      RequesterId: actor.actorId,
      RequesterType: actor.actorType,
      RecipientId: recipientId,
      RecipientType: recipientType,
      ConversationId: conversation.ConversationId,
      StoreSlug: conversation.StoreSlug,
      Purpose: String(body.purpose).trim().slice(0, MEETING_PURPOSE_MAX_LEN),
      Notes: String(body.notes || '').trim().slice(0, MEETING_NOTE_MAX_LEN),
      RequestedDate: body.requestedDate,
      RequestedTime: body.requestedTime,
      Timezone: Session.getScriptTimeZone(),
      Status: 'REQUESTED',
      GoogleMeetSpaceName: '',
      GoogleMeetUrl: '',
      MeetFailureReason: '',
      CreatedAt: now,
      AcceptedAt: '',
      ReadyAt: '',
      CancelledAt: '',
      EndedAt: '',
      LastUpdatedAt: now
    });
    meeting = getMeetingById(meetingId);
  } finally {
    lock.releaseLock();
  }

  touchMeetingCache(conversation.ConversationId);
  notifyMeetingEvent(conversation, actor.actorType, 'requested', meeting);

  return ok({ meeting: publicMeetingFields(meeting) });
}

/**
 * Public action. The RECIPIENT accepts or declines. body.accept: boolean.
 * On accept, attempts Google Meet space creation synchronously in the same
 * request - see createGoogleMeetSpace(). A creation failure leaves the row
 * ACCEPTED with MeetFailureReason set (never silently shown as ready);
 * actionRetryMeetingSpace re-attempts from there.
 */
function actionRespondToMeeting(body) {
  var actor = resolveActorForMeeting(body);
  if (!actor.ok) return fail(actor.error);
  var meeting = actor.meeting;

  if (meeting.RecipientType !== actor.actorType) return fail('Not authorized to respond to this meeting');
  // A vendor recipient is always checked against the real OwnerId already
  // resolved above. A customer recipient of a VENDOR-initiated meeting has
  // no real CustomerId on the row to check (see the file header) - the
  // conversation match resolveActorForMeeting already performed is the
  // whole check for that case. A customer recipient of a CUSTOMER-initiated
  // meeting cannot occur (both parties would be the same type), so this is
  // exhaustive for the pairings this phase supports.
  if (actor.actorType === 'vendor' && meeting.RecipientId !== actor.actorId) {
    return fail('Not authorized to respond to this meeting');
  }

  if (VALID_MEETING_STATUSES.indexOf(meeting.Status) === -1) return fail('Invalid meeting state');
  var wantStatus = body.accept ? 'ACCEPTED' : 'DECLINED';
  var allowed = MEETING_TRANSITIONS[meeting.Status] || [];
  if (allowed.indexOf(wantStatus) === -1) return fail('This meeting has already been responded to');

  var sheet = getSheet('Meetings');
  var now = nowIso();

  if (!body.accept) {
    updateRowFromObject(sheet, meeting.__row, { Status: 'DECLINED', LastUpdatedAt: now });
    touchMeetingCache(meeting.ConversationId);
    notifyMeetingEvent(actor.conversation, actor.actorType, 'declined', meeting);
    return ok({ meeting: publicMeetingFields(getMeetingById(meeting.MeetingId)) });
  }

  updateRowFromObject(sheet, meeting.__row, { Status: 'ACCEPTED', AcceptedAt: now, LastUpdatedAt: now });
  touchMeetingCache(meeting.ConversationId);
  var afterAccept = attemptMeetSpaceCreation(getMeetingById(meeting.MeetingId));
  notifyMeetingEvent(actor.conversation, actor.actorType, afterAccept.Status === 'READY' ? 'ready' : 'accepted', afterAccept);

  return ok({ meeting: publicMeetingFields(afterAccept) });
}

/**
 * Public action. Re-attempts Meet space creation for a meeting stuck in
 * ACCEPTED with a recorded failure - the recoverable state §18 of the spec
 * calls for. Either participant may retry.
 */
function actionRetryMeetingSpace(body) {
  var actor = resolveActorForMeeting(body);
  if (!actor.ok) return fail(actor.error);
  if (actor.meeting.Status !== 'ACCEPTED') return fail('This meeting is not waiting on a retry');

  var updated = attemptMeetSpaceCreation(actor.meeting);
  touchMeetingCache(actor.meeting.ConversationId);
  if (updated.Status === 'READY') {
    notifyMeetingEvent(actor.conversation, actor.actorType, 'ready', updated);
  }
  return ok({ meeting: publicMeetingFields(updated) });
}

/**
 * Public action. Either participant may cancel before it ends - matches
 * MEETING_TRANSITIONS (REQUESTED or ACCEPTED or READY -> CANCELLED).
 */
function actionCancelMeeting(body) {
  var actor = resolveActorForMeeting(body);
  if (!actor.ok) return fail(actor.error);
  var meeting = actor.meeting;

  var allowed = MEETING_TRANSITIONS[meeting.Status] || [];
  if (allowed.indexOf('CANCELLED') === -1) return fail('This meeting can no longer be cancelled');

  updateRowFromObject(getSheet('Meetings'), meeting.__row, {
    Status: 'CANCELLED', CancelledAt: nowIso(), LastUpdatedAt: nowIso()
  });
  touchMeetingCache(meeting.ConversationId);
  notifyMeetingEvent(actor.conversation, actor.actorType, 'cancelled', meeting);
  return ok({});
}

/**
 * Public action. Either participant may mark a READY meeting ended - pure
 * bookkeeping (no conference-record retrieval in this phase, see the Stage
 * 1 report), so this reflects "we're done with this Mwakete meeting record,"
 * not an authoritative "the call ended" signal from Google.
 */
function actionEndMeeting(body) {
  var actor = resolveActorForMeeting(body);
  if (!actor.ok) return fail(actor.error);
  var meeting = actor.meeting;
  if (meeting.Status !== 'READY') return fail('This meeting is not currently active');

  updateRowFromObject(getSheet('Meetings'), meeting.__row, {
    Status: 'ENDED', EndedAt: nowIso(), LastUpdatedAt: nowIso()
  });
  touchMeetingCache(meeting.ConversationId);
  return ok({});
}

/**
 * Public action. Every meeting on one conversation, oldest first - polled
 * alongside getConversation (Chat.gs) so the frontend can merge the two
 * timelines without touching the Messages sheet. Same
 * "createIfMissing:false" shape as actionGetConversation: no conversation
 * yet is a valid, empty result, not an error.
 */
function actionListMeetingsForConversation(body) {
  // Calls resolveChatRequest directly, not resolveActorForMeeting (there is
  // no single meeting in play here), so "no conversation exists yet" comes
  // back the same way actionGetConversation (Chat.gs) already treats it - a
  // valid, empty result, not an error. A customer who has never messaged
  // this store yet still gets a clean "no meetings" answer when they open
  // the chat panel, rather than an error the first time.
  var resolved = resolveChatRequest(body, { createIfMissing: false });
  if (!resolved.ok) return fail(resolved.error);
  if (!resolved.conversation) return ok({ meetings: [] });

  var list = listMeetingsForConversationRaw(resolved.conversation.ConversationId);
  return ok({ meetings: list.map(publicMeetingFields) });
}

/* ---------- Google Meet space creation ----------
 *
 * Isolated in this one function on purpose - see the Stage 1 report: this
 * is the one piece built on training-knowledge understanding of the
 * current Meet REST API rather than a live documentation check, and it
 * must be swappable without touching any caller.
 *
 * Authenticates as the Apps Script project's OWN identity
 * (ScriptApp.getOAuthToken(), scope meetings.space.created) - every space
 * in the whole marketplace is created by that one application-level
 * account, never by impersonating a customer or vendor. Requires the
 * Apps Script manifest to declare that scope and the project to be
 * re-authorized - see README.md for the equivalent step already documented
 * for 2FA/email.
 */
var GOOGLE_MEET_API_URL = 'https://meet.googleapis.com/v2/spaces';

/**
 * One attempt at creating (or confirming) a Meet space for an ACCEPTED
 * meeting, idempotent: if GoogleMeetSpaceName is already set, this reuses
 * it and moves straight to READY rather than calling the API again - the
 * duplicate-prevention guarantee §17 of the spec asks for. Returns the
 * updated meeting row either way (READY on success, still ACCEPTED with
 * MeetFailureReason set on failure - never throws, so a failure here can
 * never break the accept request that called it).
 */
function attemptMeetSpaceCreation(meeting) {
  if (meeting.GoogleMeetSpaceName && meeting.GoogleMeetUrl) {
    if (meeting.Status !== 'READY') {
      updateRowFromObject(getSheet('Meetings'), meeting.__row, { Status: 'READY', ReadyAt: nowIso(), LastUpdatedAt: nowIso() });
      return getMeetingById(meeting.MeetingId);
    }
    return meeting;
  }

  var result;
  try {
    result = createGoogleMeetSpace();
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
  }

  if (!result.ok) {
    // Logged server-side with the real detail; never surfaced to the user
    // as-is - see notifyMeetingEvent/the frontend's error copy.
    Logger.log('Meet space creation failed for ' + meeting.MeetingId + ': ' + result.error);
    updateRowFromObject(getSheet('Meetings'), meeting.__row, {
      MeetFailureReason: String(result.error || 'unknown error').slice(0, 500),
      LastUpdatedAt: nowIso()
    });
    return getMeetingById(meeting.MeetingId);
  }

  updateRowFromObject(getSheet('Meetings'), meeting.__row, {
    Status: 'READY',
    GoogleMeetSpaceName: result.spaceName,
    GoogleMeetUrl: result.meetingUri,
    MeetFailureReason: '',
    ReadyAt: nowIso(),
    LastUpdatedAt: nowIso()
  });
  return getMeetingById(meeting.MeetingId);
}

/**
 * The one Meet API call in this file. Returns { ok:true, spaceName,
 * meetingUri } or { ok:false, error }. NEVER throws - every caller treats
 * failure as an ordinary, recoverable result, not an exception.
 *
 * TRAINING-KNOWLEDGE IMPLEMENTATION, NOT LIVE-DOCS-VERIFIED - see the file
 * header and the Stage 1 report. Verify the request/response shape against
 * https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create
 * before relying on this in production; the request body and response
 * field names below are my best current understanding of the v2 API and
 * may need adjusting.
 */
function createGoogleMeetSpace() {
  var token;
  try {
    token = ScriptApp.getOAuthToken();
  } catch (e) {
    return { ok: false, error: 'Could not obtain a Google authorization token: ' + (e.message || e) };
  }

  var response;
  try {
    response = UrlFetchApp.fetch(GOOGLE_MEET_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      // An empty config accepts the API's defaults for access type - left
      // unset deliberately rather than guessed, since the exact default and
      // the options for restricting join access are exactly the kind of
      // detail that needs the live-docs check called out above.
      payload: JSON.stringify({}),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach the Google Meet API: ' + (e.message || e) };
  }

  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    return { ok: false, error: 'Google Meet API returned ' + code + ': ' + response.getContentText().slice(0, 300) };
  }

  var data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (e) {
    return { ok: false, error: 'Google Meet API returned an unreadable response' };
  }

  if (!data.name || !data.meetingUri) {
    return { ok: false, error: 'Google Meet API response was missing expected fields' };
  }

  return { ok: true, spaceName: data.name, meetingUri: data.meetingUri };
}

/* ---------- notifications ----------
 *
 * Email only, reusing sendAppEmail exactly as Chat.gs's
 * notifyVendorOfNewMessage does - this app has no push-notification
 * service (see that function's own comment). Vendor is reachable by email
 * always (Owners.Email). The customer side is reachable by email only when
 * the meeting carries a real signed-in identity - a customer-INITIATED
 * meeting's requester, per the file header. A vendor-initiated meeting's
 * anonymous customer recipient has no email on file and is notified only
 * by the meeting card appearing in their chat window on next poll - the
 * same one-directional limitation chat's own new-message email already
 * has today, not a new gap this feature introduces.
 */
var MEETING_NOTIFY_COOLDOWN_SECONDS = 60; // short: distinct events (requested/accepted/ready), not a repeat-message flood like chat's
function meetingNotifyCooldownKey(meetingId, kind) { return 'v1:meetings:notify:' + meetingId + ':' + kind; }

var MEETING_NOTIFY_KINDS = ['requested', 'accepted', 'ready', 'declined', 'cancelled'];

/** requesterLabel is folded in only where the copy actually needs it ('requested'); every other kind ignores it. */
function meetingEventCopy(kind, requesterLabel) {
  switch (kind) {
    case 'requested': return { subject: 'New meeting request', body: requesterLabel + ' requested a meeting with you on Mwakete.' };
    case 'accepted': return { subject: 'Meeting request accepted', body: 'Your meeting request was accepted - setting up the video call now.' };
    case 'ready': return { subject: 'Your Mwakete video meeting is ready', body: 'Your video meeting is ready. Open Mwakete Messages to join.' };
    case 'declined': return { subject: 'Meeting request declined', body: 'Your meeting request was declined.' };
    case 'cancelled': return { subject: 'Meeting cancelled', body: 'A scheduled meeting was cancelled.' };
    default: return null;
  }
}

function notifyMeetingEvent(conversation, actorType, kind, meeting) {
  if (MEETING_NOTIFY_KINDS.indexOf(kind) === -1) return;

  // Vendor is always one of the two parties (Customer<->Vendor is the only
  // pairing this phase supports) and the only one ever reachable by email -
  // see the header comment. So: notify the vendor whenever the vendor isn't
  // the one who just performed this action themselves (no point emailing
  // someone about what they just did), and skip silently otherwise - the
  // in-chat card, picked up on the next poll, is the notification for
  // whichever side that leaves uninformed. This one rule is correct for
  // every kind because there are only ever two parties and one of them is
  // always the vendor.
  if (actorType === 'vendor') return;
  var cache = CacheService.getScriptCache();
  var cooldownKey = meetingNotifyCooldownKey(meeting.MeetingId, kind);
  if (cache.get(cooldownKey)) return;
  try { cache.put(cooldownKey, '1', MEETING_NOTIFY_COOLDOWN_SECONDS); } catch (e) { /* best effort */ }

  var owner = findRowById(getSheet('Owners'), 'OwnerId', conversation.OwnerId);
  if (!owner || !owner.Email) return;

  var requesterLabel = meeting.RequesterType === 'customer'
    ? (conversation.CustomerName || 'A customer')
    : owner.StoreName;
  var copy = meetingEventCopy(kind, requesterLabel);
  var messagesUrl = siteBaseUrl() ? siteBaseUrl() + '/owner/messages.html' : '';
  var body = copy.body + (messagesUrl ? '\n\nOpen your Messages inbox: ' + messagesUrl : '');
  sendAppEmail(owner.Email, copy.subject + ' - ' + owner.StoreName, body);
}
