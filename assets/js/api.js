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
        return await res.json();
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
        return await res.json();
      } catch (err) {
        return { ok: false, error: 'Network error - please check your connection and try again.' };
      }
    };
    if (DEDUPE_POST_ACTIONS.indexOf(action) === -1) return send();
    // The whole body is the key, so a request differing only in a cursor
    // (beforeMessageId, say) is correctly treated as a different request.
    return share('POST ' + body, send);
  }

  return { get, post };
})();
