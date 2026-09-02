document.addEventListener('DOMContentLoaded', init);

function init() {
  const statusEl = document.getElementById('messages-status');
  const listEl = document.getElementById('messages-list');
  const stores = collectChatStores();
  if (stores.length === 0) {
    statusEl.textContent = 'No messages yet.';
    return;
  }
  loadInbox(stores, statusEl, listEl);
}

// The device's per-store chat identities live in localStorage as
// skiri_chat_token_<slug>. This inbox is per-device, matching how the
// anonymous chat already works.
function collectChatStores() {
  const stores = [];
  const prefix = 'skiri_chat_token_';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(prefix) === 0) {
        const slug = key.slice(prefix.length);
        const token = localStorage.getItem(key);
        if (slug && token) stores.push({ storeSlug: slug, customerToken: token });
      }
    }
  } catch (e) {
    // storage unavailable - treated as no threads
  }
  return stores;
}

async function loadInbox(stores, statusEl, listEl) {
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('getCustomerInbox', { stores });
  stop();
  if (!res.ok) {
    listEl.innerHTML = '';
    showLoadFailedMessage(statusEl);
    return;
  }
  const convs = res.conversations || [];
  if (convs.length === 0) {
    statusEl.textContent = 'No messages yet.';
    return;
  }
  statusEl.textContent = '';
  listEl.innerHTML = convs.map(threadRow).join('');
  listEl.querySelectorAll('.inbox-thread').forEach((el) => {
    el.addEventListener('click', () => openThread(el.dataset.slug, el.dataset.at));
  });
}

// Unread is computed here, not from the server flag: getConversation (used by
// the chat window / FAB badge) marks threads read, so the server flag is
// unreliable for a passive list. A thread is unread when the last message came
// from the vendor and is newer than the last time we opened it from here.
function isUnread(c) {
  if (c.lastSenderType !== 'vendor') return false;
  let seen = 0;
  try {
    const raw = localStorage.getItem('skiri_inbox_seen_' + c.storeSlug);
    seen = raw ? new Date(raw).getTime() : 0;
  } catch (e) {
    seen = 0;
  }
  const at = new Date(c.lastMessageAt).getTime();
  return !!at && at > (seen || 0);
}

function threadRow(c) {
  const unread = isUnread(c);
  return `
    <button type="button" class="inbox-thread" data-slug="${escapeHtml(c.storeSlug)}" data-at="${escapeHtml(c.lastMessageAt || '')}">
      <span class="inbox-dot${unread ? ' is-unread' : ''}" aria-hidden="true"></span>
      <span class="dash-item-main">
        <strong>${escapeHtml(c.storeName || c.storeSlug)}</strong>
        <span class="helper-text">${escapeHtml(c.lastMessagePreview || '')}</span>
      </span>
      <span class="dash-item-side">
        <span class="dash-status">${escapeHtml(relTime(c.lastMessageAt))}</span>
        ${unread ? '<span class="sr-only">unread</span>' : ''}
      </span>
    </button>`;
}

function openThread(slug, at) {
  try { if (at) localStorage.setItem('skiri_inbox_seen_' + slug, at); } catch (e) { /* ignore */ }
  window.location.href = 'store.html?store=' + encodeURIComponent(slug) + '&chat=open';
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  const MIN = 60000, HR = 3600000, DAY = 86400000;
  if (diff < HR) return Math.max(1, Math.floor(diff / MIN)) + 'm';
  if (diff < DAY) return Math.floor(diff / HR) + 'h';
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + 'd';
  return new Date(iso).toLocaleDateString();
}
