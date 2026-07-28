// Thin fetch wrapper around the Apps Script Web App. GET is used for public
// reads, POST for everything else. POST bodies are sent as text/plain (a
// CORS-safelisted content type) so the browser never sends a preflight
// OPTIONS request, which Apps Script Web Apps don't handle.
//
// The Apps Script backend always returns HTTP 200, so every response is
// {ok: true, ...} or {ok: false, error: "..."} - callers must check `ok`,
// never the HTTP status.
const Api = (function () {
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
    try {
      const res = await fetch(url.toString(), { method: 'GET' });
      return await res.json();
    } catch (err) {
      return { ok: false, error: 'Network error - please check your connection and try again.' };
    }
  }

  async function post(action, payload) {
    assertConfigured();
    try {
      const res = await fetch(APP_CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload || {}))
      });
      return await res.json();
    } catch (err) {
      return { ok: false, error: 'Network error - please check your connection and try again.' };
    }
  }

  return { get, post };
})();
