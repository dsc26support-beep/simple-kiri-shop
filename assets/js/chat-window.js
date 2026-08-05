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

const CHAT_POLL_INTERVAL_MS = 6000; // within the requested 5-10s range

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

  const storeSlug = getStoreSlug();
  const customerToken = storeSlug ? getOrCreateCustomerToken(storeSlug) : null;

  let isOpen = false;
  let hasLoadedOnce = false;
  let lastMessageId = null;
  let pollTimer = null;
  let selectedImageFile = null;

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
      bubble.appendChild(img);
    }
    if (text) {
      const p = document.createElement('p');
      p.textContent = text;
      bubble.appendChild(p);
    }
    if (opts && opts.beforeTyping) messagesEl.insertBefore(bubble, typingEl);
    else messagesEl.appendChild(bubble);
    scrollMessagesToBottom();
    return bubble;
  }

  function markBubbleFailed(bubble, retryText) {
    bubble.classList.add('chat-message--failed');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'chat-message-retry';
    retry.textContent = 'Failed to send · Retry';
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

  async function loadConversation(opts) {
    const isPoll = !!(opts && opts.isPoll);
    if (!storeSlug || !customerToken) {
      if (!isPoll) showLoadError();
      return;
    }

    const params = { storeSlug, customerToken };
    if (lastMessageId) params.sinceMessageId = lastMessageId;

    const res = await Api.post('getConversation', params);

    if (!res.ok) {
      if (!isPoll) showLoadError();
      return; // background polls fail silently and retry next interval
    }

    if (!isPoll) {
      loadingEl.classList.add('hidden');
      messagesEl.classList.remove('hidden');
    }

    const messages = res.messages || [];
    if (messages.length === 0) {
      if (!isPoll && !lastMessageId) showEmptyState();
      return;
    }

    messages.forEach((m) => {
      const senderClass = m.senderType === 'vendor' ? 'chat-message--vendor' : 'chat-message--customer';
      appendMessage(senderClass, m.body, { beforeTyping: true, imageUrl: m.imageUrl || null });
    });
    lastMessageId = messages[messages.length - 1].messageId;
    setLastSeenMessageId(lastMessageId); // panel is open while this runs, so this counts as "seen"
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadConversation({ isPoll: true });
    }, CHAT_POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function sendMessage(text) {
    const bubble = appendMessage('chat-message--customer', text, { beforeTyping: true });
    bubble.classList.add('chat-message--sending');

    const res = await Api.post('sendMessage', { storeSlug, customerToken, body: text });

    bubble.classList.remove('chat-message--sending');
    if (!res.ok) {
      markBubbleFailed(bubble, text);
      return;
    }
    lastMessageId = res.message.messageId;
    setLastSeenMessageId(lastMessageId);
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
}
