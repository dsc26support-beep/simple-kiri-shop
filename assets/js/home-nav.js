// Homepage "Create Store" / "Sign In" links (§13/§14). Visibility follows the
// ACTUAL session state (localStorage tokens), so it stays correct across
// refresh, login/logout, and session restore - not a fragile visual flag.
// The two links are independent: a person can own a store AND have a customer
// account, in which case both are hidden.
document.addEventListener('DOMContentLoaded', () => {
  const createLi = document.getElementById('nav-create-store');
  const signinLi = document.getElementById('nav-signin');
  const signinLink = document.getElementById('nav-signin-link');

  const hasStore = typeof Auth !== 'undefined' && !!Auth.getToken();
  const hasCustomer = typeof CustomerAuth !== 'undefined' && !!CustomerAuth.getToken();

  // §13: hide Create Store once they own a store.
  if (createLi && hasStore) createLi.hidden = true;

  if (hasCustomer) {
    // Signed-in customer: the "Sign In" link becomes their Account entry point
    // (Phase 3 dashboard) rather than disappearing.
    if (signinLink) {
      signinLink.textContent = 'Account';
      signinLink.setAttribute('href', 'customer-dashboard.html');
    }
  } else if (signinLink && hasStore) {
    // §14: not a customer but owns a store - Sign In offers a Customer/Seller
    // choice instead of assuming which one they mean.
    signinLink.addEventListener('click', (e) => {
      e.preventDefault();
      showLoginChooser();
    });
  }
});

function showLoginChooser() {
  if (document.getElementById('login-chooser')) return;
  const overlay = document.createElement('div');
  overlay.id = 'login-chooser';
  overlay.className = 'login-chooser-overlay';
  overlay.innerHTML =
    '<div class="login-chooser-card" role="dialog" aria-modal="true" aria-label="Choose how to log in">' +
    '<h2>Log In</h2>' +
    '<a class="btn btn-primary btn-block" href="customer-login.html">Customer Login</a>' +
    '<a class="btn btn-block" href="owner/login.html">Seller Login</a>' +
    '<button type="button" class="btn btn-block login-chooser-cancel">Cancel</button>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('login-chooser-cancel')) overlay.remove();
  });
  document.addEventListener('keydown', function onEsc(ev) {
    if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
  });
}
