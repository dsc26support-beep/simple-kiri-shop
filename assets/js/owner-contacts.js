// Seller: contacts (owner/contacts.html; backend Contacts.gs). Every action is
// checked again on the server, which only ever answers with this store's own
// contacts. Numbers are checked with the same rules as the server
// (sms-core.min.js, built from apps-script/SmsCore.gs).
document.addEventListener('DOMContentLoaded', ctInit);

const ct = { page: 0, limit: 50, total: 0, contacts: [], selected: new Set(), groups: [], categories: [], groupId: '', editing: null, importRows: null, importSource: 'csv', timer: 0 };
const $ct = (id) => document.getElementById(id);
const CT_CONSENT_LABEL = { yes: 'Yes', no: 'No', unknown: 'Not asked' };
const CT_PHONE_LABEL = { ok: 'Mobile', check: 'Check', invalid: 'Wrong', missing: 'No number' };
const CT_ACTION_LABEL = { new: 'Added', update: 'Fills blanks', duplicate: 'Already have', repeat: 'Same number twice', invalid: 'Left out' };

const ctCall = (action, body) => Api.post(action, Object.assign({ token: Auth.getToken() }, body || {}));

async function ctInit() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  $ct('store-name-label').textContent = shortStoreName(owner.storeName);
  const stop = startLoadingMessage($ct('ct-status'));
  const [cats, groups] = await Promise.all([ctCall('contactCategories'), ctCall('contactGroups')]);
  stop();
  if (!cats.ok) { if (cats.error) $ct('ct-status').textContent = cats.error; else showLoadFailedMessage($ct('ct-status')); return; }
  $ct('ct-status').textContent = '';
  ct.categories = cats.categories;
  ct.groups = groups.ok ? groups.groups : [];
  ctFillSelects();
  ctWire();
  $ct('ct-app').hidden = false;
  ctRenderGroups();
  ctLoadStats();
  ctLoad();
}

function ctOptions(sel, list, keepFirst) {
  const first = keepFirst ? sel.options[0].outerHTML : '';
  sel.innerHTML = first + list.map((o) => `<option value="${escapeAttr(o[0])}">${escapeHtml(o[1])}</option>`).join('');
}

function ctFillSelects() {
  const cats = ct.categories.map((c) => [c.id, c.label]);
  ctOptions($ct('ct-f-category'), cats, true);
  ctOptions($ct('ce-category'), cats, true);
  ctOptions($ct('ci-category'), cats, true);
  const islands = Object.keys(typeof KIRIBATI_ISLANDS !== 'undefined' ? KIRIBATI_ISLANDS : {}).map((i) => [i, i]);
  ctOptions($ct('ct-f-island'), islands, true);
  ctOptions($ct('ce-island'), islands, true);
  ctFillGroupSelects();
}

function ctFillGroupSelects() {
  const gs = ct.groups.map((g) => [g.groupId, g.name]);
  ctOptions($ct('ct-bulk-group'), gs.length ? gs : [['', 'Make a group first']], false);
  ctOptions($ct('ci-group'), [['', 'No group']].concat(gs), false);
}

function ctWire() {
  document.querySelectorAll('.sx-dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $ct('ct-add').addEventListener('click', () => ctOpenEdit(null));
  $ct('ct-import-open').addEventListener('click', ctOpenImport);
  $ct('ct-export').addEventListener('click', ctExport);
  $ct('ct-dupes-open').addEventListener('click', ctOpenDupes);
  $ct('ct-filters').addEventListener('submit', (e) => e.preventDefault());
  $ct('ct-filters').addEventListener('input', () => { clearTimeout(ct.timer); ct.timer = setTimeout(() => { ct.page = 0; ctLoad(); }, 300); });
  $ct('ct-filters').addEventListener('change', () => { ct.page = 0; ctLoad(); });
  $ct('ct-all').addEventListener('change', (e) => { ct.contacts.forEach((c) => (e.target.checked ? ct.selected.add(c.contactId) : ct.selected.delete(c.contactId))); ctRenderRows(); });
  $ct('ct-bulk-add').addEventListener('click', ctBulkAdd);
  $ct('ct-bulk-remove').addEventListener('click', ctBulkRemove);
  $ct('ct-bulk-delete').addEventListener('click', ctBulkDelete);
  $ct('ct-edit-form').addEventListener('submit', ctSave);
  $ct('ce-delete').addEventListener('click', ctDeleteOne);
  $ct('ce-phone').addEventListener('input', ctPhoneNote);
  $ct('ce-island').addEventListener('change', ctVillages);
  document.querySelectorAll('#ct-edit [data-kind]').forEach((s) => s.addEventListener('change', ctSourceShow));
  $ct('ce-history-btn').addEventListener('click', ctHistory);
  $ct('ci-file').addEventListener('change', ctImportFile);
  $ct('ci-paste-go').addEventListener('click', () => ctImportRows(ctParseCsv($ct('ci-paste').value), 'csv'));
  $ct('ci-orders').addEventListener('click', ctImportOrders);
  ['transactional', 'promotional', 'service'].forEach((k) => $ct('ci-c-' + k).addEventListener('change', () => {
    $ct('ci-source-wrap').hidden = !['transactional', 'promotional', 'service'].some((x) => $ct('ci-c-' + x).checked);
  }));
  $ct('ci-dupes').addEventListener('change', () => ct.importRows && ctImportRows(ct.importRows, ct.importSource));
  $ct('ci-apply').addEventListener('click', ctImportApply);
  $ct('ct-group-form').addEventListener('submit', ctGroupSave);
  $ct('cg-delete').addEventListener('click', ctGroupDelete);
}

/* ---------- stats, groups ---------- */

async function ctLoadStats() {
  const res = await ctCall('smsDashboard');
  if (!res.ok) return;
  const c = res.contacts;
  $ct('ct-stats').innerHTML = [
    [c.total, 'contacts'], [c.promotionalYes, 'said yes to promotions'], [c.invalidNumbers, 'numbers to check'], [ct.groups.length, 'groups']
  ].map((s) => `<div class="sx-stat"><strong>${Number(s[0]) || 0}</strong><span>${s[1]}</span></div>`).join('');
}

function ctRenderGroups() {
  const chip = (id, name, n) => `<span class="sx-group-chip${ct.groupId === id ? ' is-on' : ''}">
    <button type="button" data-group="${escapeAttr(id)}" aria-pressed="${ct.groupId === id}">${escapeHtml(name)}${n === null ? '' : ' (' + n + ')'}</button>
    ${id ? `<button type="button" data-group-edit="${escapeAttr(id)}" aria-label="Rename or delete ${escapeAttr(name)}">✎</button>` : ''}</span>`;
  $ct('ct-groups').innerHTML = chip('', 'Everyone', null) + ct.groups.map((g) => chip(g.groupId, g.name, g.members)).join('') +
    '<button type="button" class="btn btn-small btn-light-purple" id="ct-group-new">+ New group</button>';
  $ct('ct-groups').querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => { ct.groupId = b.dataset.group; ct.page = 0; ctRenderGroups(); ctLoad(); }));
  $ct('ct-groups').querySelectorAll('[data-group-edit]').forEach((b) => b.addEventListener('click', () => ctOpenGroup(ct.groups.find((g) => g.groupId === b.dataset.groupEdit))));
  $ct('ct-group-new').addEventListener('click', () => ctOpenGroup(null));
  $ct('ct-bulk-remove').hidden = !ct.groupId;
}

async function ctReloadGroups() {
  const res = await ctCall('contactGroups');
  if (res.ok) ct.groups = res.groups;
  ctFillGroupSelects();
  ctRenderGroups();
  ctLoadStats();
}

function ctOpenGroup(g) {
  ct.editingGroup = g;
  $ct('ct-group-title').textContent = g ? 'Group' : 'New group';
  $ct('cg-name').value = g ? g.name : '';
  $ct('cg-error').textContent = '';
  $ct('cg-delete').hidden = !g;
  $ct('ct-group').showModal();
}

async function ctGroupSave(e) {
  e.preventDefault();
  const name = $ct('cg-name').value.trim();
  if (!name) { $ct('cg-error').textContent = 'Give the group a name.'; return; }
  const res = await ctCall('contactGroupSave', { groupId: ct.editingGroup ? ct.editingGroup.groupId : undefined, name });
  if (!res.ok) { $ct('cg-error').textContent = res.error || 'Could not save.'; return; }
  $ct('ct-group').close();
  ctReloadGroups();
}

async function ctGroupDelete() {
  const g = ct.editingGroup;
  if (!g || !confirm(`Delete the group "${g.name}"? The contacts in it stay.`)) return;
  const res = await ctCall('contactGroupDelete', { groupId: g.groupId });
  if (!res.ok) { $ct('cg-error').textContent = res.error || 'Could not delete.'; return; }
  $ct('ct-group').close();
  if (ct.groupId === g.groupId) { ct.groupId = ''; ctLoad(); }
  ctReloadGroups();
}

/* ---------- list ---------- */

async function ctLoad() {
  const body = {
    q: $ct('ct-q').value.trim(), category: $ct('ct-f-category').value, island: $ct('ct-f-island').value,
    consent: $ct('ct-f-consent').value, phoneStatus: $ct('ct-f-phone').value, groupId: ct.groupId, offset: ct.page * ct.limit, limit: ct.limit
  };
  const tbody = $ct('ct-table').tBodies[0];
  const res = await ctCall('contactsList', body);
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6" class="sx-empty">${escapeHtml(res.error || 'Could not load contacts.')}</td></tr>`; return; }
  ct.contacts = res.contacts;
  ct.total = res.total;
  ctRenderRows();
  ctRenderPager();
}

function ctName(c) { return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.businessName || c.phone || c.phoneRaw || 'Contact'; }
function ctCatLabel(id) { const c = ct.categories.find((x) => x.id === id); return c ? c.label : ''; }

function ctRenderRows() {
  const tbody = $ct('ct-table').tBodies[0];
  if (!ct.contacts.length) {
    const filtered = ct.total === 0 && ($ct('ct-q').value || ct.groupId || $ct('ct-f-category').value || $ct('ct-f-island').value || $ct('ct-f-consent').value || $ct('ct-f-phone').value);
    tbody.innerHTML = `<tr><td colspan="6" class="sx-empty">${filtered ? 'Nobody matches.' : 'No contacts yet. Add one, or import a CSV.'}</td></tr>`;
  } else {
    tbody.innerHTML = ct.contacts.map((c) => `<tr>
      <td class="sx-check"><input type="checkbox" data-sel="${escapeAttr(c.contactId)}" ${ct.selected.has(c.contactId) ? 'checked' : ''} aria-label="Select ${escapeAttr(ctName(c))}"></td>
      <td><button type="button" class="sx-link sx-name" data-edit="${escapeAttr(c.contactId)}">${escapeHtml(ctName(c))}</button>${c.businessName && (c.firstName || c.lastName) ? `<span class="sx-sub">${escapeHtml(c.businessName)}</span>` : ''}</td>
      <td>${escapeHtml(c.phone || c.phoneRaw || '-')} ${c.phoneStatus && c.phoneStatus !== 'ok' ? `<span class="sx-pill is-${escapeAttr(c.phoneStatus)}">${CT_PHONE_LABEL[c.phoneStatus] || c.phoneStatus}</span>` : ''}</td>
      <td class="sx-hide-sm">${escapeHtml(ctCatLabel(c.category))}</td>
      <td class="sx-hide-sm">${escapeHtml([c.village, c.island].filter(Boolean).join(', '))}</td>
      <td><span class="sx-pill is-${escapeAttr(c.consent.promotional)}">${CT_CONSENT_LABEL[c.consent.promotional] || ''}</span></td></tr>`).join('');
    tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => ctOpenEdit(b.dataset.edit)));
    tbody.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('change', () => { b.checked ? ct.selected.add(b.dataset.sel) : ct.selected.delete(b.dataset.sel); ctRenderBulk(); }));
  }
  $ct('ct-all').checked = ct.contacts.length > 0 && ct.contacts.every((c) => ct.selected.has(c.contactId));
  ctRenderBulk();
}

function ctRenderBulk() {
  $ct('ct-bulk').hidden = ct.selected.size === 0;
  $ct('ct-bulk-count').textContent = ct.selected.size + ' selected';
}

function ctRenderPager() {
  const pages = Math.ceil(ct.total / ct.limit);
  const from = ct.total ? ct.page * ct.limit + 1 : 0;
  const to = Math.min(ct.total, (ct.page + 1) * ct.limit);
  $ct('ct-pager').innerHTML = `<span>${from}–${to} of ${ct.total}</span>
    <button type="button" class="btn btn-small btn-light-purple" data-p="-1" ${ct.page === 0 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-small btn-light-purple" data-p="1" ${ct.page >= pages - 1 ? 'disabled' : ''}>Next</button>`;
  $ct('ct-pager').querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { ct.page += Number(b.dataset.p); ctLoad(); }));
}

async function ctBulkAdd() {
  const groupId = $ct('ct-bulk-group').value;
  if (!groupId) { ctOpenGroup(null); return; }
  const res = await ctCall('contactGroupMembers', { groupId, add: Array.from(ct.selected) });
  if (!res.ok) { alert(res.error || 'Could not add.'); return; }
  ct.selected.clear();
  ctReloadGroups();
  ctRenderRows();
}

async function ctBulkRemove() {
  if (!ct.groupId) return;
  const res = await ctCall('contactGroupMembers', { groupId: ct.groupId, remove: Array.from(ct.selected) });
  if (!res.ok) { alert(res.error || 'Could not remove.'); return; }
  ct.selected.clear();
  ctReloadGroups();
  ctLoad();
}

async function ctBulkDelete() {
  const n = ct.selected.size;
  if (!n || !confirm(`Delete ${n} contact${n === 1 ? '' : 's'}? They will no longer get any SMS from you.`)) return;
  const res = await ctCall('contactDelete', { contactIds: Array.from(ct.selected) });
  if (!res.ok) { alert(res.error || 'Could not delete.'); return; }
  ct.selected.clear();
  ctLoad();
  ctLoadStats();
  ctReloadGroups();
}

/* ---------- add / edit ---------- */

function ctPhoneNote() {
  const v = $ct('ce-phone').value;
  const note = $ct('ce-phone-note');
  if (!v.trim() || typeof smsNormalisePhone !== 'function') { note.textContent = ''; return; }
  const r = smsNormalisePhone(v);
  note.textContent = r.status === 'ok' ? '✓ ' + r.e164 : (r.note || (r.status === 'check' ? 'This may be a landline - it cannot get SMS.' : 'This number does not look right.'));
}

function ctVillages() {
  const list = (typeof KIRIBATI_ISLANDS !== 'undefined' && KIRIBATI_ISLANDS[$ct('ce-island').value]) || [];
  $ct('ce-villages').innerHTML = list.map((v) => `<option value="${escapeAttr(v)}">`).join('');
}

function ctSourceShow() {
  const kinds = ['transactional', 'promotional', 'service'];
  const before = ct.editing ? ct.editing.consent : {};
  $ct('ce-source-wrap').hidden = !kinds.some((k) => $ct('ce-c-' + k).value === 'yes' && before[k] !== 'yes');
}

async function ctOpenEdit(contactId) {
  ct.editing = null;
  $ct('ct-edit-form').reset();
  $ct('ce-error').textContent = '';
  $ct('ce-history').hidden = true;
  if (contactId) {
    const res = await ctCall('contactGet', { contactId });
    if (!res.ok) { alert(res.error || 'Could not open.'); return; }
    ct.editing = res.contact;
  }
  const c = ct.editing || { consent: {} };
  $ct('ct-edit-title').textContent = ct.editing ? ctName(c) : 'New contact';
  $ct('ce-first').value = c.firstName || '';
  $ct('ce-last').value = c.lastName || '';
  $ct('ce-business').value = c.businessName || '';
  $ct('ce-phone').value = c.phone || c.phoneRaw || '';
  $ct('ce-alt').value = c.altPhone || '';
  $ct('ce-email').value = c.email || '';
  $ct('ce-category').value = c.category || '';
  $ct('ce-island').value = c.island || '';
  ctVillages();
  $ct('ce-village').value = c.village || '';
  $ct('ce-tags').value = (c.tags || []).join(', ');
  $ct('ce-notes').value = c.notes || '';
  ['transactional', 'promotional', 'service'].forEach((k) => { $ct('ce-c-' + k).value = c.consent[k] || 'unknown'; });
  $ct('ce-source').value = '';
  ctSourceShow();
  ctPhoneNote();
  $ct('ce-delete').hidden = !ct.editing;
  $ct('ce-history-btn').hidden = !ct.editing;
  $ct('ct-edit').showModal();
}

async function ctSave(e) {
  e.preventDefault();
  const btn = $ct('ce-save');
  const err = $ct('ce-error');
  err.textContent = '';
  const body = {
    contactId: ct.editing ? ct.editing.contactId : undefined,
    firstName: $ct('ce-first').value.trim(), lastName: $ct('ce-last').value.trim(), businessName: $ct('ce-business').value.trim(),
    phone: $ct('ce-phone').value.trim(), altPhone: $ct('ce-alt').value.trim(), email: $ct('ce-email').value.trim(),
    category: $ct('ce-category').value, island: $ct('ce-island').value, village: $ct('ce-village').value.trim(),
    tags: $ct('ce-tags').value, notes: $ct('ce-notes').value.trim()
  };
  const source = $ct('ce-source').value.trim();
  const before = ct.editing ? ct.editing.consent : { transactional: 'unknown', promotional: 'unknown', service: 'unknown' };
  const changes = ['transactional', 'promotional', 'service'].filter((k) => $ct('ce-c-' + k).value !== before[k]);
  if (changes.some((k) => $ct('ce-c-' + k).value === 'yes') && source.length < 3) {
    err.textContent = 'Say how this person agreed to messages.';
    $ct('ce-source').focus();
    return;
  }
  const done = setButtonBusy(btn, 'Saving');
  const res = await ctCall('contactSave', body);
  if (!res.ok) { done(); err.textContent = res.error || 'Could not save.'; return; }
  for (const k of changes) {
    const r = await ctCall('contactSetConsent', { contactId: res.contact.contactId, kind: k, value: $ct('ce-c-' + k).value, source });
    if (!r.ok) { done(); ct.editing = res.contact; err.textContent = r.error || 'Saved, but the consent could not be changed.'; return; }
  }
  done();
  $ct('ct-edit').close();
  ctLoad();
  ctLoadStats();
}

async function ctDeleteOne() {
  if (!ct.editing || !confirm(`Delete ${ctName(ct.editing)}?`)) return;
  const res = await ctCall('contactDelete', { contactId: ct.editing.contactId });
  if (!res.ok) { $ct('ce-error').textContent = res.error || 'Could not delete.'; return; }
  $ct('ct-edit').close();
  ctLoad();
  ctLoadStats();
}

async function ctHistory() {
  const list = $ct('ce-history');
  const res = await ctCall('contactConsentHistory', { contactId: ct.editing.contactId });
  const kinds = { transactional: 'Order updates', promotional: 'Promotions', service: 'Service' };
  list.innerHTML = res.ok && res.history.length
    ? res.history.map((h) => `<li>${escapeHtml(kinds[h.kind] || h.kind)}: ${escapeHtml(CT_CONSENT_LABEL[h.from] || h.from || '-')} → <strong>${escapeHtml(CT_CONSENT_LABEL[h.to] || h.to)}</strong> (${escapeHtml(h.source || '')}) <time>${escapeHtml(String(h.at).slice(0, 10))}</time></li>`).join('')
    : '<li>No changes yet.</li>';
  list.hidden = false;
}

/* ---------- import ---------- */

/** RFC 4180-ish: quotes, doubled quotes, commas and newlines inside quotes, CRLF, BOM. Header row -> objects. */
function ctParseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const data = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (data.length < 2) return [];
  const head = data[0].map((h) => h.trim());
  return data.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { if (h) o[h] = (r[i] || '').trim(); }); return o; });
}

function ctOpenImport() {
  ct.importRows = null;
  $ct('ci-preview').hidden = true;
  $ct('ci-status').textContent = '';
  $ct('ci-error').textContent = '';
  $ct('ci-file').value = '';
  $ct('ct-import').showModal();
}

function ctImportFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 3 * 1024 * 1024) { $ct('ci-status').textContent = 'That file is too big (3 MB at most). Split it into smaller files.'; return; }
  const reader = new FileReader();
  reader.onload = () => ctImportRows(ctParseCsv(reader.result), 'csv');
  reader.readAsText(f);
}

async function ctImportOrders() {
  const stop = startLoadingMessage($ct('ci-status'));
  const res = await ctCall('contactsFromOrders');
  stop();
  if (!res.ok) { $ct('ci-status').textContent = res.error || 'Could not load your orders.'; return; }
  if (!res.rows.length) { $ct('ci-status').textContent = 'No customer numbers found in your orders yet.'; return; }
  ctImportRows(res.rows, 'mwakete_orders');
}

async function ctImportRows(rows, source) {
  $ct('ci-error').textContent = '';
  if (!rows.length) { $ct('ci-status').textContent = 'Nothing to import - is there a header row and at least one contact?'; $ct('ci-preview').hidden = true; return; }
  ct.importRows = rows;
  ct.importSource = source;
  const stop = startLoadingMessage($ct('ci-status'));
  const res = await ctCall('contactsImportPreview', { rows, onDuplicate: $ct('ci-dupes').value });
  stop();
  if (!res.ok) { $ct('ci-status').textContent = res.error || 'Could not read that file.'; $ct('ci-preview').hidden = true; return; }
  $ct('ci-status').textContent = rows.length + ' rows read.';
  const n = res.counts;
  $ct('ci-counts').innerHTML = [['new', 'new'], ['update', 'fill blanks'], ['duplicate', 'already have'], ['repeat', 'repeated'], ['invalid', 'left out']]
    .filter((k) => n[k[0]]).map((k) => `<div class="sx-stat"><strong>${n[k[0]]}</strong><span>${k[1]}</span></div>`).join('');
  $ct('ci-rows').innerHTML = res.rows.map((r) => `<tr><td>${r.line}</td><td>${escapeHtml(r.name || '')}</td><td>${escapeHtml(r.phone || '')}</td>
    <td>${escapeHtml(CT_ACTION_LABEL[r.action] || r.action)}${r.note ? `<span class="sx-sub">${escapeHtml(r.note)}</span>` : ''}</td></tr>`).join('');
  $ct('ci-apply').disabled = !(n.new || n.update);
  $ct('ci-preview').hidden = false;
}

async function ctImportApply() {
  const err = $ct('ci-error');
  err.textContent = '';
  const consent = {};
  ['transactional', 'promotional', 'service'].forEach((k) => { if ($ct('ci-c-' + k).checked) consent[k] = 'yes'; });
  const consentSource = $ct('ci-source').value.trim();
  if (Object.keys(consent).length && consentSource.length < 3) { err.textContent = 'Say how these people agreed to messages.'; $ct('ci-source').focus(); return; }
  const done = setButtonBusy($ct('ci-apply'), 'Importing');
  const res = await ctCall('contactsImportApply', {
    rows: ct.importRows, source: ct.importSource, onDuplicate: $ct('ci-dupes').value, groupId: $ct('ci-group').value || undefined,
    category: $ct('ci-category').value || undefined, consent, consentSource
  });
  done();
  if (!res.ok) { err.textContent = res.error || 'Could not import.'; return; }
  $ct('ct-import').close();
  $ct('ct-status').textContent = `Imported: ${res.added} added, ${res.updated} updated, ${res.skipped} skipped, ${res.invalid} left out.` +
    (res.full ? ' Your contact list is full - some were not added.' : '');
  ctLoad();
  ctLoadStats();
  ctReloadGroups();
}

/* ---------- duplicates, export ---------- */

async function ctOpenDupes() {
  $ct('cd-list').innerHTML = '';
  $ct('ct-dupes').showModal();
  const stop = startLoadingMessage($ct('cd-status'));
  const res = await ctCall('contactsDuplicates');
  stop();
  if (!res.ok) { $ct('cd-status').textContent = res.error || 'Could not check.'; return; }
  $ct('cd-status').textContent = res.groups.length ? '' : 'No duplicates found.';
  $ct('cd-list').innerHTML = res.groups.map((g, i) => `<div class="sx-device">
    <div class="sx-device-head"><h3>${escapeHtml(g.reason)}</h3><button type="button" class="btn btn-small btn-primary" data-merge="${i}">Merge into the first</button></div>
    <ul>${g.contacts.map((c) => `<li>${escapeHtml(ctName(c))} · ${escapeHtml(c.phone || c.phoneRaw || '-')} · ${escapeHtml(c.email || '')}</li>`).join('')}</ul></div>`).join('');
  $ct('cd-list').querySelectorAll('[data-merge]').forEach((b) => b.addEventListener('click', async () => {
    const g = res.groups[Number(b.dataset.merge)];
    const done = setButtonBusy(b, 'Merging');
    const r = await ctCall('contactsMerge', { keepId: g.contacts[0].contactId, mergeIds: g.contacts.slice(1).map((c) => c.contactId) });
    done();
    if (!r.ok) { alert(r.error || 'Could not merge.'); return; }
    b.closest('.sx-device').remove();
    ctLoad();
    ctLoadStats();
  }));
}

async function ctExport() {
  const btn = $ct('ct-export');
  const done = setButtonBusy(btn, 'Exporting');
  const res = await ctCall('contactsExport', { category: $ct('ct-f-category').value, island: $ct('ct-f-island').value, groupId: ct.groupId, q: $ct('ct-q').value.trim() });
  done();
  if (!res.ok) { alert(res.error || 'Could not export.'); return; }
  const blob = new Blob(['﻿' + res.csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mwakete-contacts-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
