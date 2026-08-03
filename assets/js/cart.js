// Cart is scoped per store slug in localStorage: one checkout = one vendor,
// since each store arranges payment directly and separately with the
// customer. A shopper can hold separate in-progress carts for different
// stores without one clobbering the other.
const Cart = (function () {
  function storageKey(storeSlug) {
    return 'skiri_cart_' + storeSlug;
  }

  function getCart(storeSlug) {
    try {
      return JSON.parse(localStorage.getItem(storageKey(storeSlug))) || [];
    } catch (err) {
      return [];
    }
  }

  function saveCart(storeSlug, cart) {
    localStorage.setItem(storageKey(storeSlug), JSON.stringify(cart));
  }

  // item: { variantId, productId, label, unitPrice, qty }
  function addItem(storeSlug, item) {
    const cart = getCart(storeSlug);
    const existing = cart.find((line) => line.variantId === item.variantId);
    if (existing) {
      existing.qty += item.qty;
    } else {
      cart.push(item);
    }
    saveCart(storeSlug, cart);
    return cart;
  }

  function updateQty(storeSlug, variantId, qty) {
    let cart = getCart(storeSlug);
    if (qty <= 0) {
      cart = cart.filter((line) => line.variantId !== variantId);
    } else {
      cart.forEach((line) => {
        if (line.variantId === variantId) line.qty = qty;
      });
    }
    saveCart(storeSlug, cart);
    return cart;
  }

  function removeItem(storeSlug, variantId) {
    return updateQty(storeSlug, variantId, 0);
  }

  function clearCart(storeSlug) {
    saveCart(storeSlug, []);
  }

  function getTotal(storeSlug) {
    return getCart(storeSlug).reduce((sum, line) => sum + line.unitPrice * line.qty, 0);
  }

  function getItemCount(storeSlug) {
    return getCart(storeSlug).reduce((sum, line) => sum + line.qty, 0);
  }

  return { getCart, addItem, updateQty, removeItem, clearCart, getTotal, getItemCount };
})();
