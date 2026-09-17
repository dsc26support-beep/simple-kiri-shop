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
      window.location.href = 'login.html?needStore=1';
      return null;
    }
    const res = await Api.post('getOwnerProfile', { token });
    if (!res.ok) {
      clearSession();
      window.location.href = 'login.html?expired=1';
      return null;
    }
    saveSession(token, res.owner);
    return res.owner;
  }

  return { saveSession, getToken, getOwner, clearSession, logout, guardOwnerAuth };
})();
