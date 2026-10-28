// Mwakete POS inside the seller dashboard (owner/pos.html). Oct 2026.
// Mounts the shared app (pos-app.js) for the signed-in store owner. Works
// offline after the first visit: the owner's last profile is used when
// Mwakete cannot be reached, and every sale is kept on this device until
// Mwakete confirms it.
document.addEventListener('DOMContentLoaded', () => {
  PosApp.start({
    mode: 'embedded',
    productsHref: 'products.html',
    ordersHref: 'orders.html',
    footerHtml: () => '<a href="../pos/">Open the till app (installable, works offline)</a>',
    camera: typeof PosCamera !== 'undefined' ? PosCamera.open : null,
    signOut: async () => { await Auth.logout(); window.location.href = 'login.html'; },
    session: async () => {
      const token = Auth.getToken();
      if (!token) { window.location.href = 'login.html?next=pos.html'; return null; }
      let owner = Auth.getOwner();
      const res = await Api.post('getOwnerProfile', { token });
      if (res.ok) { Auth.saveSession(token, res.owner); owner = res.owner; }
      else if (!/network error/i.test(String(res.error || ''))) {
        // A real "no" from Mwakete (signed out elsewhere, closed store). Sales waiting
        // on this device stay in its storage and are sent after the next sign-in.
        Auth.clearSession();
        window.location.href = 'login.html?expired=1&next=pos.html';
        return null;
      }
      if (!owner || !owner.ownerId) throw new Error('Connect to the internet once to open the till on this device.');
      const label = document.getElementById('store-name-label');
      if (label) label.textContent = shortStoreName(owner.storeName);
      if (res.ok) {
        const probe = await Api.post('posGetSettings', { token });
        if (!probe.ok && /not switched on/i.test(String(probe.error || ''))) {
          throw new Error('The Point of Sale is not switched on for your store yet. Your online store and inventory work as before.');
        }
      }
      return { ownerId: owner.ownerId, storeName: owner.storeName, who: (owner.storeName || 'Owner') + ' (owner)', auth: () => ({ token: Auth.getToken() }), deviceLabel: 'dashboard' };
    }
  });
});
