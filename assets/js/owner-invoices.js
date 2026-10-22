// Seller: invoice and receipt design (owner/invoices.html; backend Invoices.gs).
// Every choice is checked again on the server; the preview is the server's own
// render of a sample, shown in a sandboxed frame with scripts off.
document.addEventListener('DOMContentLoaded', ivInit);

const iv = { kind: 'invoice', storeColor: '', timer: 0 };
const $iv = (id) => document.getElementById(id);

async function ivInit() {
  const owner = await Auth.guardOwnerAuth();
  if (!owner) return;
  $iv('store-name-label').textContent = shortStoreName(owner.storeName);
  const stop = startLoadingMessage($iv('iv-status'));
  const res = await Api.post('getInvoiceSettings', { token: Auth.getToken() });
  stop();
  if (!res.ok) { showLoadFailedMessage($iv('iv-status')); return; }
  $iv('iv-status').textContent = '';
  iv.storeColor = res.storeColor || '';
  ivFill(res.settings);
  $iv('iv-layout').hidden = false;
  $iv('iv-store-colour').hidden = !iv.storeColor;
  $iv('iv-store-colour').addEventListener('click', () => { $iv('iv-color').value = iv.storeColor; ivChanged(); });
  $iv('iv-form').addEventListener('input', ivChanged);
  $iv('iv-form').addEventListener('change', ivChanged);
  $iv('iv-form').addEventListener('submit', ivSave);
  document.querySelectorAll('.iv-tabs [data-kind]').forEach((b) => b.addEventListener('click', () => {
    iv.kind = b.dataset.kind;
    document.querySelectorAll('.iv-tabs [data-kind]').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    ivPreview();
  }));
  ivPreview();
}

function ivFill(s) {
  $iv('iv-enabled').checked = !!s.enabled;
  const t = document.querySelector(`input[name="iv-template"][value="${s.template}"]`);
  if (t) t.checked = true;
  $iv('iv-color').value = s.color;
  $iv('iv-accent').value = s.accent;
  $iv('iv-bname').value = s.businessName || '';
  $iv('iv-baddr').value = s.businessAddress || '';
  $iv('iv-bphone').value = s.businessPhone || '';
  $iv('iv-due').value = s.dueDays;
  $iv('iv-inote').value = s.invoiceNote || '';
  $iv('iv-rnote').value = s.receiptNote || '';
  $iv('iv-vat').checked = !!s.vatEnabled;
  $iv('iv-vatno').value = s.vatNumber || '';
  $iv('iv-vatrate').value = s.vatRate;
  $iv('iv-vat-fields').hidden = !s.vatEnabled;
}

function ivValues() {
  const t = document.querySelector('input[name="iv-template"]:checked');
  return {
    enabled: $iv('iv-enabled').checked, template: t ? t.value : 'classic',
    color: $iv('iv-color').value, accent: $iv('iv-accent').value,
    businessName: $iv('iv-bname').value.trim(), businessAddress: $iv('iv-baddr').value.trim(), businessPhone: $iv('iv-bphone').value.trim(),
    dueDays: Number($iv('iv-due').value) || 0, invoiceNote: $iv('iv-inote').value.trim(), receiptNote: $iv('iv-rnote').value.trim(),
    vatEnabled: $iv('iv-vat').checked, vatNumber: $iv('iv-vatno').value.trim(), vatRate: Number($iv('iv-vatrate').value) || 0
  };
}

function ivChanged() {
  $iv('iv-vat-fields').hidden = !$iv('iv-vat').checked;
  $iv('iv-error').textContent = '';
  clearTimeout(iv.timer);
  iv.timer = setTimeout(ivPreview, 350);
}

async function ivPreview() {
  const res = await Api.post('previewInvoiceDesign', Object.assign({ token: Auth.getToken(), kind: iv.kind }, ivValues()));
  if (!res.ok) return;
  $iv('iv-frame').srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:8px;background:#fff}</style></head><body>' + res.html + '</body></html>';
}

async function ivSave(e) {
  e.preventDefault();
  const btn = $iv('iv-save');
  const busyDone = setButtonBusy(btn, 'Saving');
  const res = await Api.post('saveInvoiceSettings', Object.assign({ token: Auth.getToken() }, ivValues()));
  busyDone();
  if (!res.ok) { $iv('iv-error').textContent = res.error || 'Not saved. Please try again.'; return; }
  ivFill(res.settings);
  ivPreview();
  $iv('iv-status').textContent = res.settings.enabled
    ? 'Saved. Buyers can now ask for an invoice at checkout, and get a receipt when they pay.'
    : 'Saved. Invoices and receipts are off for your store.';
}
