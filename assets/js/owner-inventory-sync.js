// Import & Sync (owner/inventory-sync.html): choose where stock lives, read a
// CSV in the browser, match its columns to Mwakete fields, preview every
// change (server dry run), then apply exactly that preview. Export downloads
// the same columns the importer reads, so files round-trip.
// Rules and safety checks are server-side: apps-script/InventorySync.gs.
document.addEventListener('DOMContentLoaded', init);

const FIELD_OPTIONS = [
  ['', 'Ignore this column'],
  ['mwaketeId', 'Mwakete ID'],
  ['externalId', 'Your system\'s product ID'],
  ['sku', 'SKU / item code'],
  ['barcode', 'Barcode'],
  ['productName', 'Product name'],
  ['variantLabel', 'Variety / size'],
  ['physicalStock', 'Stock on hand'],
  ['price', 'Selling price'],
  ['costPrice', 'Cost price'],
  ['reorderLevel', 'Low-stock level'],
  ['reorderQty', 'Reorder quantity']
];
// First header word-match wins. Covers common till / spreadsheet names.
// Most specific first; each field is used once. Covers common till and
// spreadsheet column names.
const GUESSES = [
  [/^mwakete\s*id$/i, 'mwaketeId'],
  [/reorder\s*(qty|quantity|amount)/i, 'reorderQty'],
  [/(min|minimum|reorder\s*level|low)/i, 'reorderLevel'],
  [/\b(sku|item\s*code|product\s*code|code)\b/i, 'sku'],
  [/barcode|ean|upc/i, 'barcode'],
  [/external|system\s*id|product\s*id/i, 'externalId'],
  [/variety|size|variant|pack/i, 'variantLabel'],
  [/cost/i, 'costPrice'],
  [/(stock|qty|quantity|on\s*hand|balance|count)/i, 'physicalStock'],
  [/(price|selling|retail)/i, 'price'],
  [/(name|description|product|item)/i, 'productName']
];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

let owner = null;
let file = { headers: [], rows: [] };
let connections = [];
let lastRequest = null;
let lastPreview = null;
let applying = false;
let source = 'csv';          // 'csv' | 'googleSheets'
let sheetSettings = null;    // last checked { url, sheetName, headerRow }
let sheetTitle = '';
let editingId = '';          // saved source being changed, if any
let shareEmail = '';
let lastJobs = [];

async function init() {
  owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  document.getElementById('store-name-label').textContent = owner.storeName;
  document.getElementById('sync-file').addEventListener('change', onFile);
  document.getElementById('sync-create-new').addEventListener('change', (e) => {
    document.getElementById('sync-category-field').classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('sync-preview-btn').addEventListener('click', onPreview);
  document.getElementById('sync-cancel-btn').addEventListener('click', () => show('map'));
  document.getElementById('sync-apply-btn').addEventListener('click', onApply);
  document.getElementById('sync-again-btn').addEventListener('click', resetFile);
  document.getElementById('sync-export-btn').addEventListener('click', onExport);
  document.getElementById('sync-sheet-check').addEventListener('click', () => checkSheet(false));
  document.getElementById('sync-sheet-tab').addEventListener('change', () => checkSheet(true));
  document.getElementById('sync-header-row').addEventListener('change', () => checkSheet(true));
  document.getElementById('sync-copy-email').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(shareEmail).then(() => { document.getElementById('sync-copy-email').textContent = 'Copied'; }).catch(() => {});
  });
  document.querySelectorAll('input[name="sync-mode"]').forEach((r) => r.addEventListener('change', onModeChange));
  document.getElementById('sync-connections').addEventListener('click', onCenterClick);
  document.getElementById('sync-conflicts').addEventListener('click', onConflictClick);
  fillCategories();

  const statusEl = document.getElementById('sync-status');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.post('listInventoryConnections', { token: Auth.getToken() });
  stop();
  if (!res.ok) { showLoadFailedMessage(statusEl); return; }
  statusEl.textContent = '';
  connections = res.connections || [];
  shareEmail = res.shareEmail || '';
  document.getElementById('sync-share-email').textContent = shareEmail;
  renderSources(res.connectors || []);
  await loadHistory();
  // Awaited: loadConflicts re-draws the cards, and must finish before a
  // caller writes a result message into one.
  await loadConflicts();
}

function show(step) {
  const sheets = source === 'googleSheets';
  const visible = {
    sheet: sheets && (step === 'map' || step === 'preview'),
    map: step === 'preview' || (step === 'map' && (!sheets || file.headers.length > 0)),
    preview: step === 'preview',
    done: step === 'done'
  };
  Object.keys(visible).forEach((k) => document.getElementById('sync-step-' + k).classList.toggle('hidden', !visible[k]));
  document.getElementById('sync-file-field').classList.toggle('hidden', sheets);
  document.getElementById('sync-mode-field').classList.toggle('hidden', !sheets);
  document.getElementById('sync-map-heading').textContent = sheets ? '3. Match the columns' : '2. Choose your file and match the columns';
  if (step === 'preview') document.getElementById('sync-step-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- step 1: source ---------- */

function renderSources(connectors) {
  const by = Object.fromEntries(connectors.map((c) => [c.type, c]));
  const card = (key, title, text, ready, action) => `
    <button type="button" class="sync-source${ready ? '' : ' is-off'}" data-source="${key}">
      <strong>${title}</strong><span class="helper-text">${text}</span>
      <span class="sync-source-state ${ready ? 'is-ready' : 'is-off'}">${ready ? action : 'Not connected yet'}</span>
    </button>`;
  const el = document.getElementById('sync-sources');
  el.innerHTML =
    card('csv', 'CSV file', 'Excel, Google Sheets, your till or any system can save a CSV.', !!(by.csv && by.csv.configured), 'Use a CSV') +
    card('googleSheets', 'Google Sheets', 'Link your sheet once and keep it in step.', !!(by.googleSheets && by.googleSheets.configured), 'Connect') +
    card('microsoftExcel', 'Excel / OneDrive', by.microsoftExcel && by.microsoftExcel.configured ? 'Link a workbook in OneDrive.' : 'Coming later. For now: in Excel, File > Save As > CSV, and use CSV.', !!(by.microsoftExcel && by.microsoftExcel.configured), 'Connect') +
    card('customApi', 'Other system', 'POS, accounting or ERP: export a CSV from it for now.', !!(by.customApi && by.customApi.configured), 'Connect');
  el.querySelectorAll('.sync-source').forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('is-off')) {
      document.getElementById('sync-status').textContent = b.dataset.source === 'googleSheets'
        ? 'Google Sheets linking isn\'t switched on yet. For now, in your sheet choose File > Download > CSV and use the CSV option.'
        : 'That connection isn\'t available yet. Save or export a CSV and use the CSV option.';
      return;
    }
    document.getElementById('sync-status').textContent = '';
    startSource(b.dataset.source);
  }));
}

function startSource(type, conn) {
  source = type;
  editingId = conn ? conn.connectionId : '';
  file = { headers: [], rows: [] };
  ['sync-mapping', 'sync-options', 'sync-preview-btn'].forEach((id) => document.getElementById(id).classList.add('hidden'));
  document.getElementById('sync-file-info').textContent = '';
  document.getElementById('sync-sheet-error').textContent = '';
  document.getElementById('sync-sheet-info').textContent = '';
  document.getElementById('sync-sheet-pick').classList.add('hidden');
  if (type === 'googleSheets') {
    const st = conn ? conn.settings : {};
    document.getElementById('sync-sheet-url').value = st.spreadsheetId ? 'https://docs.google.com/spreadsheets/d/' + st.spreadsheetId + '/edit' : '';
    document.getElementById('sync-header-row').value = st.headerRow || 1;
    document.getElementById('sync-sheet-tab').innerHTML = st.sheetName ? `<option>${escapeHtml(st.sheetName)}</option>` : '';
    document.getElementById('sync-auto').checked = conn ? !!st.autoSync : true;
    const mode = document.querySelector(`input[name="sync-mode"][value="${conn ? conn.mode : 'import'}"]`);
    if (mode) mode.checked = true;
    document.getElementById('sync-save-name').value = conn ? conn.name : '';
  }
  show('map');
  const target = document.getElementById(type === 'googleSheets' ? 'sync-step-sheet' : 'sync-step-map');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (conn) checkSheet(true);
}

/** Opens the pasted sheet on the server: tabs, columns, a few rows. */
async function checkSheet(keepTab) {
  const errEl = document.getElementById('sync-sheet-error');
  const info = document.getElementById('sync-sheet-info');
  errEl.textContent = '';
  const url = document.getElementById('sync-sheet-url').value.trim();
  if (!url) { errEl.textContent = 'Paste the link to your Google Sheet first.'; return; }
  const settings = { url, sheetName: keepTab ? document.getElementById('sync-sheet-tab').value : '', headerRow: document.getElementById('sync-header-row').value };
  const btn = document.getElementById('sync-sheet-check');
  btn.disabled = true; btn.textContent = 'Opening your sheet…';
  const res = await Api.post('testSheetConnection', { token: Auth.getToken(), settings });
  btn.disabled = false; btn.textContent = 'Check the sheet';
  if (!res.ok) { errEl.textContent = res.error || 'Could not check the sheet. Please try again.'; return; }
  if (!res.connected) { errEl.textContent = res.error; return; }
  sheetTitle = res.title;
  sheetSettings = { url, spreadsheetId: res.spreadsheetId, sheetName: res.sheetName, headerRow: res.headerRow };
  document.getElementById('sync-sheet-tab').innerHTML = res.tabs.map((t) => `<option${t === res.sheetName ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
  document.getElementById('sync-header-row').value = res.headerRow;
  document.getElementById('sync-sheet-pick').classList.remove('hidden');
  if (res.error || !res.headers.length) { errEl.textContent = res.error || 'No column names found in that row.'; return; }
  info.textContent = `Connected to "${res.title}" › ${res.sheetName}: ${res.rowCount} row${res.rowCount === 1 ? '' : 's'}, ${res.headers.length} columns.`;
  file = { headers: res.headers, rows: res.sample };
  if (!document.getElementById('sync-save-name').value) document.getElementById('sync-save-name').value = res.title;
  renderMapping();
  show('map');
}

function onModeChange() {
  const mode = selectedMode();
  // Creating products only makes sense when their sheet is in charge.
  document.getElementById('sync-create-new-row').classList.toggle('hidden', mode === 'export');
}

function selectedMode() {
  const r = document.querySelector('input[name="sync-mode"]:checked');
  return source === 'googleSheets' && r ? r.value : 'import';
}

function fillCategories() {
  const sel = document.getElementById('sync-category');
  const canFood = owner.storeType === 'wholesaler' || owner.storeType === 'distributor';
  sel.innerHTML = '<option value="">Choose…</option>' + CATEGORIES
    .filter((c) => c.active && c.types.includes('product') && (canFood || c.id !== 'food'))
    .sort((a, b) => a.order - b.order)
    .map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
}

/* ---------- step 2: file + mapping ---------- */

/** RFC 4180-ish: quoted fields, "" escapes, CR/LF, BOM; comma, semicolon or tab separated. */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (quoted) throw new Error('A quote mark (") is never closed - the file may be cut off.');
  return rows;
}

function onFile(e) {
  const info = document.getElementById('sync-file-info');
  const errEl = document.getElementById('sync-map-error');
  errEl.textContent = '';
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > MAX_FILE_BYTES) { errEl.textContent = 'That file is over 2MB. Split it into smaller files.'; return; }
  const reader = new FileReader();
  reader.onload = () => {
    let grid;
    try { grid = parseCsv(String(reader.result)); } catch (err) { errEl.textContent = 'We couldn\'t read that file: ' + err.message; return; }
    const headers = (grid[0] || []).map((h) => h.trim());
    if (!headers.length || headers.every((h) => !h)) { errEl.textContent = 'The first line should name the columns (e.g. Item Code, Stock).'; return; }
    file = { headers, rows: grid.slice(1).filter((r) => r.some((c) => String(c).trim() !== '')) };
    info.textContent = `${f.name}: ${file.rows.length} item row${file.rows.length === 1 ? '' : 's'}, ${headers.length} columns.`;
    renderMapping();
  };
  reader.onerror = () => { errEl.textContent = 'That file could not be read. Please choose it again.'; };
  reader.readAsText(f);
}

function guessMapping(headers) {
  // A saved matching for exactly these columns wins.
  const editing = editingId && connections.find((c) => c.connectionId === editingId);
  if (editing) return { mapping: editing.mapping, from: editing };
  const saved = connections.find((c) => c.type === source && Object.keys(c.mapping).every((h) => headers.includes(h)) && Object.keys(c.mapping).length);
  if (saved) return { mapping: saved.mapping, from: saved };
  const used = new Set();
  const mapping = {};
  headers.forEach((h) => {
    const g = GUESSES.find(([re, field]) => re.test(h) && !used.has(field));
    if (g) { mapping[h] = g[1]; used.add(g[1]); }
  });
  return { mapping, from: null };
}

function renderMapping() {
  const { mapping, from } = guessMapping(file.headers);
  const sample = (c) => file.rows.slice(0, 3).map((r) => r[c]).filter((x) => x !== undefined && x !== '').map(String).join(', ');
  const el = document.getElementById('sync-mapping');
  el.innerHTML = (from ? `<p class="inv-saved">Using your saved matching "${escapeHtml(from.name)}". Check it, then preview.</p>` : '') +
    `<div class="sync-map-head"><span>Your column</span><span>Means on Mwakete</span></div>` +
    file.headers.map((h, c) => `
      <div class="sync-map-row">
        <label for="map-${c}"><strong>${escapeHtml(h || '(no name)')}</strong><span class="helper-text">${escapeHtml(sample(c).slice(0, 60))}</span></label>
        <select id="map-${c}" data-header="${escapeAttr(h)}">
          ${FIELD_OPTIONS.map(([v, l]) => `<option value="${v}"${mapping[h] === v ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}
        </select>
      </div>`).join('');
  el.dataset.connectionId = from ? from.connectionId : '';
  if (from) document.getElementById('sync-save-name').value = from.name;
  el.classList.remove('hidden');
  document.getElementById('sync-options').classList.remove('hidden');
  document.getElementById('sync-preview-btn').classList.remove('hidden');
}

function currentMapping() {
  const mapping = {};
  document.querySelectorAll('#sync-mapping select').forEach((s) => { if (s.value) mapping[s.dataset.header] = s.value; });
  return mapping;
}

/* ---------- step 3: preview ---------- */

async function onPreview() {
  const errEl = document.getElementById('sync-map-error');
  errEl.textContent = '';
  const mapping = currentMapping();
  const mode = selectedMode();
  const createNew = mode !== 'export' && document.getElementById('sync-create-new').checked;
  const category = createNew ? document.getElementById('sync-category').value : '';
  const btn = document.getElementById('sync-preview-btn');
  let req;
  if (source === 'googleSheets') {
    // A linked sheet is saved first (only its address, tab and matching -
    // no passwords), then previewed straight from the sheet.
    if (!sheetSettings) { errEl.textContent = 'Check the sheet first.'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    const saved = await Api.post('saveInventoryConnection', { token: Auth.getToken(), connectionId: editingId, type: 'googleSheets',
      name: document.getElementById('sync-save-name').value.trim() || sheetTitle, mapping, mode,
      settings: Object.assign({}, sheetSettings, { autoSync: document.getElementById('sync-auto').checked }) });
    if (!saved.ok) { btn.disabled = false; btn.textContent = 'Preview changes'; errEl.textContent = saved.error || 'Could not save the link.'; return; }
    editingId = saved.connection.connectionId;
    connections = connections.filter((c) => c.connectionId !== editingId).concat(saved.connection);
    req = { token: Auth.getToken(), connectionId: editingId, createNew, category };
  } else {
    req = { token: Auth.getToken(), type: 'csv', headers: file.headers, rows: file.rows, mapping, createNew, category };
  }
  btn.disabled = true; btn.textContent = 'Checking…';
  const res = await Api.post('previewInventoryImport', req);
  btn.disabled = false; btn.textContent = 'Preview changes';
  if (!res.ok) { errEl.textContent = res.error || 'Preview failed. Please try again.'; return; }
  lastRequest = req;
  lastPreview = res.preview;
  renderPreview(res.preview);
  show('preview');
}

const FIELD_NAMES = { StockQty: 'stock', Price: 'price', CostPrice: 'cost', ReorderLevel: 'low-stock level', ReorderQty: 'reorder qty', SKU: 'SKU', Barcode: 'barcode', ExternalId: 'product ID' };

function renderPreview(p) {
  const c = p.counts;
  const stat = (n, label, cls) => `<div class="inv-tile${cls ? ' inv-tile--' + cls : ''}"><span class="inv-tile-value">${n}</span><span class="inv-tile-label">${label}</span></div>`;
  const list = (title, items, fmt) => items.length ? `<details class="sync-details"${title.open ? ' open' : ''}><summary>${title.text} (${items.length}${items.length >= 50 ? '+' : ''})</summary><ul>${items.map(fmt).join('')}</ul></details>` : '';
  const fmtVal = (v) => (v === null || v === undefined || v === '' ? 'blank' : v);
  document.getElementById('sync-preview').innerHTML = `
    <div class="inv-summary">
      ${stat(c.read, 'rows read')}
      ${stat(c.existing, 'matched items')}
      ${stat(c.stockChanges, 'stock changes')}
      ${stat(c.priceChanges, 'price changes')}
      ${p.mode !== 'import' ? stat(c.writes, 'written to your sheet') : stat(c.newProducts, 'new products')}
      ${p.mode === 'twoWay' ? stat(c.syncConflicts, 'need your decision', c.syncConflicts ? 'out' : '') : ''}
      ${stat(c.unmatched, 'not matched', c.unmatched ? 'low' : '')}
      ${stat(c.conflicts, 'conflicts', c.conflicts ? 'out' : '')}
      ${stat(c.errors, 'errors', c.errors ? 'out' : '')}
    </div>
    ${c.existing + c.newProducts === 0 && !p.updates.length ? '<p class="form-error">Nothing in this file matches your Mwakete items. Check that the identifying column (SKU, Mwakete ID...) is matched correctly.</p>' : ''}
    ${list({ text: 'Changes', open: true }, p.updates, (u) => `<li><strong>${escapeHtml(u.name)}</strong>: ${Object.keys(u.set).map((k) => `${FIELD_NAMES[k] || k} ${escapeHtml(fmtVal(u.before[k]))} → ${escapeHtml(u.set[k])}`).join(', ')}</li>`)}
    ${list({ text: 'Written to your sheet', open: true }, p.writes || [], (w) => `<li><strong>${escapeHtml(w.name)}</strong>: row ${w.line} ${escapeHtml(fmtVal(w.before))} → ${w.value}</li>`)}
    ${list({ text: 'Changed in both places - you decide after applying', open: true }, p.syncConflicts || [], (x) => `<li><strong>${escapeHtml(x.name)}</strong> - ${escapeHtml(x.message)}</li>`)}
    ${list({ text: 'New products to add' }, p.newProducts, (n) => `<li>${escapeHtml(n.name)} (${n.varieties} variet${n.varieties === 1 ? 'y' : 'ies'})</li>`)}
    ${list({ text: 'Conflicts - left as they are', open: true }, p.conflicts, (x) => `<li>Line ${x.line}: <strong>${escapeHtml(x.name)}</strong> - ${escapeHtml(x.message)}</li>`)}
    ${list({ text: 'Not matched - skipped' }, p.unmatched, (u) => `<li>Line ${u.line}: ${escapeHtml(u.name || u.key || '(no name)')} - ${escapeHtml(u.reason)}</li>`)}
    ${list({ text: 'Errors - skipped', open: true }, p.errors, (e) => `<li>${e.line ? 'Line ' + e.line + ': ' : ''}${escapeHtml(e.message)}</li>`)}
    ${c.unchanged ? `<p class="helper-text">${c.unchanged} matched item${c.unchanged === 1 ? ' is' : 's are'} already the same - no change.</p>` : ''}`;
  // A first two-way sync with only conflicts still needs applying: that's
  // what records them for you to decide, and switches the link on.
  const nothing = !p.updates.length && !p.newProducts.length && !(p.writes || []).length && !(p.syncConflicts || []).length && source !== 'googleSheets';
  const applyBtn = document.getElementById('sync-apply-btn');
  applyBtn.disabled = nothing;
  applyBtn.textContent = nothing ? 'Nothing to apply' : 'Apply changes';
  document.getElementById('sync-apply-error').textContent = '';
}

async function onApply() {
  if (applying || !lastRequest || !lastPreview) return;
  const errEl = document.getElementById('sync-apply-error');
  errEl.textContent = '';
  const btn = document.getElementById('sync-apply-btn');
  applying = true; btn.disabled = true; btn.textContent = 'Applying…';

  // Remember the matching first (if named), so the sync is recorded against it.
  let connectionId = source === 'googleSheets' ? editingId : (document.getElementById('sync-mapping').dataset.connectionId || '');
  const name = document.getElementById('sync-save-name').value.trim();
  if (name && source === 'csv') {
    const saved = await Api.post('saveInventoryConnection', { token: Auth.getToken(), connectionId, type: 'csv', name, mapping: lastRequest.mapping, mode: 'import' });
    if (saved.ok) {
      connectionId = saved.connection.connectionId;
      // Keep the page's list current, so the next file this visit gets it too.
      connections = connections.filter((c) => c.connectionId !== connectionId).concat(saved.connection);
    }
  }
  const res = await Api.post('applyInventoryImport', Object.assign({}, lastRequest, { planToken: lastPreview.planToken, connectionId }));
  applying = false; btn.disabled = false; btn.textContent = 'Apply changes';
  if (!res.ok) {
    // The server re-checks the plan; a network failure can't confirm either way,
    // and a second press is refused unless the plan still matches exactly.
    errEl.textContent = /^Network error/.test(res.error || '')
      ? 'We couldn\'t reach Mwakete to confirm. Check your Sync history below before trying again - if it shows this import, it worked.'
      : (res.error || 'The import did not go through. Nothing was changed.');
    loadHistory();
    return;
  }
  document.getElementById('sync-done-text').textContent = syncResultText(res) +
    (source === 'googleSheets' && document.getElementById('sync-auto').checked ? ' Your sheet will now stay in step every hour.' : '');
  show('done');
  await refreshAll();
}

function syncResultText(res) {
  const parts = [`Updated ${res.updated} item${res.updated === 1 ? '' : 's'} on Mwakete`];
  if (res.created) parts.push(`added ${res.created} new product${res.created === 1 ? '' : 's'}`);
  if (res.written) parts.push(`wrote ${res.written} to your sheet`);
  let text = parts.join(', ') + '.';
  if (res.writeError) text += ' ' + res.writeError;
  if (res.status === 'CONFLICT') text += ' Some items changed in both places - choose which number is right above.';
  else if (res.status === 'PARTIAL_SUCCESS') text += ' Some rows were skipped - see the history below.';
  return text;
}

async function refreshAll() {
  const res = await Api.post('listInventoryConnections', { token: Auth.getToken() });
  if (res.ok) connections = res.connections || [];
  await loadHistory();
  // Awaited: loadConflicts re-draws the cards, and must finish before a
  // caller writes a result message into one.
  await loadConflicts();
}

function resetFile() {
  source = 'csv';
  editingId = '';
  file = { headers: [], rows: [] };
  document.getElementById('sync-file').value = '';
  document.getElementById('sync-file-info').textContent = '';
  ['sync-mapping', 'sync-options', 'sync-preview-btn'].forEach((id) => document.getElementById(id).classList.add('hidden'));
  show('map');
}

/* ---------- export + history ---------- */

function csvCell(v) {
  const s = String(v == null ? '' : v);
  // Leading = + - @ would run as a formula when opened in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) && isNaN(Number(s)) ? "'" + s : s;
  return /[",\n\r;]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

async function onExport() {
  const errEl = document.getElementById('sync-export-error');
  errEl.textContent = '';
  const btn = document.getElementById('sync-export-btn');
  btn.disabled = true;
  const res = await Api.post('exportInventoryRows', { token: Auth.getToken() });
  btn.disabled = false;
  if (!res.ok) { errEl.textContent = res.error || 'Could not prepare the file. Please try again.'; return; }
  const text = '﻿' + [res.headers].concat(res.rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `mwakete-stock-${(owner.storeSlug || 'store')}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const JOB_STATUS = { SUCCESS: ['Done', 'is-healthy'], PARTIAL_SUCCESS: ['Done, some rows skipped', 'is-low'], FAILED: ['Failed', 'is-out'], CONFLICT: ['Needs a decision', 'is-out'], RUNNING: ['Running', 'is-untracked'], PENDING: ['Waiting', 'is-untracked'] };

async function loadHistory() {
  const el = document.getElementById('sync-history');
  const res = await Api.post('listSyncJobs', { token: Auth.getToken(), limit: 20 });
  if (!res.ok) { el.innerHTML = '<p class="helper-text">Could not load the history.</p>'; return; }
  const jobs = res.jobs || [];
  lastJobs = jobs;
  el.innerHTML = jobs.length ? jobs.map((j) => {
    const st = JOB_STATUS[j.status] || [j.status, 'is-untracked'];
    const when = j.completedAt ? new Date(j.completedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const skipped = (j.summary.errors || []).concat(j.summary.conflicts || []);
    return `<div class="inv-move">
      <div><span class="inv-health ${st[1]}">${escapeHtml(st[0])}</span> <strong>${escapeHtml(jobLabel(j))}</strong> <span class="helper-text">${escapeHtml(when)}</span></div>
      <div class="helper-text">${j.read} read · ${j.updated} updated · ${j.created} new · ${j.skipped} unchanged/unmatched · ${j.failed} errors · ${j.conflicts} conflicts</div>
      ${skipped.length ? `<details class="sync-details"><summary>What was skipped</summary><ul>${skipped.map((x) => `<li>${x.line ? 'Line ' + x.line + ': ' : ''}${escapeHtml(x.message)}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }).join('') : '<p class="helper-text">No imports yet.</p>';
}

const SOURCE_NAMES = { csv: 'CSV import', googleSheets: 'Google Sheets', microsoftExcel: 'Excel / OneDrive', customApi: 'Other system' };
const MODE_TEXT = { import: 'Your sheet → Mwakete', export: 'Mwakete → your sheet', twoWay: 'Both ways' };

function jobLabel(j) {
  const conn = connections.find((c) => c.connectionId === j.connectionId);
  return (conn && conn.type !== 'csv' ? conn.name : SOURCE_NAMES[j.connectorType] || j.connectorType) +
    (j.direction && j.direction !== 'import' ? ' (' + (MODE_TEXT[j.direction] || j.direction) + ')' : '');
}

function fmtWhen(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
}

/* ---------- Sync Center ---------- */

function renderCenter() {
  const linked = connections.filter((c) => c.type !== 'csv');
  const center = document.getElementById('sync-center');
  center.classList.toggle('hidden', linked.length === 0 && document.getElementById('sync-conflicts').classList.contains('hidden'));
  document.getElementById('sync-connections').innerHTML = linked.map((c) => {
    const job = lastJobs.find((j) => j.connectionId === c.connectionId);
    const state = !c.lastSyncAt ? ['Set up - preview to finish', 'is-untracked']
      : c.lastSyncStatus === 'FAILED' ? ['Problem', 'is-out']
      : c.lastSyncStatus === 'CONFLICT' ? ['Needs a decision', 'is-low']
      : ['Connected', 'is-healthy'];
    return `
      <div class="sync-conn" data-id="${escapeAttr(c.connectionId)}">
        <div><span class="inv-health ${state[1]}">${state[0]}</span> <strong>${escapeHtml(c.name)}</strong>
          <span class="helper-text">${escapeHtml(SOURCE_NAMES[c.type] || c.type)} · ${escapeHtml(MODE_TEXT[c.mode] || c.mode)}</span></div>
        <div class="helper-text">
          ${c.lastSyncAt ? 'Last sync ' + escapeHtml(fmtWhen(c.lastSyncAt)) : 'Not synced yet'}${c.nextSyncAt ? ' · next about ' + escapeHtml(fmtWhen(c.nextSyncAt)) : (c.settings && c.settings.autoSync ? '' : ' · automatic sync off')}
          ${job ? `<br>${job.read} read · ${job.updated} updated · ${job.failed} errors · ${job.conflicts} conflicts` : ''}
        </div>
        ${c.lastError ? `<p class="form-error">${escapeHtml(c.lastError)}</p>` : ''}
        <p class="sync-conn-result helper-text" role="status"></p>
        <div class="inv-row-actions">
          <button type="button" class="btn btn-small btn-primary" data-act="sync"${c.lastSyncAt ? '' : ' disabled'}>Sync now</button>
          <button type="button" class="btn btn-small" data-act="settings">${c.lastSyncAt ? 'Settings' : 'Finish set-up'}</button>
          <button type="button" class="btn btn-small" data-act="disconnect">Disconnect</button>
        </div>
      </div>`;
  }).join('');
}

async function onCenterClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('.sync-conn');
  const conn = connections.find((c) => c.connectionId === card.dataset.id);
  if (!conn) return;
  const out = card.querySelector('.sync-conn-result');
  if (btn.dataset.act === 'settings') { startSource(conn.type, conn); return; }
  if (btn.dataset.act === 'disconnect') {
    if (!window.confirm(`Disconnect "${conn.name}"? Your stock on Mwakete and your sheet stay as they are.`)) return;
    const res = await Api.post('deleteInventoryConnection', { token: Auth.getToken(), connectionId: conn.connectionId });
    if (!res.ok) { out.textContent = res.error || 'Could not disconnect. Please try again.'; return; }
    await refreshAll();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  out.textContent = '';
  const res = await Api.post('syncNow', { token: Auth.getToken(), connectionId: conn.connectionId });
  btn.disabled = false;
  btn.textContent = 'Sync now';
  if (!res.ok) {
    out.textContent = /^Network error/.test(res.error || '')
      ? 'We couldn\'t reach Mwakete to confirm. Check the history below before syncing again.'
      : res.error;
    await refreshAll();
    return;
  }
  await refreshAll();
  const fresh = document.querySelector(`.sync-conn[data-id="${CSS.escape(conn.connectionId)}"] .sync-conn-result`);
  if (fresh) fresh.textContent = syncResultText(res);
}

/* ---------- conflicts ---------- */

async function loadConflicts() {
  const el = document.getElementById('sync-conflicts');
  const res = await Api.post('listSyncConflicts', { token: Auth.getToken() });
  const list = res.ok ? (res.conflicts || []) : [];
  el.classList.toggle('hidden', list.length === 0);
  el.innerHTML = list.length ? `<h3>${list.length} item${list.length === 1 ? ' needs' : 's need'} your decision</h3>
    <p class="helper-text">These changed in both places, so nothing was overwritten. Which number is right?</p>` +
    list.map((x) => `
      <div class="sync-conflict" data-id="${escapeAttr(x.conflictId)}">
        <strong>${escapeHtml(x.name)}</strong>
        <div class="inv-row-actions">
          <button type="button" class="btn btn-small btn-primary" data-choice="external">Your sheet: ${x.external}</button>
          <button type="button" class="btn btn-small btn-primary" data-choice="mwakete">Mwakete: ${x.mwakete}</button>
          <button type="button" class="btn btn-small" data-choice="keep">Leave both for now</button>
        </div>
        ${x.reservedNow > x.external ? `<p class="inv-hint">${x.reservedNow} are held by open orders, so your sheet's ${x.external} can't be used until those are fulfilled or cancelled.</p>` : ''}
        <p class="sync-conflict-result helper-text" role="status"></p>
      </div>`).join('') : '';
  renderCenter();
}

async function onConflictClick(e) {
  const btn = e.target.closest('[data-choice]');
  if (!btn) return;
  const row = btn.closest('.sync-conflict');
  const out = row.querySelector('.sync-conflict-result');
  row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  out.textContent = 'Saving…';
  const res = await Api.post('resolveSyncConflict', { token: Auth.getToken(), conflictId: row.dataset.id, choice: btn.dataset.choice });
  if (!res.ok) {
    row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    out.textContent = res.error || 'Could not save your choice. Please try again.';
    return;
  }
  // The set-up "Done" note may still say a decision is needed - it isn't now.
  document.getElementById('sync-step-done').classList.add('hidden');
  document.getElementById('sync-status').textContent = btn.dataset.choice === 'keep'
    ? 'Left as it is. We won\'t ask again unless the numbers change.'
    : 'Done - both sides now match. ' + (res.status ? syncResultText(res) : '');
  await refreshAll();
}
