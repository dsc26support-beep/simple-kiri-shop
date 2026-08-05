// Shared logout + unread-messages badge wiring for every owner/*.html page.
document.addEventListener('DOMContentLoaded', () => {
  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await Auth.logout();
      window.location.href = 'login.html';
    });
  }

  // One-shot on page load (not polled) - matches owner-dashboard.js's own
  // metrics, which also load once rather than staying live. messages.html
  // itself has the richer, actually-live polling for the active inbox.
  const badge = document.getElementById('nav-messages-badge');
  const token = Auth.getToken();
  if (badge && token) {
    Api.post('getUnreadCount', { token }).then((res) => {
      if (res.ok && res.unreadCount > 0) {
        badge.textContent = res.unreadCount;
        badge.classList.remove('hidden');
      }
    });
  }
});
