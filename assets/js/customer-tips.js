document.addEventListener('DOMContentLoaded', init);

async function init() {
  const statusEl = document.getElementById('tips-status');
  const stop = startLoadingMessage(statusEl);
  const res = await Api.get('getTips', {});
  stop();

  if (!res.ok) {
    showLoadFailedMessage(statusEl);
    return;
  }

  const stores = res.stores || [];
  const products = res.products || [];
  if (stores.length === 0 && products.length === 0) {
    statusEl.textContent = 'No featured items yet. Check back soon!';
    return;
  }
  statusEl.textContent = '';

  if (stores.length) {
    document.getElementById('tips-stores').innerHTML = stores.map(renderLogoCarouselItem).join('');
    document.getElementById('tips-stores-wrap').classList.remove('hidden');
  }
  if (products.length) {
    document.getElementById('tips-products').innerHTML = products.map((p) => renderBrowseProductCard(p)).join('');
    document.getElementById('tips-products-wrap').classList.remove('hidden');
  }
}
