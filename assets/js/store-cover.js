// The store's cover at the top of the page on phones and tablets (owner
// requests, Nov 2026): the store page, and the cart, checkout, order-received
// and order sign-in screens of that store, which all open the same way. The
// markup is in each page's HTML (#store-profile, reserved in CSS so filling it
// in moves nothing); this fills it, points the back arrow, and moves the ⋮
// menu and the cart button onto the cover. Computers keep the red header.
const StoreCover = (() => {
  const QUERY = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : null;
  const TICK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l2.4 1.8 3-.2.9 2.9 2.4 1.8-1 2.8 1 2.8-2.4 1.8-.9 2.9-3-.2L12 21.5l-2.4-1.8-3 .2-.9-2.9-2.4-1.8 1-2.8-1-2.8 2.4-1.8.9-2.9 3 .2z"></path><path d="m8.5 12 2.4 2.4 4.6-4.8"></path></svg><span class="sr-only">Verified by Mwakete</span>';
  const $ = (id) => document.getElementById(id);

  /**
   * s: { storeName, logoUrl, coverUrl, color, isOpen, sellerBadges }. The
   * seller's own data, so set as text; the colour was checked as #rrggbb by
   * the server and is checked again before it reaches a style.
   */
  function fill(s) {
    const box = $('store-profile');
    if (!box || !s) return;
    const name = s.storeName || 'Store';
    if (/^#[0-9a-f]{6}$/i.test(s.color || '')) box.style.setProperty('--sp-color', s.color);
    if (s.coverUrl) {
      const cover = $('sp-cover-img');
      cover.src = optimizedImageUrl(s.coverUrl, 1200);
      cover.hidden = false;
    }
    $('sp-cover-name').textContent = name;
    if (s.logoUrl) {
      const img = $('sp-avatar-img');
      img.src = optimizedImageUrl(s.logoUrl, IMG_W.logo);
      img.alt = name;
      img.hidden = false;
      $('sp-avatar-initials').textContent = '';
    } else {
      $('sp-avatar-initials').textContent = initials(name);
    }
    const dot = $('sp-dot');
    if (dot) { dot.hidden = false; dot.classList.toggle('is-closed', s.isOpen === false); }
    const tick = $('sp-verified');
    if (tick && (s.sellerBadges || []).indexOf('verified') !== -1) { tick.innerHTML = TICK; tick.hidden = false; }
  }

  /** Where the cover's back arrow goes (one step back: cart -> store, checkout -> cart, order received -> store). */
  function setBack(href) {
    const a = $('sp-back');
    if (a && href) a.setAttribute('href', href);
  }

  // The ⋮ menu and the cart button are made by header-menu.js and
  // header-cart.js at DOMContentLoaded, so this runs a tick later; they go
  // back into the header if the window grows to computer width.
  function placeHeaderTools() {
    const cover = $('sp-cover');
    const home = document.querySelector('header.site-header .header-top-row');
    if (!cover || !home || !QUERY) return;
    [$('header-cart-link'), document.querySelector('.header-menu')].filter(Boolean)
      .forEach((el) => (QUERY.matches ? cover : home).appendChild(el));
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(placeHeaderTools, 0);
    if (QUERY) {
      if (QUERY.addEventListener) QUERY.addEventListener('change', placeHeaderTools);
      else if (QUERY.addListener) QUERY.addListener(placeHeaderTools);
    }
    // The order sign-in screen (customer-login.html?reason=order, flagged on
    // <html> before first paint): the cover of the store being ordered from.
    if (document.documentElement.classList.contains('auth-for-store') && typeof Api !== 'undefined') {
      let slug = '';
      try { slug = localStorage.getItem('skiri_active_store') || ''; } catch (e) { /* private mode */ }
      if (!slug) return;
      setBack('cart.html');
      Api.get('getStorePublicInfo', { storeSlug: slug }).then((r) => { if (r && r.ok && r.store) fill(r.store); });
    }
  });

  return { fill, setBack, placeHeaderTools };
})();
