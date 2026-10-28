// Mwakete POS - sync engine shared by the dashboard till (owner/pos.html) and
// the standalone app (pos/). Oct 2026. docs/mwakete-pos-architecture.md.
//
// THE RULES IT KEEPS
// * Every sale is written to this device (PosDB) BEFORE anything is shown as
//   done. Online, it is then sent at once and the till waits for Mwakete's
//   answer; only that answer makes it "Synchronised".
// * If the answer never comes (dropped connection, timeout), the till does not
//   say it failed or succeeded. The sale stays saved here, is sent again with
//   the SAME reference (clientTxnId) - Mwakete returns the first sale rather
//   than making a second - and Mwakete is asked which sales it already has.
// * Mwakete's stock numbers always win. This device only subtracts its own
//   sales that Mwakete has not seen yet.
// * The cursor (the last change applied) moves only in the same storage write
//   that applied the change. A gap or a bad cursor means: reload the catalogue.
// * Apps Script cannot push, so the till asks for changes: every few seconds
//   after activity, less often when quiet, not at all while hidden.
const PosEngine = (function () {
  const POLL_FAST = 3000, POLL_NORMAL = 12000, POLL_IDLE = 45000, FAST_FOR = 60000, IDLE_AFTER = 5 * 60000;
  const UPLOAD_BATCH = 10;
  const TIMEOUT = 30000;
  let cfg = null;
  let ownerId = '';
  const state = { started: false, reachable: navigator.onLine, syncing: false, lastSyncAt: null, lastError: '', cursor: 0, latest: null,
    pending: 0, failed: 0, awaiting: 0, authProblem: false, clockOffset: 0, latency: [] };
  const listeners = {};
  let pollTimer = null, lastActivity = Date.now(), flushing = null, polling = null;

  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  function touch() { lastActivity = Date.now(); schedule(POLL_FAST); }

  /** POST to the backend with a time limit. A network failure is { ok:false, network:true }. */
  async function call(action, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT) : null;
    try {
      const res = await fetch(APP_CONFIG.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, cfg.auth(), body || {})), signal: ctl ? ctl.signal : undefined });
      const json = await res.json();
      setReachable(true);
      if (json && json.ok === false && /not authenticated|session|sign in|log in|revoked/i.test(String(json.error || ''))) {
        state.authProblem = true; emit('status', status());
        json.errorKind = json.errorKind || 'auth';
      }
      if (json && /^Unknown action: /.test(String(json.error || ''))) json.error = 'This part of Mwakete is being updated. Please try again in a little while.';
      return json;
    } catch (e) {
      setReachable(false);
      return { ok: false, network: true, error: 'No connection to Mwakete.' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function setReachable(v) {
    if (state.reachable === v) return;
    state.reachable = v;
    PosDB.addLog(v ? 'online' : 'offline', v ? 'Connected to Mwakete.' : 'Cannot reach Mwakete - working offline.');
    emit('status', status());
    if (v) { flushQueue(); schedule(500); }
  }

  function status() {
    return { online: state.reachable && navigator.onLine, syncing: state.syncing, lastSyncAt: state.lastSyncAt, lastError: state.lastError,
      cursor: state.cursor, latest: state.latest, pending: state.pending, awaiting: state.awaiting, failed: state.failed, authProblem: state.authProblem };
  }

  async function refreshCounts() {
    const q = await PosDB.all('queue');
    state.pending = q.length;
    state.failed = q.filter((e) => e.state === 'failed' || e.state === 'conflict').length;
    state.awaiting = q.filter((e) => e.state === 'awaiting').length;
    emit('queue', q);
    emit('status', status());
    return q;
  }

  /* ---------------- catalogue ---------------- */

  async function loadCatalog() {
    const res = await call('posCatalog', {});
    if (!res.ok) { if (!res.network) state.lastError = res.error; emit('status', status()); return res; }
    noteClock(res.serverTime);
    await PosDB.replaceCatalog(res.items, res.cursor, { settings: res.settings, store: res.store, methods: res.methods, actor: res.actor, bulkOn: res.bulkOn });
    state.cursor = res.cursor; state.latest = res.cursor;
    state.lastSyncAt = new Date().toISOString(); state.lastError = '';
    await PosDB.setMeta('lastSyncAt', state.lastSyncAt);
    await PosDB.addLog('catalog', 'Catalogue loaded: ' + res.items.length + ' items.');
    emit('items'); emit('meta', res); emit('status', status());
    return res;
  }

  function noteClock(serverTime) {
    const t = Date.parse(serverTime);
    if (isFinite(t)) state.clockOffset = t - Date.now();
  }

  /* ---------------- changes ---------------- */

  async function pollChanges() {
    if (polling) return polling;
    polling = (async () => {
      state.syncing = true; emit('status', status());
      try {
        for (let round = 0; round < 10; round++) {
          const since = await PosDB.getMeta('cursor', 0);
          const res = await call('posChanges', { since });
          if (!res.ok) { if (!res.network) { state.lastError = res.error; await PosDB.addLog('error', res.error); } break; }
          noteClock(res.serverTime);
          state.latest = res.latest;
          if (res.resync) {
            await PosDB.addLog('resync', 'Changes missing (' + (res.reason || 'gap') + ') - reloading the catalogue.');
            await loadCatalog();
            break;
          }
          const changes = res.changes || [];
          if (!changes.length) { state.cursor = since; break; }
          const last = changes[changes.length - 1].seq;
          const catalogIds = Array.from(new Set(changes.filter((c) => c.kind === 'catalog').map((c) => String(c.productId || '')).filter(Boolean)));
          if (changes.some((c) => c.kind === 'catalog' && !c.productId)) { await loadCatalog(); break; }
          if (catalogIds.length) {
            const cat = await call('posCatalog', { productIds: catalogIds });
            if (!cat.ok) break; // try again next poll; the cursor has not moved
            await PosDB.upsertItems(cat.items, catalogIds);
          }
          await PosDB.applyStockChanges(changes, last);
          state.cursor = last;
          // Latency: from Mwakete recording the change to this till showing it.
          const now = Date.now() + state.clockOffset;
          changes.forEach((c) => { const t = Date.parse(c.at); if (isFinite(t)) state.latency.push(Math.max(0, now - t)); });
          if (state.latency.length > 200) state.latency = state.latency.slice(-200);
          emit('items', changes);
          if (changes.some((c) => c.kind === 'sale')) emit('sales');
          if (!res.more) break;
        }
        state.lastSyncAt = new Date().toISOString();
        await PosDB.setMeta('lastSyncAt', state.lastSyncAt);
      } finally {
        state.syncing = false; emit('status', status()); polling = null;
      }
    })();
    return polling;
  }

  function schedule(ms) {
    clearTimeout(pollTimer);
    if (!state.started) return;
    pollTimer = setTimeout(tick, ms);
  }

  async function tick() {
    if (document.hidden) { schedule(POLL_IDLE); return; }
    await flushQueue();
    await pollChanges();
    const quiet = Date.now() - lastActivity;
    schedule(quiet < FAST_FOR ? POLL_FAST : quiet < IDLE_AFTER ? POLL_NORMAL : POLL_IDLE);
  }

  /* ---------------- sales ---------------- */

  async function nextOfflineReceiptNo() {
    const day = new Date(Date.now() + 12 * 3600000).toISOString().slice(0, 10); // Tarawa day
    const key = 'receiptSeq:' + day;
    const n = (await PosDB.getMeta(key, 0)) + 1;
    await PosDB.setMeta(key, n);
    return posOfflineReceiptNo(day, await deviceCode(), n);
  }

  async function deviceCode() {
    let code = await PosDB.getMeta('deviceCode', '');
    if (!code) {
      code = (cfg.deviceCode && cfg.deviceCode()) || Math.random().toString(36).slice(2, 6).toUpperCase();
      await PosDB.setMeta('deviceCode', code);
    }
    return code;
  }

  function newTxnId() {
    const rnd = (window.crypto && crypto.getRandomValues) ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('') : Math.random().toString(36).slice(2, 18);
    return 'pos-' + Date.now().toString(36) + '-' + rnd;
  }

  /**
   * Completes a sale. body: the checkout body (clientTxnId, lines, payment, ...);
   * local: what the till showed (lines with names/prices, totals, method).
   * Resolves { state: 'synced' | 'saved_locally' | 'awaiting' | 'rejected', sale?, error?, entry }.
   *   rejected = Mwakete said no BEFORE anything was sold (online only) - nothing is kept, the cart stays.
   */
  async function completeSale(body, local) {
    touch();
    const now = new Date().toISOString();
    // Whenever the device says it has a network, Mwakete is tried first - an
    // earlier failure is no reason not to. If the try fails, the sale is kept
    // as "awaiting" (it may or may not have arrived), never lost.
    const online = navigator.onLine;
    const entry = { clientTxnId: body.clientTxnId, createdAt: now, state: online ? 'awaiting' : 'saved_locally', attempts: 0, nextTry: 0,
      body: Object.assign({}, body), local: Object.assign({}, local), server: null, error: '' };
    if (!online) {
      entry.body.offline = true; entry.body.completedAt = now; entry.body.receiptNo = await nextOfflineReceiptNo();
      entry.local.receiptNo = entry.body.receiptNo;
    }
    const deltas = (local.lines || []).map((l) => ({ variantId: l.variantId, qty: l.qty }));
    await PosDB.saveSaleLocally(entry, deltas);       // durable from here on
    await refreshCounts();
    emit('items');
    if (!online) {
      await PosDB.addLog('sale', 'Saved offline: ' + entry.body.receiptNo);
      return { state: 'saved_locally', entry };
    }
    const res = await call('posCheckout', entry.body);
    if (res.ok) {
      await PosDB.settleQueued(entry.clientTxnId, 'synced', { saleId: res.sale.saleId, receiptNo: res.sale.receiptNo, sale: res.sale, receipt: res.receipt, cases: res.cases || [] });
      await refreshCounts();
      schedule(300);
      return { state: 'synced', sale: res.sale, receipt: res.receipt, cases: res.cases || [], entry };
    }
    if (res.network) {
      // We do not know if Mwakete got it. Keep it as a sale made now; it is sent
      // again with the same reference, which can never make a second sale.
      entry.body.offline = true; entry.body.completedAt = now; entry.body.receiptNo = await nextOfflineReceiptNo();
      entry.local.receiptNo = entry.body.receiptNo; entry.state = 'awaiting'; entry.error = 'No answer from Mwakete yet.';
      await PosDB.put('queue', entry);
      await PosDB.settleQueued(entry.clientTxnId, 'awaiting', null);
      await PosDB.addLog('unknown', 'No answer for sale ' + entry.clientTxnId + ' - will check and resend.');
      await refreshCounts();
      return { state: 'awaiting', entry };
    }
    // Mwakete refused it before selling anything (stock, prices, permissions): undo here too.
    await discard(entry, res.error);
    return { state: 'rejected', error: res.error, errorKind: res.errorKind, entry };
  }

  async function discard(entry, why) {
    await PosDB.del('queue', entry.clientTxnId);
    await PosDB.del('sales', entry.clientTxnId);
    // Put the local stock back.
    for (const l of entry.local.lines || []) {
      const it = await PosDB.get('items', l.variantId);
      if (it && it.tracked) { it.localSold = Math.max(0, Number(it.localSold || 0) - l.qty); it.available = Number(it.available || 0) + l.qty; await PosDB.put('items', it); }
    }
    await PosDB.addLog('rejected', 'Not sold: ' + why);
    await refreshCounts();
    emit('items');
  }

  /**
   * Sends queued sales. Safe to call any time: concurrent calls share one run.
   * force: ignore the back-off timer (the "Retry now" button).
   */
  function flushQueue(force) {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        let q = await PosDB.all('queue');
        const due = q.filter((e) => e.state !== 'failed' && e.state !== 'conflict' && (force || !e.nextTry || e.nextTry <= Date.now()))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        if (!due.length) return;
        if (!state.reachable && !force && !navigator.onLine) return;
        // Stock work (receive / adjust) goes one at a time; its opId makes a repeat harmless.
        for (const e of due.filter((x) => x.kind === 'op')) {
          const res = await call('posStockOp', e.body);
          if (res.ok) {
            await PosDB.settleQueued(e.clientTxnId, 'synced', { replayed: !!res.replayed });
            await PosDB.addLog('synced', 'Stock change confirmed by Mwakete (' + e.body.type + ').');
            continue;
          }
          e.attempts = (e.attempts || 0) + 1;
          e.error = res.error;
          e.nextTry = Date.now() + Math.min(5 * 60000, 5000 * Math.pow(2, Math.min(e.attempts, 6)));
          if (!res.network && res.errorKind !== 'auth') e.state = 'failed';
          await PosDB.put('queue', e);
          if (res.network) break;
          await PosDB.addLog('failed', 'Stock change not accepted: ' + res.error);
        }
        const saleDue = due.filter((x) => x.kind !== 'op');
        for (let i = 0; i < saleDue.length; i += UPLOAD_BATCH) {
          const batch = saleDue.slice(i, i + UPLOAD_BATCH);
          // A sale sent from here is always the record of a sale already made: offline semantics.
          const sales = batch.map((e) => Object.assign({}, e.body, { offline: true, completedAt: e.body.completedAt || e.createdAt }));
          const res = await call('posUploadSales', { sales });
          if (!res.ok) {
            const later = res.network || res.errorKind === 'auth';
            for (const e of batch) {
              e.attempts = (e.attempts || 0) + 1;
              e.nextTry = Date.now() + Math.min(5 * 60000, 5000 * Math.pow(2, Math.min(e.attempts, 6)));
              e.error = res.error;
              if (!later) e.state = 'failed';
              await PosDB.put('queue', e);
            }
            if (!res.network) await PosDB.addLog('error', 'Upload refused: ' + res.error);
            break;
          }
          for (const r of res.results) {
            const e = batch.find((x) => x.clientTxnId === r.clientTxnId);
            if (!e) continue;
            if (r.ok) {
              await PosDB.settleQueued(e.clientTxnId, 'synced', { saleId: r.saleId, receiptNo: r.receiptNo, sale: r.sale, cases: r.cases || [] });
              await PosDB.addLog('synced', 'Confirmed by Mwakete: ' + r.receiptNo + (r.cases && r.cases.length ? ' (' + r.cases.length + ' to review)' : ''));
              if (r.cases && r.cases.length) emit('cases', r.cases);
            } else {
              e.attempts = (e.attempts || 0) + 1;
              e.error = r.error;
              e.errorKind = r.errorKind;
              // Kept, never deleted: a person looks at it in the Sync Centre.
              e.state = r.errorKind === 'auth' ? 'awaiting' : 'failed';
              e.nextTry = Date.now() + Math.min(5 * 60000, 5000 * Math.pow(2, Math.min(e.attempts, 6)));
              await PosDB.put('queue', e);
              await PosDB.settleQueued(e.clientTxnId, e.state, null);
              await PosDB.addLog('failed', 'Not accepted: ' + r.error);
            }
          }
          state.lastSyncAt = new Date().toISOString();
        }
      } finally {
        await refreshCounts();
        flushing = null;
      }
    })();
    return flushing;
  }

  /** Sync Centre: send a failed sale again (after the problem is fixed). Nothing is changed in it. */
  async function retryFailed(clientTxnId) {
    const e = await PosDB.get('queue', clientTxnId);
    if (!e) return;
    e.state = 'awaiting'; e.nextTry = 0;
    await PosDB.put('queue', e);
    await flushQueue(true);
  }

  /** Asks Mwakete which waiting sales it already has (after a lost answer). */
  async function reconcileUnknown() {
    const q = (await PosDB.all('queue')).filter((e) => e.state === 'awaiting' && e.kind !== 'op');
    if (!q.length) return { checked: 0 };
    const res = await call('posLookupTxns', { clientTxnIds: q.map((e) => e.clientTxnId).slice(0, 50) });
    if (!res.ok) return res;
    for (const id of Object.keys(res.found || {})) {
      const f = res.found[id];
      await PosDB.settleQueued(id, 'synced', { saleId: f.saleId, receiptNo: f.receiptNo });
      await PosDB.addLog('synced', 'Mwakete already had ' + f.receiptNo + '.');
    }
    await refreshCounts();
    return { checked: q.length, found: Object.keys(res.found || {}).length };
  }

  /* ---------------- life cycle ---------------- */

  /**
   * opts: { ownerId, auth: () => ({ token }) , deviceCode?: () => string }
   */
  async function start(opts) {
    cfg = opts;
    ownerId = opts.ownerId;
    await PosDB.open(ownerId);
    PosDB.askPersistent();
    state.cursor = await PosDB.getMeta('cursor', 0);
    state.lastSyncAt = await PosDB.getMeta('lastSyncAt', null);
    state.started = true;
    await refreshCounts();
    const items = await PosDB.all('items');
    // A different person signed in on this device: the stored catalogue was
    // shaped for the previous one (e.g. cost prices for the owner). Reload it
    // for this person before showing anything. Waiting sales are untouched.
    const prevKey = await PosDB.getMeta('sessionKey', null);
    const switched = opts.sessionKey && prevKey !== opts.sessionKey;
    if (switched) {
      await PosDB.replaceCatalog([], 0, { actor: null });
      const r = await loadCatalog();
      if (r.ok) await PosDB.setMeta('sessionKey', opts.sessionKey);
      else if (!r.network) throw new Error(r.error);
      else throw new Error('Connect to the internet to open the till for ' + (opts.sessionLabel || 'this person') + ' - their items are loaded online once.');
    } else if (!items.length) await loadCatalog();
    else { emit('items'); reconcileUnknown(); }
    window.addEventListener('online', () => { setReachable(true); });
    window.addEventListener('offline', () => setReachable(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { touch(); } });
    window.addEventListener('beforeunload', (ev) => { if (state.pending > 0) { ev.preventDefault(); ev.returnValue = ''; } });
    schedule(200);
  }

  function stop() { state.started = false; clearTimeout(pollTimer); }

  function latencyStats() {
    const s = state.latency.slice().sort((a, b) => a - b);
    if (!s.length) return null;
    const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    return { samples: s.length, medianMs: pick(0.5), p95Ms: pick(0.95), maxMs: s[s.length - 1] };
  }

  return { start, stop, on, call, status, touch, loadCatalog, pollChanges, flushQueue, retryFailed, reconcileUnknown, completeSale, newTxnId, refreshCounts,
    latencyStats, deviceCode, _state: state };
})();
