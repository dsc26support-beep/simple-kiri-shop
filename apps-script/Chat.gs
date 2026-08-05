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
 *     Body | CreatedAt | ImageUrl | ImageFileId
 *
 * Locking: the data-layer functions below (findConversation, appendMessage,
 * etc.) still take no lock themselves - same reasoning as Db.gs's generic
 * helpers. The action* handlers at the bottom of this file are what take
 * LockService.getScriptLock() around a multi-step sequence, exactly like
 * every other action handler in this codebase.
 */

var MAX_CHAT_MESSAGE_LENGTH = 2000; // Sheet-cell/payload size guard, same role as Images.gs's MAX_IMAGE_BYTES

// Performance tuning - see docs/chat-performance-optimizations.md for the
// full rationale behind every constant and cache/pagination decision below.
var DEFAULT_MESSAGE_PAGE_SIZE = 50;
var MAX_MESSAGE_PAGE_SIZE = 100;
var DEFAULT_CONVERSATION_PAGE_SIZE = 20;
var MAX_CONVERSATION_PAGE_SIZE = 100;
var CHAT_MESSAGES_CACHE_TTL_SECONDS = 10;
var CHAT_CONVERSATIONS_CACHE_TTL_SECONDS = 8;

function chatMessagesCacheKey(conversationId) { return 'v1:chat:messages:' + conversationId; }
function chatConversationsCacheKey(ownerId) { return 'v1:chat:conversations:' + ownerId; }
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

/**
 * All of one owner's conversations, most recently active first - cached
 * briefly (CHAT_CONVERSATIONS_CACHE_TTL_SECONDS) since this is otherwise a
 * full Conversations-table scan on every call, and it's read on every
 * vendor inbox poll plus the nav unread badge. Unsliced - callers page the
 * result themselves (see actionGetVendorConversations) so the cached value
 * is identical regardless of what page was requested. Invalidated on every
 * write that changes what this list contains or how it's ordered - see
 * touchConversationOnNewMessage, markConversationReadByVendor,
 * setConversationStatus. (markConversationReadByCustomer deliberately does
 * NOT invalidate this - UnreadByCustomer isn't surfaced anywhere in the
 * vendor-facing UI this list feeds, so there's nothing to go stale.)
 */
function listConversationsForOwner(ownerId) {
  return getCached(chatConversationsCacheKey(ownerId), CHAT_CONVERSATIONS_CACHE_TTL_SECONDS, function () {
    return sheetToObjects(getSheet('Conversations'))
      .filter(function (c) { return c.OwnerId === ownerId; })
      .sort(function (a, b) {
        return new Date(b.LastMessageAt || b.CreatedAt) - new Date(a.LastMessageAt || a.CreatedAt);
      });
  });
}

function setConversationStatus(conversationId, status) {
  if (CHAT_CONVERSATION_STATUSES.indexOf(status) === -1) return null;
  var conversation = getConversationById(conversationId);
  if (!conversation) return null;
  updateRowFromObject(getSheet('Conversations'), conversation.__row, { Status: status, UpdatedAt: nowIso() });
  invalidateCache([chatConversationsCacheKey(conversation.OwnerId)]);
  return getConversationById(conversationId);
}

/**
 * Skips the write entirely once already read - this gets called on every
 * single getConversation poll from the vendor side (as a side effect, see
 * actionGetConversation), so without this check a conversation that's
 * already been read writes an identical "still false" value to the sheet
 * on every poll cycle forever. See docs/chat-performance-optimizations.md
 * "Batch writes".
 */
function markConversationReadByVendor(conversationId) {
  var conversation = getConversationById(conversationId);
  if (!conversation) return;
  if (String(conversation.UnreadByVendor) === 'false') return;
  updateRowFromObject(getSheet('Conversations'), conversation.__row, { UnreadByVendor: 'false' });
  invalidateCache([chatConversationsCacheKey(conversation.OwnerId)]);
}

/** Same write-skip reasoning as markConversationReadByVendor above, for the customer-polling side. No cache to invalidate here - see listConversationsForOwner's comment. */
function markConversationReadByCustomer(conversationId) {
  var conversation = getConversationById(conversationId);
  if (!conversation) return;
  if (String(conversation.UnreadByCustomer) === 'false') return;
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
  invalidateCache([chatConversationsCacheKey(conversation.OwnerId)]);
}

/* ---------- Messages ---------- */

/**
 * Appends a message and updates the parent conversation's denormalized
 * fields in the same call, so callers can't do one without the other and
 * leave the inbox list stale. Returns null (and writes nothing) for an
 * invalid senderType, or a message with neither text nor an image.
 *
 * `attachment` is optional: { imageUrl, imageFileId } from
 * actionSendChatImage's Drive upload. A text message passes it as null/
 * undefined; an image message may still carry a caption in `body`, so the
 * two aren't mutually exclusive - only an empty body AND no attachment is
 * rejected.
 */
function appendMessage(conversation, senderType, body, attachment) {
  if (CHAT_SENDER_TYPES.indexOf(senderType) === -1) return null;
  var trimmed = String(body || '').trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
  var hasImage = !!(attachment && attachment.imageUrl);
  if (!trimmed && !hasImage) return null;

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
    CreatedAt: now,
    ImageUrl: hasImage ? attachment.imageUrl : '',
    ImageFileId: hasImage ? attachment.imageFileId : ''
  });

  touchConversationOnNewMessage(conversation, senderType, trimmed || 'Photo');
  // touchConversationOnNewMessage already invalidates the owner's conversations-list
  // cache; the conversation's own message-list cache needs its own invalidation.
  invalidateCache([chatMessagesCacheKey(conversation.ConversationId)]);

  return findRowById(sheet, 'MessageId', messageId);
}

/**
 * Every message in one conversation, oldest first, cached briefly
 * (CHAT_MESSAGES_CACHE_TTL_SECONDS) - the Messages sheet has no way to
 * query "just this conversation's rows," so every miss otherwise re-scans
 * the ENTIRE table across every store's every conversation. Never sliced
 * itself - callers page the result (see listMessagesForConversation) so
 * the cached value is identical no matter what page/cursor was requested.
 * Invalidated immediately on every new message (see appendMessage), so
 * this is never the reason a message looks delayed - the cache only ever
 * absorbs repeat reads between genuine writes (e.g. overlapping polls).
 */
function getConversationMessagesRaw(conversationId) {
  return getCached(chatMessagesCacheKey(conversationId), CHAT_MESSAGES_CACHE_TTL_SECONDS, function () {
    return sheetToObjects(getSheet('Messages'))
      .filter(function (m) { return m.ConversationId === conversationId; })
      .sort(function (a, b) { return new Date(a.CreatedAt) - new Date(b.CreatedAt); });
  });
}

/**
 * Paginated/incremental message fetch for one conversation. `opts` picks
 * exactly one mode:
 *  - opts.sinceMessageId: everything after that message, oldest first -
 *    the polling-delta cursor. Deliberately unbounded (no limit applied) -
 *    a real gap between two polls a few seconds apart is always small, and
 *    truncating it would silently drop a message from the live view.
 *    Falls back to the full list if the cursor doesn't match anything (a
 *    stale/invalid cursor), the same defensive-fallback style used
 *    elsewhere in this codebase (e.g. malformed ItemsJson in Orders.gs).
 *  - opts.beforeMessageId: up to opts.limit messages immediately before
 *    that message - "load earlier history," paging backward.
 *  - neither: the most recent opts.limit messages - the initial-load page,
 *    so opening a long-running conversation never fetches its entire
 *    history in one response.
 * Returns { messages, hasMoreBefore } - hasMoreBefore is always false for
 * the sinceMessageId/polling mode, which never pages backward.
 */
function listMessagesForConversation(conversationId, opts) {
  opts = opts || {};
  var all = getConversationMessagesRaw(conversationId);

  if (opts.sinceMessageId) {
    var sinceIndex = all.findIndex(function (m) { return m.MessageId === opts.sinceMessageId; });
    return { messages: sinceIndex === -1 ? all : all.slice(sinceIndex + 1), hasMoreBefore: false };
  }

  var limit = clampPageSize(opts.limit, DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE);

  if (opts.beforeMessageId) {
    var beforeIndex = all.findIndex(function (m) { return m.MessageId === opts.beforeMessageId; });
    var upTo = beforeIndex === -1 ? all.length : beforeIndex;
    var start = Math.max(0, upTo - limit);
    return { messages: all.slice(start, upTo), hasMoreBefore: start > 0 };
  }

  var start2 = Math.max(0, all.length - limit);
  return { messages: all.slice(start2), hasMoreBefore: start2 > 0 };
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

/** Shapes a raw Messages row for eventual API responses - omits ConversationId/OwnerId/StoreSlug/ImageFileId (the last is a hosting-provider-internal id - Drive file id or Cloudinary public_id, see Utils.gs's uploadImage - not needed by either side of the conversation). */
function publicMessageFields(message) {
  return {
    messageId: message.MessageId,
    senderType: message.SenderType,
    body: message.Body,
    createdAt: message.CreatedAt,
    imageUrl: message.ImageUrl || ''
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
 * Chat images get their own Drive folder (separate from Images.gs's product-
 * photo folder) since these come from anonymous customers, not authenticated
 * vendors uploading their own catalog - keeping the two separate makes it
 * easy to find/moderate/prune chat uploads independently later. Same
 * lazy-create-and-remember-the-id pattern as Images.gs's getImageFolder().
 */
function getChatImageFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('CHAT_IMAGE_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // stored id no longer valid, fall through and recreate
    }
  }
  var folder = DriveApp.createFolder('Mwakete Chat Images');
  props.setProperty('CHAT_IMAGE_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * "Maximum size configurable" - unlike Images.gs's MAX_IMAGE_BYTES (a fixed
 * code constant), the chat image cap reads a Script Property so it can be
 * tuned from the Apps Script editor's Project Settings without touching code
 * or redeploying. Falls back to the same 5MB ceiling as product photos if
 * the property is unset or not a positive number.
 */
function getMaxChatImageBytes() {
  var configured = Number(PropertiesService.getScriptProperties().getProperty('MAX_CHAT_IMAGE_BYTES'));
  return configured > 0 ? configured : 5 * 1024 * 1024;
}

/**
 * Public action. Uploads an image (via Utils.gs's uploadImage() -
 * Cloudinary if configured, else this file's Drive folder) and appends it
 * as a message from whichever side is calling (see resolveChatRequest) -
 * same decode/validate/upload shape as Images.gs's actionUploadProductImage,
 * but writing a Messages row instead of updating a Products row, and using
 * the chat-specific folder/Cloudinary subfolder + configurable size cap
 * above. `body.body`, if present, is sent as an optional caption alongside
 * the image.
 */
function actionSendChatImage(body) {
  var mimeType = body.mimeType;
  var imageBase64 = body.imageBase64;
  if (!mimeType || mimeType.indexOf('image/') !== 0) return fail('Only image uploads are allowed');
  if (!imageBase64) return fail('No image data received');

  var bytes;
  try {
    bytes = Utilities.base64Decode(imageBase64);
  } catch (e) {
    return fail('Invalid image data');
  }
  var maxBytes = getMaxChatImageBytes();
  if (bytes.length > maxBytes) {
    return fail('Image is too large (max ' + Math.floor(maxBytes / (1024 * 1024)) + 'MB) - please choose a smaller photo');
  }

  var resolved = resolveChatRequest(body, { createIfMissing: true });
  if (!resolved.ok) return fail(resolved.error);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var uploaded = uploadImage(bytes, mimeType, resolved.conversation.ConversationId + '_' + Date.now(), getChatImageFolder, 'chat');

    var message = appendMessage(resolved.conversation, resolved.senderType, body.body, {
      imageUrl: uploaded.imageUrl,
      imageFileId: uploaded.imageFileId
    });
    if (!message) return fail('Could not send this image');

    return ok({
      conversationId: resolved.conversation.ConversationId,
      message: publicMessageFields(message)
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Public action. Fetches one conversation + a page of its messages for
 * whichever side is calling. Three ways to call it (see
 * listMessagesForConversation): body.sinceMessageId for the live polling
 * delta, body.beforeMessageId(+body.limit) to page backward into older
 * history, or neither for the initial load's most-recent-page (also
 * +body.limit). Marks it read for that side as a side effect. A customer
 * with no conversation yet gets {conversation:null, messages:[],
 * hasMoreBefore:false}, not an error - that's the normal "haven't sent a
 * first message" state.
 */
function actionGetConversation(body) {
  var resolved = resolveChatRequest(body, { createIfMissing: false });
  if (!resolved.ok) return fail(resolved.error);
  if (!resolved.conversation) return ok({ conversation: null, messages: [], hasMoreBefore: false });

  var page = listMessagesForConversation(resolved.conversation.ConversationId, {
    sinceMessageId: body.sinceMessageId,
    beforeMessageId: body.beforeMessageId,
    limit: body.limit
  });
  if (resolved.senderType === 'vendor') markConversationReadByVendor(resolved.conversation.ConversationId);
  else markConversationReadByCustomer(resolved.conversation.ConversationId);

  return ok({
    conversation: publicConversationFields(resolved.conversation),
    messages: page.messages.map(publicMessageFields),
    hasMoreBefore: page.hasMoreBefore
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
 * this owner except ones they've deleted, newest-activity first, paginated
 * via body.limit/body.offset (defaults: DEFAULT_CONVERSATION_PAGE_SIZE,
 * clamped to MAX_CONVERSATION_PAGE_SIZE). Archived conversations are still
 * included (tagged via `status`) so the UI can filter/group by status
 * rather than losing them from the list entirely. Reads from the cached,
 * unsliced list (listConversationsForOwner) and slices AFTER the cache
 * read, so one cached value serves every page/poll.
 */
function actionGetVendorConversations(owner, body) {
  var all = listConversationsForOwner(owner.OwnerId).filter(function (c) { return c.Status !== 'deleted'; });
  var limit = clampPageSize(body.limit, DEFAULT_CONVERSATION_PAGE_SIZE, MAX_CONVERSATION_PAGE_SIZE);
  var offset = Math.max(0, Number(body.offset) || 0);
  var page = all.slice(offset, offset + limit).map(publicConversationFields);
  return ok({ conversations: page, total: all.length, hasMore: offset + limit < all.length });
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
