// Small local-storage/cookie consent notice, shown once per device until
// accepted. This site doesn't use tracking cookies - the only device
// storage is functional (cart contents, store-owner login) - but we still
// ask before using it, since that's what visitors expect.
document.addEventListener('DOMContentLoaded', initCookieConsent);

function initCookieConsent() {
  if (localStorage.getItem('skiri_cookie_consent')) return;

  const banner = document.createElement('div');
  banner.className = 'cookie-consent-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Cookie notice');
  banner.innerHTML = `
    <p>This site stores a small amount of data on your device (cookies/local storage) — e.g. to remember your cart and keep store owners logged in. No data is sold or shared with third parties.</p>
    <button type="button" class="btn btn-primary btn-small" id="cookie-consent-accept">Accept</button>
  `;
  document.body.appendChild(banner);

  document.getElementById('cookie-consent-accept').addEventListener('click', () => {
    localStorage.setItem('skiri_cookie_consent', 'true');
    banner.remove();
  });
}
