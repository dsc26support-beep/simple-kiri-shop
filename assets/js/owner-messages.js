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
let isLoadingEarlierMessages = false;
let searchQuery = '';
let conversationPollTimer = null;
let conversationPollDelayMs = CONVERSATION_POLL_MIN_MS;
let listPollTimer = null;
let listPollDelayMs = LIST_POLL_MIN_MS;
let selectedReplyImageFile = null;

async function init() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;

  document.getElementById('conversation-search').addEventListener('input', onSearchInput);
  document.getElementById('conversation-list').addEventListener('click', onConversationClick);
  document.getElementById('conversation-list-load-more').addEventListener('click', onLoadMoreConversations);
  document.getElementById('back-to-list-btn').addEventListener('click', closeConversation);
  document.getElementById('archive-btn').addEventListener('click', onArchive);
  document.getElementById('delete-btn').addEventListener('click', onDelete);
  document.getElementById('conversation-load-earlier-btn').addEventListener('click', loadEarlierConversationMessages);
  document.getElementById('reply-form').addEventListener('submit', onReplySubmit);
  document.getElementById('reply-input').addEventListener('input', autoResizeReplyInput);
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
  if (!isPoll) statusEl.textContent = 'Loading…';

  const params = { token: Auth.getToken() };
  const limit = (opts && opts.limit) || ownerConversations.length || undefined;
  if (limit) params.limit = limit;

  const res = await Api.post('getVendorConversations', params);
  if (!res.ok) {
    if (!isPoll) statusEl.textContent = res.error || 'Could not load conversations.';
    return; // a background poll failing stays silent and just retries next interval
  }

  ownerConversations = res.conversations;
  conversationsHasMore = !!res.hasMore;
  renderConversationList();
}

async function onLoadMoreConversations() {
  const btn = document.getElementById('conversation-list-load-more');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  await loadConversations({ isPoll: false, limit: ownerConversations.length + CONVERSATION_LIST_PAGE_SIZE });
  btn.disabled = false;
  btn.textContent = 'Load More';
}

function onSearchInput(e) {
  searchQuery = e.target.value;
  renderConversationList();
}

function renderConversationList() {
  const listEl = document.getElementById('conversation-list');
  const statusEl = document.getElementById('conversations-status');
  const loadMoreBtn = document.getElementById('conversation-list-load-more');
  const q = searchQuery.trim().toLowerCase();
  const filtered = ownerConversations.filter((c) => {
    if (!q) return true;
    const name = (c.customerName || 'Customer').toLowerCase();
    const preview = (c.lastMessagePreview || '').toLowerCase();
    return name.indexOf(q) !== -1 || preview.indexOf(q) !== -1;
  });

  if (ownerConversations.length === 0) statusEl.textContent = 'No conversations yet.';
  else if (filtered.length === 0) statusEl.textContent = 'No conversations match your search.';
  else statusEl.textContent = '';

  updateUnreadTitle();

  listEl.innerHTML = filtered.map(renderConversationListItem).join('');
  if (conversationsHasMore) loadMoreBtn.classList.remove('hidden');
  else loadMoreBtn.classList.add('hidden');
}

/** Notification counter for the browser tab - the conversation-list poll is this page's own "chat is open" signal, so this stays live while the page is open. */
function updateUnreadTitle() {
  const unreadCount = ownerConversations.filter((c) => c.unreadByVendor).length;
  document.title = unreadCount > 0 ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
}

function renderConversationListItem(c) {
  const name = escapeHtml(c.customerName || 'Customer');
  const time = c.lastMessageAt ? escapeHtml(new Date(c.lastMessageAt).toLocaleString()) : '';
  const preview = escapeHtml(c.lastMessagePreview || 'No messages yet');
  const isUnread = !!c.unreadByVendor;
  const isActive = c.conversationId === activeConversationId;
  const archivedTag = c.status === 'archived' ? ' · Archived' : '';

  return `
    <button type="button" class="conversation-list-item${isUnread ? ' is-unread' : ''}${isActive ? ' is-active' : ''}" data-conversation-id="${escapeHtml(c.conversationId)}">
      <span class="conversation-item-top-row">
        <span class="conversation-item-name">${name}${isUnread ? '<span class="conversation-item-unread-dot" aria-label="Unread"></span>' : ''}</span>
        <span class="conversation-item-time">${time}</span>
      </span>
      <span class="conversation-item-preview">${preview}${escapeHtml(archivedTag)}</span>
    </button>
  `;
}

function onConversationClick(e) {
  const item = e.target.closest('.conversation-list-item');
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
  updateLoadEarlierMessagesButton();

  document.getElementById('messages-layout').classList.add('has-open-conversation');
  document.getElementById('conversation-empty-state').classList.add('hidden');
  document.getElementById('conversation-detail').classList.remove('hidden');
  document.getElementById('conversation-messages').innerHTML = '<p class="helper-text">Loading…</p>';

  const conv = ownerConversations.find((c) => c.conversationId === conversationId);
  document.getElementById('detail-customer-name').textContent = conv && conv.customerName ? conv.customerName : 'Customer';
  const statusBadge = document.getElementById('detail-status-badge');
  const status = conv ? conv.status : 'open';
  statusBadge.textContent = status;
  statusBadge.className = 'status-badge status-' + status;

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
  updateLoadEarlierMessagesButton();
  stopConversationPolling();
  document.getElementById('messages-layout').classList.remove('has-open-conversation');
  document.getElementById('conversation-empty-state').classList.remove('hidden');
  document.getElementById('conversation-detail').classList.add('hidden');
  renderConversationList();
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

  const params = { token: Auth.getToken(), conversationId: activeConversationId };
  if (activeLastMessageId) params.sinceMessageId = activeLastMessageId;

  const res = await Api.post('getConversation', params);
  if (!res.ok) {
    if (!isPoll) document.getElementById('conversation-messages').innerHTML = '<p class="helper-text">Could not load messages.</p>';
    return false;
  }

  const messagesEl = document.getElementById('conversation-messages');
  const messages = res.messages || [];
  if (!isPoll) {
    messagesEl.innerHTML = messages.length === 0 ? '<p class="helper-text">No messages yet.</p>' : '';
    activeHasMoreBefore = !!res.hasMoreBefore;
    updateLoadEarlierMessagesButton();
  }
  messages.forEach((m) => {
    const bubble = appendConversationMessage(m);
    if (!activeOldestBubble) activeOldestBubble = bubble; // first message rendered this session becomes the "load earlier" anchor
  });
  if (messages.length > 0) {
    activeLastMessageId = messages[messages.length - 1].messageId;
    if (!activeOldestMessageId) activeOldestMessageId = messages[0].messageId;
  }
  return messages.length > 0;
}

/** Pages backward into older history for the open conversation - same prepend-and-preserve-scroll approach as chat-window.js's loadEarlierMessages(), just against #conversation-messages directly since that element is its own scroll container here (unlike the customer widget's separate scrolling wrapper). */
async function loadEarlierConversationMessages() {
  if (isLoadingEarlierMessages || !activeHasMoreBefore || !activeOldestMessageId) return;
  isLoadingEarlierMessages = true;
  const btn = document.getElementById('conversation-load-earlier-btn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Loading…';

  const res = await Api.post('getConversation', { token: Auth.getToken(), conversationId: activeConversationId, beforeMessageId: activeOldestMessageId });

  btn.disabled = false;
  btn.textContent = originalLabel;
  isLoadingEarlierMessages = false;
  if (!res.ok) return;

  const messagesEl = document.getElementById('conversation-messages');
  const scrollHeightBefore = messagesEl.scrollHeight;
  const scrollTopBefore = messagesEl.scrollTop;
  const messages = res.messages || [];
  const anchor = activeOldestBubble || messagesEl.firstChild;
  messages.forEach((m, i) => {
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
    img.src = m.imageUrl;
    img.alt = 'Photo';
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
  statusBadge.className = 'status-badge status-archived';
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
    await loadConversations({ isPoll: true });
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
