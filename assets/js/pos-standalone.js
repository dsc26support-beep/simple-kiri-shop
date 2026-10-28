// Mwakete POS - the standalone, installable till (pos/index.html). Oct 2026.
// Mounts the shared app (pos-app.js). Who can use it:
//   * the store owner, signed in on this device (the same sign-in as the
//     seller dashboard), and
//   * staff, by PIN, on a till the owner registered (PosStaff.gs). The till's
//     secret is kept on this device only; a staff session lasts 12 hours and
//     only works on this till. Sign in while online at the start of a shift -
//     the till then keeps selling if the connection drops.
// Signing out never deletes sales waiting on this device.
(function () {
  const DEVICE_KEY = 'mwk_pos_device';
  const STAFF_KEY = 'mwk_pos_staff';
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const write = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  const esc = (s) => escapeHtml(s == null ? '' : String(s));

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}); });
  }

  async function post(action, body) {
    try {
      const res = await fetch(APP_CONFIG.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action }, body || {})) });
      return await res.json();
    } catch (e) { return { ok: false, network: true, error: 'No connection to Mwakete.' }; }
  }

  function screen(html) {
    const root = document.getElementById('pos-root');
    root.className = '';
    root.innerHTML = `<main class="pos-main" style="max-width:520px" id="pos-view"><h1>Mwakete POS</h1>${html}</main>`;
    return root;
  }

  /** Staff picks their name and types their PIN on a registered till. */
  function pinScreen(device) {
    return new Promise((resolve) => {
      const draw = async () => {
        const root = screen(`<p class="pos-muted">Till: ${esc(device.name)} · ${esc(device.storeName || '')}</p><div id="pin-body"><p class="pos-muted">${loadingMessageHtml()}</p></div>
          <p style="margin-top:2rem"><a href="../owner/login.html?next=pos-app.html">Store owner? Sign in here</a></p>`);
        const info = await post('posDeviceInfo', { deviceId: device.deviceId, deviceSecret: device.deviceSecret });
        const body = root.querySelector('#pin-body');
        if (!info.ok) {
          if (info.network) {
            body.innerHTML = '<p class="pos-note">No connection. Staff sign in needs a connection; a till already signed in keeps selling offline.</p><button type="button" class="btn" id="pin-retry">Try again</button>';
            body.querySelector('#pin-retry').addEventListener('click', draw);
          } else {
            body.innerHTML = `<p class="pos-note is-bad">${esc(info.error)}</p><p>Sales waiting on this device are kept. The owner can sign in here to send them.</p>`;
          }
          return;
        }
        if (!info.staff.length) { body.innerHTML = '<p class="pos-note">No staff yet. The owner adds staff in the till\'s Settings.</p>'; return; }
        let picked = null, pin = '';
        body.innerHTML = `<label for="pin-who" style="font-weight:700">Who are you?</label>
          <select id="pin-who" style="width:100%;min-height:48px;margin:6px 0 12px"><option value="">Choose your name</option>${info.staff.map((s) => `<option value="${esc(s.staffId)}">${esc(s.name)} (${esc(s.roleLabel)})</option>`).join('')}</select>
          <div class="pos-pin-dots" aria-live="polite" id="pin-dots"></div>
          <div class="pos-pin">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-d="${n}">${n}</button>`).join('')}<button type="button" data-clear>Clear</button><button type="button" data-d="0">0</button><button type="button" data-go>OK</button></div>
          <p class="form-error" id="pin-err" role="alert"></p>`;
        const dots = () => { body.querySelector('#pin-dots').innerHTML = '<span></span>'.repeat(pin.length); };
        body.querySelector('#pin-who').addEventListener('change', (e) => { picked = e.target.value; });
        body.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => { if (pin.length < 6) { pin += b.dataset.d; dots(); } }));
        body.querySelector('[data-clear]').addEventListener('click', () => { pin = ''; dots(); });
        const go = async () => {
          const err = body.querySelector('#pin-err');
          if (!picked) { err.textContent = 'Choose your name first.'; return; }
          if (pin.length < 4) { err.textContent = 'Enter your 4-6 digit PIN.'; return; }
          err.innerHTML = loadingMessageHtml('Checking');
          const res = await post('posStaffLogin', { deviceId: device.deviceId, deviceSecret: device.deviceSecret, staffId: picked, pin });
          pin = ''; dots();
          if (!res.ok) { err.textContent = res.network ? 'No connection. Try again when online.' : res.error; return; }
          const staff = { posToken: res.posToken, expiresAt: res.expiresAt, staff: res.staff, ownerId: res.store.ownerId, storeName: res.store.name };
          write(STAFF_KEY, staff);
          resolve(staff);
        };
        body.querySelector('[data-go]').addEventListener('click', go);
        document.addEventListener('keydown', function onKey(e) {
          if (!document.getElementById('pin-dots')) { document.removeEventListener('keydown', onKey); return; }
          if (/^\d$/.test(e.key) && pin.length < 6) { pin += e.key; dots(); }
          else if (e.key === 'Backspace') { pin = pin.slice(0, -1); dots(); }
          else if (e.key === 'Enter') go();
        });
      };
      draw();
    });
  }

  function welcome() {
    screen(`<p>This is the Mwakete till app. It sells in your shop, scans barcodes, manages stock and keeps working when the internet drops.</p>
      <div class="pos-card" style="margin:1rem 0"><h2 style="margin-top:0">Store owner</h2><p>Sign in with your Mwakete seller account. You can then use this device as a till, and set it up for your staff.</p>
        <a class="btn btn-primary btn-block" href="../owner/login.html?next=pos-app.html">Sign in as the store owner</a></div>
      <div class="pos-card"><h2 style="margin-top:0">Staff</h2><p>Your till must be set up by the store owner first. Ask them to sign in here once and choose Settings → Use this device as a till.</p></div>
      <p class="pos-muted" style="margin-top:1rem">Install: in Chrome, open the menu (⋮) and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>`);
  }

  async function session() {
    const device = read(DEVICE_KEY);
    const staff = read(STAFF_KEY);
    const ownerToken = Auth.getToken();
    // 1. A staff member signed in on this till, session not expired.
    if (device && staff && staff.ownerId === device.ownerId && Date.parse(staff.expiresAt) > Date.now()) {
      return staffSession(device, staff);
    }
    // 2. The owner, signed in on this device.
    if (ownerToken) {
      let owner = Auth.getOwner();
      const res = await post('getOwnerProfile', { token: ownerToken });
      if (res.ok) { Auth.saveSession(ownerToken, res.owner); owner = res.owner; }
      else if (!res.network) { Auth.clearSession(); owner = null; }
      if (owner && owner.ownerId) {
        return { ownerId: owner.ownerId, storeName: owner.storeName, who: (owner.storeName || 'Owner') + ' (owner)', auth: () => ({ token: Auth.getToken() }),
          deviceCode: () => (device && device.ownerId === owner.ownerId ? device.code : ''), deviceLabel: device && device.ownerId === owner.ownerId ? device.name + ' (' + device.code + ')' : 'not set up as a till',
          isOwner: true };
      }
    }
    // 3. A registered till: staff sign in with a PIN.
    if (device) {
      write(STAFF_KEY, null);
      const s = await pinScreen(device);
      return staffSession(device, s);
    }
    welcome();
    return null;
  }

  function staffSession(device, staff) {
    return { ownerId: device.ownerId, storeName: staff.storeName || device.storeName, who: staff.staff.name + ' (' + staff.staff.roleLabel + ')',
      auth: () => ({ posToken: staff.posToken, deviceSecret: device.deviceSecret }), deviceCode: () => device.code, deviceLabel: device.name + ' (' + device.code + ')' };
  }

  /** Owner only: makes THIS device a till for staff. The secret stays on this device. */
  function settingsExtra(box, h) {
    const device = read(DEVICE_KEY);
    const owner = Auth.getOwner();
    if (!Auth.getToken() || !owner) return;
    const here = device && device.ownerId === owner.ownerId;
    const part = document.createElement('div');
    part.innerHTML = `<h2>This device as a till</h2>${here ? `<p>This device is the till <strong>${esc(device.name)}</strong> (${esc(device.code)}). Staff can sign in here with their PIN.</p>
      <button type="button" class="btn" id="dv-staff">Hand over to staff (sign the owner out here)</button>`
      : `<p>Make this device a till so your staff can sign in here with their PIN.</p><div class="pos-form"><div class="field"><label for="dv-name">Till name</label><input id="dv-name" maxlength="40" placeholder="Front counter"></div></div>
      <button type="button" class="btn btn-primary" id="dv-reg">Use this device as a till</button>`}<p class="form-error" id="dv-err" role="alert"></p>`;
    box.appendChild(part);
    const reg = part.querySelector('#dv-reg');
    if (reg) reg.addEventListener('click', async () => {
      const res = await h.call('posRegisterDevice', { name: part.querySelector('#dv-name').value });
      if (!res.ok) { part.querySelector('#dv-err').textContent = res.network ? 'Needs a connection.' : res.error; return; }
      write(DEVICE_KEY, { deviceId: res.device.deviceId, deviceSecret: res.deviceSecret, code: res.device.code, name: res.device.name, ownerId: res.ownerId, storeName: res.storeName });
      h.toast('This device is now the till "' + res.device.name + '".');
      location.reload();
    });
    const hand = part.querySelector('#dv-staff');
    if (hand) hand.addEventListener('click', async () => {
      if (PosEngine.status().pending) {
        h.toast('Sync first: ' + PosEngine.status().pending + ' waiting. They are kept either way.', true);
      }
      Auth.clearSession();
      location.reload();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    PosApp.start({
      mode: 'standalone',
      productsHref: '../owner/products.html',
      ordersHref: '../owner/orders.html',
      footerHtml: () => '<a href="../owner/dashboard.html">Seller dashboard</a>',
      camera: typeof PosCamera !== 'undefined' ? PosCamera.open : null,
      session,
      settingsExtra,
      signOut: () => {
        const staff = read(STAFF_KEY);
        if (staff) { post('posStaffLogout', { posToken: staff.posToken, deviceSecret: (read(DEVICE_KEY) || {}).deviceSecret }); write(STAFF_KEY, null); }
        else if (Auth.getToken()) Auth.clearSession();
        location.reload();
      }
    });
  });
})();
