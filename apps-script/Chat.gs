/**
 * Vendor-specific live chat — DATA LAYER ONLY.
 *
 * This file defines the Conversations/Messages Sheet model and the plain
 * helper functions that read and write them. There are no `action*`
 * handlers here and nothing in this file is registered in Code.gs's
 * PUBLIC_POST_ACTIONS/PROTECTED_POST_ACTIONS or its doGet/doPost switches —
 * none of this is reachable from the outside yet. No chat UI exists either.
 * See docs/vendor-chat-design.md for the full design (API shape, security,
 * polling strategy) this is the storage layer for.
 *
 * Sheet schema (see README.md):
 *   Conversations: ConversationId | OwnerId | StoreSlug | CustomerToken |
 *     CustomerName | Status | CreatedAt | UpdatedAt | LastMessageAt |
 *     LastMessagePreview | LastSenderType | UnreadByVendor | UnreadByCustomer
 *   Messages: MessageId | ConversationId | OwnerId | StoreSlug | SenderType |
 *     Body | CreatedAt
 *
 * Locking: none of these functions take LockService.getScriptLock() - like
 * Db.gs's generic helpers, that's a write-orchestration concern for the
 * future API layer (e.g. a sendChatMessage handler), not this data layer.
 * Same reasoning: findRowById/appendRowFromObject/updateRowFromObject are
 * lock-free too, and every existing action handler takes its own lock
 * around whichever sequence of them needs to be atomic.
 */

var MAX_CHAT_MESSAGE_LENGTH = 2000; // Sheet-cell/payload size guard, same role as Images.gs's MAX_IMAGE_BYTES
var CHAT_CONVERSATION_STATUSES = ['open', 'closed'];
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
