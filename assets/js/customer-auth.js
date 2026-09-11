// Customer session handling - mirrors the owner Auth module (auth.js), but for
// passwordless customer accounts. The server issues a token after an email-code
// verify; we keep it + the public profile in localStorage and attach the token
// inside the JSON body of protected customer calls (never a header - see api.js).
// Entirely separate keys from the owner session, so a person can be signed in
// as a customer AND a store owner at the same time.
const CustomerAuth = (function () {
  const TOKEN_KEY = 'skiri_customer_token';
  const PROFILE_KEY = 'skiri_customer_profile';

  function saveSession(token, customer) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(PROFILE_KEY, JSON.stringify(customer));
    } catch (e) {
      // storage unavailable (private mode) - session just won't persist
    }
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }

  function getCustomer() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY));
    } catch (e) {
      return null;
    }
  }

  function isLoggedIn() {
    return !!getToken();
  }

  function clearSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PROFILE_KEY);
    } catch (e) {
      // ignore
    }
  }

  // How long the redirect will wait for the backend before going anyway.
  // The comment below explains why this exists at all.
  const LOGOUT_NETWORK_GRACE_MS = 1500;

  async function logout() {
    const token = getToken();
    clearSession();
    if (token) {
      try {
        // The local session is ALREADY cleared above, so the person is signed
        // out on this device whatever the backend does next. Telling the server
        // is worth doing, but it must never hold the page hostage: on a cold
        // Apps Script start over a weak link this round trip can take many
        // seconds, and awaiting it plainly is what made "Log out" look dead -
        // nothing moved and nothing spoke for as long as the network took.
        // Measured at an 8s backend: the page had not moved after 3s.
        // So the redirect races a short grace period and wins if the network
        // is slow. The request is still in flight when we navigate; the
        // browser may cancel it, which is acceptable - sessions expire on
        // their own, and the token is gone from the device either way.
        await Promise.race([
          Api.post('logoutCustomer', { token }).catch(function () {}),
          new Promise(function (resolve) { setTimeout(resolve, LOGOUT_NETWORK_GRACE_MS); })
        ]);
      } catch (e) {
        // best effort - the local session is already cleared
      }
    }
  }

  // For Phase-3 customer-only pages: confirm the session server-side, otherwise
  // redirect to sign in. Resolves with the current customer profile.
  async function guardCustomerAuth(redirectTo) {
    const dest = redirectTo || 'customer-login.html';
    const token = getToken();
    if (!token) {
      window.location.href = dest;
      return null;
    }
    const res = await Api.post('getCustomerProfile', { token });
    if (!res.ok) {
      clearSession();
      window.location.href = dest + '?expired=1';
      return null;
    }
    saveSession(token, res.customer);
    return res.customer;
  }

  return { saveSession, getToken, getCustomer, isLoggedIn, clearSession, logout, guardCustomerAuth };
})();
