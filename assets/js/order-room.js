/**
 * Order room page (order-room.html?order=REF&as=buyer|seller|admin).
 *
 * The page only draws what the server decides: which steps are open
 * (room.actions), what each step needs (room.policy), and the timeline. Every
 * click goes back to Transactions.gs, which checks the session, the order and
 * the rules again - nothing here is trusted to decide.
 *
 * Low bandwidth: photos are shrunk and re-saved on the phone before upload
 * (which also drops location data hidden in camera photos), a small
 * thumbnail is sent with each, previews load thumbnails only, and the page
 * polls every 20 seconds while visible with a request that answers
 * "unchanged" in a few bytes. Nothing private is written to localStorage;
 * an unsent message draft lives in sessionStorage (this tab only) and files
 * are only ever held in memory.
 */
const OrderRoom = (function () {
  const POLL_MS = 20000;
  const MAX_SIDE = 2560;
  const THUMB_SIDE = 320;
  const RECEIPT_CHOICES = [
    ['ok', 'I received everything and there is no problem'],
    ['problem', 'I received it, but there is a problem'],
    ['partial', 'I received only part of the order'],
    ['not_received', 'I have not received it'],
    ['unable', 'I cannot confirm yet']
  ];
  const METHODS = [['bank_transfer', 'Bank transfer'], ['mobile_money', 'Mobile money'], ['cash', 'Cash in person'], ['other', 'Other']];
  const FILE_CATEGORIES = [['other', 'Other'], ['payment', 'Payment receipt'], ['goods', 'Goods condition'], ['defect', 'Defect'],
    ['packaging', 'Packaging'], ['dispatch', 'Dispatch'], ['handover', 'Handover'], ['delivery', 'After delivery'], ['dispute', 'Problem report']];

  let orderId = '';
  let side = 'buyer';
  let room = null;
  let events = [];
  let hasMoreBefore = false;
  let pollTimer = null;
  let openAction = '';
  const thumbCache = new Map();

  /* ---------- small helpers ---------- */

  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const rid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  function token() {
    if (side === 'buyer') return typeof CustomerAuth !== 'undefined' ? CustomerAuth.getToken() : null;
    return typeof Auth !== 'undefined' ? Auth.getToken() : null;
  }
  function call(action, payload) {
    return Api.post(action, Object.assign({ side, token: token(), orderId }, payload || {}));
  }
  function when(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function draftKey() { return 'skiri_tx_draft_' + side + '_' + orderId; }
  function readDraft() { try { return sessionStorage.getItem(draftKey()) || ''; } catch (e) { return ''; } }
  function writeDraft(v) { try { if (v) sessionStorage.setItem(draftKey(), v); else sessionStorage.removeItem(draftKey()); } catch (e) { /* private mode */ } }

  /* ---------- start ---------- */

  async function init() {
    orderId = (getQueryParam('order') || '').trim();
    const as = getQueryParam('as');
    side = as === 'seller' || as === 'admin' ? as : 'buyer';
    const back = $('tx-back-link');
    if (side === 'seller') { back.href = 'owner/orders.html'; back.textContent = 'Orders'; }
    if (side === 'admin') { back.href = 'owner/admin.html#tx-disputes'; back.textContent = 'Admin'; }
    if (!orderId) { setStatus('No order was chosen.'); return; }
    if (!token()) { showSignIn(); return; }
    $('tx-composer').addEventListener('submit', onSend);
    $('tx-message').value = readDraft();
    $('tx-message').addEventListener('input', (e) => writeDraft(e.target.value));
    $('tx-composer-files').addEventListener('change', (e) => { addFiles(composerQueue, e.target.files, $('tx-composer-uploads'), 'other'); e.target.value = ''; });
    $('tx-older').addEventListener('click', loadOlder);
    $('tx-timeline').addEventListener('click', onTimelineClick);
    // A saved file is already on the timeline server-side - show it now.
    document.addEventListener('tx-uploads-changed', () => poll());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
    await load();
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
  }

  function setStatus(text) { $('tx-status').textContent = text || ''; }

  function showSignIn(message) {
    $('tx-body').hidden = true;
    $('tx-signin').hidden = false;
    setStatus('');
    const here = 'order-room.html?order=' + encodeURIComponent(orderId) + '&as=' + side;
    const link = $('tx-signin-link');
    if (side === 'buyer') {
      $('tx-signin-text').textContent = message || 'Sign in with the email address you used for this order to see it.';
      link.href = 'customer-login.html?next=' + encodeURIComponent(here);
    } else {
      $('tx-signin-text').textContent = message || 'Please log in to your store account to see this order.';
      link.href = 'owner/login.html';
      link.textContent = 'Log in';
    }
  }

  async function load() {
    const res = await call('getTxRoom', { limit: 40 });
    if (!res.ok) {
      if (res.authRequired) { showSignIn(res.error); return; }
      setStatus(res.error || 'This order could not be loaded.');
      return;
    }
    room = res.room;
    events = res.events;
    hasMoreBefore = res.hasMoreBefore;
    setStatus('');
    $('tx-signin').hidden = true;
    $('tx-body').hidden = false;
    renderAll();
  }

  async function poll() {
    if (!room) return;
    const res = await call('getTxRoom', { sinceSeq: room.lastSeq, version: room.version });
    if (!res.ok) { if (res.authRequired) showSignIn(res.error); return; }
    if (res.unchanged) return;
    if (res.room.version !== room.version) {
      // The state moved (payment, sending, a problem...) - redraw everything,
      // but keep a form the person is filling in.
      room = res.room;
      mergeEvents(res.events);
      renderAll({ keepPanel: true });
      return;
    }
    room = res.room;
    mergeEvents(res.events);
    renderTimeline({ stickToBottom: true });
  }

  function mergeEvents(list) {
    const seen = new Set(events.map((e) => e.id));
    list.forEach((e) => { if (!seen.has(e.id)) events.push(e); });
    events.sort((a, b) => a.seq - b.seq);
  }

  async function loadOlder() {
    if (!events.length) return;
    const btn = $('tx-older');
    btn.disabled = true;
    const res = await call('getTxRoom', { beforeSeq: events[0].seq, limit: 40 });
    btn.disabled = false;
    if (!res.ok) return;
    events = res.events.concat(events);
    hasMoreBefore = res.hasMoreBefore;
    renderTimeline({ keepScroll: true });
  }

  /* ---------- drawing ---------- */

  function renderAll(opts) {
    $('tx-title').textContent = 'Order ' + room.orderId;
    renderSummary();
    renderDispute();
    renderActions(opts && opts.keepPanel);
    renderTimeline({ stickToBottom: true });
    const composer = $('tx-composer');
    composer.hidden = room.actions.indexOf('message') === -1;
  }

  function statusRow(label, text, tone) {
    return `<div class="tx-state tx-state--${tone}"><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`;
  }

  function renderSummary() {
    const r = room;
    const items = r.items.map((l) => {
      const opts = l.options ? Object.keys(l.options).map((k) => `${k}: ${l.options[k]}`).join(', ') : '';
      return `<li><span class="tx-qty">${esc(l.qty)} ×</span> ${esc(l.label)}${opts ? ` <span class="helper-text">(${esc(opts)})</span>` : ''}
        <span class="tx-line-total">${formatMoney(l.lineTotal)}</span></li>`;
    }).join('');
    const delivery = r.deliveryNegotiated ? 'to be agreed' : Number(r.deliveryCost) === 0 || r.deliveryCost === '' ? 'free' : formatMoney(r.deliveryCost);
    const tone = (s, good) => (s === good ? 'done' : s ? 'active' : 'todo');
    const buyerBlock = r.buyer ? `<p class="helper-text tx-buyer">Buyer: ${esc(r.buyer.name)} · ${esc(r.buyer.phone)}${r.buyer.address ? ' · ' + esc(r.buyer.address) : ''}
      ${r.buyer.notes ? `<br>Notes: ${esc(r.buyer.notes)}` : ''}</p>` : '';
    const flags = r.paymentFlags && r.paymentFlags.length ? `<p class="tx-flag" role="note"><strong>Please check carefully:</strong> ${r.paymentFlags.map(flagText).map(esc).join(' ')}</p>` : '';
    const legacy = r.flow === 'legacy' ? `<p class="helper-text tx-legacy">This order was placed before order rooms. Its payment and status are set by the seller on the Orders page.</p>` : '';
    const sub = r.paymentSubmission ? `<p class="helper-text">Payment details sent ${esc(when(r.paymentSubmission.at))}: ${esc(r.paymentSubmission.methodLabel || '')}${r.paymentSubmission.reference ? ', ref ' + esc(r.paymentSubmission.reference) : ''}${r.paymentSubmission.amount ? ', ' + formatMoney(r.paymentSubmission.amount) : ''}</p>` : '';
    $('tx-summary').innerHTML = `
      <div class="tx-summary-head">
        <div><strong>${esc(r.storeName)}</strong><br><span class="helper-text">Placed ${esc(when(r.createdAt))} · ${esc(r.deliveryLabel || '')}</span></div>
        <span class="tx-stage" aria-label="Order stage">${esc(r.stage)}</span>
      </div>
      <ul class="tx-items">${items}</ul>
      <p class="tx-total">Delivery: ${esc(delivery)} · <strong>Total ${formatMoney(r.total)}</strong></p>
      <dl class="tx-states">
        ${statusRow('Payment', r.payment.label, tone(r.payment.state, 'verified'))}
        ${statusRow(r.collection ? 'Collection' : 'Goods', r.fulfilment.label, tone(r.fulfilment.state, r.collection ? 'handed_over' : 'delivered'))}
        ${statusRow('Receipt', r.receipt.label, tone(r.receipt.state, 'confirmed'))}
        ${r.refund ? statusRow('Refund', { due: 'Refund due from the seller', sent: 'Seller reports refund sent', received: 'Buyer confirmed the refund' }[r.refund] || r.refund, r.refund === 'received' ? 'done' : 'active') : ''}
      </dl>
      ${r.readyInfo && r.readyInfo.instructions ? `<p class="helper-text">Collection: ${esc(r.readyInfo.instructions)}${r.readyInfo.when ? ' · ' + esc(r.readyInfo.when) : ''}</p>` : ''}
      ${r.dispatchInfo ? `<p class="helper-text">Sent ${esc(r.dispatchInfo.date)} by ${esc(r.dispatchInfo.method)}${r.dispatchInfo.tracking ? ' · tracking ' + esc(r.dispatchInfo.tracking) : ''}</p>` : ''}
      ${sub}${flags}${buyerBlock}${legacy}
      ${r.hold && r.hold.on ? `<p class="tx-flag">On hold: ${esc(r.hold.reason)}</p>` : ''}`;
  }

  function flagText(f) {
    return {
      amount_differs: 'The amount the buyer entered is different from the order total.',
      amount_below_items: 'The amount the buyer entered is less than the items’ total.',
      receipt_used_on_other_order: 'The same receipt image was also sent for another order.',
      reference_used_on_other_order: 'The same reference was also given for another order.'
    }[f] || f;
  }

  function renderDispute() {
    const el = $('tx-dispute');
    const d = room.dispute;
    if (!d) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = 'tx-dispute ' + (d.status === 'resolved' ? 'is-resolved' : 'is-open');
    el.innerHTML = `
      <h2>${d.status === 'resolved' ? 'Problem resolved' : 'Problem reported'}: ${esc(d.categoryLabel)}</h2>
      <p>${esc(d.description)}</p>
      <p class="helper-text">Reported by the ${esc(d.openedBy)} · ${esc(when(d.createdAt))} · <strong>${esc(d.statusLabel)}</strong></p>
      ${d.status === 'resolved' ? `<p><strong>${esc(d.outcomeLabel)}.</strong> ${esc(d.rationale)}</p>` : ''}`;
  }

  const ACTION_LABELS = {
    submitPayment: 'Send payment details', verifyPayment: 'Check payment', checklist: 'Check goods against the order',
    markReady: 'Mark ready', dispatch: 'Record sending', markDelivered: 'Report delivered', handover: 'Record handover',
    confirmReceipt: 'Confirm receipt', openDispute: 'Report a problem', respondDispute: 'Reply about the problem', cancel: 'Cancel order',
    recordRefund: 'Record refund sent', confirmRefund: 'Refund arrived', adminDispute: 'Review problem', adminException: 'Waive a requirement',
    adminHold: 'Hold files', adminCorrectReceipt: 'Correct receipt answer', adminComplete: 'Complete without buyer', adminNote: 'Admin note',
    adminReopen: 'Reopen problem'
  };
  const PRIMARY = ['submitPayment', 'verifyPayment', 'checklist', 'markReady', 'dispatch', 'handover', 'confirmReceipt', 'respondDispute', 'recordRefund', 'adminDispute'];

  function renderActions(keepPanel) {
    const list = room.actions.filter((a) => a !== 'message' && a !== 'upload');
    if (room.collection) ACTION_LABELS.markReady = 'Ready for collection'; else ACTION_LABELS.markReady = 'Mark ready to send';
    $('tx-next-hint').textContent = nextHint(list);
    $('tx-action-buttons').innerHTML = list.map((a) => {
      const danger = a === 'cancel' || a === 'openDispute';
      const cls = PRIMARY.indexOf(a) !== -1 ? 'btn btn-primary' : danger ? 'btn btn-outline tx-btn-quiet' : 'btn btn-outline';
      return `<button type="button" class="${cls}" data-action="${a}" aria-expanded="${openAction === a}">${esc(ACTION_LABELS[a] || a)}</button>`;
    }).join('');
    $('tx-action-buttons').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.action)));
    if (keepPanel && openAction && list.indexOf(openAction) !== -1) return;
    if (openAction && list.indexOf(openAction) === -1) { openAction = ''; $('tx-action-panel').innerHTML = ''; }
  }

  function nextHint(list) {
    if (room.status === 'Cancelled') return 'This order is cancelled.';
    if (room.status === 'Fulfilled') return 'This order is complete. If something is wrong you can still report a problem.';
    if (side === 'buyer') {
      if (list.indexOf('submitPayment') !== -1) return 'Paid already? Send the payment details so the seller can check. Your order is marked paid only when the seller confirms the money arrived.';
      if (list.indexOf('confirmReceipt') !== -1) return 'When your order arrives, confirm receipt - or report a problem if anything is missing, damaged or different.';
      if (room.dispute && room.dispute.status !== 'resolved') return 'Your problem report is open. Add replies and photos here; Mwakete reviews what is in this room.';
      if (room.receipt.state === 'confirmed') return 'You confirmed receipt. The order completes once the seller confirms your payment.';
      return 'The seller is working on your order. You will see each step here.';
    }
    if (side === 'seller') {
      if (list.indexOf('verifyPayment') !== -1 && room.payment.state === 'submitted') return 'The buyer says they paid. Check your own bank, wallet or cash before confirming.';
      if (list.indexOf('checklist') !== -1 && !room.checklistDone) return 'Before sending, check the actual goods against the order and add photos where asked.';
      return '';
    }
    return 'Admin view. Decisions are recorded with your name and reasons.';
  }

  /* ---------- timeline ---------- */

  function renderTimeline(opts) {
    const el = $('tx-timeline');
    const prevHeight = el.scrollHeight;
    $('tx-older').hidden = !hasMoreBefore;
    el.innerHTML = events.map(eventHtml).join('') + pendingMessagesHtml();
    hydrateThumbs(el);
    if (opts && opts.keepScroll) el.scrollTop = el.scrollHeight - prevHeight;
    else if (opts && opts.stickToBottom) el.scrollTop = el.scrollHeight;
  }

  function eventHtml(e) {
    const mine = e.byLabel === 'You';
    const system = e.by === 'system';
    const kindLabel = { message: '', system: 'Automatic message', evidence: 'File added', payment: 'Payment', fulfilment: 'Goods',
      receipt: 'Receipt', dispute: 'Problem', status: 'Order', note: 'Admin note' }[e.kind] || '';
    const cls = ['tx-event', 'tx-event--' + e.kind, mine ? 'is-mine' : '', system ? 'is-system' : '', e.audience ? 'is-private' : ''].join(' ');
    const files = (e.evidence || []).map(fileHtml).join('');
    return `<li class="${cls}" data-seq="${e.seq}">
      <div class="tx-event-meta"><strong>${esc(e.byLabel)}</strong>${kindLabel ? ` · ${esc(kindLabel)}` : ''}${e.audience ? ` · <span class="tx-private">only you can see this</span>` : ''}
        <time datetime="${esc(e.at)}">${esc(when(e.at))}</time></div>
      ${e.body ? `<p class="tx-event-body">${esc(e.body)}</p>` : ''}
      ${files ? `<div class="tx-files">${files}</div>` : ''}
    </li>`;
  }

  function fileHtml(f) {
    const label = `${esc(f.categoryLabel)}${f.description ? ' - ' + esc(f.description) : ''}`;
    if (f.removed) return `<div class="tx-file is-removed"><span>${label}: removed (${esc(f.removedReason)})</span></div>`;
    const isImage = /^image\//.test(f.mimeType);
    const redact = side === 'admin' && room.actions.indexOf('adminNote') !== -1 ? `<button type="button" class="btn btn-small tx-redact" data-redact="${esc(f.id)}">Remove file</button>` : '';
    return `<figure class="tx-file">
      ${isImage ? `<button type="button" class="tx-thumb" data-open="${esc(f.id)}" aria-label="Open ${label}"><img alt="" data-thumb="${esc(f.id)}" data-has-thumb="${f.hasThumb ? 1 : 0}" width="96" height="96"></button>`
        : `<button type="button" class="btn btn-small" data-open="${esc(f.id)}">Open PDF</button>`}
      <figcaption>${label}${f.by ? `<br><span class="helper-text">from the ${esc(f.by)}</span>` : ''}</figcaption>${redact}
    </figure>`;
  }

  /** Thumbnails load one at a time, only once per page. */
  async function hydrateThumbs(root) {
    const imgs = Array.from(root.querySelectorAll('img[data-thumb]'));
    for (const img of imgs) {
      const id = img.dataset.thumb;
      if (thumbCache.has(id)) { img.src = thumbCache.get(id); continue; }
      const res = await call('getTxEvidence', { evidenceId: id, variant: img.dataset.hasThumb === '1' ? 'thumb' : 'full' });
      if (!res.ok) { img.alt = 'Preview not available'; continue; }
      const url = URL.createObjectURL(b64ToBlob(res.dataBase64, res.mimeType));
      thumbCache.set(id, url);
      document.querySelectorAll(`img[data-thumb="${CSS.escape(id)}"]`).forEach((x) => { x.src = url; });
    }
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function onTimelineClick(e) {
    const open = e.target.closest('[data-open]');
    if (open) {
      open.disabled = true;
      const res = await call('getTxEvidence', { evidenceId: open.dataset.open, variant: 'full' });
      open.disabled = false;
      if (!res.ok) { alert(res.error || 'This file could not be opened.'); return; }
      const url = URL.createObjectURL(b64ToBlob(res.dataBase64, res.mimeType));
      const w = window.open(url, '_blank', 'noopener');
      if (!w) location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    const red = e.target.closest('[data-redact]');
    if (red) {
      const reason = prompt('Why is this file being removed? (For example: shows a full account number.) The record of the file stays.');
      if (!reason) return;
      const res = await call('adminTxRedactEvidence', { evidenceId: red.dataset.redact, reason, requestId: rid() });
      if (!res.ok) { alert(res.error); return; }
      await load();
    }
  }

  /* ---------- messages ---------- */

  const pendingMessages = [];
  const composerQueue = [];

  function pendingMessagesHtml() {
    return pendingMessages.map((m, i) => `<li class="tx-event tx-event--message is-mine is-pending">
      <div class="tx-event-meta"><strong>You</strong> · <span class="tx-unsent">${m.failed ? 'Not sent' : 'Sending…'}</span></div>
      <p class="tx-event-body">${esc(m.text)}</p>
      ${m.failed ? `<p><button type="button" class="btn btn-small" data-retry-msg="${i}">Retry</button> <span class="helper-text">${esc(m.error)}</span></p>` : ''}
    </li>`).join('');
  }

  async function onSend(e) {
    e.preventDefault();
    const box = $('tx-message');
    const text = box.value.trim();
    const errEl = $('tx-composer-error');
    errEl.textContent = '';
    if (composerQueue.some((u) => u.state !== 'saved' && u.state !== 'failed')) { errEl.textContent = 'Wait for the files to finish uploading.'; return; }
    if (!text) {
      if (composerQueue.length) { clearQueue(composerQueue, $('tx-composer-uploads')); await load(); return; }
      errEl.textContent = 'Write a message first.';
      return;
    }
    const msg = { text, requestId: rid(), failed: false, error: '' };
    pendingMessages.push(msg);
    box.value = '';
    writeDraft('');
    renderTimeline({ stickToBottom: true });
    await sendPending(msg);
  }

  async function sendPending(msg) {
    msg.failed = false;
    renderTimeline({ stickToBottom: true });
    const res = await call('sendTxMessage', { text: msg.text, requestId: msg.requestId });
    if (!res.ok) {
      if (res.authRequired) { showSignIn(res.error); return; }
      msg.failed = true;
      msg.error = res.error || 'Not sent - check your connection.';
      renderTimeline({ stickToBottom: true });
      return;
    }
    pendingMessages.splice(pendingMessages.indexOf(msg), 1);
    clearQueue(composerQueue, $('tx-composer-uploads'));
    await poll();
    renderTimeline({ stickToBottom: true });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-retry-msg]');
    if (b) sendPending(pendingMessages[Number(b.dataset.retryMsg)]);
  });

  /* ---------- uploads ---------- */

  /**
   * One entry per chosen file: selected -> preparing -> uploading -> saved,
   * or failed (with Retry). "Saved" only after the server confirmed both the
   * file and its record. The requestId stays the same across retries, so a
   * retry after a dropped connection never makes a second copy.
   */
  function addFiles(queue, fileList, listEl, category) {
    Array.from(fileList || []).forEach((file) => {
      const item = { file, name: file.name, category, state: 'selected', error: '', requestId: rid(), evidenceId: '' };
      queue.push(item);
      upload(item, queue, listEl);
    });
    drawQueue(queue, listEl);
  }

  function drawQueue(queue, listEl) {
    const label = { selected: 'Waiting', preparing: 'Preparing…', uploading: 'Uploading…', saved: 'Saved', failed: 'Not uploaded' };
    listEl.innerHTML = queue.map((u, i) => `<li class="tx-upload is-${u.state}">
      <span class="tx-upload-name">${esc(u.name)}</span>
      <label class="sr-only" for="${listEl.id}-cat-${i}">What this shows</label>
      <select id="${listEl.id}-cat-${i}" data-cat="${i}" ${u.state === 'saved' || u.state === 'uploading' ? 'disabled' : ''}>
        ${FILE_CATEGORIES.map(([v, l]) => `<option value="${v}" ${v === u.category ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="tx-upload-state">${label[u.state]}${u.state === 'saved' ? ' ✓' : ''}</span>
      ${u.state === 'failed' ? `<span class="form-error">${esc(u.error)}</span> <button type="button" class="btn btn-small" data-retry="${i}">Retry</button> <button type="button" class="btn btn-small" data-remove="${i}">Remove</button>` : ''}
    </li>`).join('');
    listEl.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => upload(queue[Number(b.dataset.retry)], queue, listEl)));
    listEl.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => { queue.splice(Number(b.dataset.remove), 1); drawQueue(queue, listEl); }));
    listEl.querySelectorAll('[data-cat]').forEach((s) => s.addEventListener('change', () => { queue[Number(s.dataset.cat)].category = s.value; }));
  }

  function clearQueue(queue, listEl) { queue.splice(0, queue.length); drawQueue(queue, listEl); }

  async function upload(item, queue, listEl) {
    const maxBytes = (room && room.policy ? room.policy.maxFileMB : 5) * 1024 * 1024;
    item.state = 'preparing'; item.error = '';
    drawQueue(queue, listEl);
    let prepared;
    try {
      prepared = await prepareFile(item.file);
    } catch (err) {
      item.state = 'failed'; item.error = 'This file could not be read.';
      drawQueue(queue, listEl);
      return;
    }
    if (prepared.blob.size > maxBytes) {
      item.state = 'failed'; item.error = `Too large (the limit is ${maxBytes / 1048576} MB).`;
      drawQueue(queue, listEl);
      return;
    }
    item.state = 'uploading';
    drawQueue(queue, listEl);
    const res = await call('uploadTxEvidence', {
      category: item.category, name: item.name, mimeType: prepared.blob.type, dataBase64: await blobToB64(prepared.blob),
      thumbBase64: prepared.thumb ? await blobToB64(prepared.thumb) : '', requestId: item.requestId
    });
    if (!res.ok) {
      if (res.authRequired) { showSignIn(res.error); return; }
      item.state = 'failed'; item.error = res.error || 'Upload failed - check your connection.';
      drawQueue(queue, listEl);
      return;
    }
    item.state = 'saved';
    item.evidenceId = res.evidence.id;
    drawQueue(queue, listEl);
    listEl.dispatchEvent(new CustomEvent('tx-uploads-changed', { bubbles: true }));
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  /**
   * Photos: re-saved as JPEG at up to 2560px (clear enough to show a defect
   * or a serial number, a fraction of the size, and without the location a
   * camera hides in the file). Screenshots under 1.5MB stay as they are so
   * receipt text stays crisp. PDFs are sent unchanged.
   */
  async function prepareFile(file) {
    const type = (file.type || '').toLowerCase();
    if (type === 'application/pdf') return { blob: file, thumb: null };
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('type');
    const img = await loadImage(file);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const keep = type === 'image/png' && file.size <= 1.5 * 1048576 && Math.max(w, h) <= MAX_SIDE;
    const blob = keep ? file : await drawTo(img, w, h, MAX_SIDE, 0.86);
    const thumb = await drawTo(img, w, h, THUMB_SIDE, 0.7);
    return { blob, thumb };
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  function drawTo(img, w, h, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
  }

  /* ---------- action forms ---------- */

  function field(id, label, input, hint) {
    return `<div class="form-field"><label for="${id}">${label}</label>${input}${hint ? `<p class="helper-text">${hint}</p>` : ''}</div>`;
  }
  const text = (id, attrs) => `<input id="${id}" type="text" ${attrs || ''}>`;
  const area = (id, attrs) => `<textarea id="${id}" rows="3" ${attrs || ''}></textarea>`;
  const check = (id, label) => `<div class="form-field tx-check"><input id="${id}" type="checkbox"><label for="${id}">${label}</label></div>`;
  const select = (id, options, value) => `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  function filesBlock(id, category, note) {
    return `<div class="form-field"><span class="tx-files-label">Photos or PDF${note ? ` - ${note}` : ''}</span>
      <label class="btn btn-small tx-attach"><span>Add files</span><input id="${id}-input" type="file" accept="image/jpeg,image/png,image/webp${room.policy.pdf ? ',application/pdf' : ''}" multiple class="sr-only" data-category="${category}"></label>
      <ul id="${id}" class="tx-uploads" aria-live="polite"></ul></div>`;
  }
  function reqList(reqs) {
    if (!reqs || !reqs.length) return '';
    return `<ul class="tx-reqs">${reqs.map((r) => `<li class="tx-req is-${r.waived ? 'waived' : r.level}"><strong>${r.waived ? 'Waived by Mwakete' : r.level === 'required' ? 'Required' : 'Recommended'}:</strong> ${esc(r.message)}</li>`).join('')}</ul>`;
  }

  const forms = {
    submitPayment: () => `
      <p class="tx-warn"><strong>Hide sensitive details</strong> (full account numbers, balances) before adding a screenshot. Your order is marked paid only when the seller confirms the money arrived in their account.</p>
      ${field('f-method', 'How did you pay?', select('f-method', METHODS, 'bank_transfer'))}
      ${field('f-reference', 'Transfer reference', text('f-reference', 'maxlength="60" autocomplete="off"'), room.policy.paymentNeedsProof ? 'Give the reference, a receipt, or both.' : '')}
      ${field('f-amount', 'Amount paid ($)', '<input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal">', 'Order total: ' + formatMoney(room.total))}
      ${field('f-note', 'Note (optional)', area('f-note', 'maxlength="500"'))}
      ${filesBlock('f-files', 'payment', 'receipt or transfer screenshot')}`,
    verifyPayment: () => `
      <p class="tx-warn">Check your <strong>own</strong> bank, wallet or the cash in your hand. A screenshot or reference from the buyer is not proof that money arrived.</p>
      <fieldset class="form-field"><legend>What did you find?</legend>
        <div class="tx-check"><input type="radio" name="f-result" id="f-res-v" value="verified"><label for="f-res-v">The money is in my account / in my hand</label></div>
        <div class="tx-check"><input type="radio" name="f-result" id="f-res-r" value="rejected"><label for="f-res-r">I cannot find this payment</label></div>
        <div class="tx-check"><input type="radio" name="f-result" id="f-res-m" value="more_info"><label for="f-res-m">I need more information</label></div>
      </fieldset>
      ${field('f-method', 'How it arrived', select('f-method', METHODS, (room.paymentSubmission && room.paymentSubmission.method) || 'bank_transfer'))}
      ${field('f-reference', 'Reference shown in your account', text('f-reference', 'maxlength="60" autocomplete="off"'), 'Not needed for cash.')}
      ${field('f-amount', 'Amount that arrived ($)', '<input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal">', 'Order total: ' + formatMoney(room.total))}
      ${check('f-checked', 'I checked my own account (or counted the cash) and the money has arrived')}
      ${check('f-accept', 'Accept a different amount (explain below)')}
      ${field('f-reason', 'Reason or note for the buyer', area('f-reason', 'maxlength="500"'), 'Needed when declining, asking for more, or accepting a different amount.')}`,
    checklist: () => `
      <p class="helper-text">Check the actual goods you are sending against the order. Photos must be of these goods, not catalogue pictures.</p>
      <fieldset class="form-field"><legend>Items in the order</legend>
        ${room.items.map((l, i) => `<div class="tx-check"><input type="checkbox" id="f-line-${i}" data-line="${i}"><label for="f-line-${i}">${esc(l.qty)} × ${esc(l.label)}${l.options ? ' (' + esc(Object.values(l.options).join(', ')) + ')' : ''} - correct product, variety and quantity</label></div>`).join('')}
      </fieldset>
      ${field('f-accessories', 'Included accessories (if any)', text('f-accessories', 'maxlength="300"'))}
      ${field('f-defects', 'Known defects or visible damage', area('f-defects', 'maxlength="500"'), 'Leave empty if none. If you note a defect, add a photo of it and set its type to "Defect".')}
      ${field('f-packaging', 'Packaging condition', text('f-packaging', 'maxlength="300"'))}
      ${field('f-subs', 'Changes agreed with the buyer (if any)', area('f-subs', 'maxlength="500"'), 'Needed if an item is not ticked.')}
      ${reqList(room.policy.checklist)}
      ${filesBlock('f-files', 'goods', 'actual goods')}`,
    markReady: () => room.collection ? `
      ${field('f-instructions', 'Where and how to collect', area('f-instructions', 'maxlength="500"'), 'Avoid sharing private details you would not want kept in the record.')}
      ${field('f-when', 'When (optional)', text('f-when', 'maxlength="120" placeholder="e.g. Friday after 10am"'))}` : `<p>Mark the order as packed and ready to send.</p>`,
    dispatch: () => `
      ${field('f-date', 'Date sent', `<input id="f-date" type="date" value="${today()}">`)}
      ${field('f-dmethod', 'Delivery method', text('f-dmethod', `maxlength="60" value="${esc(room.deliveryLabel || '')}"`))}
      ${field('f-provider', 'Carrier or driver (optional)', text('f-provider', 'maxlength="80"'))}
      ${field('f-tracking', 'Tracking or reference number (if there is one)', text('f-tracking', 'maxlength="80"'))}
      ${field('f-notes', 'Notes (optional)', area('f-notes', 'maxlength="500"'))}
      ${room.payment.state !== 'verified' ? check('f-unpaid', 'Send before payment is confirmed (agreed with the buyer, e.g. cash on delivery)') : ''}
      ${reqList(room.policy.dispatch)}
      ${filesBlock('f-files', 'dispatch', 'packed goods or hand-over to the carrier')}
      <p class="helper-text">This records that you sent it. Only the buyer can confirm it arrived.</p>`,
    markDelivered: () => `${field('f-note', 'How do you know it was delivered? (optional)', area('f-note', 'maxlength="300"'))}<p class="helper-text">This is your report. The buyer is still asked to confirm.</p>`,
    handover: () => `
      ${field('f-date', 'Date of handover', `<input id="f-date" type="date" value="${today()}">`)}
      ${field('f-notes', 'Notes (optional)', area('f-notes', 'maxlength="500"'))}
      ${room.payment.state !== 'verified' ? `${check('f-cash', 'I received the payment in cash at handover')}
        ${field('f-amount', 'Cash received ($)', '<input id="f-amount" type="number" min="0" step="0.01" inputmode="decimal">')}
        ${check('f-unpaid', 'Hand over before payment (agreed with the buyer)')}` : ''}
      ${reqList(room.policy.handover)}
      ${filesBlock('f-files', 'handover', 'optional')}`,
    confirmReceipt: () => `
      <fieldset class="form-field"><legend>What happened?</legend>
        ${RECEIPT_CHOICES.map(([v, l]) => `<div class="tx-check"><input type="radio" name="f-choice" id="f-ch-${v}" value="${v}"><label for="f-ch-${v}">${esc(l)}</label></div>`).join('')}
      </fieldset>
      <div id="f-problem-fields" hidden>
        ${field('f-category', 'What is the problem?', select('f-category', room.disputeCategories.filter((c) => ['wrong_item', 'damaged', 'condition', 'missing_items', 'other'].indexOf(c.id) !== -1).map((c) => [c.id, c.label]), 'damaged'))}
      </div>
      ${field('f-note', 'Details', area('f-note', 'maxlength="1000"'), 'Needed for a problem (at least 15 characters), or to say why you cannot confirm yet.')}
      ${filesBlock('f-files', 'delivery', 'photos of what arrived')}
      <p class="helper-text">Confirming receipt records that the goods arrived. You can still report a problem found later.</p>`,
    openDispute: () => `
      ${field('f-category', 'What is the problem?', select('f-category', room.disputeCategories.map((c) => [c.id, c.label]), room.disputeCategories[0] && room.disputeCategories[0].id))}
      ${field('f-desc', 'Describe what happened', area('f-desc', 'maxlength="1500"'), 'At least 15 characters. Photos are required for damaged, wrong or not-as-described goods.')}
      ${filesBlock('f-files', 'dispute', 'photos of the problem')}
      <p class="helper-text">The other party and Mwakete are told. Mwakete reviews what is in this room.</p>`,
    respondDispute: () => `
      ${field('f-text', 'Your reply', area('f-text', 'maxlength="1500"'))}
      ${filesBlock('f-files', 'dispute', 'supporting photos')}
      ${room.dispute && room.dispute.openedBy === side ? check('f-withdraw', 'Withdraw the problem (it has been sorted out)') : ''}`,
    cancel: () => `${field('f-reason', 'Why is the order cancelled?', area('f-reason', 'maxlength="500"'))}
      ${room.payment.state === 'verified' ? '<p class="tx-warn">Payment was confirmed - the seller must return it and record the refund here. Mwakete does not hold or send money.</p>' : ''}`,
    recordRefund: () => `
      ${field('f-reference', 'Refund reference', text('f-reference', 'maxlength="60"'))}
      ${field('f-note', 'How it was returned', area('f-note', 'maxlength="500"'))}
      ${check('f-sent', 'I have actually sent this refund')}
      ${filesBlock('f-files', 'refund', 'optional')}`,
    confirmRefund: () => '<p>Confirm that the refund has arrived in your account.</p>',
    adminDispute: () => `
      ${field('f-act', 'Action', select('f-act', [['start', 'Start review'], ['request_info', 'Ask for more information'], ['propose', 'Propose a resolution'], ['resolve', 'Record the decision']], 'start'))}
      ${field('f-party', 'Ask whom (for more information)', select('f-party', [['buyer', 'Buyer'], ['seller', 'Seller']], 'seller'))}
      ${field('f-outcome', 'Outcome (for a decision)', select('f-outcome', (room.outcomes || []).filter((o) => o.id !== 'withdrawn').map((o) => [o.id, o.label]), 'agreed'))}
      ${field('f-effect', 'What happens to the order (for a decision)', select('f-effect', [['none', 'No change'], ['cancel', 'Cancel the order'], ['complete', 'Complete the order']], 'none'))}
      ${field('f-note', 'Note or reasons', area('f-note', 'maxlength="1500"'), 'Decisions need reasons (at least 15 characters). Refunds are recorded by the seller only when they are actually sent.')}`,
    adminReopen: () => field('f-note', 'Why reopen?', area('f-note', 'maxlength="1500"')),
    adminException: () => `
      ${field('f-key', 'Requirement to waive', select('f-key', (room.exceptionKeys || []).map((k) => [k, k]), (room.exceptionKeys || [])[0]))}
      ${field('f-reason', 'Why is the exception justified?', area('f-reason', 'maxlength="500"'), 'Recorded with your name. Identity, ownership and payment checks can never be waived.')}`,
    adminHold: () => `${check('f-hold', 'Keep this order’s files beyond the normal retention time')}${field('f-reason', 'Reason', area('f-reason', 'maxlength="300"'))}`,
    adminCorrectReceipt: () => field('f-reason', 'Why set the buyer’s answer aside? (it stays in the history)', area('f-reason', 'maxlength="500"')),
    adminComplete: () => field('f-reason', 'Why complete without the buyer’s confirmation?', area('f-reason', 'maxlength="500"')),
    adminNote: () => field('f-text', 'Note (only admins see it)', area('f-text', 'maxlength="1500"'))
  };

  let formQueue = [];

  function openForm(action) {
    const panel = $('tx-action-panel');
    if (openAction === action) { openAction = ''; panel.innerHTML = ''; renderActions(); return; }
    openAction = action;
    formQueue = [];
    panel.innerHTML = `<form id="tx-form" class="tx-form" novalidate data-request-id="${rid()}">
      <h3>${esc(ACTION_LABELS[action] || action)}</h3>
      ${forms[action] ? forms[action]() : ''}
      <p id="tx-form-error" class="form-error" role="alert"></p>
      <div class="tx-form-buttons">
        <button type="submit" class="btn btn-primary">${action === 'cancel' ? 'Cancel the order' : 'Save'}</button>
        <button type="button" class="btn btn-outline" id="tx-form-close">Close</button>
      </div>
    </form>`;
    renderActions();
    const form = $('tx-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); submitForm(action, form); });
    $('tx-form-close').addEventListener('click', () => openForm(action));
    const fileInput = $('f-files-input');
    if (fileInput) fileInput.addEventListener('change', (e) => { addFiles(formQueue, e.target.files, $('f-files'), e.target.dataset.category); e.target.value = ''; });
    form.querySelectorAll('input[name="f-choice"]').forEach((r) => r.addEventListener('change', () => { $('f-problem-fields').hidden = r.value !== 'problem' || !r.checked; }));
    const first = form.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  const val = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
  const on = (id) => { const el = $(id); return !!(el && el.checked); };
  const radio = (name) => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ''; };

  function payloadFor(action, form) {
    const ev = formQueue.filter((u) => u.state === 'saved').map((u) => u.evidenceId);
    switch (action) {
      case 'submitPayment': return { method: val('f-method'), reference: val('f-reference'), amount: val('f-amount'), note: val('f-note'), evidenceIds: ev };
      case 'verifyPayment': return { result: radio('f-result'), method: val('f-method'), reference: val('f-reference'), amountReceived: val('f-amount'),
        checkedSource: on('f-checked'), acceptDifference: on('f-accept'), reason: val('f-reason') };
      case 'checklist': return { evidenceIds: ev, checklist: { lines: Array.from(form.querySelectorAll('[data-line]')).map((c) => ({ index: Number(c.dataset.line), ok: c.checked })),
        accessories: val('f-accessories'), defects: val('f-defects'), packaging: val('f-packaging'), substitutions: val('f-subs') } };
      case 'markReady': return { collection: { instructions: val('f-instructions'), when: val('f-when') } };
      case 'dispatch': return { evidenceIds: ev, sendUnpaid: on('f-unpaid'), dispatch: { date: val('f-date'), method: val('f-dmethod'), provider: val('f-provider'), tracking: val('f-tracking'), notes: val('f-notes') } };
      case 'markDelivered': return { note: val('f-note') };
      case 'handover': return { evidenceIds: ev, handOverUnpaid: on('f-unpaid'), handover: { date: val('f-date'), notes: val('f-notes'), cashReceived: on('f-cash'), amount: val('f-amount') } };
      case 'confirmReceipt': return { choice: radio('f-choice'), category: val('f-category'), note: val('f-note'), evidenceIds: ev };
      case 'openDispute': return { category: val('f-category'), description: val('f-desc'), evidenceIds: ev };
      case 'respondDispute': return { text: val('f-text'), withdraw: on('f-withdraw'), evidenceIds: ev };
      case 'cancel': return { reason: val('f-reason') };
      case 'recordRefund': return { reference: val('f-reference'), note: val('f-note'), confirmSent: on('f-sent'), evidenceIds: ev };
      case 'confirmRefund': return {};
      case 'adminDispute': return { disputeId: room.dispute.id, disputeVersion: room.dispute.version, act: val('f-act'), party: val('f-party'), outcome: val('f-outcome'), orderEffect: val('f-effect'), note: val('f-note') };
      case 'adminReopen': return { disputeId: room.dispute.id, act: 'reopen', note: val('f-note') };
      case 'adminException': return { key: val('f-key'), reason: val('f-reason') };
      case 'adminHold': return { hold: on('f-hold'), reason: val('f-reason') };
      case 'adminCorrectReceipt': case 'adminComplete': return { reason: val('f-reason') };
      case 'adminNote': return { text: val('f-text') };
      default: return {};
    }
  }

  const ENDPOINT = {
    submitPayment: 'txSubmitPayment', verifyPayment: 'txVerifyPayment', checklist: 'txChecklist', markReady: 'txMarkReady', dispatch: 'txDispatch',
    markDelivered: 'txMarkDelivered', handover: 'txHandover', confirmReceipt: 'txConfirmReceipt', openDispute: 'txOpenDispute',
    respondDispute: 'txRespondDispute', cancel: 'txCancel', recordRefund: 'txRecordRefund', confirmRefund: 'txConfirmRefund',
    adminDispute: 'adminTxDispute', adminReopen: 'adminTxDispute', adminException: 'adminTxException', adminHold: 'adminTxHold',
    adminCorrectReceipt: 'adminTxCorrectReceipt', adminComplete: 'adminTxComplete', adminNote: 'adminTxNote'
  };

  function confirmText(action, payload) {
    if (action === 'verifyPayment' && payload.result === 'verified') return 'Confirm that ' + formatMoney(payload.amountReceived || 0) + ' is really in your account or your hand? The buyer will be told it arrived.';
    if (action === 'confirmReceipt' && payload.choice === 'ok') return 'Confirm you received this order? Only confirm if nothing is missing, damaged or different.';
    if (action === 'cancel') return 'Cancel this order? This cannot be undone.';
    if (action === 'adminComplete') return 'Complete this order without the buyer’s confirmation?';
    if (action === 'adminDispute' && payload.act === 'resolve') return 'Record this decision? Both parties will be told.';
    if (action === 'dispatch') return 'Record that this order has been sent?';
    if (action === 'handover') return 'Record that the buyer has collected this order?';
    return '';
  }

  async function submitForm(action, form) {
    const err = $('tx-form-error');
    err.textContent = '';
    if (formQueue.some((u) => u.state === 'preparing' || u.state === 'uploading' || u.state === 'selected')) { err.textContent = 'Wait for the files to finish uploading.'; return; }
    if (formQueue.some((u) => u.state === 'failed')) { err.textContent = 'A file did not upload. Retry it or remove it first.'; return; }
    const payload = payloadFor(action, form);
    const question = confirmText(action, payload);
    if (question && !confirm(question)) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    // Same requestId on every retry of this form: a dropped answer can never record a step twice.
    const res = await call(ENDPOINT[action], Object.assign({ version: room.version, requestId: form.dataset.requestId }, payload));
    btn.disabled = false;
    btn.textContent = action === 'cancel' ? 'Cancel the order' : 'Save';
    if (!res.ok) {
      if (res.authRequired) { showSignIn(res.error); return; }
      err.textContent = res.error || 'Not saved - check your connection and try again.';
      if (res.stale) { await load(); }
      return;
    }
    openAction = '';
    $('tx-action-panel').innerHTML = res.recommendedMissing && res.recommendedMissing.length
      ? `<p class="tx-warn" role="status">Saved. Recommended: ${res.recommendedMissing.map(esc).join(' ')}</p>` : '<p class="tx-saved" role="status">Saved.</p>';
    await load();
  }

  return { init, _prepareFile: prepareFile };
})();

document.addEventListener('DOMContentLoaded', () => OrderRoom.init());
