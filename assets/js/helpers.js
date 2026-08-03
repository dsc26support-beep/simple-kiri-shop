function formatMoney(amount) {
  return APP_CONFIG.CURRENCY_SYMBOL + Number(amount || 0).toFixed(2);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

// Kept in sync with the category <select> options in owner/products.html.
const CATEGORIES = [
  { id: 'pantry', label: 'Pantry / Food' },
  { id: 'clothing', label: 'Clothing' },
  { id: 'household', label: 'Household' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'general', label: 'General' }
];

function renderCategoryButtons(containerId) {
  document.getElementById(containerId).innerHTML = CATEGORIES.map(
    (c) => `<a class="btn category-btn" href="search.html?category=${encodeURIComponent(c.id)}">${escapeHtml(c.label)}</a>`
  ).join('');
}

// Self-contained inline-SVG icons (no external icon library/CDN) - keep the
// site working offline-first on limited mobile data.
const DELIVERY_ICON_SVG = {
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="14" height="10"></rect><path d="M15 10h4l3 3v4h-7z"></path><circle cx="6" cy="18" r="1.5"></circle><circle cx="17.5" cy="18" r="1.5"></circle></svg>',
  ship: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l1.5 3h15L21 17"></path><path d="M5 17V10h14v7"></path><rect x="8" y="6" width="3" height="4"></rect><rect x="13" y="6" width="3" height="4"></rect><path d="M12 10V4"></path></svg>',
  airCargo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path></svg>'
};
const DELIVERY_ICON_LABELS = { truck: 'Truck delivery', ship: 'Ship delivery', airCargo: 'Air cargo delivery' };

/** flags: {truck, ship, airCargo} booleans - renders 0-3 small labeled icons. */
function renderDeliveryIcons(flags) {
  flags = flags || {};
  const methods = ['truck', 'ship', 'airCargo'].filter((m) => flags[m]);
  if (methods.length === 0) return '';
  return `<span class="delivery-icons">${methods
    .map(
      (m) =>
        `<span class="delivery-icon" role="img" aria-label="${escapeHtml(DELIVERY_ICON_LABELS[m])}" title="${escapeHtml(DELIVERY_ICON_LABELS[m])}">${DELIVERY_ICON_SVG[m]}</span>`
    )
    .join('')}</span>`;
}

const EYE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const EYE_OFF_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-2.94 4.06M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><path d="M1 1l22 22"></path></svg>';

/**
 * Wraps a password input with a show/hide toggle button. Safe to call once
 * per password field at page init - no-ops if the input isn't found.
 */
function wirePasswordToggle(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'password-field';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'password-toggle';
  btn.setAttribute('aria-label', 'Show password');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = EYE_ICON_SVG;
  wrapper.appendChild(btn);

  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? EYE_ICON_SVG : EYE_OFF_ICON_SVG;
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    btn.setAttribute('aria-pressed', String(!showing));
  });
}
