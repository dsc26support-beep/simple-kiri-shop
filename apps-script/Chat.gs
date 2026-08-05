/**
 * Vendor-specific live chat: data layer + backend API actions.
 *
 * Still no chat UI anywhere in the repo - this file is the Conversations/
 * Messages Sheet model (unchanged from the original data-layer pass) plus
 * the action* handlers that Code.gs now routes to. See
 * docs/vendor-chat-design.md for the full design (API shape, security,
 * polling strategy) this implements.
 *
 * Sheet schema (see README.md):
 *   Conversations: ConversationId | OwnerId | StoreSlug | CustomerToken |
 *     CustomerName | Status | CreatedAt | UpdatedAt | LastMessageAt |
 *     LastMessagePreview | LastSenderType | UnreadByVendor | UnreadByCustomer
 *   Messages: MessageId | ConversationId | OwnerId | StoreSlug | SenderType |
 *     Body | CreatedAt
 *
 * Locking: the data-layer functions below (findConversation, appendMessage,
 * etc.) still take no lock themselves - same reasoning as Db.gs's generic
 * helpers. The action* handlers at the bottom of this file are what take
 * LockService.getScriptLock() around a multi-step sequence, exactly like
 * every other action handler in this codebase.
 */

var MAX_CHAT_MESSAGE_LENGTH = 2000; // Sheet-cell/payload size guard, same role as Images.gs's MAX_IMAGE_BYTES
// 'deleted'/'archived' are vendor-only housekeeping states (see
// actionDeleteConversation/actionArchiveConversation below) - a soft delete,
// consistent with every other "delete" in this codebase (archived products,
// deleted variants, closed stores). A new message from either side always
// reopens a conversation back to 'open' (touchConversationOnNewMessage),
// including one a vendor had archived or deleted - a customer who keeps
// writing should never silently stop reaching the vendor just because the
// vendor tidied their inbox.
var CHAT_CONVERSATION_STATUSES = ['open', 'closed', 'archived', 'deleted'];
var CHAT_SENDER_TYPES = ['customer', 'vendor'];

/* ---------- Conversations ---------- */

/** Looks up the one conversation for a (store, anonymous customer) pair, or null. */
function findConversation(storeSlug, customerToken) {
  if (!storeSlug || !customerToken) return null;
  return sheetToObjects(getSheet('Conversations')).filter(function (c) {
    return c.StoreSlug === storeSlug && c.CustomerToken === customerToken;
  })[0] || null;
}

function getConversationById(conversationId) {
  if (!conversationId) return null;
  return findRowById(getSheet('Conversations'), 'ConversationId', conversationId);
}

/**
 * Creates a new conversation row. `owner` is the already-resolved Owners row
 * for `storeSlug` (callers resolve it the same way actionCreateOrder already
 * does via getOwnerBySlug in Products.gs) - this function doesn't do that
 * lookup itself, keeping it a pure data-layer write.
 */
function createConversation(owner, storeSlug, customerToken, customerName) {
  var sheet = getSheet('Conversations');
  var conversationId = newId('conv');
  var now = nowIso();
  appendRowFromObject(sheet, {
    ConversationId: conversationId,
    OwnerId: owner.OwnerId,
    StoreSlug: storeSlug,
    CustomerToken: customerToken,
    CustomerName: customerName || '',
    Status: 'open',
    CreatedAt: now,
    UpdatedAt: now,
    LastMessageAt: '',
    LastMessagePreview: '',
    LastSenderType: '',
    UnreadByVendor: 'false',
    UnreadByCustomer: 'false'
  });
  return getConversationById(conversationId);
}

/**
 * The "one thread per (store, customer)" invariant from the design doc.
 * Not lock-guarded here - a caller that needs this race-safe (e.g. two tabs
 * open at once both sending a first message) should wrap it in
 * LockService.getScriptLock() itself, same as actionCreateOrder does around
 * its own multi-step Sheet sequence.
 */
function findOrCreateConversation(owner, storeSlug, customerToken, customerName) {
  var existing = findConversation(storeSlug, customerToken);
  if (existing) return existing;
  return createConversation(owner, storeSlug, customerToken, customerName);
}

/** All of one owner's conversations, most recently active first. Unsliced - pagination is a future API-layer concern. */
function listConversationsForOwner(ownerId) {
  return sheetToObjects(getSheet('Conversations'))
    .filter(function (c) { return c.OwnerId === ownerId; })
    .sort(function (a, b) {
      return new Date(b.LastMessageAt || b.CreatedAt) - new Date(a.LastMessageAt || a.CreatedAt);
    });
}

function setConversationStatus(conversationId, status) {
  if (CHAT_CONVERSATION_STATUSES.indexOf(status) === -1) return null;
  var conversation = getConversationById(conversationId);
  if (!conversation) return null;
  updateRowFromObject(getSheet('Conversations'), conversation.__row, { Status: status, UpdatedAt: nowIso() });
  return getConversationById(conversationId);
}

function markConversationReadByVendor(conversationId) {
  var conversation = getConversationById(conversationId);
  if (!conversation) return;
  updateRowFromObject(getSheet('Conversations'), conversation.__row, { UnreadByVendor: 'false' });
}

function markConversationReadByCustomer(conversationId) {
  var conversation = getConversationById(conversationId);
  if (!conversation) return;
  updateRowFromObject(getSheet('Conversations'), conversation.__row, { UnreadByCustomer: 'false' });
}

/**
 * Updates a conversation's denormalized "last message" fields and unread
 * flags after a new message is appended, so the vendor inbox list
 * (listConversationsForOwner) never has to scan Messages - same reasoning as
 * Products.Views/Owners.Visits elsewhere in this codebase. Reopens a closed
 * conversation, since a new message from either side means it's active again.
 */
function touchConversationOnNewMessage(conversation, senderType, previewText) {
  var preview = String(previewText || '').slice(0, 200);
  var update = {
    UpdatedAt: nowIso(),
    LastMessageAt: nowIso(),
    LastMessagePreview: preview,
    LastSenderType: senderType,
    Status: 'open'
  };
  if (senderType === 'customer') update.UnreadByVendor = 'true';
  if (senderType === 'vendor') update.UnreadByCustomer = 'true';
  updateRowFromObject(getSheet('Conversations'), conversation.__row, update);
}

/* ---------- Messages ---------- */

/**
 * Appends a message and updates the parent conversation's denormalized
 * fields in the same call, so callers can't do one without the other and
 * leave the inbox list stale. Returns null (and writes nothing) for an
 * invalid senderType or an empty/whitespace-only body.
 */
function appendMessage(conversation, senderType, body) {
  if (CHAT_SENDER_TYPES.indexOf(senderType) === -1) return null;
  var trimmed = String(body || '').trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
  if (!trimmed) return null;

  var sheet = getSheet('Messages');
  var messageId = newId('msg');
  var now = nowIso();
  appendRowFromObject(sheet, {
    MessageId: messageId,
    ConversationId: conversation.ConversationId,
    OwnerId: conversation.OwnerId,
    StoreSlug: conversation.StoreSlug,
    SenderType: senderType,
    Body: trimmed,
    CreatedAt: now
  });

  touchConversationOnNewMessage(conversation, senderType, trimmed);

  return findRowById(sheet, 'MessageId', messageId);
}

/**
 * All messages for a conversation, oldest first. If sinceMessageId is given,
 * returns only the messages after it - the incremental-fetch cursor from the
 * design doc's polling strategy. Falls back to the full list if
 * sinceMessageId doesn't match anything (a stale/invalid cursor), the same
 * defensive-fallback style used elsewhere in this codebase (e.g. malformed
 * ItemsJson parsing in Orders.gs).
 */
function listMessagesForConversation(conversationId, sinceMessageId) {
  var messages = sheetToObjects(getSheet('Messages'))
    .filter(function (m) { return m.ConversationId === conversationId; })
    .sort(function (a, b) { return new Date(a.CreatedAt) - new Date(b.CreatedAt); });

  if (!sinceMessageId) return messages;

  var cursorIndex = messages.findIndex(function (m) { return m.MessageId === sinceMessageId; });
  if (cursorIndex === -1) return messages;
  return messages.slice(cursorIndex + 1);
}

/* ---------- Model shaping (mirrors publicOwnerFields in Auth.gs) ---------- */

/** Shapes a raw Conversations row for eventual API responses - omits OwnerId/CustomerToken, which neither side needs echoed back. */
function publicConversationFields(conversation) {
  return {
    conversationId: conversation.ConversationId,
    storeSlug: conversation.StoreSlug,
    customerName: conversation.CustomerName,
    status: conversation.Status,
    createdAt: conversation.CreatedAt,
    updatedAt: conversation.UpdatedAt,
    lastMessageAt: conversation.LastMessageAt,
    lastMessagePreview: conversation.LastMessagePreview,
    lastSenderType: conversation.LastSenderType,
    unreadByVendor: String(conversation.UnreadByVendor) === 'true',
    unreadByCustomer: String(conversation.UnreadByCustomer) === 'true'
  };
}

/** Shapes a raw Messages row for eventual API responses - omits ConversationId/OwnerId/StoreSlug, redundant once scoped to one conversation. */
function publicMessageFields(message) {
  return {
    messageId: message.MessageId,
    senderType: message.SenderType,
    body: message.Body,
    createdAt: message.CreatedAt
  };
}

/* ==================== Backend API actions ====================
 * Registered in Code.gs's PUBLIC_POST_ACTIONS/PROTECTED_POST_ACTIONS and
 * doPost switch. sendMessage/getConversation/markAsRead are public actions
 * that serve BOTH sides of a conversation from one function each - Code.gs's
 * public/protected split is binary (protected always requires a token), but
 * chat genuinely needs "auth if you have a vendor token, anonymous
 * customer-token flow otherwise" - so these three do that branching
 * themselves via resolveChatRequest() rather than being force-fit into two
 * near-duplicate public/protected handlers each.
 */

/**
 * Resolves which conversation a request is about and which side is calling,
 * shared by sendMessage/getConversation/markAsRead so the "vendor token vs.
 * anonymous customer token" branching exists in exactly one place.
 *
 * Vendor path (body.token present): requireAuth()'s the token, requires
 * body.conversationId, and ownership-checks it - the same pattern as every
 * other owned-row action in this codebase (actionUpdateOrderStatus,
 * actionDeleteProduct, etc.).
 *
 * Customer path (no token): requires body.storeSlug + body.customerToken.
 * With opts.createIfMissing, resolves the store and finds-or-creates the
 * conversation (only sendMessage should pass this - a customer's first
 * message is what starts a thread). Without it, just looks up whatever
 * conversation already exists - `conversation: null` is a valid, non-error
 * result here (no thread yet), not every caller wants one created.
 *
 * Returns { ok: true, conversation, senderType } or { ok: false, error }.
 */
function resolveChatRequest(body, opts) {
  var createIfMissing = !!(opts && opts.createIfMissing);

  if (body.token) {
    var owner;
    try {
      owner = requireAuth(body.token);
    } catch (e) {
      return { ok: false, error: e.message || 'Not authenticated' };
    }
    if (!body.conversationId) return { ok: false, error: 'conversationId is required' };
    var conversation = getConversationById(body.conversationId);
    if (!conversation || conversation.OwnerId !== owner.OwnerId) return { ok: false, error: 'Conversation not found' };
    return { ok: true, conversation: conversation, senderType: 'vendor' };
  }

  var storeSlug = body.storeSlug;
  var customerToken = body.customerToken;
  if (!storeSlug || !customerToken) return { ok: false, error: 'storeSlug and customerToken are required' };

  if (createIfMissing) {
    var storeOwner = getOwnerBySlug(storeSlug);
    if (!storeOwner || storeOwner.Status !== 'active') return { ok: false, error: 'Store not found' };
    var conv = findOrCreateConversation(storeOwner, storeSlug, customerToken, body.customerName);
    return { ok: true, conversation: conv, senderType: 'customer' };
  }

  return { ok: true, conversation: findConversation(storeSlug, customerToken), senderType: 'customer' };
}

/**
 * Public action. Sends a message from either side (see resolveChatRequest) -
 * creates the conversation on a customer's first message. Lock-guarded
 * around the find-or-create-then-append sequence, same as actionCreateOrder.
 */
function actionSendMessage(body) {
  var resolved = resolveChatRequest(body, { createIfMissing: true });
  if (!resolved.ok) return fail(resolved.error);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var message = appendMessage(resolved.conversation, resolved.senderType, body.body);
    if (!message) return fail('Message text is required');
    return ok({
      conversationId: resolved.conversation.ConversationId,
      message: publicMessageFields(message)
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Public action. Fetches one conversation + its messages for whichever side
 * is calling, optionally incremental via body.sinceMessageId (the polling
 * cursor from the design doc). Marks it read for that side as a side effect.
 * A customer with no conversation yet gets {conversation:null, messages:[]},
 * not an error - that's the normal "haven't sent a first message" state.
 */
function actionGetConversation(body) {
  var resolved = resolveChatRequest(body, { createIfMissing: false });
  if (!resolved.ok) return fail(resolved.error);
  if (!resolved.conversation) return ok({ conversation: null, messages: [] });

  var messages = listMessagesForConversation(resolved.conversation.ConversationId, body.sinceMessageId);
  if (resolved.senderType === 'vendor') markConversationReadByVendor(resolved.conversation.ConversationId);
  else markConversationReadByCustomer(resolved.conversation.ConversationId);

  return ok({
    conversation: publicConversationFields(resolved.conversation),
    messages: messages.map(publicMessageFields)
  });
}

/**
 * Public action. Explicit "mark read" for either side, independent of
 * fetching messages (e.g. a vendor glancing at the inbox list without
 * opening the full thread). No-op-ish failure if there's no conversation to
 * mark - unlike sendMessage, this never creates one.
 */
function actionMarkAsRead(body) {
  var resolved = resolveChatRequest(body, { createIfMissing: false });
  if (!resolved.ok) return fail(resolved.error);
  if (!resolved.conversation) return fail('Conversation not found');

  if (resolved.senderType === 'vendor') markConversationReadByVendor(resolved.conversation.ConversationId);
  else markConversationReadByCustomer(resolved.conversation.ConversationId);

  return ok({});
}

/**
 * Protected action (vendor only). The inbox list - every conversation for
 * this owner except ones they've deleted, newest-activity first. Archived
 * conversations are still included (tagged via `status`) so a future UI can
 * filter/group by status rather than losing them from the list entirely.
 * Unpaginated for now, same as every other owner-scoped list in this
 * codebase (listOwnerProducts, listOwnerOrders) - pagination is a separate,
 * not-yet-implemented plan that applies to all of them together.
 */
function actionGetVendorConversations(owner) {
  var conversations = listConversationsForOwner(owner.OwnerId)
    .filter(function (c) { return c.Status !== 'deleted'; })
    .map(publicConversationFields);
  return ok({ conversations: conversations });
}

/** Protected action (vendor only). Soft-deletes a conversation - hides it from actionGetVendorConversations, never removes the row. */
function actionDeleteConversation(owner, body) {
  var conversation = getConversationById(body.conversationId);
  if (!conversation || conversation.OwnerId !== owner.OwnerId) return fail('Conversation not found');
  setConversationStatus(body.conversationId, 'deleted');
  return ok({});
}

/** Protected action (vendor only). Marks a conversation archived - still listed, tagged with status:'archived' for the UI to filter/group. */
function actionArchiveConversation(owner, body) {
  var conversation = getConversationById(body.conversationId);
  if (!conversation || conversation.OwnerId !== owner.OwnerId) return fail('Conversation not found');
  setConversationStatus(body.conversationId, 'archived');
  return ok({});
}

/**
 * Protected action (vendor only). Count of conversations with an unread
 * message waiting, for a lightweight nav badge - the "slow background poll"
 * case from the design doc's polling strategy, deliberately separate from
 * fetching full conversation/message data.
 */
function actionGetUnreadCount(owner) {
  var count = listConversationsForOwner(owner.OwnerId)
    .filter(function (c) { return c.Status !== 'deleted' && String(c.UnreadByVendor) === 'true'; })
    .length;
  return ok({ unreadCount: count });
}
