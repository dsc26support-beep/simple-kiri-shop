/**
 * Driver page (driver.html, backend Deliveries.gs). A driver is a signed-in
 * customer account approved by a Mwakete admin. Everything shown comes from
 * getDriverHome; buyer details arrive only for jobs this driver accepted.
 *
 * Location sharing is opt-in per job, uses the phone's own GPS through the
 * browser (no paid map service), sends at most one point every 30 seconds,
 * and only while this page is open and the switch is on.
 */
const DriverPage = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const rid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  let home = null;
  // The application's ID photo, face check and signature (owner request, Oct 2026).
  const apply = { idBlob: null, idUrl: '', face: null, sigDrawn: false };
  let watchId = null, watchJob = '', lastSent = 0;
  const proofs = {};

  const call = (action, payload) => Api.post(action, Object.assign({ token: CustomerAuth.getToken() }, payload || {}));

  async function init() {
    if (!CustomerAuth.getToken()) { show('drv-signin'); $('drv-status').textContent = ''; return; }
    $('drv-apply-form').addEventListener('submit', onApply);
    wireApplyForm();
    $('drv-online').addEventListener('click', onToggleOnline);
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    await load();
    setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
  }

  function show(id) {
    ['drv-signin', 'drv-closed', 'drv-apply', 'drv-wait', 'drv-app'].forEach((x) => { $(x).hidden = x !== id; });
  }

  async function load() {
    const res = await call('getDriverHome');
    if (!res.ok) {
      if (res.authRequired) { show('drv-signin'); $('drv-status').textContent = ''; return; }
      $('drv-status').textContent = res.error || 'Could not load. Check your connection.';
      return;
    }
    home = res;
    $('drv-status').textContent = '';
    const d = res.driver;
    if (!d) {
      if (!res.enabled) { show('drv-closed'); return; }
      show('drv-apply');
      if (!$('drv-vehicle').options.length) {
        $('drv-vehicle').innerHTML = Object.entries(res.vehicles).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
        $('drv-area').innerHTML = res.areas.map((a) => `<option>${esc(a)}</option>`).join('');
        const p = CustomerAuth.getCustomer() || {};
        $('drv-name').value = p.name || '';
        $('drv-phone').value = p.phone || '';
        $('drv-email').value = p.email || '';
      }
      return;
    }
    if (d.status !== 'approved') {
      show('drv-wait');
      $('drv-wait-text').textContent = d.status === 'pending' ? 'Thank you - your application is waiting for a Mwakete admin. We will contact you on Facebook Messenger about your approval (and by email).'
        : `Your driver status is: ${d.status}.${d.note ? ' Reason: ' + d.note : ''}`;
      return;
    }
    show('drv-app');
    renderOnline(d.available);
    $('drv-k-active').textContent = res.mine.length;
    $('drv-k-done').textContent = res.earnings.delivered;
    $('drv-k-fees').textContent = formatMoney(res.earnings.fees);
    // A wallet driver is paid by Mwakete, not "marked paid" by sellers.
    const paidLabel = $('drv-k-paid').previousElementSibling;
    if (res.wallet) { paidLabel.textContent = 'Paid out by Mwakete'; $('drv-k-paid').textContent = formatMoney(res.wallet.balance.paidOut); }
    else { paidLabel.textContent = 'Marked paid by sellers'; $('drv-k-paid').textContent = formatMoney(res.earnings.feesPaid); }
    renderMine(res.mine);
    renderWallet(res.wallet);
    $('drv-open').innerHTML = !d.available ? '<p class="dash-empty">Go online to see available jobs.</p>'
      : res.open.length ? res.open.map((j) => `<article class="drv-job">
          <strong>${esc(j.storeName)}</strong> → ${esc(j.dropoffArea)}<br>
          <span class="helper-text">${j.items} item(s) · posted ${esc(new Date(j.postedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
          <p class="drv-fee">Fee ${formatMoney(j.fee)} <span class="helper-text">paid by the seller</span></p>
          <button type="button" class="btn btn-primary" data-accept="${esc(j.jobId)}" data-version="${j.version}">Accept job</button></article>`).join('')
      : '<p class="dash-empty">No jobs right now. New jobs appear here (and you get an email).</p>';
    $('drv-hist').innerHTML = res.history.length ? `<table class="dash-table"><thead><tr><th scope="col">Store</th><th scope="col">Result</th><th scope="col">Fee</th></tr></thead><tbody>${res.history.map((j) => `<tr>
      <td data-label="Store">${esc(j.storeName)}<span class="dash-table-sub">${esc(new Date(j.updatedAt).toLocaleDateString())}</span></td>
      <td data-label="Result">${esc(j.statusLabel)}${j.failReason ? `<span class="dash-table-sub">${esc(j.failReason)}</span>` : ''}</td>
      <td data-label="Fee">${formatMoney(j.fee)}${j.payLabel ? `<span class="dash-table-sub">${esc(j.payLabel)}</span>` : j.status === 'delivered' ? `<span class="dash-table-sub">${j.feePaid ? 'Marked paid' : 'Not marked paid yet'}</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<p class="dash-empty">No past jobs yet.</p>';
    if (watchId !== null && !res.mine.some((j) => j.jobId === watchJob)) stopSharing(false);
  }

  function renderOnline(on) {
    $('drv-online').setAttribute('aria-checked', on ? 'true' : 'false');
    $('drv-online').classList.toggle('is-open', on);
    $('drv-online-label').textContent = on ? 'Online' : 'Offline';
    $('drv-online-hint').textContent = on ? 'You can see and accept new jobs.' : 'Go online to see new jobs on your island.';
  }

  /** The driver's Mwakete balance, payout details and claim (driver wallet, phase 4). Hidden unless the backend sends it. */
  function renderWallet(w) {
    const box = $('drv-wallet');
    box.hidden = !w;
    if (!w) return;
    const typed = $('drv-payout-input') ? $('drv-payout-input').value : '';
    const b = w.balance;
    const rows = w.entries.length ? `<ul class="drv-ledger" aria-label="Balance history">${w.entries.map((e) => `<li>
        <span><strong>${esc(e.label)}</strong><br><span class="helper-text">${esc(new Date(e.at).toLocaleDateString())}${e.status ? ' · ' + esc(e.status) : ''}${e.reference ? ' · ref ' + esc(e.reference) : ''}${e.note && e.type === 'ADJUSTMENT' ? ' · ' + esc(e.note) : ''}</span></span>
        <strong class="drv-amt">${e.amount < 0 ? '−' : '+'}${formatMoney(Math.abs(e.amount))}</strong></li>`).join('')}</ul>` : '<p class="dash-empty">Nothing yet. You are credited when the buyer confirms the delivery.</p>';
    $('drv-wallet-body').innerHTML = `
      <div class="kpi-grid" aria-label="Your balance">
        <div class="kpi-card"><span class="kpi-label">Available to claim</span><strong class="kpi-value">${formatMoney(b.available)}</strong></div>
        <div class="kpi-card"><span class="kpi-label">In the ${esc(w.holdHours)}-hour hold</span><strong class="kpi-value">${formatMoney(b.pending)}</strong></div>
        <div class="kpi-card"><span class="kpi-label">Waiting to be paid</span><strong class="kpi-value">${formatMoney(b.claimed)}</strong></div>
        <div class="kpi-card"><span class="kpi-label">Paid to you so far</span><strong class="kpi-value">${formatMoney(b.paidOut)}</strong></div>
      </div>
      <p class="helper-text">Mwakete pays you the fee after the buyer confirms delivery. You can claim once your available balance reaches ${formatMoney(b.minPayout)}. Payouts are made by bank transfer.</p>
      <div class="field"><label for="drv-payout-input">Where to send your money (bank, name on the account, account number)</label>
        <textarea id="drv-payout-input" rows="2" maxlength="300">${esc(typed || w.payoutDetails)}</textarea>
        <button type="button" class="btn btn-small btn-outline" data-wallet="save">Save</button></div>
      <button type="button" class="btn btn-primary" data-wallet="claim" ${w.canClaim ? '' : 'disabled'}>Claim ${formatMoney(b.available)}</button>
      <p class="form-error" id="drv-wallet-error" role="alert"></p>
      ${rows}`;
  }

  async function onWallet(btn) {
    const err = $('drv-wallet-error');
    err.textContent = '';
    const busyDone = setButtonBusy(btn, 'Saving');
    let res;
    if (btn.dataset.wallet === 'save') {
      res = await call('driverSetPayoutDetails', { details: $('drv-payout-input').value.trim() });
    } else {
      if (!confirm('Ask Mwakete to pay you your available balance by bank transfer?')) { busyDone(); return; }
      res = await call('driverClaimPayout', { requestId: btn.dataset.rid || (btn.dataset.rid = rid()) });
    }
    busyDone();
    if (!res.ok) { err.textContent = res.error || 'Not saved - check your connection and try again.'; return; }
    await load();
  }

  /** Chat and fee agreement for one job (driver wallet phase 2); empty when the backend does not send it. */
  function chatHtml(j) {
    const c = j.chat;
    if (!c) return '';
    const f = c.fee, id = esc(j.jobId);
    const state = f.locked ? 'Agreed and locked' : f.agreedByMe && !f.agreedByOther ? 'Waiting for the seller to agree' : f.canAgree ? 'The seller proposed this fee' : 'Not agreed yet';
    const msgs = c.messages.length ? c.messages.map((m) => `<li class="tx-jc-msg tx-jc-${m.by === 'system' ? 'system' : m.mine ? 'mine' : 'theirs'}">
        <span class="helper-text">${m.by === 'system' ? 'Mwakete' : m.mine ? 'You' : 'Seller'}</span><br>${esc(m.body)}</li>`).join('')
      : '<li class="helper-text">No messages yet. Say hello and agree the fee.</li>';
    return `<div class="tx-jobchat" role="group" aria-label="Chat with the seller">
      <p><strong>Delivery fee ${formatMoney(f.amount)}</strong> · <span class="helper-text">${esc(state)}</span></p>
      ${!f.locked && j.status === 'accepted' ? '<p class="helper-text">You can collect the goods once you and the seller have both agreed the fee.</p>' : ''}
      ${f.canAgree ? `<button type="button" class="btn btn-small btn-primary" data-jc="agree" data-job-id="${id}" data-fee="${esc(f.amount)}">Agree to ${formatMoney(f.amount)}</button>` : ''}
      ${f.canPropose ? `<div class="tx-jc-form"><label class="helper-text" for="jcfee-${id}">Propose a different fee ($)</label>
        <input id="jcfee-${id}" type="number" min="0.5" max="500" step="0.5" inputmode="decimal">
        <button type="button" class="btn btn-small btn-outline" data-jc="propose" data-job-id="${id}">Propose</button></div>` : ''}
      <ul class="tx-jc-list">${msgs}</ul>
      ${c.canWrite ? `<div class="tx-jc-form"><label class="helper-text" for="jctext-${id}">Message the seller</label>
        <textarea id="jctext-${id}" rows="2" maxlength="1000" data-chat-input="${id}"></textarea>
        <button type="button" class="btn btn-small btn-primary" data-jc="message" data-job-id="${id}">Send</button></div>` : ''}
      <p class="form-error" id="jcerr-${id}" role="alert"></p>
    </div>`;
  }

  function renderMine(list) {
    // The page refreshes every 30 seconds: keep anything half-typed in a chat box.
    const typed = {};
    document.querySelectorAll('[data-chat-input]').forEach((el) => { if (el.value) typed[el.dataset.chatInput] = el.value; });
    $('drv-mine').innerHTML = list.length ? list.map((j) => `<article class="drv-job is-mine" data-job="${esc(j.jobId)}">
      <p><strong>${esc(j.statusLabel)}</strong> · fee ${formatMoney(j.fee)}</p>
      ${j.detailsLocked ? `<p class="tx-warn" role="status">The pickup place and the buyer’s details appear here once Mwakete confirms the seller’s payment${j.chat && j.chat.payment ? ' (' + esc(j.chat.payment.label.toLowerCase()) + ')' : ''}.</p>
        <dl class="dash-facts"><div><dt>Deliver to</dt><dd>${esc(j.dropoff)}</dd></div></dl>` : `<dl class="dash-facts">
        <div><dt>Collect from</dt><dd>${esc(j.storeName)} - ${esc(j.pickup)}${j.storePhone ? ` · <a href="tel:${esc(j.storePhone)}">${esc(j.storePhone)}</a>` : ''}</dd></div>
        <div><dt>Deliver to</dt><dd>${esc(j.buyerName)}, ${esc(j.dropoff)} · <a href="tel:${esc(j.buyerPhone)}">${esc(j.buyerPhone)}</a> · <a href="${esc(j.mapSearch)}" target="_blank" rel="noopener">Map</a></dd></div>
        <div><dt>Items</dt><dd>${j.items.map(esc).join(', ')}</dd></div>
        ${j.notes ? `<div><dt>Notes</dt><dd>${esc(j.notes)}</dd></div>` : ''}
      </dl>`}
      ${chatHtml(j)}
      <div class="tx-check"><input type="checkbox" id="share-${esc(j.jobId)}" data-share="${esc(j.jobId)}" ${watchJob === j.jobId ? 'checked' : ''}>
        <label for="share-${esc(j.jobId)}">Share my live location with the buyer and seller for this job (while this page is open)</label></div>
      <p class="form-error" id="err-${esc(j.jobId)}" role="alert"></p>
      ${j.status === 'accepted' ? `<button type="button" class="btn btn-primary" data-act="picked_up" data-job-id="${esc(j.jobId)}">I've collected the goods</button>` : ''}
      ${j.status === 'picked_up' ? `<div class="drv-deliver">
          <div class="field"><label for="rcpt-${esc(j.jobId)}">Received by (name)</label><input id="rcpt-${esc(j.jobId)}" maxlength="80"></div>
          <div class="field"><span class="tx-files-label">Photo of the delivered goods (required)</span>
            <label class="btn btn-small tx-attach"><span>Take or choose photo</span><input type="file" accept="image/*" capture="environment" class="sr-only" data-proof="${esc(j.jobId)}"></label>
            <span class="helper-text" id="proof-${esc(j.jobId)}">${proofs[j.jobId] ? 'Photo saved ✓' : ''}</span></div>
          <button type="button" class="btn btn-primary" data-act="delivered" data-job-id="${esc(j.jobId)}">Delivered</button>
        </div>` : ''}
      <details class="drv-fail"><summary>Couldn't deliver?</summary>
        <div class="field"><label for="why-${esc(j.jobId)}">What happened</label><select id="why-${esc(j.jobId)}">${Object.entries(home.failReasons).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label for="note-${esc(j.jobId)}">Note</label><textarea id="note-${esc(j.jobId)}" rows="2" maxlength="300"></textarea></div>
        <button type="button" class="btn btn-outline" data-act="failed" data-job-id="${esc(j.jobId)}">Report failed delivery</button>
      </details>
    </article>`).join('') : '<p class="dash-empty">No active jobs.</p>';
    document.querySelectorAll('[data-chat-input]').forEach((el) => { if (typed[el.dataset.chatInput]) el.value = typed[el.dataset.chatInput]; });
    document.querySelectorAll('.tx-jc-list').forEach((el) => { el.scrollTop = el.scrollHeight; });
  }

  async function onChat(btn) {
    const jobId = btn.dataset.jobId, kind = btn.dataset.jc;
    const err = $('jcerr-' + jobId);
    err.textContent = '';
    let action, payload;
    if (kind === 'agree') { action = 'driverAgreeFee'; payload = { fee: btn.dataset.fee }; }
    else if (kind === 'propose') { action = 'driverProposeFee'; payload = { fee: $('jcfee-' + jobId).value }; }
    else { action = 'driverJobMessage'; payload = { text: $('jctext-' + jobId).value.trim() }; }
    const busyDone = setButtonBusy(btn, 'Sending');
    const res = await call(action, Object.assign({ jobId, requestId: rid() }, payload));
    busyDone();
    if (!res.ok) { err.textContent = res.error || 'Not saved - check your connection and try again.'; if (res.stale) await load(); return; }
    if (kind === 'message') $('jctext-' + jobId).value = '';
    await load();
  }

  /* ---------- Apply: ID, face check, agreement ---------- */

  function wireApplyForm() {
    $('drv-idphoto').addEventListener('change', async () => {
      const f = $('drv-idphoto').files[0];
      apply.face = null;
      $('drv-face-result').textContent = '';
      if (!f) return;
      try {
        const { blob } = await shrink(f);
        apply.idBlob = blob;
        if (apply.idUrl) URL.revokeObjectURL(apply.idUrl);
        apply.idUrl = URL.createObjectURL(blob);
        $('drv-idpreview').src = apply.idUrl;
        $('drv-idpreview').hidden = false;
      } catch (e) { $('drv-apply-error').textContent = 'That photo could not be read. Please take it again.'; }
    });
    $('drv-face-start').addEventListener('click', onFaceCheck);
    document.querySelectorAll('input[name="drv-sign"]').forEach((r) => r.addEventListener('change', () => {
      const digital = signMethod() === 'digital';
      $('drv-sign-digital').hidden = !digital;
      $('drv-sign-physical').hidden = digital;
    }));
    wireSignature();
  }

  const signMethod = () => (document.querySelector('input[name="drv-sign"]:checked') || {}).value || 'digital';

  async function onFaceCheck() {
    const out = $('drv-face-result');
    if (!apply.idBlob) { out.textContent = 'Add the photo of your ID first - the face check compares you with it.'; return; }
    $('drv-face-start').hidden = true;
    try {
      const r = await DriverFace.run({ mount: $('drv-face'), idImageUrl: apply.idUrl });
      apply.face = r;
      out.textContent = r.note;
      out.classList.toggle('is-ok', r.result === 'passed');
      $('drv-selfie-fallback').hidden = r.result !== 'unsupported' || !!r.selfie;
    } catch (e) {
      out.textContent = 'Face check stopped. Tap Start face check to try again.';
    }
    $('drv-face').innerHTML = '';
    $('drv-face-start').hidden = false;
    $('drv-face-start').textContent = apply.face ? 'Do the face check again' : 'Start face check';
  }

  function wireSignature() {
    const c = $('drv-sig');
    const ctx = c.getContext('2d');
    const reset = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); apply.sigDrawn = false; };
    reset();
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    let drawing = false;
    const pt = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
    c.addEventListener('pointerdown', (e) => { drawing = true; c.setPointerCapture(e.pointerId); const [x, y] = pt(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); });
    c.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pt(e); ctx.lineTo(x, y); ctx.stroke(); apply.sigDrawn = true; e.preventDefault(); });
    const end = () => { drawing = false; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    $('drv-sig-clear').addEventListener('click', reset);
  }

  const canvasBlob = (c) => new Promise((r) => c.toBlob((b) => r(b), 'image/png'));

  async function onApply(e) {
    e.preventDefault();
    const err = $('drv-apply-error');
    err.textContent = '';
    const idType = (document.querySelector('input[name="drv-idtype"]:checked') || {}).value || '';
    if (!idType) { err.textContent = 'Choose your ID: KPF ID, National ID or passport.'; return; }
    if (!apply.idBlob) { err.textContent = 'Add a photo of your ID.'; return; }
    let face = apply.face;
    if (!face) { err.textContent = 'Do the face check (step 3) before sending.'; return; }
    let selfie = face.selfie;
    if (!selfie && $('drv-selfie').files[0]) selfie = (await shrink($('drv-selfie').files[0])).blob;
    if (!selfie) { err.textContent = 'Take a photo of your face (step 3).'; return; }

    const method = signMethod();
    const contract = { version: home && home.contractVersion, method };
    if (method === 'digital') {
      if (!$('drv-agree').checked) { err.textContent = 'Tick that you have read and agree to the driver agreement.'; return; }
      if ($('drv-signname').value.trim().length < 3) { err.textContent = 'Type your full name to sign.'; return; }
      if (!apply.sigDrawn) { err.textContent = 'Draw your signature in the box.'; return; }
      contract.agree = true;
      contract.signedName = $('drv-signname').value.trim();
      contract.signatureBase64 = await toB64(await canvasBlob($('drv-sig')));
    } else {
      const pages = [...$('drv-pages').files].slice(0, 3);
      if (!pages.length) { err.textContent = 'Add photos of both signed pages of the agreement.'; return; }
      contract.pagesBase64 = await Promise.all(pages.map(async (f) => toB64(f.type === 'application/pdf' ? f : (await shrink(f)).blob)));
    }

    const btn = e.target.querySelector('button[type="submit"]');
    const busyDone = setButtonBusy(btn, 'Sending');
    const res = await call('driverApply', {
      name: $('drv-name').value.trim(), phone: $('drv-phone').value.trim(), messenger: $('drv-messenger').value.trim(), email: $('drv-email').value.trim(),
      vehicle: $('drv-vehicle').value, area: $('drv-area').value,
      idType, idNumber: $('drv-idnumber').value.trim(), idPhotoBase64: await toB64(apply.idBlob), selfieBase64: await toB64(selfie),
      faceResult: face.result, faceScore: face.score, contract
    });
    busyDone();
    if (!res.ok) { err.textContent = res.error || 'Not sent - try again.'; return; }
    await load();
  }

  async function onToggleOnline() {
    const on = $('drv-online').getAttribute('aria-checked') !== 'true';
    $('drv-online').disabled = true;
    const res = await call('driverSetAvailable', { available: on });
    $('drv-online').disabled = false;
    if (!res.ok) { $('drv-online-hint').textContent = res.error || 'Could not change - try again.'; return; }
    await load();
  }

  async function onClick(e) {
    const acc = e.target.closest('[data-accept]');
    if (acc) {
      acc.disabled = true;
      const res = await call('driverAcceptJob', { jobId: acc.dataset.accept, version: acc.dataset.version, requestId: rid() });
      if (!res.ok) { alert(res.error || 'Could not accept - try again.'); acc.disabled = false; }
      await load();
      return;
    }
    const wallet = e.target.closest('[data-wallet]');
    if (wallet) { await onWallet(wallet); return; }
    const chat = e.target.closest('[data-jc]');
    if (chat) { await onChat(chat); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const jobId = btn.dataset.jobId, act = btn.dataset.act;
    const payload = { jobId, act, requestId: btn.dataset.rid || (btn.dataset.rid = rid()) };
    if (act === 'delivered') { payload.recipientName = $('rcpt-' + jobId).value.trim(); payload.proofId = proofs[jobId] || ''; }
    if (act === 'failed') { payload.reason = $('why-' + jobId).value; payload.note = $('note-' + jobId).value.trim(); }
    if (act === 'picked_up' && !confirm('Confirm you have collected the goods from the store?')) return;
    if (act === 'delivered' && !confirm('Confirm the goods were handed over?')) return;
    const busyDone = setButtonBusy(btn, 'Saving');
    const res = await call('driverUpdateJob', payload);
    busyDone();
    if (!res.ok) { $('err-' + jobId).textContent = res.error || 'Not saved - check your connection and try again.'; return; }
    if (act !== 'picked_up' && watchJob === jobId) stopSharing(false);
    await load();
  }

  async function onChange(e) {
    const share = e.target.closest('[data-share]');
    if (share) { if (share.checked) startSharing(share.dataset.share); else stopSharing(true); return; }
    const proof = e.target.closest('[data-proof]');
    if (proof && proof.files && proof.files[0]) {
      const jobId = proof.dataset.proof;
      const note = $('proof-' + jobId);
      note.innerHTML = loadingMessageHtml('Uploading');
      try {
        const { blob, thumb } = await shrink(proof.files[0]);
        const res = await call('driverUploadProof', { jobId, mimeType: 'image/jpeg', dataBase64: await toB64(blob), thumbBase64: await toB64(thumb), requestId: rid() });
        if (!res.ok) { note.textContent = res.error || 'Upload failed - try again.'; return; }
        proofs[jobId] = res.proofId;
        note.textContent = 'Photo saved ✓';
      } catch (err) { note.textContent = 'That photo could not be read - try again.'; }
    }
  }

  function startSharing(jobId) {
    if (!navigator.geolocation) { alert('This phone does not share location from the browser.'); return; }
    stopSharing(false);
    watchJob = jobId;
    watchId = navigator.geolocation.watchPosition((pos) => {
      if (Date.now() - lastSent < 30000) return;
      lastSent = Date.now();
      call('driverShareLocation', { jobId, share: true, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
    }, () => { const box = document.getElementById('share-' + jobId); if (box) box.checked = false; stopSharing(false); alert('Location is blocked on this phone. Allow it in the browser settings to share.'); },
    { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 });
  }

  function stopSharing(tellServer) {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    if (tellServer && watchJob) call('driverShareLocation', { jobId: watchJob, share: false });
    watchId = null; watchJob = ''; lastSent = 0;
  }

  function toB64(blob) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(blob); });
  }

  /** Photo re-saved as JPEG (max 2048px) plus a 320px thumbnail - small on mobile data, and without hidden location tags. */
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const draw = (max, q) => new Promise((res) => {
          const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
          const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob((b) => res(b), 'image/jpeg', q);
        });
        Promise.all([draw(2048, 0.85), draw(320, 0.7)]).then(([blob, thumb]) => resolve({ blob, thumb }));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => DriverPage.init());
