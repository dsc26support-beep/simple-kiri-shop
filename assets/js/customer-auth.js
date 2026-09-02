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

  async function logout() {
    const token = getToken();
    clearSession();
    if (token) {
      try {
        await Api.post('logoutCustomer', { token });
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
