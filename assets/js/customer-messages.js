document.addEventListener('DOMContentLoaded', init);

// Adaptive polling backoff, same reasoning as chat-window.js / owner-messages.js:
// start fast after activity, back off while idle to spare Apps Script executions.
const CMSG_CONV_POLL_MIN_MS = 5000;
const CMSG_CONV_POLL_MAX_MS = 20000;
const CMSG_LIST_POLL_MIN_MS = 15000;
const CMSG_LIST_POLL_MAX_MS = 40000;
const CMSG_POLL_BACKOFF = 1.5;
const BASE_TITLE = document.title;

let cmsgConversations = [];
let listFilter = 'all'; // 'all' | 'unread'
let searchQuery = '';

// Open-conversation state (mirrors owner-messages.js's active* set).
let activeSlug = null;
let activeToken = null;
let activeConv = null;
let activeLastMessageId = null;
let activeOldestMessageId = null;
let activeOldestBubble = null;
let activeHasMoreBefore = false;
let renderedMessageIds = new Set();
let isLoadingEarlier = false;
let selectedImageFile = null;
let lastTypingSignalSentAt = 0;
let convPollTimer = null;
let convPollDelayMs = CMSG_CONV_POLL_MIN_MS;
let listPollTimer = null;
let listPollDelayMs = CMSG_LIST_POLL_MIN_MS;

async function init() {
  // From a "seller replied" email (?from=email): not signed in -> sign in, then
  // back here; signed in -> this account's chats are added to this phone.
  const session = typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken ? CustomerAuth.getToken() : null;
  if (/[?&]from=email\b/.test(location.search) && !session) {
    window.location.href = 'customer-login.html?next=' + encodeURIComponent('customer-messages.html');
    return;
  }
  if (session) await claimAccountChats(session);

  wireControls();

  const stores = collectChatStores();
  if (stores.length === 0) {
    document.getElementById('messages-status').textContent = 'No messages yet.';
    return;
  }
  await loadInbox(stores);
  startListPolling();
}

function wireControls() {
  document.getElementById('cmsg-filter-all').addEventListener('click', () => setListFilter('all'));
  document.getElementById('cmsg-filter-unread').addEventListener('click', () => setListFilter('unread'));
  document.getElementById('cmsg-search').addEventListener('input', (e) => { searchQuery = e.target.value; renderInbox(); });
  document.getElementById('messages-list').addEventListener('click', onThreadClick);
  document.getElementById('cmsg-back').addEventListener('click', closeThread);
  document.getElementById('cmsg-load-earlier').addEventListener('click', loadEarlierMessages);
  document.getElementById('cmsg-reply-form').addEventListener('submit', onSendSubmit);
  const input = document.getElementById('cmsg-input');
  input.addEventListener('input', autoResizeInput);
  input.addEventListener('input', sendTypingSignal);
  input.addEventListener('keydown', onInputKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  wireImageAttach();
}

/* ---------- Inbox identity (per-device chat tokens) ---------- */

async function claimAccountChats(session) {
  let res;
  try { res = await Api.post('claimCustomerChats', { customerSession: session }); } catch (e) { return; }
  if (!res || !res.ok || !Array.isArray(res.chats)) return;
  res.chats.forEach((c) => {
    try {
      if (c.storeSlug && c.customerToken && (!localStorage.getItem('skiri_chat_token_' + c.storeSlug) || !chatStartedWith(c.storeSlug))) {
        localStorage.setItem('skiri_chat_token_' + c.storeSlug, c.customerToken);
        markChatStarted(c.storeSlug);
      }
    } catch (e) { /* storage unavailable */ }
  });
}

// The device's per-store chat identities live in localStorage as
// skiri_chat_token_<slug>. This inbox is per-device, matching the anonymous
// chat. seenAt rides along so the backend can count what is unread FOR THIS
// DEVICE (shared with bottom-nav.js, which needs the identical list).
function collectChatStores() {
  const stores = [];
  const prefix = 'skiri_chat_token_';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(prefix) === 0) {
        const slug = key.slice(prefix.length);
        const token = localStorage.getItem(key);
        if (slug && token && chatStartedWith(slug)) {
          stores.push({ storeSlug: slug, customerToken: token, seenAt: inboxSeenAt(slug) });
        }
      }
    }
  } catch (e) { /* storage unavailable - treated as no threads */ }
  return stores;
}

async function loadInbox(stores) {
  const statusEl = document.getElementById('messages-status');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('getCustomerInbox', { stores });
  stop();
  if (!res.ok) {
    document.getElementById('messages-list').innerHTML = '';
    showMessagesLoadFailed(statusEl);
    return;
  }
  cmsgConversations = res.conversations || [];
  renderInbox();
}

// The inbox is the one place where "refresh" is not the most useful next step:
// a visitor with no account may simply not have one yet, and creating it is what
// gets them a history. Signed-in visitors keep the plain shared wording.
function showMessagesLoadFailed(statusEl) {
  const signedIn = typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken();
  if (signedIn) { showLoadFailedMessage(statusEl); return; }
  statusEl.innerHTML = '<a href="customer-login.html">Create Your Account now</a> or refresh page' + STATIC_DOTS_HTML;
}

/* ---------- Inbox rendering ---------- */

function setListFilter(filter) {
  listFilter = filter;
  const allBtn = document.getElementById('cmsg-filter-all');
  const unreadBtn = document.getElementById('cmsg-filter-unread');
  allBtn.classList.toggle('is-active', filter === 'all');
  allBtn.setAttribute('aria-selected', String(filter === 'all'));
  unreadBtn.classList.toggle('is-active', filter === 'unread');
  unreadBtn.setAttribute('aria-selected', String(filter === 'unread'));
  renderInbox();
}

function unreadCountOf(c) {
  if (typeof c.unreadCount === 'number') return c.unreadCount;
  // Fallback for a backend not yet redeployed: last-message-is-newer test.
  if (c.lastSenderType !== 'vendor') return 0;
  const at = new Date(c.lastMessageAt).getTime();
  const seenRaw = inboxSeenAt(c.storeSlug);
  const seen = seenRaw ? new Date(seenRaw).getTime() : 0;
  return at && at > seen ? 1 : 0;
}

function renderInbox() {
  const listEl = document.getElementById('messages-list');
  const statusEl = document.getElementById('messages-status');
  const q = searchQuery.trim().toLowerCase();
  const unreadTotal = cmsgConversations.reduce((n, c) => n + (unreadCountOf(c) > 0 ? 1 : 0), 0);

  const filtered = cmsgConversations.filter((c) => {
    if (listFilter === 'unread' && unreadCountOf(c) === 0) return false;
    if (!q) return true;
    const name = (c.storeName || c.storeSlug || '').toLowerCase();
    const preview = (c.lastMessagePreview || '').toLowerCase();
    return name.indexOf(q) !== -1 || preview.indexOf(q) !== -1;
  });

  const unreadBtn = document.getElementById('cmsg-filter-unread');
  if (unreadBtn) unreadBtn.textContent = unreadTotal > 0 ? `Unread (${unreadTotal})` : 'Unread';

  const totalUnreadMessages = cmsgConversations.reduce((n, c) => n + unreadCountOf(c), 0);
  document.title = totalUnreadMessages > 0 ? `(${totalUnreadMessages}) ${BASE_TITLE}` : BASE_TITLE;

  if (cmsgConversations.length === 0) statusEl.textContent = 'No messages yet.';
  else if (filtered.length === 0) {
    statusEl.textContent = listFilter === 'unread' && !q ? 'No unread conversations.' : 'No conversations match your search.';
  } else statusEl.textContent = '';

  listEl.innerHTML = filtered.map(threadRow).join('');
}

const PHOTO_GLYPH =
  '<span class="msgr-thread-photo" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></span>';

// One row: avatar (store logo, or a coloured initial), store name + role,
// last message with a photo glyph when it was an image, relative time, and an
// unread count badge. Avatar is Mwakete's own store logo - storeLogoUrl, which
// the inbox call returns, or initials when a store has no logo.
function threadRow(c) {
  const count = unreadCountOf(c);
  const name = c.storeName || c.storeSlug;
  const avatarInner = c.storeLogoUrl
    ? `<img class="msgr-avatar-img" src="${escapeHtml(optimizedImageUrl(c.storeLogoUrl, IMG_W.logo))}" alt="" loading="lazy" decoding="async">`
    : `<span class="msgr-avatar-initials" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
  const badge = count > 0 ? `<span class="msgr-avatar-badge" aria-hidden="true">${count > 99 ? '99+' : count}</span>` : '';
  const unreadLabel = count > 0 ? `<span class="sr-only">${count} unread message${count === 1 ? '' : 's'}</span>` : '';
  const isPhoto = c.lastMessagePreview === 'Photo';

  return `
    <button type="button" class="msgr-thread${count > 0 ? ' is-unread' : ''}" data-slug="${escapeHtml(c.storeSlug)}" data-at="${escapeHtml(c.lastMessageAt || '')}">
      <span class="msgr-avatar">${avatarInner}${badge}</span>
      <span class="msgr-thread-main">
        <span class="msgr-thread-top">
          <span class="msgr-thread-name">${escapeHtml(name)}${unreadLabel}</span>
          <span class="msgr-thread-time">${escapeHtml(relTime(c.lastMessageAt))}</span>
        </span>
        <span class="msgr-thread-sub">Store</span>
        <span class="msgr-thread-preview-row">${isPhoto ? PHOTO_GLYPH : ''}<span class="msgr-thread-preview">${escapeHtml(c.lastMessagePreview || '')}</span></span>
      </span>
    </button>`;
}

// Today -> time, within a week -> weekday, older -> date. A real date is easier
// to place a conversation by than a "3d" relative form.
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

function inboxSeenAt(slug) {
  try { return localStorage.getItem('skiri_inbox_seen_' + slug) || ''; } catch (e) { return ''; }
}

function markInboxSeen(slug, at) {
  try { if (at) localStorage.setItem('skiri_inbox_seen_' + slug, at); } catch (e) { /* ignore */ }
}

/* ---------- Open / close a conversation ---------- */

function onThreadClick(e) {
  const row = e.target.closest('.msgr-thread');
  if (!row) return;
  const slug = row.dataset.slug;
  const conv = cmsgConversations.find((c) => c.storeSlug === slug);
  if (conv) openThread(conv);
}

async function openThread(conv) {
  activeConv = conv;
  activeSlug = conv.storeSlug;
  try { activeToken = localStorage.getItem('skiri_chat_token_' + conv.storeSlug) || ''; } catch (e) { activeToken = ''; }
  activeLastMessageId = null;
  activeOldestMessageId = null;
  activeOldestBubble = null;
  activeHasMoreBefore = false;
  renderedMessageIds = new Set();
  updateLoadEarlierButton();

  // Opening it counts as reading it, same as the storefront chat window.
  markInboxSeen(conv.storeSlug, conv.lastMessageAt);
  conv.unreadCount = 0;
  renderInbox();

  const layout = document.getElementById('cmsg-layout');
  layout.classList.add('has-open');
  layout.classList.remove('has-empty');
  document.getElementById('cmsg-detail').classList.remove('hidden');

  const name = conv.storeName || conv.storeSlug;
  document.getElementById('cmsg-store-name').textContent = name;
  document.getElementById('cmsg-store-sub').textContent = 'Store';
  document.getElementById('cmsg-visit-store').href = 'store.html?store=' + encodeURIComponent(conv.storeSlug);
  const avatarEl = document.getElementById('cmsg-avatar');
  if (conv.storeLogoUrl) {
    avatarEl.outerHTML = `<img id="cmsg-avatar" class="msgr-avatar-img" src="${escapeHtml(optimizedImageUrl(conv.storeLogoUrl, IMG_W.logo))}" alt="" decoding="async">`;
  } else {
    // Reset to an initials span (it may have been replaced by an <img> before).
    avatarEl.outerHTML = `<span id="cmsg-avatar" class="msgr-avatar-initials" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
  }

  updateReplyGate();
  clearImageSelection();
  document.getElementById('cmsg-input').value = '';
  autoResizeInput();

  await loadMessages({ isPoll: false });
  startConvPolling();
}

function closeThread() {
  activeSlug = null;
  activeToken = null;
  activeConv = null;
  activeLastMessageId = null;
  activeOldestMessageId = null;
  activeOldestBubble = null;
  activeHasMoreBefore = false;
  renderedMessageIds = new Set();
  showTyping(false);
  stopConvPolling();
  const layout = document.getElementById('cmsg-layout');
  layout.classList.remove('has-open');
  layout.classList.add('has-empty');
  document.getElementById('cmsg-detail').classList.add('hidden');
  renderInbox();
}

function isSignedInCustomer() {
  return typeof CustomerAuth !== 'undefined' && !!CustomerAuth.getToken();
}

// Guests can read a thread they started before, but sending needs a sign-in -
// so the reply box is swapped for a "Sign in to reply" prompt until they do.
function updateReplyGate() {
  const form = document.getElementById('cmsg-reply-form');
  const gate = document.getElementById('cmsg-signin-gate');
  if (isSignedInCustomer()) {
    form.classList.remove('hidden');
    gate.classList.add('hidden');
  } else {
    form.classList.add('hidden');
    gate.classList.remove('hidden');
    document.getElementById('cmsg-signin-link').href = CustomerAuth.signInUrl('message', 'customer-messages.html');
  }
}

/* ---------- Messages ---------- */

function showTyping(isTyping) {
  const el = document.getElementById('cmsg-typing');
  if (el) el.classList.toggle('hidden', !isTyping);
}

function sendTypingSignal() {
  if (!activeSlug || !activeToken) return;
  const now = Date.now();
  if (now - lastTypingSignalSentAt < 2500) return;
  lastTypingSignalSentAt = now;
  Api.post('setTyping', { storeSlug: activeSlug, customerToken: activeToken }).catch(() => {});
}

function updateLoadEarlierButton() {
  const btn = document.getElementById('cmsg-load-earlier');
  btn.classList.toggle('hidden', !activeHasMoreBefore);
}

async function loadMessages(opts) {
  const isPoll = !!(opts && opts.isPoll);
  if (!activeSlug || !activeToken) return false;

  const messagesEl = document.getElementById('cmsg-messages');
  let stopLoading = null;
  if (!isPoll) {
    messagesEl.innerHTML = '<p id="cmsg-messages-loading" class="helper-text"></p>';
    stopLoading = startLoadingMessage(document.getElementById('cmsg-messages-loading'));
  }

  const params = { storeSlug: activeSlug, customerToken: activeToken };
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
    messagesEl.innerHTML = messages.length === 0 ? '<p class="helper-text">No messages yet. Say hi to get started!</p>' : '';
    activeHasMoreBefore = !!res.hasMoreBefore;
    updateLoadEarlierButton();
  }

  let appendedAny = false;
  let newVendorCount = 0;
  messages.forEach((m) => {
    if (renderedMessageIds.has(m.messageId)) return;
    renderedMessageIds.add(m.messageId);
    appendedAny = true;
    if (isPoll && m.senderType === 'vendor') newVendorCount++;
    const bubble = appendMessage(m);
    if (!activeOldestBubble) activeOldestBubble = bubble;
  });
  if (messages.length > 0) {
    activeLastMessageId = messages[messages.length - 1].messageId;
    if (!activeOldestMessageId) activeOldestMessageId = messages[0].messageId;
    // Reading them clears unread for this device.
    markInboxSeen(activeSlug, messages[messages.length - 1].createdAt);
  }

  if (newVendorCount > 0) {
    playChatNotificationSound();
    const storeName = (activeConv && activeConv.storeName) || 'the store';
    const text = newVendorCount === 1 ? `New message from ${storeName}` : `${newVendorCount} new messages from ${storeName}`;
    showChatNotificationToast(text, () => document.getElementById('cmsg-input').focus());
  }

  return appendedAny;
}

async function loadEarlierMessages() {
  if (isLoadingEarlier || !activeHasMoreBefore || !activeOldestMessageId) return;
  isLoadingEarlier = true;
  const btn = document.getElementById('cmsg-load-earlier');
  const done = setButtonBusy(btn, 'Loading');

  const res = await Api.post('getConversation', { storeSlug: activeSlug, customerToken: activeToken, beforeMessageId: activeOldestMessageId });
  done();
  isLoadingEarlier = false;
  if (!res.ok) return;

  const messagesEl = document.getElementById('cmsg-messages');
  const scrollHeightBefore = messagesEl.scrollHeight;
  const scrollTopBefore = messagesEl.scrollTop;
  const messages = res.messages || [];
  const anchor = activeOldestBubble || messagesEl.firstChild;
  messages.forEach((m, i) => {
    renderedMessageIds.add(m.messageId);
    const bubble = appendMessage(m, { insertBeforeEl: anchor });
    if (i === 0) activeOldestBubble = bubble;
  });
  if (messages.length > 0) activeOldestMessageId = messages[0].messageId;
  activeHasMoreBefore = !!res.hasMoreBefore;
  updateLoadEarlierButton();
  messagesEl.scrollTop = scrollTopBefore + (messagesEl.scrollHeight - scrollHeightBefore);
}

// Customer's own messages sit right (--customer); the store's sit left (--vendor).
function appendMessage(m, opts) {
  const messagesEl = document.getElementById('cmsg-messages');
  const placeholder = messagesEl.querySelector('.helper-text');
  if (placeholder) placeholder.remove();

  const bubble = document.createElement('div');
  bubble.className = 'chat-message ' + (m.senderType === 'vendor' ? 'chat-message--vendor' : 'chat-message--customer');
  if (m.imageUrl) {
    const img = document.createElement('img');
    img.className = 'chat-message-image';
    img.src = optimizedImageUrl(m.imageUrl, IMG_W.chat);
    img.alt = 'Photo';
    img.decoding = 'async';
    img.loading = 'lazy';
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
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  return bubble;
}

/* ---------- Sending ---------- */

function appendOptimistic(m) {
  const bubble = appendMessage(m);
  bubble.classList.add('chat-message--sending');
  return bubble;
}

function markSendFailed(bubble, retryFn, errorMessage) {
  bubble.classList.remove('chat-message--sending');
  bubble.classList.add('chat-message--failed');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'chat-message-retry';
  retry.textContent = (errorMessage || 'Failed to send') + ' · Retry';
  retry.addEventListener('click', () => { bubble.remove(); retryFn(); });
  bubble.appendChild(retry);
}

function getCustomerName() {
  try {
    const c = typeof CustomerAuth !== 'undefined' && CustomerAuth.getCustomer ? CustomerAuth.getCustomer() : null;
    if (c && c.name) return c.name;
  } catch (e) { /* ignore */ }
  return '';
}

async function sendText(text) {
  const bubble = appendOptimistic({ senderType: 'customer', body: text });
  const customerSession = isSignedInCustomer() ? CustomerAuth.getToken() : null;
  const res = await Api.post('sendMessage', Object.assign(
    { storeSlug: activeSlug, customerToken: activeToken, customerName: getCustomerName(), body: text },
    customerSession ? { customerSession } : {}));
  bubble.classList.remove('chat-message--sending');

  if (!res.ok) {
    markSendFailed(bubble, () => sendText(text), res.error);
    if (res.signInRequired) updateReplyGate();
    return;
  }
  afterSendOk(res, text);
}

async function sendImage(file, caption) {
  let compressed;
  try { compressed = await compressImage(file); }
  catch (e) { alert("Couldn't process that photo — please try a different one."); return; }
  sendCompressedImage(compressed, caption);
}

async function sendCompressedImage(compressed, caption) {
  const dataUrl = 'data:' + compressed.mimeType + ';base64,' + compressed.base64;
  const bubble = appendOptimistic({ senderType: 'customer', body: caption, imageUrl: dataUrl });
  const res = await Api.post('sendChatImage', {
    storeSlug: activeSlug,
    customerToken: activeToken,
    customerName: getCustomerName(),
    mimeType: compressed.mimeType,
    imageBase64: compressed.base64,
    body: caption || '',
    customerSession: isSignedInCustomer() ? CustomerAuth.getToken() : ''
  });
  bubble.classList.remove('chat-message--sending');

  if (!res.ok) {
    markSendFailed(bubble, () => sendCompressedImage(compressed, caption), res.error);
    if (res.signInRequired) updateReplyGate();
    return;
  }
  afterSendOk(res, caption || 'Photo');
}

function afterSendOk(res, previewText) {
  activeLastMessageId = res.message.messageId;
  renderedMessageIds.add(activeLastMessageId);
  convPollDelayMs = CMSG_CONV_POLL_MIN_MS;
  if (activeConv) {
    activeConv.lastMessagePreview = previewText;
    activeConv.lastMessageAt = res.message.createdAt;
    activeConv.lastSenderType = 'customer';
    activeConv.unreadCount = 0;
    markInboxSeen(activeSlug, res.message.createdAt);
    renderInbox();
  }
}

function onSendSubmit(e) {
  e.preventDefault();
  if (!activeSlug) return;
  const input = document.getElementById('cmsg-input');
  const text = input.value.trim();

  if (selectedImageFile) {
    const file = selectedImageFile;
    clearImageSelection();
    input.value = '';
    autoResizeInput();
    sendImage(file, text);
    return;
  }
  if (!text) return;
  input.value = '';
  autoResizeInput();
  sendText(text);
}

function autoResizeInput() {
  const input = document.getElementById('cmsg-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
}

function onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('cmsg-reply-form').requestSubmit();
  }
}

/* ---------- Image attachment ---------- */

function clearImageSelection() {
  selectedImageFile = null;
  const input = document.getElementById('cmsg-image-input');
  if (input) input.value = '';
  const img = document.getElementById('cmsg-image-preview-img');
  if (img) img.src = '';
  const preview = document.getElementById('cmsg-image-preview');
  if (preview) preview.classList.add('hidden');
}

function wireImageAttach() {
  const attachBtn = document.getElementById('cmsg-attach-btn');
  const imageInput = document.getElementById('cmsg-image-input');
  const previewEl = document.getElementById('cmsg-image-preview');
  const previewImg = document.getElementById('cmsg-image-preview-img');
  const previewRemoveBtn = document.getElementById('cmsg-image-preview-remove');
  if (!attachBtn || !imageInput) return;

  attachBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (!file) return;
    selectedImageFile = file;
    const reader = new FileReader();
    reader.onload = () => { previewImg.src = reader.result; previewEl.classList.remove('hidden'); };
    reader.readAsDataURL(file);
  });
  previewRemoveBtn.addEventListener('click', clearImageSelection);
}

/* ---------- Polling ---------- */

async function convPollTick() {
  if (document.visibilityState === 'visible' && activeSlug) {
    const got = await loadMessages({ isPoll: true });
    convPollDelayMs = got ? CMSG_CONV_POLL_MIN_MS : Math.min(CMSG_CONV_POLL_MAX_MS, Math.round(convPollDelayMs * CMSG_POLL_BACKOFF));
  }
  convPollTimer = setTimeout(convPollTick, convPollDelayMs);
}

function startConvPolling() {
  stopConvPolling();
  convPollDelayMs = CMSG_CONV_POLL_MIN_MS;
  convPollTimer = setTimeout(convPollTick, convPollDelayMs);
}

function stopConvPolling() {
  if (convPollTimer) { clearTimeout(convPollTimer); convPollTimer = null; }
}

async function listPollTick() {
  if (document.visibilityState === 'visible') {
    const stores = collectChatStores();
    if (stores.length > 0) {
      const res = await Api.post('getCustomerInbox', { stores });
      if (res && res.ok) {
        cmsgConversations = res.conversations || [];
        // Keep the open conversation marked read in the refreshed list.
        if (activeSlug) {
          const open = cmsgConversations.find((c) => c.storeSlug === activeSlug);
          if (open) { open.unreadCount = 0; activeConv = open; }
        }
        renderInbox();
      }
    }
  }
  listPollDelayMs = Math.min(CMSG_LIST_POLL_MAX_MS, Math.round(listPollDelayMs * CMSG_POLL_BACKOFF));
  listPollTimer = setTimeout(listPollTick, listPollDelayMs);
}

function startListPolling() {
  stopListPolling();
  listPollDelayMs = CMSG_LIST_POLL_MIN_MS;
  listPollTimer = setTimeout(listPollTick, listPollDelayMs);
}

function stopListPolling() {
  if (listPollTimer) { clearTimeout(listPollTimer); listPollTimer = null; }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    startListPolling();
    if (activeSlug) startConvPolling();
  } else {
    stopListPolling();
    stopConvPolling();
  }
}
