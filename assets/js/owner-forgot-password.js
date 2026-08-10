document.addEventListener('DOMContentLoaded', init);

function init() {
  document.getElementById('request-form').addEventListener('submit', onRequestCode);
  document.getElementById('reset-form').addEventListener('submit', onResetPassword);
  wirePasswordToggle('reset-new-password');
}

async function onRequestCode(e) {
  e.preventDefault();
  const errorEl = document.getElementById('request-error');
  errorEl.textContent = '';

  const username = document.getElementById('request-username').value.trim();
  const res = await Api.post('requestPasswordReset', { username });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Something went wrong. Please try again.';
    return;
  }

  document.getElementById('reset-token').value = res.token;
  document.getElementById('request-form').classList.add('hidden');
  document.getElementById('reset-form').classList.remove('hidden');
  document.getElementById('reset-code').focus();
}

async function onResetPassword(e) {
  e.preventDefault();
  const errorEl = document.getElementById('reset-error');
  const successEl = document.getElementById('reset-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const token = document.getElementById('reset-token').value;
  const code = document.getElementById('reset-code').value.trim();
  const newPassword = document.getElementById('reset-new-password').value;

  const res = await Api.post('resetPasswordWithCode', { token, code, newPassword });
  if (!res.ok) {
    errorEl.textContent = res.error || 'Could not reset your password.';
    return;
  }

  successEl.textContent = 'Password reset! Redirecting to login…';
  setTimeout(() => {
    window.location.href = 'login.html';
  }, 1500);
}
