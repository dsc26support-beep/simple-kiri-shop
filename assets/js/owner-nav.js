// Shared logout wiring for every owner/*.html page.
document.addEventListener('DOMContentLoaded', () => {
  const logoutLink = document.getElementById('logout-link');
  if (!logoutLink) return;
  logoutLink.addEventListener('click', async (e) => {
    e.preventDefault();
    await Auth.logout();
    window.location.href = 'login.html';
  });
});
