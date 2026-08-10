// Chat window - connected to the real backend (sendMessage/getConversation in
// apps-script/Chat.gs, via the shared Api module in api.js, which is itself
// async/await + fetch()). Customers are anonymous, so identity is a
// per-store token generated once and kept in localStorage, same pattern as
// cart.js's skiri_cart_<slug>.
//
// Notifications: the recurring poll (new messages arriving live) only runs
// while the panel is actually open. The unread badge still needs to mean
// something when the panel is CLOSED, so on every page load we do exactly
// ONE (not recurring) getConversation check against a persisted "last seen
// message" cursor - separate from the in-memory polling cursor - and count
// how many vendor messages have arrived since. That single check is not a
// poll, so it doesn't violate "only poll while open".
document.addEventListener('DOMContentLoaded', initChatWindow);

// Adaptive polling backoff: starts fast right after activity (a message
// arriving or being sent) and geometrically backs off while idle, capping
// at CHAT_POLL_MAX_MS. This is the same "reduce Apps Script executions"
// reasoning as the vendor side (owner-messages.js) - most poll cycles on an
// open-but-quiet conversation return zero new messages, so there's no
// reason to keep hitting the backend at a fixed fast interval indefinitely.
// See docs/chat-performance-optimizations.md.
const CHAT_POLL_MIN_MS = 5000;
const CHAT_POLL_MAX_MS = 20000;
const CHAT_POLL_BACKOFF_FACTOR = 1.5;

function initChatWindow() {
  const fab = document.getElementById('chat-fab');
  const win = document.getElementById('chat-window');
  if (!fab || !win) return;

  const closeBtn = document.getElementById('chat-window-close');
  const body = document.getElementById('chat-window-body');
  const loadingEl = document.getElementById('chat-loading');
  const messagesEl = document.getElementById('chat-messages');
  const typingEl = document.getElementById('chat-typing');
  const form = document.getElementById('chat-window-form');
  const input = document.getElementById('chat-message-input');
  const badge = document.getElementById('chat-unread-badge');
  const attachBtn = document.getElementById('chat-attach-btn');
  const imageInput = document.getElementById('chat-image-input');
  const previewEl = document.getElementById('chat-image-preview');
  const previewImg = document.getElementById('chat-image-preview-img');
  const previewRemoveBtn = document.getElementById('chat-image-preview-remove');
  const loadEarlierBtn = document.getElementById('chat-load-earlier-btn');

  const storeSlug = getStoreSlug();
  const customerToken = storeSlug ? getOrCreateCustomerToken(storeSlug) : null;

  let isOpen = false;
  let hasLoadedOnce = false;
  let lastMessageId = null;
  let pollTimer = null;
  let pollDelayMs = CHAT_POLL_MIN_MS;
  let selectedImageFile = null;
  let oldestMessageId = null; // earliest messageId currently rendered - the cursor for "load earlier"
  let oldestBubble = null; // DOM node of the earliest rendered bubble - the prepend anchor
  let hasMoreBefore = false;
  let isLoadingEarlier = false;
  let lastTypingSignalSentAt = 0;

  function scrollMessagesToBottom() {
    body.scrollTop = body.scrollHeight;
  }

  function getStoreSlug() {
    // store.html carries it in the URL; cart.html/checkout.html rely on the
    // same skiri_active_store key store.js already sets during a normal visit.
    return getQueryParam('store') || localStorage.getItem('skiri_active_store');
  }

  function getOrCreateCustomerToken(slug) {
    const key = 'skiri_chat_token_' + slug;
    let token = localStorage.getItem(key);
    if (!token) {
      token = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      localStorage.setItem(key, token);
    }
    return token;
  }

  function getLastSeenMessageId() {
    return localStorage.getItem('skiri_chat_lastseen_' + storeSlug);
  }

  function setLastSeenMessageId(messageId) {
    if (!messageId) return;
    localStorage.setItem('skiri_chat_lastseen_' + storeSlug, messageId);
  }

  /**
   * The header's name/avatar were static placeholders ("This Store" / "S")
   * in the HTML with nothing ever wiring them up to the real store - fixed
   * here by fetching the same cached public store-info endpoint the rest of
   * the app already uses (Products.gs's actionGetStorePublicInfo), rather
   * than depending on whatever the host page's own script (store.js/
   * cart-page.js/checkout.js) happens to have loaded, since this file is
   * shared across all three pages and should work self-contained.
   */
  async function loadVendorHeader() {
    if (!storeSlug) return;
    const res = await Api.get('getStorePublicInfo', { storeSlug });
    if (!res.ok || !res.store) return;

    const nameEl = document.getElementById('chat-window-vendor-name');
    if (nameEl) nameEl.textContent = res.store.storeName || 'This Store';

    const placeholder = document.getElementById('chat-vendor-avatar-placeholder');
    if (!placeholder) return;
    if (res.store.logoUrl) {
      const img = document.createElement('img');
      img.className = 'chat-vendor-avatar';
      img.src = res.store.logoUrl;
      img.alt = '';
      placeholder.replaceWith(img);
    } else {
      placeholder.textContent = initials(res.store.storeName);
    }
  }

  function updateBadge(count) {
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  /**
   * One-time check (not a recurring poll) so the badge reflects reality
   * right after a page load/reload even though the panel is closed and the
   * live poll isn't running yet. Uses the persisted "last seen" cursor, not
   * the in-memory polling cursor, and deliberately does NOT advance that
   * cursor - only actually opening the panel counts as "seen".
   */
  async function checkForUnreadMessages() {
    if (!storeSlug || !customerToken) return;
    const params = { storeSlug, customerToken };
    const sinceId = getLastSeenMessageId();
    if (sinceId) params.sinceMessageId = sinceId;

    const res = await Api.post('getConversation', params);
    if (!res.ok || !res.conversation) return;

    const newFromVendor = (res.messages || []).filter((m) => m.senderType === 'vendor');
    updateBadge(newFromVendor.length);
  }

  function clearEmptyState() {
    const existing = messagesEl.querySelector('.chat-empty-state');
    if (existing) existing.remove();
  }

  function showEmptyState() {
    clearEmptyState();
    const empty = document.createElement('p');
    empty.className = 'chat-empty-state';
    empty.textContent = 'Say hi to get started!';
    messagesEl.insertBefore(empty, typingEl);
  }

  function appendMessage(senderClass, text, opts) {
    clearEmptyState();
    const bubble = document.createElement('div');
    bubble.className = 'chat-message ' + senderClass;
    if (opts && opts.imageUrl) {
      const img = document.createElement('img');
      img.className = 'chat-message-image';
      img.src = opts.imageUrl;
      img.alt = 'Photo';
      img.loading = 'lazy'; // off-screen chat photos (older history, long threads) don't cost bandwidth until scrolled into view - real savings on mobile data
      bubble.appendChild(img);
    }
    if (text) {
      const p = document.createElement('p');
      p.textContent = text;
      bubble.appendChild(p);
    }
    // insertBeforeEl (older-message prepend) takes priority over beforeTyping
    // (normal bottom-append) - see loadEarlierMessages().
    if (opts && opts.insertBeforeEl) messagesEl.insertBefore(bubble, opts.insertBeforeEl);
    else if (opts && opts.beforeTyping) messagesEl.insertBefore(bubble, typingEl);
    else messagesEl.appendChild(bubble);
    if (!opts || !opts.insertBeforeEl) scrollMessagesToBottom(); // prepending older history must never yank the view down to the bottom
    return bubble;
  }

  function markBubbleFailed(bubble, retryText, errorMessage) {
    bubble.classList.add('chat-message--failed');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'chat-message-retry';
    retry.textContent = (errorMessage || 'Failed to send') + ' · Retry';
    retry.addEventListener('click', () => {
      bubble.remove();
      sendMessage(retryText);
    });
    bubble.appendChild(retry);
  }

  function showLoadError() {
    loadingEl.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = "Couldn't load messages.";
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-small';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => loadConversation({ isPoll: false }));
    loadingEl.appendChild(msg);
    loadingEl.appendChild(retry);
    loadingEl.classList.remove('hidden');
    messagesEl.classList.add('hidden');
  }

  function resetLoadingSpinner() {
    loadingEl.innerHTML = '<span class="chat-spinner" aria-hidden="true"></span><span>Loading conversation…</span>';
  }

  /**
   * The three-dot bubble already existed in the HTML/CSS (used only as a
   * DOM anchor for message inserts) - this is what actually drives it,
   * fed by getConversation's otherPartyTyping flag on every load/poll.
   * Only ever reflects the vendor's signal; nothing to show before the
   * customer has an actual conversation.
   */
  function showTyping(isTyping) {
    if (!typingEl) return;
    typingEl.classList.toggle('hidden', !isTyping);
    if (isTyping) scrollMessagesToBottom();
  }

  /**
   * Fire-and-forget, debounced to at most once per ~2.5s while actively
   * typing - matches TYPING_SIGNAL_TTL_SECONDS (6s) on the backend with
   * margin, so continuous typing never has a visible gap where the vendor's
   * dots flicker off between signals. Never awaited/surfaced - a failed
   * typing signal isn't worth interrupting anything for.
   */
  function sendTypingSignal() {
    if (!storeSlug || !customerToken) return;
    const now = Date.now();
    if (now - lastTypingSignalSentAt < 2500) return;
    lastTypingSignalSentAt = now;
    Api.post('setTyping', { storeSlug, customerToken }).catch(() => {});
  }

  function updateLoadEarlierButton() {
    if (!loadEarlierBtn) return;
    if (hasMoreBefore) loadEarlierBtn.classList.remove('hidden');
    else loadEarlierBtn.classList.add('hidden');
  }

  /**
   * Initial load (no cursor - server returns the most recent page, see
   * apps-script/Chat.gs's listMessagesForConversation) or a polling delta
   * (sinceMessageId - always the full unbounded gap, never paginated).
   * Returns true if any new message was received, so the adaptive-poll
   * scheduler knows whether to reset to the fast interval or keep backing
   * off - see startPolling/scheduleNextPoll.
   */
  async function loadConversation(opts) {
    const isPoll = !!(opts && opts.isPoll);
    if (!storeSlug || !customerToken) {
      if (!isPoll) showLoadError();
      return false;
    }

    const params = { storeSlug, customerToken };
    if (lastMessageId) params.sinceMessageId = lastMessageId;

    const res = await Api.post('getConversation', params);

    if (!res.ok) {
      if (!isPoll) showLoadError();
      return false; // background polls fail silently and retry next interval
    }

    showTyping(!!res.otherPartyTyping);

    if (!isPoll) {
      loadingEl.classList.add('hidden');
      messagesEl.classList.remove('hidden');
      hasMoreBefore = !!res.hasMoreBefore;
      updateLoadEarlierButton();
    }

    const messages = res.messages || [];
    if (messages.length === 0) {
      if (!isPoll && !lastMessageId) showEmptyState();
      return false;
    }

    messages.forEach((m) => {
      const senderClass = m.senderType === 'vendor' ? 'chat-message--vendor' : 'chat-message--customer';
      const bubble = appendMessage(senderClass, m.body, { beforeTyping: true, imageUrl: m.imageUrl || null });
      if (!oldestBubble) oldestBubble = bubble; // first message ever rendered in this session becomes the initial "load earlier" anchor
    });
    lastMessageId = messages[messages.length - 1].messageId;
    if (!oldestMessageId) oldestMessageId = messages[0].messageId; // only the very first load establishes the oldest boundary - later appends are always newer
    setLastSeenMessageId(lastMessageId); // panel is open while this runs, so this counts as "seen"
    return true;
  }

  /**
   * Pages backward into older history, prepending above the current
   * earliest bubble and preserving scroll position (without this, inserting
   * content above the visible area would otherwise yank the view down by
   * the inserted height). Guarded by isLoadingEarlier against double-clicks
   * firing two overlapping fetches.
   */
  async function loadEarlierMessages() {
    if (isLoadingEarlier || !hasMoreBefore || !oldestMessageId) return;
    isLoadingEarlier = true;
    loadEarlierBtn.disabled = true;
    const originalLabel = loadEarlierBtn.textContent;
    loadEarlierBtn.textContent = 'Loading…';

    const res = await Api.post('getConversation', { storeSlug, customerToken, beforeMessageId: oldestMessageId });

    loadEarlierBtn.disabled = false;
    loadEarlierBtn.textContent = originalLabel;
    isLoadingEarlier = false;

    if (!res.ok) return; // leave the button as-is so the customer can just try again

    const scrollHeightBefore = body.scrollHeight;
    const scrollTopBefore = body.scrollTop;
    const messages = res.messages || [];
    const anchor = oldestBubble || typingEl;
    messages.forEach((m, i) => {
      const senderClass = m.senderType === 'vendor' ? 'chat-message--vendor' : 'chat-message--customer';
      const bubble = appendMessage(senderClass, m.body, { insertBeforeEl: anchor, imageUrl: m.imageUrl || null });
      if (i === 0) oldestBubble = bubble; // messages arrive oldest-first, so the first one processed is the new earliest
    });
    if (messages.length > 0) oldestMessageId = messages[0].messageId;
    hasMoreBefore = !!res.hasMoreBefore;
    updateLoadEarlierButton();
    // Keep whatever was on-screen anchored in place instead of visually jumping.
    body.scrollTop = scrollTopBefore + (body.scrollHeight - scrollHeightBefore);
  }

  if (loadEarlierBtn) loadEarlierBtn.addEventListener('click', loadEarlierMessages);

  function scheduleNextPoll() {
    pollTimer = setTimeout(pollTick, pollDelayMs);
  }

  async function pollTick() {
    if (document.visibilityState === 'visible') {
      const gotNewMessage = await loadConversation({ isPoll: true });
      pollDelayMs = gotNewMessage
        ? CHAT_POLL_MIN_MS
        : Math.min(CHAT_POLL_MAX_MS, Math.round(pollDelayMs * CHAT_POLL_BACKOFF_FACTOR));
    }
    scheduleNextPoll();
  }

  function startPolling() {
    stopPolling();
    pollDelayMs = CHAT_POLL_MIN_MS; // always resume at the fast interval - opening/reopening the panel counts as fresh activity
    scheduleNextPoll();
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function sendMessage(text) {
    const bubble = appendMessage('chat-message--customer', text, { beforeTyping: true });
    bubble.classList.add('chat-message--sending');

    const res = await Api.post('sendMessage', { storeSlug, customerToken, body: text });

    bubble.classList.remove('chat-message--sending');
    if (!res.ok) {
      markBubbleFailed(bubble, text, res.error);
      return;
    }
    lastMessageId = res.message.messageId;
    setLastSeenMessageId(lastMessageId);
    pollDelayMs = CHAT_POLL_MIN_MS; // sending is activity too - a reply might come back quickly, so resume fast polling rather than waiting out a backed-off interval
  }

  /**
   * Image send/retry, mirrored after sendMessage() above. The already-
   * compressed { base64, mimeType } is what a retry resends - no point
   * recompressing the same file a second time on failure.
   */
  function markImageBubbleFailed(bubble, compressed, caption, errorMessage) {
    bubble.classList.add('chat-message--failed');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'chat-message-retry';
    retry.textContent = (errorMessage || 'Failed to send') + ' · Retry';
    retry.addEventListener('click', () => {
      bubble.remove();
      sendCompressedImage(compressed, caption);
    });
    bubble.appendChild(retry);
  }

  async function sendCompressedImage(compressed, caption) {
    const dataUrl = 'data:' + compressed.mimeType + ';base64,' + compressed.base64;
    const bubble = appendMessage('chat-message--customer', caption || '', { beforeTyping: true, imageUrl: dataUrl });
    bubble.classList.add('chat-message--sending');

    const res = await Api.post('sendChatImage', {
      storeSlug,
      customerToken,
      mimeType: compressed.mimeType,
      imageBase64: compressed.base64,
      body: caption || ''
    });

    bubble.classList.remove('chat-message--sending');
    if (!res.ok) {
      markImageBubbleFailed(bubble, compressed, caption, res.error);
      return;
    }
    lastMessageId = res.message.messageId;
    setLastSeenMessageId(lastMessageId);
    pollDelayMs = CHAT_POLL_MIN_MS; // see sendMessage's identical reset
  }

  /** Compresses (helpers.js's shared compressImage) before ever hitting the network - same reasoning as product photos/store logos. */
  async function sendImageMessage(file, caption) {
    let compressed;
    try {
      compressed = await compressImage(file);
    } catch (e) {
      alert("Couldn't process that photo — please try a different one.");
      return;
    }
    sendCompressedImage(compressed, caption);
  }

  function clearImageSelection() {
    selectedImageFile = null;
    imageInput.value = '';
    previewImg.src = '';
    previewEl.classList.add('hidden');
  }

  if (attachBtn && imageInput) {
    attachBtn.addEventListener('click', () => imageInput.click());

    // "Allow preview": show the picked photo before it's compressed/sent, so
    // the customer can back out (Remove) without ever hitting the network.
    imageInput.addEventListener('change', () => {
      const file = imageInput.files[0];
      if (!file) return;
      selectedImageFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        previewImg.src = reader.result;
        previewEl.classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    });

    previewRemoveBtn.addEventListener('click', clearImageSelection);
  }

  function openWindow() {
    isOpen = true;
    win.classList.add('chat-window--open');
    win.setAttribute('aria-hidden', 'false');
    fab.setAttribute('aria-expanded', 'true');
    updateBadge(0); // opening it is reading it

    if (!hasLoadedOnce) {
      hasLoadedOnce = true;
      resetLoadingSpinner();
      loadingEl.classList.remove('hidden');
      messagesEl.classList.add('hidden');
      loadConversation({ isPoll: false });
    }

    startPolling();
    setTimeout(() => input.focus(), 220); // after the open transition
  }

  function closeWindow() {
    isOpen = false;
    win.classList.remove('chat-window--open');
    win.setAttribute('aria-hidden', 'true');
    fab.setAttribute('aria-expanded', 'false');
    stopPolling();
    fab.focus();
  }

  document.addEventListener('visibilitychange', () => {
    if (!isOpen) return;
    if (document.visibilityState === 'visible') startPolling();
    else stopPolling();
  });

  fab.setAttribute('aria-haspopup', 'dialog');
  fab.setAttribute('aria-expanded', 'false');
  win.setAttribute('aria-hidden', 'true');

  fab.addEventListener('click', () => {
    if (isOpen) closeWindow();
    else openWindow();
  });

  closeBtn.addEventListener('click', closeWindow);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closeWindow();
  });

  function autoResizeInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  }
  input.addEventListener('input', autoResizeInput);
  input.addEventListener('input', sendTypingSignal);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();

    if (selectedImageFile) {
      const file = selectedImageFile;
      clearImageSelection();
      input.value = '';
      autoResizeInput();
      sendImageMessage(file, text);
      return;
    }

    if (!text) return;
    input.value = '';
    autoResizeInput();
    sendMessage(text);
  });

  checkForUnreadMessages();
  loadVendorHeader();
}
