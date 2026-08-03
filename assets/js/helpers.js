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
