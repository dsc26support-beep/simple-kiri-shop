document.addEventListener('DOMContentLoaded', init);

function init() {
  renderCategoryButtons('category-buttons');
  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  window.location.href = `search.html?q=${encodeURIComponent(q)}`;
}
