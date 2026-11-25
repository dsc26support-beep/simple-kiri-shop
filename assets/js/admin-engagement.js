/**
 * CESN admin controls (Stage 8) on owner/admin.html. Backend CesnAdmin.gs
 * gates everything on isOwnerAdmin, so a non-admin simply gets {ok:false} and
 * the section stays hidden. Lets a Mwakete admin set the platform-wide limits,
 * the price-drop threshold, the master switch and per-category on/off, and see
 * volumes + recent campaign activity. These are anti-abuse settings, never a
 * paid seller feature.
 */
document.addEventListener('DOMContentLoaded', initCesnAdmin);

async function initCesnAdmin() {
  const section = document.getElementById('engagement-admin');
  if (!section || typeof Auth === 'undefined' || !Auth.getToken()) return;
  let res;
  try { res = await Api.post('getCesnAdmin', { token: Auth.getToken() }); } catch (e) { return; }
  if (!res || !res.ok) return;      // not an admin, or an older backend
  section.hidden = false;
  renderCesnAdmin(res);
  document.getElementById('cesn-save').addEventListener('click', saveCesnConfig);
}

function cesnStat(label, val) {
  return `<div class="cesn-stat"><span class="cesn-stat-num">${escapeHtml(String(val))}</span><span class="cesn-stat-label">${escapeHtml(label)}</span></div>`;
}

function renderCesnAdmin(res) {
  const c = res.config || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  document.getElementById('cesn-enabled').checked = !!c.enabled;
  set('cesn-max-day', c.maxPerDay); set('cesn-max-week', c.maxPerWeek);
  set('cesn-min-interval', c.minIntervalMin); set('cesn-drop-pct', c.dropPct); set('cesn-dwell', c.dwellHours);

  document.getElementById('cesn-categories').innerHTML = (res.categories || []).map((cat) =>
    `<label class="cesn-cat"><input type="checkbox" class="cesn-cat-box" data-key="${escapeHtml(cat.key)}"${cat.enabled ? ' checked' : ''}> <span>${escapeHtml(cat.label)}${cat.auto ? ' <em>(auto)</em>' : ''}</span></label>`).join('');

  const v = res.volumes || {};
  document.getElementById('cesn-volumes').innerHTML =
    cesnStat('Sent today', v.queuedToday || 0) + cesnStat('Sent this week', v.queuedWeek || 0) +
    cesnStat('Skipped: limits', v.skippedFreqWeek || 0) + cesnStat('Skipped: duplicate', v.skippedDupWeek || 0) +
    cesnStat('Push devices', res.pushSubscriptions || 0) + cesnStat('Push', res.pushEnabled ? 'on' : 'off');

  const tb = document.querySelector('#cesn-campaigns tbody');
  const rows = (res.recentCampaigns || []).map((c2) =>
    `<tr><td>${escapeHtml(c2.storeSlug || '')}</td><td>${escapeHtml(c2.category || '')}</td><td>${escapeHtml(c2.status || '')}</td><td>${Number(c2.queued) || 0}</td><td>${escapeHtml(c2.createdAt ? new Date(c2.createdAt).toLocaleString() : '')}</td></tr>`);
  tb.innerHTML = rows.join('') || '<tr><td colspan="5" class="helper-text">No campaigns yet.</td></tr>';
}

async function saveCesnConfig() {
  const btn = document.getElementById('cesn-save');
  const msg = document.getElementById('cesn-admin-msg');
  const num = (id) => Number(document.getElementById(id).value);
  const disabled = Array.from(document.querySelectorAll('.cesn-cat-box')).filter((b) => !b.checked).map((b) => b.dataset.key);
  const body = {
    token: Auth.getToken(),
    enabled: document.getElementById('cesn-enabled').checked,
    maxPerDay: num('cesn-max-day'), maxPerWeek: num('cesn-max-week'), minIntervalMin: num('cesn-min-interval'),
    dropPct: num('cesn-drop-pct'), dwellHours: num('cesn-dwell'),
    disabledCategories: disabled
  };
  btn.disabled = true; msg.textContent = 'Saving…';
  let res;
  try { res = await Api.post('setCesnConfig', body); } catch (e) { res = null; }
  btn.disabled = false;
  msg.textContent = (res && res.ok) ? 'Saved. Changes take effect immediately.' : ((res && res.error) || 'Could not save.');
}
