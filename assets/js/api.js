// Thin fetch wrapper around the Apps Script Web App. GET is used for public
// reads, POST for everything else. POST bodies are sent as text/plain (a
// CORS-safelisted content type) so the browser never sends a preflight
// OPTIONS request, which Apps Script Web Apps don't handle.
//
// The Apps Script backend always returns HTTP 200, so every response is
// {ok: true, ...} or {ok: false, error: "..."} - callers must check `ok`,
// never the HTTP status.
const Api = (function () {
  // In-flight de-duplication.
  //
  // Independent modules ask for the same thing at the same moment: on
  // checkout.html the page and the chat window both requested
  // getStorePublicInfo (measured 64ms apart), and getConversation and
  // getCustomerInbox each went out twice - 6 requests where 3 would do. On
  // customer-messages.html the page and the nav badge both asked for the inbox,
  // 17ms apart, and getCustomerInbox costs three full-tab reads on the backend.
  //
  // This coalesces only requests that are IDENTICAL AND STILL IN FLIGHT: the
  // second caller is handed the first one's promise. It is not a cache - the
  // entry is dropped the moment the request settles, so the next call goes to
  // the network as before and no price, stock or message is ever served stale.
  //
  // Writes are never coalesced. Two identical sendMessage calls are two
  // messages the user meant to send, so POST is de-duplicated only for the
  // read actions listed below.
  const inFlight = new Map();

  const DEDUPE_POST_ACTIONS = [
    'getConversation', 'getCustomerInbox', 'getCustomerProfile',
    'listCustomerOrders', 'listCustomerBookings',
    'getUnreadCount', 'getVendorConversations'
  ];

  function share(key, run) {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = run().finally(() => {
      // Only clear if we are still the current entry - a later identical call
      // that started after we settled must not have its promise removed.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  // The website can go live a few minutes before the matching backend is
  // deployed. The backend router then answers "Unknown action: x" - shown to a
  // shopper that's meaningless, so it becomes a plain "being updated" message.
  // `outdated: true` lets a page tell it apart if it needs to.
  const UPDATING = 'This part of Mwakete is being updated. Please try again in a little while.';
  function friendly(res) {
    if (res && res.ok === false && /^Unknown action: /.test(String(res.error || ''))) {
      return Object.assign({}, res, { error: UPDATING, outdated: true });
    }
    return res;
  }

  function assertConfigured() {
    if (!APP_CONFIG.APPS_SCRIPT_URL || APP_CONFIG.APPS_SCRIPT_URL.indexOf('PASTE_YOUR') === 0) {
      throw new Error('This shop is not connected yet. Ask the site owner to finish setup (see README.md).');
    }
  }

  async function get(action, params) {
    assertConfigured();
    const url = new URL(APP_CONFIG.APPS_SCRIPT_URL);
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });
    const href = url.toString();
    // Every GET here is a read, so the URL alone identifies the request.
    return share('GET ' + href, async () => {
      try {
        const res = await fetch(href, { method: 'GET' });
        return friendly(await res.json());
      } catch (err) {
        return { ok: false, error: 'Network error - please check your connection and try again.' };
      }
    });
  }

  async function post(action, payload) {
    assertConfigured();
    const body = JSON.stringify(Object.assign({ action }, payload || {}));
    const send = async () => {
      try {
        const res = await fetch(APP_CONFIG.APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: body
        });
        return friendly(await res.json());
      } catch (err) {
        return { ok: false, error: 'Network error - please check your connection and try again.' };
      }
    };
    if (DEDUPE_POST_ACTIONS.indexOf(action) === -1) return send();
    // The whole body is the key, so a request differing only in a cursor
    // (beforeMessageId, say) is correctly treated as a different request.
    return share('POST ' + body, send);
  }

  // ---- Last good answer, kept on this phone (Oct 2026: "pages feel slow") --
  //
  // Apps Script takes seconds to answer from Kiribati. A page that showed
  // something before can show it again at once from here, then quietly swap
  // in the fresh answer when it arrives. Only for read-only lists (home,
  // categories, the seller's own summary); prices and stock are re-checked by
  // the server at checkout whatever a list showed. Capped at MAX_KEPT
  // answers and MAX_AGE_MS old, and every read/write survives a full or
  // blocked storage (private mode) by doing nothing.
  const KEPT_PREFIX = 'skiri_kept:';
  const MAX_KEPT = 12;
  const MAX_AGE_MS = 7 * 86400000;

  function recall(key) {
    try {
      const v = JSON.parse(localStorage.getItem(KEPT_PREFIX + key));
      return v && v.data && Date.now() - v.t < MAX_AGE_MS ? v.data : null;
    } catch (e) {
      return null;
    }
  }

  // Returns true when data differs from what was kept (worth re-drawing).
  function remember(key, data) {
    try {
      const json = JSON.stringify(data);
      const old = localStorage.getItem(KEPT_PREFIX + key);
      if (old && old.indexOf(json) !== -1 && old.length - json.length < 40) return false;
      localStorage.setItem(KEPT_PREFIX + key, JSON.stringify({ t: Date.now(), data: data }));
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(KEPT_PREFIX) === 0) keys.push(k);
      }
      if (keys.length > MAX_KEPT) {
        keys.map((k) => { try { return [k, JSON.parse(localStorage.getItem(k)).t || 0]; } catch (e) { return [k, 0]; } })
          .sort((a, b) => a[1] - b[1]).slice(0, keys.length - MAX_KEPT)
          .forEach((x) => localStorage.removeItem(x[0]));
      }
    } catch (e) {
      // Full or blocked storage: just not kept.
    }
    return true;
  }

  // Drops every kept answer whose key starts with prefix (e.g. at log-out).
  function forget(prefix) {
    try {
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(KEPT_PREFIX + (prefix || '')) === 0) drop.push(k);
      }
      drop.forEach((k) => localStorage.removeItem(k));
    } catch (e) {
      // nothing kept
    }
  }

  return { get, post, recall, remember, forget };
})();
