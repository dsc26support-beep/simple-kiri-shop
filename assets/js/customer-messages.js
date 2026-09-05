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
//
// seenAt rides along so the backend can count what is actually unread FOR THIS
// DEVICE. The server cannot work it out alone: getConversation marks a thread
// read the moment the chat window opens, so its read flag says nothing about
// whether this phone has seen the messages. Shared with bottom-nav.js, which
// needs the identical list for the tab badge.
function collectChatStores() {
  const stores = [];
  const prefix = 'skiri_chat_token_';
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(prefix) === 0) {
        const slug = key.slice(prefix.length);
        const token = localStorage.getItem(key);
        if (slug && token) {
          stores.push({ storeSlug: slug, customerToken: token, seenAt: inboxSeenAt(slug) });
        }
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
    showMessagesLoadFailed(statusEl);
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

// The inbox is the one place where "refresh" is not the most useful next step
// for everyone seeing it: a visitor with no account may simply not have one
// yet, and creating it - not retrying - is what gets them a message history.
// Signed-in visitors keep the plain shared wording, and every other page keeps
// showLoadFailedMessage untouched, so this stays local rather than changing a
// helper used in fourteen places.
function showMessagesLoadFailed(statusEl) {
  const signedIn = typeof CustomerAuth !== 'undefined' && CustomerAuth.getToken();
  if (signedIn) {
    showLoadFailedMessage(statusEl);
    return;
  }
  statusEl.innerHTML =
    '<a href="customer-login.html">Create Your Account now</a> or refresh page' + STATIC_DOTS_HTML;
}

// The count comes from the backend (actionGetCustomerInbox), which counts
// vendor messages newer than the seenAt this device sent. The old local
// boolean could only ever say "something is new" - it had no access to the
// message list, so it could never say how much.
//
// The fallback keeps a device honest if it is talking to a backend that has
// not been redeployed yet: no unreadCount field means fall back to the old
// last-message-is-newer test, which yields 1 or 0 rather than a wrong number.
function unreadCountOf(c) {
  if (typeof c.unreadCount === 'number') return c.unreadCount;
  if (c.lastSenderType !== 'vendor') return 0;
  const at = new Date(c.lastMessageAt).getTime();
  const seenRaw = inboxSeenAt(c.storeSlug);
  const seen = seenRaw ? new Date(seenRaw).getTime() : 0;
  return at && at > seen ? 1 : 0;
}

function inboxSeenAt(slug) {
  try {
    return localStorage.getItem('skiri_inbox_seen_' + slug) || '';
  } catch (e) {
    return '';
  }
}

// One row: avatar with its unread badge, store name, last message, date.
//
// The avatar is drawn from storeLogoUrl, which the inbox call now returns -
// the backend was already fetching each store's owner row for the name, so the
// logo costs nothing extra. Initials stand in when a store has no logo, and
// both are the same size, so a missing logo cannot change the row's height.
function threadRow(c) {
  const count = unreadCountOf(c);
  const name = c.storeName || c.storeSlug;
  const avatar = c.storeLogoUrl
    ? `<img class="inbox-avatar-img" src="${escapeHtml(optimizedImageUrl(c.storeLogoUrl, IMG_W.logo))}" alt="" loading="lazy" decoding="async">`
    : `<span class="inbox-avatar-initials" aria-hidden="true">${escapeHtml(initials(name))}</span>`;

  // 99+ rather than a number wide enough to reshape the avatar.
  const badge = count > 0
    ? `<span class="inbox-unread-badge">${count > 99 ? '99+' : count}</span>`
    : '';
  const unreadLabel = count > 0
    ? `<span class="sr-only">${count} unread message${count === 1 ? '' : 's'}</span>`
    : '';

  return `
    <button type="button" class="inbox-thread" data-slug="${escapeHtml(c.storeSlug)}" data-at="${escapeHtml(c.lastMessageAt || '')}">
      <span class="inbox-avatar">${avatar}${badge}</span>
      <span class="inbox-thread-main">
        <span class="inbox-thread-name">${escapeHtml(name)}${unreadLabel}</span>
        <span class="inbox-thread-preview">${escapeHtml(c.lastMessagePreview || '')}</span>
      </span>
      <span class="inbox-thread-date">${escapeHtml(inboxDate(c.lastMessageAt))}</span>
    </button>`;
}

function openThread(slug, at) {
  try { if (at) localStorage.setItem('skiri_inbox_seen_' + slug, at); } catch (e) { /* ignore */ }
  window.location.href = 'store.html?store=' + encodeURIComponent(slug) + '&chat=open';
}

// Time of day for today, weekday within the last week, then a plain date -
// the shape every messaging inbox uses, and what the reference screenshot
// shows for older threads. Deliberately not the old "3d" relative form: in a
// dated list a real date is easier to place a conversation by.
function inboxDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.getTime();
  if (!t || isNaN(t)) return '';
  const diff = Date.now() - t;
  const DAY = 86400000;
  if (diff < DAY && d.getDate() === new Date().getDate()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (diff < 7 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString();
}
