document.addEventListener('DOMContentLoaded', init);

// Adaptive polling backoff (both loops) - starts fast right after activity
// and geometrically backs off while idle, same "reduce Apps Script
// executions" reasoning as the customer-side chat window. The list poll
// keeps a slower floor/ceiling than the conversation poll since a new
// conversation arriving is less time-sensitive than a reply inside one
// already open - preserves the original 6s/8s distinction between the two,
// just adaptive now instead of fixed. See docs/chat-performance-optimizations.md.
const CONVERSATION_POLL_MIN_MS = 5000;
const CONVERSATION_POLL_MAX_MS = 20000;
const LIST_POLL_MIN_MS = 8000;
const LIST_POLL_MAX_MS = 30000;
const POLL_BACKOFF_FACTOR = 1.5;
const CONVERSATION_LIST_PAGE_SIZE = 20;
const BASE_TITLE = document.title;

let ownerConversations = [];
let conversationsHasMore = false;
let activeConversationId = null;
let activeLastMessageId = null;
let activeOldestMessageId = null;
let activeOldestBubble = null;
let activeHasMoreBefore = false;
// Belt-and-suspenders against ever rendering the same message twice - see
// chat-window.js's identical renderedMessageIds for why. Reset whenever the
// open conversation changes (openConversation/closeConversation).
let renderedMessageIds = new Set();
let isLoadingEarlierMessages = false;
let searchQuery = '';
let listFilter = 'all'; // 'all' | 'unread'
let conversationPollTimer = null;
let conversationPollDelayMs = CONVERSATION_POLL_MIN_MS;
let listPollTimer = null;
let listPollDelayMs = LIST_POLL_MIN_MS;
let selectedReplyImageFile = null;
let lastTypingSignalSentAt = 0;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = shortStoreName(owner.storeName);

  document.getElementById('conversation-search').addEventListener('input', onSearchInput);
  document.getElementById('msg-filter-all').addEventListener('click', () => setListFilter('all'));
  document.getElementById('msg-filter-unread').addEventListener('click', () => setListFilter('unread'));
  document.getElementById('conversation-list').addEventListener('click', onConversationClick);
  document.getElementById('conversation-list-load-more').addEventListener('click', onLoadMoreConversations);
  document.getElementById('back-to-list-btn').addEventListener('click', closeConversation);
  document.getElementById('archive-btn').addEventListener('click', onArchive);
  document.getElementById('delete-btn').addEventListener('click', onDelete);
  document.getElementById('conversation-load-earlier-btn').addEventListener('click', loadEarlierConversationMessages);
  document.getElementById('reply-form').addEventListener('submit', onReplySubmit);
  document.getElementById('reply-input').addEventListener('input', autoResizeReplyInput);
  document.getElementById('reply-input').addEventListener('input', sendTypingSignal);
  document.getElementById('reply-input').addEventListener('keydown', onReplyKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  wireReplyImageAttach();

  await loadConversations({ isPoll: false });
  startListPolling();
}

/* ---------- Conversation list ---------- */

/**
 * `opts.limit`, if given, overrides the fetch size (used by "Load More" to
 * grow the visible page). Otherwise: the very first call omits `limit`
 * entirely so the backend applies its own default page, and every
 * subsequent call (including every poll) re-requests exactly however many
 * conversations are already loaded - a poll's job is to refresh what's on
 * screen, not to silently grow or shrink it.
 */
async function loadConversations(opts) {
  const isPoll = !!(opts && opts.isPoll);
  const statusEl = document.getElementById('conversations-status');
  const stopLoading = isPoll ? null : startLoadingMessage(statusEl);

  const params = { token: Auth.getToken() };
  const limit = (opts && opts.limit) || ownerConversations.length || undefined;
  if (limit) params.limit = limit;

  const res = await Api.post('getVendorConversations', params);
  if (stopLoading) stopLoading();
  if (!res.ok) {
    if (!isPoll) showLoadFailedMessage(statusEl);
    return; // a background poll failing stays silent and just retries next interval
  }

  ownerConversations = res.conversations;
  conversationsHasMore = !!res.hasMore;
  renderConversationList();
}

async function onLoadMoreConversations() {
  const btn = document.getElementById('conversation-list-load-more');
  const done = setButtonBusy(btn, 'Loading');
  await loadConversations({ isPoll: false, limit: ownerConversations.length + CONVERSATION_LIST_PAGE_SIZE });
  done();
}

function onSearchInput(e) {
  searchQuery = e.target.value;
  renderConversationList();
}

function setListFilter(filter) {
  listFilter = filter;
  const allBtn = document.getElementById('msg-filter-all');
  const unreadBtn = document.getElementById('msg-filter-unread');
  allBtn.classList.toggle('is-active', filter === 'all');
  allBtn.setAttribute('aria-selected', String(filter === 'all'));
  unreadBtn.classList.toggle('is-active', filter === 'unread');
  unreadBtn.setAttribute('aria-selected', String(filter === 'unread'));
  renderConversationList();
}

function renderConversationList() {
  const listEl = document.getElementById('conversation-list');
  const statusEl = document.getElementById('conversations-status');
  const loadMoreBtn = document.getElementById('conversation-list-load-more');
  const q = searchQuery.trim().toLowerCase();
  const unreadTotal = ownerConversations.filter((c) => c.unreadByVendor).length;
  const filtered = ownerConversations.filter((c) => {
    if (listFilter === 'unread' && !c.unreadByVendor) return false;
    if (!q) return true;
    const name = (c.customerName || 'Customer').toLowerCase();
    const preview = (c.lastMessagePreview || '').toLowerCase();
    return name.indexOf(q) !== -1 || preview.indexOf(q) !== -1;
  });

  // Live "Unread (N)" count on the filter chip.
  const unreadBtn = document.getElementById('msg-filter-unread');
  if (unreadBtn) unreadBtn.textContent = unreadTotal > 0 ? `Unread (${unreadTotal})` : 'Unread';

  if (ownerConversations.length === 0) statusEl.textContent = 'No conversations yet.';
  else if (filtered.length === 0) {
    statusEl.textContent = listFilter === 'unread' && !q
      ? 'No unread conversations.'
      : 'No conversations match your search.';
  } else statusEl.textContent = '';

  updateUnreadTitle();

  // Load More only makes sense on the unfiltered "All" view - a filtered or
  // searched subset is drawn from what's already loaded.
  const showLoadMore = conversationsHasMore && listFilter === 'all' && !q;
  loadMoreBtn.classList.toggle('hidden', !showLoadMore);

  listEl.innerHTML = filtered.map(renderConversationListItem).join('');
}

// Today -> time; within a week -> weekday; older -> date. Same shape the
// shopper inbox uses, so both sides read a timestamp the same way.
function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.getTime();
  if (!t || isNaN(t)) return '';
  const now = new Date();
  const DAY = 86400000;
  if (now - t < DAY && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (now - t < 7 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString();
}

// A small camera glyph stands in when the last message was a photo (the
// backend sets the preview to "Photo" for an image-only message - the list
// carries no image URL, so this flags it without claiming a specific picture).
const PHOTO_GLYPH =
  '<span class="msgr-thread-photo" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></span>';

function renderConversationListItem(c) {
  const rawName = c.customerName || 'Customer';
  const name = escapeHtml(rawName);
  const time = escapeHtml(relTime(c.lastMessageAt));
  const isPhoto = c.lastMessagePreview === 'Photo';
  const preview = escapeHtml(c.lastMessagePreview || 'No messages yet');
  const isUnread = !!c.unreadByVendor;
  const isActive = c.conversationId === activeConversationId;
  const sub = c.status === 'archived' ? 'Customer · Archived' : 'Customer';
  const badge = isUnread ? '<span class="msgr-avatar-badge" aria-hidden="true"></span>' : '';
  const unreadLabel = isUnread ? '<span class="sr-only">Unread</span>' : '';

  return `
    <button type="button" class="msgr-thread${isUnread ? ' is-unread' : ''}${isActive ? ' is-active' : ''}" data-conversation-id="${escapeHtml(c.conversationId)}">
      <span class="msgr-avatar"><span class="msgr-avatar-initials" aria-hidden="true">${escapeHtml(initials(rawName))}</span>${badge}</span>
      <span class="msgr-thread-main">
        <span class="msgr-thread-top">
          <span class="msgr-thread-name">${name}${unreadLabel}</span>
          <span class="msgr-thread-time">${time}</span>
        </span>
        <span class="msgr-thread-sub">${escapeHtml(sub)}</span>
        <span class="msgr-thread-preview-row">${isPhoto ? PHOTO_GLYPH : ''}<span class="msgr-thread-preview">${preview}</span></span>
      </span>
    </button>
  `;
}

/** Notification counter for the browser tab - the conversation-list poll is this page's own "chat is open" signal, so this stays live while the page is open. */
function updateUnreadTitle() {
  const unreadCount = ownerConversations.filter((c) => c.unreadByVendor).length;
  document.title = unreadCount > 0 ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
}

function onConversationClick(e) {
  const item = e.target.closest('.msgr-thread');
  if (!item) return;
  openConversation(item.dataset.conversationId);
}

/* ---------- Conversation detail ---------- */

async function openConversation(conversationId) {
  activeConversationId = conversationId;
  activeLastMessageId = null;
  activeOldestMessageId = null;
  activeOldestBubble = null;
  activeHasMoreBefore = false;
  renderedMessageIds = new Set();
  updateLoadEarlierMessagesButton();

  const layout = document.getElementById('messages-layout');
  layout.classList.add('has-open');
  layout.classList.remove('has-empty');
  document.getElementById('conversation-detail').classList.remove('hidden');

  const conv = ownerConversations.find((c) => c.conversationId === conversationId);
  const customerName = conv && conv.customerName ? conv.customerName : 'Customer';
  document.getElementById('detail-customer-name').textContent = customerName;
  document.getElementById('detail-avatar').textContent = initials(customerName);
  const statusBadge = document.getElementById('detail-status-badge');
  const status = conv ? conv.status : 'open';
  statusBadge.textContent = status;
  statusBadge.className = 'status-badge msgr-detail-sub status-' + status;

  if (conv) conv.unreadByVendor = false; // opening it is reading it, same as the customer-side chat window
  renderConversationList();

  await loadConversationMessages({ isPoll: false });
  startConversationPolling();
}

function closeConversation() {
  activeConversationId = null;
  activeLastMessageId = null;
  activeOldestMessageId = null;
  activeOldestBubble = null;
  activeHasMoreBefore = false;
  renderedMessageIds = new Set();
  updateLoadEarlierMessagesButton();
  showTyping(false);
  stopConversationPolling();
  const layout = document.getElementById('messages-layout');
  layout.classList.remove('has-open');
  layout.classList.add('has-empty');
  document.getElementById('conversation-detail').classList.add('hidden');
  renderConversationList();
}

/**
 * Sibling of #conversation-messages (not nested inside it - that element's
 * innerHTML gets wiped wholesale on every initial load, which would delete
 * a nested typing indicator along with it). Mirrors chat-window.js's
 * showTyping/sendTypingSignal on the customer side.
 */
function showTyping(isTyping) {
  const typingEl = document.getElementById('conversation-typing');
  if (typingEl) typingEl.classList.toggle('hidden', !isTyping);
}

function sendTypingSignal() {
  if (!activeConversationId) return;
  const now = Date.now();
  if (now - lastTypingSignalSentAt < 2500) return;
  lastTypingSignalSentAt = now;
  Api.post('setTyping', { token: Auth.getToken(), conversationId: activeConversationId }).catch(() => {});
}

function updateLoadEarlierMessagesButton() {
  const btn = document.getElementById('conversation-load-earlier-btn');
  if (activeHasMoreBefore) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
}

/**
 * Initial open (no cursor - server returns the most recent page) or a
 * polling delta (sinceMessageId - always unbounded, never paginated).
 * Returns true if any new message was received, so the adaptive-poll
 * scheduler knows whether to reset to the fast interval or keep backing off.
 */
async function loadConversationMessages(opts) {
  const isPoll = !!(opts && opts.isPoll);
  if (!activeConversationId) return false;

  const messagesEl = document.getElementById('conversation-messages');
  let stopLoading = null;
  if (!isPoll) {
    messagesEl.innerHTML = '<p id="conversation-messages-loading" class="helper-text"></p>';
    stopLoading = startLoadingMessage(document.getElementById('conversation-messages-loading'));
  }

  const params = { token: Auth.getToken(), conversationId: activeConversationId };
  if (activeLastMessageId) params.sinceMessageId = activeLastMessageId;

  const res = await Api.post('getConversation', params);
  if (stopLoading) stopLoading();
  if (!res.ok) {
    if (!isPoll) messagesEl.innerHTML = '<p class="helper-text">' + loadFailedMessageHtml() + '</p>';
    return false;
  }

  showTyping(!!res.otherPartyTyping);

  const messages = res.messages || [];
  if (!isPoll) {
    messagesEl.innerHTML = messages.length === 0 ? '<p class="helper-text">No messages yet.</p>' : '';
    activeHasMoreBefore = !!res.hasMoreBefore;
    updateLoadEarlierMessagesButton();
  }
  let appendedAny = false;
  let newCustomerMessageCount = 0;
  messages.forEach((m) => {
    if (renderedMessageIds.has(m.messageId)) return; // already on screen - see renderedMessageIds' comment near its declaration
    renderedMessageIds.add(m.messageId);
    appendedAny = true;
    // Only a poll represents a message genuinely arriving "live" - see
    // chat-window.js's identical reasoning at its own newVendorMessageCount.
    if (isPoll && m.senderType === 'customer') newCustomerMessageCount++;
    const bubble = appendConversationMessage(m);
    if (!activeOldestBubble) activeOldestBubble = bubble; // first message rendered this session becomes the "load earlier" anchor
  });
  if (messages.length > 0) {
    activeLastMessageId = messages[messages.length - 1].messageId;
    if (!activeOldestMessageId) activeOldestMessageId = messages[0].messageId;
  }

  if (newCustomerMessageCount > 0) {
    playChatNotificationSound();
    const conv = ownerConversations.find((c) => c.conversationId === activeConversationId);
    const customerName = (conv && conv.customerName) || 'the customer';
    const text = newCustomerMessageCount === 1 ? `New message from ${customerName}` : `${newCustomerMessageCount} new messages from ${customerName}`;
    showChatNotificationToast(text, () => document.getElementById('reply-input').focus());
  }

  return appendedAny;
}

/** Pages backward into older history for the open conversation - same prepend-and-preserve-scroll approach as chat-window.js's loadEarlierMessages(), just against #conversation-messages directly since that element is its own scroll container here (unlike the customer widget's separate scrolling wrapper). */
async function loadEarlierConversationMessages() {
  if (isLoadingEarlierMessages || !activeHasMoreBefore || !activeOldestMessageId) return;
  isLoadingEarlierMessages = true;
  const btn = document.getElementById('conversation-load-earlier-btn');
  const done = setButtonBusy(btn, 'Loading');

  const res = await Api.post('getConversation', { token: Auth.getToken(), conversationId: activeConversationId, beforeMessageId: activeOldestMessageId });

  done();
  isLoadingEarlierMessages = false;
  if (!res.ok) return;

  const messagesEl = document.getElementById('conversation-messages');
  const scrollHeightBefore = messagesEl.scrollHeight;
  const scrollTopBefore = messagesEl.scrollTop;
  const messages = res.messages || [];
  const anchor = activeOldestBubble || messagesEl.firstChild;
  messages.forEach((m, i) => {
    renderedMessageIds.add(m.messageId);
    const bubble = appendConversationMessage(m, { insertBeforeEl: anchor });
    if (i === 0) activeOldestBubble = bubble;
  });
  if (messages.length > 0) activeOldestMessageId = messages[0].messageId;
  activeHasMoreBefore = !!res.hasMoreBefore;
  updateLoadEarlierMessagesButton();
  messagesEl.scrollTop = scrollTopBefore + (messagesEl.scrollHeight - scrollHeightBefore);
}

function appendConversationMessage(m, opts) {
  const messagesEl = document.getElementById('conversation-messages');
  const placeholder = messagesEl.querySelector('.helper-text');
  if (placeholder) placeholder.remove();

  const bubble = document.createElement('div');
  bubble.className = 'chat-message ' + (m.senderType === 'vendor' ? 'chat-message--mine' : 'chat-message--theirs');
  if (m.imageUrl) {
    const img = document.createElement('img');
    img.className = 'chat-message-image';
    img.src = optimizedImageUrl(m.imageUrl, IMG_W.chat);
    img.alt = 'Photo';
    img.decoding = 'async';
    img.loading = 'lazy'; // off-screen chat photos don't cost bandwidth until scrolled into view
    bubble.appendChild(img);
  }
  if (m.body) {
    const p = document.createElement('p');
    p.textContent = m.body;
    bubble.appendChild(p);
  }
  if (opts && opts.insertBeforeEl) {
    messagesEl.insertBefore(bubble, opts.insertBeforeEl);
  } else {
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight; // prepending older history must never yank the view down to the bottom
  }
  return bubble;
}

/* ---------- Reply ---------- */

function appendOptimisticReply(text) {
  const bubble = appendConversationMessage({ senderType: 'vendor', body: text });
  bubble.classList.add('chat-message--sending');
  return bubble;
}

function markReplyFailed(bubble, text, errorMessage) {
  bubble.classList.add('chat-message--failed');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'chat-message-retry';
  retry.textContent = (errorMessage || 'Failed to send') + ' · Retry';
  retry.addEventListener('click', () => {
    bubble.remove();
    sendReply(text);
  });
  bubble.appendChild(retry);
}

async function sendReply(text) {
  const bubble = appendOptimisticReply(text);
  const res = await Api.post('sendMessage', { token: Auth.getToken(), conversationId: activeConversationId, body: text });
  bubble.classList.remove('chat-message--sending');

  if (!res.ok) {
    markReplyFailed(bubble, text, res.error);
    return;
  }

  activeLastMessageId = res.message.messageId;
  renderedMessageIds.add(activeLastMessageId); // already on screen (the optimistic bubble above) - a later poll returning it too must not duplicate it
  conversationPollDelayMs = CONVERSATION_POLL_MIN_MS; // sending is activity too - resume fast polling rather than waiting out a backed-off interval
  const conv = ownerConversations.find((c) => c.conversationId === activeConversationId);
  if (conv) {
    conv.lastMessagePreview = text;
    conv.lastMessageAt = res.message.createdAt;
    conv.lastSenderType = 'vendor';
    renderConversationList();
  }
}

/* ---------- Reply image attachment (mirrors chat-window.js's customer-side flow) ---------- */

function markReplyImageFailed(bubble, compressed, caption, errorMessage) {
  bubble.classList.add('chat-message--failed');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'chat-message-retry';
  retry.textContent = (errorMessage || 'Failed to send') + ' · Retry';
  retry.addEventListener('click', () => {
    bubble.remove();
    sendReplyCompressedImage(compressed, caption);
  });
  bubble.appendChild(retry);
}

async function sendReplyCompressedImage(compressed, caption) {
  const dataUrl = 'data:' + compressed.mimeType + ';base64,' + compressed.base64;
  const bubble = appendConversationMessage({ senderType: 'vendor', body: caption, imageUrl: dataUrl });
  bubble.classList.add('chat-message--sending');

  const res = await Api.post('sendChatImage', {
    token: Auth.getToken(),
    conversationId: activeConversationId,
    mimeType: compressed.mimeType,
    imageBase64: compressed.base64,
    body: caption || ''
  });
  bubble.classList.remove('chat-message--sending');

  if (!res.ok) {
    markReplyImageFailed(bubble, compressed, caption, res.error);
    return;
  }

  activeLastMessageId = res.message.messageId;
  renderedMessageIds.add(activeLastMessageId); // see sendReply's identical guard
  conversationPollDelayMs = CONVERSATION_POLL_MIN_MS; // see sendReply's identical reset
  const conv = ownerConversations.find((c) => c.conversationId === activeConversationId);
  if (conv) {
    conv.lastMessagePreview = caption || 'Photo';
    conv.lastMessageAt = res.message.createdAt;
    conv.lastSenderType = 'vendor';
    renderConversationList();
  }
}

async function sendReplyImage(file, caption) {
  let compressed;
  try {
    compressed = await compressImage(file);
  } catch (e) {
    alert("Couldn't process that photo — please try a different one.");
    return;
  }
  sendReplyCompressedImage(compressed, caption);
}

function clearReplyImageSelection() {
  selectedReplyImageFile = null;
  document.getElementById('reply-image-input').value = '';
  document.getElementById('reply-image-preview-img').src = '';
  document.getElementById('reply-image-preview').classList.add('hidden');
}

function wireReplyImageAttach() {
  const attachBtn = document.getElementById('reply-attach-btn');
  const imageInput = document.getElementById('reply-image-input');
  const previewEl = document.getElementById('reply-image-preview');
  const previewImg = document.getElementById('reply-image-preview-img');
  const previewRemoveBtn = document.getElementById('reply-image-preview-remove');
  if (!attachBtn || !imageInput) return;

  attachBtn.addEventListener('click', () => imageInput.click());

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    selectedReplyImageFile = file;
    const reader = new FileReader();
    reader.onload = () => {
      previewImg.src = reader.result;
      previewEl.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  previewRemoveBtn.addEventListener('click', clearReplyImageSelection);
}

function onReplySubmit(e) {
  e.preventDefault();
  const input = document.getElementById('reply-input');
  const text = input.value.trim();
  if (!activeConversationId) return;

  if (selectedReplyImageFile) {
    const file = selectedReplyImageFile;
    clearReplyImageSelection();
    input.value = '';
    autoResizeReplyInput();
    sendReplyImage(file, text);
    return;
  }

  if (!text) return;
  input.value = '';
  autoResizeReplyInput();
  sendReply(text);
}

function autoResizeReplyInput() {
  const input = document.getElementById('reply-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
}

function onReplyKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('reply-form').requestSubmit();
  }
}

/* ---------- Archive / Delete ---------- */

async function onArchive() {
  if (!activeConversationId) return;
  const res = await Api.post('archiveConversation', { token: Auth.getToken(), conversationId: activeConversationId });
  if (!res.ok) {
    alert(res.error || 'Could not archive this conversation.');
    return;
  }
  const conv = ownerConversations.find((c) => c.conversationId === activeConversationId);
  if (conv) conv.status = 'archived';
  const statusBadge = document.getElementById('detail-status-badge');
  statusBadge.textContent = 'archived';
  statusBadge.className = 'status-badge msgr-detail-sub status-archived';
  renderConversationList();
}

async function onDelete() {
  if (!activeConversationId) return;
  if (!confirm('Delete this conversation? It will be hidden from your inbox (the customer can still reach you again by sending a new message).')) return;

  const res = await Api.post('deleteConversation', { token: Auth.getToken(), conversationId: activeConversationId });
  if (!res.ok) {
    alert(res.error || 'Could not delete this conversation.');
    return;
  }
  ownerConversations = ownerConversations.filter((c) => c.conversationId !== activeConversationId);
  closeConversation();
}

/* ---------- Polling ---------- */

async function conversationPollTick() {
  if (document.visibilityState === 'visible') {
    const gotNewMessage = await loadConversationMessages({ isPoll: true });
    conversationPollDelayMs = gotNewMessage
      ? CONVERSATION_POLL_MIN_MS
      : Math.min(CONVERSATION_POLL_MAX_MS, Math.round(conversationPollDelayMs * POLL_BACKOFF_FACTOR));
  }
  conversationPollTimer = setTimeout(conversationPollTick, conversationPollDelayMs);
}

function startConversationPolling() {
  stopConversationPolling();
  conversationPollDelayMs = CONVERSATION_POLL_MIN_MS; // opening/reopening the panel counts as fresh activity
  conversationPollTimer = setTimeout(conversationPollTick, conversationPollDelayMs);
}

function stopConversationPolling() {
  if (conversationPollTimer) {
    clearTimeout(conversationPollTimer);
    conversationPollTimer = null;
  }
}

async function listPollTick() {
  if (document.visibilityState === 'visible') {
    const beforeCount = ownerConversations.length;
    // A conversation the customer is currently viewing (activeConversationId)
    // is covered by loadConversationMessages' own notification above -
    // notifying about it again here would double-fire for the same message.
    const previouslyUnreadIds = new Set(ownerConversations.filter((c) => c.unreadByVendor).map((c) => c.conversationId));
    await loadConversations({ isPoll: true });

    const newlyUnread = ownerConversations.filter(
      (c) => c.unreadByVendor && c.conversationId !== activeConversationId && !previouslyUnreadIds.has(c.conversationId)
    );
    if (newlyUnread.length > 0) {
      playChatNotificationSound();
      const text =
        newlyUnread.length === 1
          ? `New message from ${newlyUnread[0].customerName || 'a customer'}`
          : `${newlyUnread.length} new messages`;
      showChatNotificationToast(text, () => openConversation(newlyUnread[0].conversationId));
    }

    // A changed count (new conversation arrived, or one dropped out somehow)
    // counts as activity; an identical-shaped refresh does not - a truly
    // idle inbox is the common case this backoff is meant to save requests on.
    const gotChange = ownerConversations.length !== beforeCount;
    listPollDelayMs = gotChange
      ? LIST_POLL_MIN_MS
      : Math.min(LIST_POLL_MAX_MS, Math.round(listPollDelayMs * POLL_BACKOFF_FACTOR));
  }
  listPollTimer = setTimeout(listPollTick, listPollDelayMs);
}

function startListPolling() {
  stopListPolling();
  listPollDelayMs = LIST_POLL_MIN_MS;
  listPollTimer = setTimeout(listPollTick, listPollDelayMs);
}

function stopListPolling() {
  if (listPollTimer) {
    clearTimeout(listPollTimer);
    listPollTimer = null;
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    startListPolling();
    if (activeConversationId) startConversationPolling();
  } else {
    stopListPolling();
    stopConversationPolling();
  }
}
