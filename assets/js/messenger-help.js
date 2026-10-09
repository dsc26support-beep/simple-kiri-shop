// messenger-help.html: shows the Messenger link Mwakete would save for what
// is typed, using the same normaliser as the Register Store / Settings forms
// (messengerHandle in helpers.js, mirrored in Utils.gs) - so what this says
// is exactly what the store page will use. Nothing is sent or saved.
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('mh-input');
  const out = document.getElementById('mh-result');
  if (!input || !out) return;
  const show = () => {
    const raw = input.value.trim();
    if (!raw) { out.textContent = ''; out.className = 'mh-result'; return; }
    const handle = messengerHandle(raw);
    if (!handle) {
      out.className = 'mh-result is-bad';
      out.textContent = 'That doesn’t look like a Facebook profile name or link. Try the steps above and paste the link you copy.';
      return;
    }
    const link = 'https://m.me/' + handle;
    out.className = 'mh-result is-good';
    out.innerHTML = `We would save <a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a> &mdash; tap it to check it opens a chat with you.`;
  };
  input.addEventListener('input', show);
  show();
});
