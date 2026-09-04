// Cart button in the page header, on every customer-facing page.
//
// It exists because the bottom bar's Cart tab became Browse: without this
// there would be no way to the cart from the homepage, search, or the category
// page itself. The store page's floating "Cart (N)" button is untouched and
// still does its own job.
//
// It points at my-carts.html rather than cart.html because carts are
// per-store: cart.html shows ONE store's cart and, with nothing to tell it
// which, fell back to whichever store was visited last. my-carts.html lists
// them all, and sends a shopper with a single cart straight into it.
//
// Injected rather than written into each page's markup, because the headers
// are not a shared component - index, store, search and cart all differ - and
// keeping ten copies of this in sync by hand is how they drift.
document.addEventListener('DOMContentLoaded', initHeaderCart);

function initHeaderCart() {
  const header = document.querySelector('header.site-header');
  if (!header || document.getElementById('header-cart-link')) return;

  // Prefer the top row where there is one; search.html's header is a plain
  // .container, so fall back to the first one rather than skipping the page.
  const host = header.querySelector('.header-top-row') || header.querySelector('.container');
  if (!host) return;

  const link = document.createElement('a');
  link.id = 'header-cart-link';
  link.className = 'header-cart';
  link.href = 'my-carts.html';
  link.setAttribute('aria-label', 'Your carts');
  link.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle>' +
    '<path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>' +
    '<span class="header-cart-badge" id="header-cart-badge" hidden></span>';

  host.appendChild(link);
  updateHeaderCartBadge();
}

// Local read only - no request, so this is safe to run inline at
// DOMContentLoaded rather than deferring it like the backend-backed badges.
function updateHeaderCartBadge() {
  const badge = document.getElementById('header-cart-badge');
  if (!badge) return;
  const total = totalCartItemCount();
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}
