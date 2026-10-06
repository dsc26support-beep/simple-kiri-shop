/**
 * Meeting requests, integrated into the existing Customer <-> Vendor chat.
 *
 * VIDEO REMOVED (owner decision, Oct 2026): meetings are now requests only -
 * one side asks for a date/time, the other accepts or declines, and they
 * arrange the rest in chat. No video room is created on accept any more, and
 * "Video Call Now" / retryMeetingSpace answer with a plain failure. Rows
 * already READY/RINGING from before keep their status for the record; old
 * RINGING ones still settle to MISSED via settleIfExpired.
 * Scope for this phase, approved explicitly:
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

// RINGING/MISSED: "Video Call Now" (actionStartVideoCallNow) - an instant
// call, as opposed to REQUESTED's scheduled-for-later. RINGING behaves like
// a REQUESTED with a 45-second fuse instead of a chosen date/time; MISSED is
// its terminal timeout, reached only by settleIfExpired, never by a direct
// user action - see that function.
var VALID_MEETING_STATUSES = ['REQUESTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'READY', 'ENDED', 'RINGING', 'MISSED'];
// Mirrors Bookings.gs's BOOKING_TRANSITIONS exactly - same shape, same
// reasoning: an explicit map of what's legal is what keeps "decline a
// meeting that's already READY" from ever silently succeeding.
var MEETING_TRANSITIONS = {
  REQUESTED: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
  RINGING: ['ACCEPTED', 'DECLINED', 'CANCELLED'],
  // ACCEPTED is the settled "yes" now that no video room follows it. READY
  // only exists on rows from before video was removed.
  ACCEPTED: ['CANCELLED'],
  READY: ['ENDED', 'CANCELLED']
  // DECLINED, CANCELLED, ENDED, MISSED are terminal - no outgoing transitions.
};

function meetingCacheKey(conversationId) { return 'v1:meetings:conv:' + conversationId; }
var MEETINGS_CACHE_TTL_SECONDS = 10; // same order as chat's own message cache - see Chat.gs

/**
 * How long a "Video Call Now" rings before it settles to MISSED on its own.
 * There is no server-side timer in Apps Script, so this is enforced lazily:
 * every read path that touches a RINGING meeting (settleIfExpired) is the
 * trigger, whichever side happens to poll next past the deadline. That is
 * self-correcting and never off by more than one poll interval either side.
 */
var RINGING_TIMEOUT_MS = 45 * 1000;

/** A "Video Call Now" never carries a scheduled date/time (see actionStartVideoCallNow) - a REQUESTED meeting always does. Used to decide which events are worth an email (see notifyMeetingEvent). */
function isNowCall(meeting) { return !meeting.RequestedDate; }

function isRingingExpired(meeting) {
  return meeting.Status === 'RINGING' && (Date.now() - new Date(meeting.CreatedAt).getTime()) > RINGING_TIMEOUT_MS;
}

/**
 * Lazily settles a timed-out "Video Call Now" to MISSED. Idempotent and
 * cheap - only writes when the row actually just crossed the deadline, so
 * calling this on every read of a RINGING meeting costs nothing extra on the
 * common case (still within the 45s window). The MISSED email (if any) is
 * sent from here, once, at the moment it is first observed to have expired -
 * see notifyMeetingEvent's 'missed' handling.
 */
function settleIfExpired(meeting) {
  if (!isRingingExpired(meeting)) return meeting;
  updateRowFromObject(getSheet('Meetings'), meeting.__row, { Status: 'MISSED', LastUpdatedAt: nowIso() });
  touchMeetingCache(meeting.ConversationId);
  // See reloadMeetingOrFallback's header comment (defined further down, but
  // hoisted like every top-level function here) - the same "should always
  // find it, but this function must never hand a caller something it can
  // crash on" reasoning applies to every reload-after-write in this file.
  var updated = reloadMeetingOrFallback(meeting.MeetingId, meeting);
  var conversation = getConversationById(meeting.ConversationId);
  if (conversation) notifyMeetingEvent(conversation, meeting.RequesterType, 'missed', updated);
  return updated;
}

/** listMeetingsForConversationRaw, with any timed-out ring settled to MISSED first - the version every action and poll should read from. */
function listMeetingsForConversationLive(conversationId) {
  return listMeetingsForConversationRaw(conversationId).map(settleIfExpired);
}

/**
 * The live incoming-call view for ONE side of a conversation - folded into
 * Chat.gs's getConversation poll rather than a separate endpoint, so a ring
 * costs zero extra requests: it rides whatever interval chat already polls
 * at (5-20s). Returns null when there is nothing currently ringing for this
 * recipientType.
 */
function activeIncomingCall(conversationId, recipientType) {
  var ringing = listMeetingsForConversationLive(conversationId).filter(function (m) {
    return m.Status === 'RINGING' && m.RecipientType === recipientType;
  });
  return ringing.length ? publicMeetingFields(ringing[0]) : null;
}

/**
 * One full scan of the Meetings sheet, not one per conversation - listing
 * conversations already costs one full scan of its own sheet
 * (listConversationsForOwner), so this must not multiply that by the page
 * size. Read-only (does not settle expiry) - purely advisory for highlighting
 * which row in the vendor's inbox list to open; the authoritative check runs
 * when that conversation is actually opened (activeIncomingCall, via
 * actionGetConversation), so a few seconds of staleness here self-corrects.
 */
function ringingConversationIdsForVendor(ownerId) {
  var now = Date.now();
  var ids = {};
  sheetToObjects(getSheet('Meetings')).forEach(function (m) {
    if (m.Status !== 'RINGING' || m.RecipientType !== 'vendor' || m.RecipientId !== ownerId) return;
    if (now - new Date(m.CreatedAt).getTime() > RINGING_TIMEOUT_MS) return;
    ids[m.ConversationId] = true;
  });
  return ids;
}

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
  meeting = settleIfExpired(meeting); // a RINGING call past its 45s fuse must never look answerable
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

/** Public action, kept only so an old cached page gets a clear answer - video calls were removed (see the file header). */
function actionStartVideoCallNow(body) {
  return fail('Video calls are no longer available on Mwakete. Please request a meeting instead.');
}

/**
 * Public action. The RECIPIENT accepts or declines. body.accept: boolean.
 * Accepting just records ACCEPTED - the two parties arrange the details in
 * chat; no video room is created (see the file header).
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
    return ok({ meeting: publicMeetingFields(reloadMeetingOrFallback(meeting.MeetingId, meeting)) });
  }

  updateRowFromObject(sheet, meeting.__row, { Status: 'ACCEPTED', AcceptedAt: now, LastUpdatedAt: now });
  touchMeetingCache(meeting.ConversationId);
  var accepted = reloadMeetingOrFallback(meeting.MeetingId, meeting);
  notifyMeetingEvent(actor.conversation, actor.actorType, 'accepted', accepted);
  return ok({ meeting: publicMeetingFields(accepted) });
}

/** Public action, kept only so an old cached page gets a clear answer - there is no video room to retry any more. */
function actionRetryMeetingSpace(body) {
  return fail('Video calls are no longer available on Mwakete.');
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

  var list = listMeetingsForConversationLive(resolved.conversation.ConversationId);
  return ok({ meetings: list.map(publicMeetingFields) });
}

/**
 * getMeetingById(meetingId) right after writing to that exact row should
 * always find it - but on the rare chance the reload comes back empty, fall
 * back to the last known in-memory row rather than handing the caller
 * something it can crash on. The sheet write already landed either way.
 */
function reloadMeetingOrFallback(meetingId, fallback) {
  var reloaded = getMeetingById(meetingId);
  if (reloaded) return reloaded;
  Logger.log('reloadMeetingOrFallback: could not re-read meeting ' + meetingId + ' immediately after writing to it');
  return fallback;
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
var MEETING_NOTIFY_COOLDOWN_SECONDS = 60; // short: distinct events (requested/accepted/declined), not a repeat-message flood like chat's
function meetingNotifyCooldownKey(meetingId, kind) { return 'v1:meetings:notify:' + meetingId + ':' + kind; }

var MEETING_NOTIFY_KINDS = ['requested', 'accepted', 'declined', 'cancelled', 'missed'];

/** requesterLabel is folded in only where the copy actually needs it ('requested', 'missed'); every other kind ignores it. */
function meetingEventCopy(kind, requesterLabel) {
  switch (kind) {
    case 'requested': return { subject: 'New meeting request', body: requesterLabel + ' requested a meeting with you on Mwakete.' };
    case 'accepted': return { subject: 'Meeting request accepted', body: 'Your meeting request was accepted. Use Mwakete Messages to arrange the details.' };
    case 'declined': return { subject: 'Meeting request declined', body: 'Your meeting request was declined.' };
    case 'cancelled': return { subject: 'Meeting cancelled', body: 'A scheduled meeting was cancelled.' };
    case 'missed': return { subject: 'Missed video call', body: 'You missed a video call from ' + requesterLabel + ' on Mwakete.' };
    default: return null;
  }
}

function notifyMeetingEvent(conversation, actorType, kind, meeting) {
  if (MEETING_NOTIFY_KINDS.indexOf(kind) === -1) return;

  // A "Video Call Now"'s accept/decline/ready/cancel all happen live, seconds
  // apart, on two already-open screens - an email arriving after would only
  // ever describe something already over. Only the terminal "missed" case is
  // genuinely worth telling someone about after the fact.
  if (isNowCall(meeting) && kind !== 'missed') return;

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
