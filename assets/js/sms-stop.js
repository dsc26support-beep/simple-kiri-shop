// Public "stop SMS from this store" page (sms-stop.html?store=slug; backend
// actionSmsOptOut in Contacts.gs). Nothing happens on load - only when the
// person presses the button - and the answer never says whether the number
// was on the store's list.
document.addEventListener('DOMContentLoaded', () => {
  const slug = getQueryParam('store') || '';
  const form = document.getElementById('stop-form');
  const err = document.getElementById('stop-error');
  if (!slug) { form.hidden = true; err.textContent = 'This link is missing the store. Reply STOP to the store’s SMS instead.'; return; }
  Api.get('getStorePublicInfo', { storeSlug: slug }).then((r) => {
    if (r && r.ok && r.store && r.store.storeName) document.getElementById('stop-store').textContent = r.store.storeName;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const phone = document.getElementById('stop-phone').value.trim();
    if (phone.replace(/\D/g, '').length < 7) { err.textContent = 'Please type your mobile number.'; return; }
    const done = setButtonBusy(document.getElementById('stop-btn'), 'Sending');
    const res = await Api.post('smsOptOut', { storeSlug: slug, phone });
    done();
    if (!res.ok) { err.textContent = res.error || 'Something went wrong. Please try again.'; return; }
    form.hidden = true;
    const ok = document.getElementById('stop-done');
    ok.textContent = res.message || 'Done.';
    ok.hidden = false;
  });
});
