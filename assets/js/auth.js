// Store-owner session handling: token in localStorage, attached to every
// protected API call inside the JSON body (never a header - see api.js).
const Auth = (function () {
  const TOKEN_KEY = 'skiri_owner_token';
  const OWNER_KEY = 'skiri_owner_profile';

  function saveSession(token, owner) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(OWNER_KEY, JSON.stringify(owner));
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getOwner() {
    try {
      return JSON.parse(localStorage.getItem(OWNER_KEY));
    } catch (err) {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(OWNER_KEY);
    // The seller's kept dashboard summaries (api.js) leave with the session.
    if (typeof Api !== 'undefined' && Api.forget) Api.forget('seller:');
    // ...and so do unsaved product listings kept on this device
    // (owner-product-steps.js), so the next person on a shared phone never sees them.
    try {
      Object.keys(localStorage).filter((k) => k.indexOf('mwk_pdraft_v1:') === 0).forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* private mode */ }
  }

  async function logout() {
    const token = getToken();
    clearSession();
    if (token) {
      try {
        await Api.post('logoutOwner', { token });
      } catch (err) {
        // best effort - the local session is already cleared
      }
    }
  }

  // Call at the top of every owner page. Redirects to login if there's no
  // valid session, otherwise resolves with the current owner profile.
  // This page, to come back to after logging in (owner-login.js ownerNextPage
  // accepts only a page in the same folder).
  function returnPage() {
    return (location.pathname.split('/').pop() || 'dashboard.html') + location.search.replace(/[?&]from=email\b/, '').replace(/^&/, '?');
  }

  async function guardOwnerAuth() {
    const token = getToken();
    if (!token) {
      // No session has ever existed on this device, so this is most likely
      // somebody who has not opened a store yet - a bookmark, a shared link,
      // the app icon. They used to be dropped on the Log In form with no
      // explanation at all. ?needStore=1 opens Register with a line saying
      // what is needed; Log In is still one tap away for a seller on a new
      // phone, and the wording never claims they have no account.
      //
      // Deliberately NOT the same as ?expired=1 below: that one had a session,
      // so it is a returning seller and belongs on Log In.
      // Opened from one of our emails (?from=email, e.g. "Open Messages"):
      // this is a seller, so Log In - and back to this page afterwards.
      window.location.href = /[?&]from=email\b/.test(location.search)
        ? 'login.html?next=' + encodeURIComponent(returnPage())
        : 'login.html?needStore=1';
      return null;
    }
    const res = await Api.post('getOwnerProfile', { token });
    if (!res.ok) {
      clearSession();
      window.location.href = 'login.html?expired=1&next=' + encodeURIComponent(returnPage());
      return null;
    }
    saveSession(token, res.owner);
    return res.owner;
  }

  /**
   * Until an admin marks them verified, a wholesaler sees at the top of the
   * page that a verification call is coming - the same promise sign-up made
   * when they picked Wholesaler.
   */
  function showWholesalePendingNotice(owner) {
    if (!owner || (owner.storeType !== 'wholesaler' && owner.storeType !== 'distributor') || owner.wholesaleVerified) return;
    const host = document.querySelector('main .container');
    if (!host || host.querySelector('.wholesale-pending-banner')) return;
    const note = document.createElement('p');
    note.className = 'wholesaler-note wholesale-pending-banner';
    note.setAttribute('role', 'status');
    note.textContent = 'Wholesale verification pending - Mwakete.com will contact you to schedule a verification call.';
    host.insertBefore(note, host.firstChild);
  }

  return { saveSession, getToken, getOwner, clearSession, logout, guardOwnerAuth, showWholesalePendingNotice };
})();
