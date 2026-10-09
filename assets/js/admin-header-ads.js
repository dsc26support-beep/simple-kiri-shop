// Admin: header adverts - the homepage strip (backend HeaderAds.gs). Every
// change is checked again on the server (admin email, text length, safe link).
const HeaderAdsAdmin = (() => {
  const $ = (id) => document.getElementById(id);
  let ads = [];

  function stateOf(a, today) {
    if (a.status !== 'active') return 'Off';
    if (a.startDate && today < a.startDate) return 'Starts ' + a.startDate;
    if (a.endDate && today > a.endDate) return 'Ended ' + a.endDate;
    return 'Showing now';
  }

  async function load() {
    $('ha-status').textContent = 'Loading…';
    const res = await Api.post('adminListHeaderAds', { token: Auth.getToken() });
    if (!res.ok) { $('ha-status').textContent = res.error || 'Could not load the adverts.'; return; }
    ads = res.ads || [];
    const showing = ads.filter((a) => a.running).length;
    $('ha-status').textContent = showing ? `${showing} advert(s) showing now.` : 'No advert is showing - the three built-in lines are shown.';
    $('ha-list').innerHTML = ads.map((a, i) => `<li class="ha-item${a.running ? '' : ' is-idle'}" data-id="${escapeHtml(a.adId)}">
      <div class="ha-item-text"><strong>${escapeHtml(a.text)}</strong>
        <span class="helper-text">${escapeHtml(a.link)} · ${escapeHtml(stateOf(a, res.today))}${a.startDate || a.endDate ? ' · ' + escapeHtml((a.startDate || '…') + ' to ' + (a.endDate || '…')) : ''}</span></div>
      <div class="ha-item-actions">
        <button type="button" class="btn btn-small" data-act="up" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn btn-small" data-act="down" aria-label="Move down"${i === ads.length - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="btn btn-small" data-act="edit">Edit</button>
        <button type="button" class="btn btn-small" data-act="toggle">${a.status === 'active' ? 'Switch off' : 'Switch on'}</button>
        <button type="button" class="btn btn-small btn-danger" data-act="delete">Delete</button>
      </div></li>`).join('');
  }

  function fillForm(a) {
    $('ha-id').value = a ? a.adId : '';
    $('ha-text').value = a ? a.text : '';
    $('ha-link').value = a ? a.link : '';
    $('ha-start').value = a ? a.startDate : '';
    $('ha-end').value = a ? a.endDate : '';
    $('ha-on').checked = a ? a.status === 'active' : true;
    $('ha-store').value = '';
    $('ha-form-title').textContent = a ? 'Edit advert' : 'Add an advert';
    $('ha-cancel').hidden = !a;
    $('ha-error').textContent = '';
    preview();
  }

  function preview() {
    const t = $('ha-text').value.trim();
    $('ha-count').textContent = String($('ha-text').value.length);
    $('ha-preview-text').textContent = t ? t + ' ›' : 'Local Kiribati sellers';
  }

  async function save(e) {
    e.preventDefault();
    const body = { token: Auth.getToken(), adId: $('ha-id').value || undefined, text: $('ha-text').value.trim(), link: $('ha-link').value.trim(),
      startDate: $('ha-start').value, endDate: $('ha-end').value, status: $('ha-on').checked ? 'active' : 'off' };
    if (!body.text) { $('ha-error').textContent = 'Write the advert text.'; $('ha-text').focus(); return; }
    if (!body.link) { $('ha-error').textContent = 'Add the link it opens (or pick a store).'; $('ha-link').focus(); return; }
    $('ha-save').disabled = true;
    const res = await Api.post('adminSaveHeaderAd', body);
    $('ha-save').disabled = false;
    if (!res.ok) { $('ha-error').textContent = res.error || 'Could not save.'; return; }
    fillForm(null);
    await load();
    $('ha-status').textContent = 'Saved. ' + $('ha-status').textContent + ' The homepage updates within 5 minutes.';
  }

  async function onListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.ha-item').dataset.id;
    const a = ads.find((x) => x.adId === id);
    const act = btn.dataset.act;
    let res;
    if (act === 'edit') { fillForm(a); $('ha-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (act === 'up' || act === 'down') {
      const order = ads.map((x) => x.adId);
      const i = order.indexOf(id), j = act === 'up' ? i - 1 : i + 1;
      [order[i], order[j]] = [order[j], order[i]];
      res = await Api.post('adminReorderHeaderAds', { token: Auth.getToken(), order });
    } else if (act === 'toggle') {
      res = await Api.post('adminSaveHeaderAd', { token: Auth.getToken(), adId: a.adId, text: a.text, link: a.link, startDate: a.startDate, endDate: a.endDate,
        status: a.status === 'active' ? 'off' : 'active' });
    } else if (act === 'delete') {
      if (!confirm(`Delete the advert "${a.text}"?`)) return;
      res = await Api.post('adminDeleteHeaderAd', { token: Auth.getToken(), adId: id });
    }
    if (res && !res.ok) { $('ha-status').textContent = res.error || 'That did not work.'; return; }
    await load();
  }

  function init() {
    if (!$('header-ads')) return;
    $('ha-form').addEventListener('submit', save);
    $('ha-cancel').addEventListener('click', () => fillForm(null));
    $('ha-text').addEventListener('input', preview);
    $('ha-list').addEventListener('click', onListClick);
    $('ha-store').addEventListener('change', () => {
      const slug = $('ha-store').value;
      if (slug) $('ha-link').value = 'store.html?store=' + encodeURIComponent(slug);
    });
    // The store list the admin page already loads (admin.js loadStores).
    const copy = () => { const src = $('store-select'); if (src && src.options.length > 1) $('ha-store').innerHTML = src.innerHTML; };
    copy();
    setTimeout(copy, 1500);
    load();
  }

  return { init };
})();
