// Listing checks on the seller's product form (owner/products.html).
//
// The rules themselves are listing-rules.js - a generated copy of the
// backend's apps-script/ListingRules.gs - so what this shows while typing is
// what the backend will decide on Save. The backend runs them again on every
// save regardless; nothing here is trusted by the server.
//
// The register (categories, subcategories, keywords) comes from the public
// listCategories action. Until it arrives - or if it can't be fetched on a
// bad connection - the starter register built into listing-rules.js is used,
// so the form never waits on it.
const ListingCheck = (() => {
  let rows = LISTING_CATEGORY_SEED.slice();
  let register = buildListingRegister(rows);
  let timer = null;
  let lastInput = null;
  // The buttons a refused Save earned (Submit for review / Save anyway) and
  // the listing they were for. A later live re-check keeps them while the
  // listing is unchanged, and drops them once the seller edits it.
  let held = { flags: null, key: '' };
  const keyOf = (input) => JSON.stringify([input.name, input.description, input.categoryId, input.subcategoryId, input.listingType]);

  async function load() {
    const res = await Api.get('listCategories', {});
    if (res && res.ok && Array.isArray(res.categories) && res.categories.length) {
      rows = res.categories;
      register = buildListingRegister(rows);
    }
    return register;
  }

  function isActive(id) {
    const r = register.byId[id];
    return !r || r.active;   // a category the register doesn't know is left to the site list
  }

  /** Subcategory options under one category. keepId stays offered even if switched off. */
  function fillSubcategories(categoryId, keepId) {
    const field = document.getElementById('subcategory-field');
    const select = document.getElementById('product-subcategory');
    const kids = register.list.filter((r) => r.parentId === categoryId && (r.active || r.id === keepId));
    field.hidden = kids.length === 0;
    select.innerHTML = '<option value="">Choose one (optional)…</option>' + kids.map((r) =>
      `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}${r.active ? '' : ' (no longer offered)'}</option>`).join('');
    select.value = kids.some((r) => r.id === keepId) ? keepId : '';
  }

  function parentOptionsHtml() {
    return '<option value="">Not sure</option>' + register.list.filter((r) => !r.parentId && r.active && r.id !== 'other')
      .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  }

  /** The form's input at the moment of a refused Save (so its buttons can be kept). */
  function remember(input) { lastInput = input; }

  function forget() { held = { flags: null, key: '' }; }

  function check(input) {
    lastInput = input;
    return validateListing(input, register);
  }

  /**
   * Draws the panel. flags (from a refused Save) add the buttons that only
   * make sense after the backend said no: Submit for review / Save anyway.
   */
  function render(result, flags) {
    if (flags) {
      clearTimeout(timer);
      held = { flags, key: lastInput ? keyOf(lastInput) : '' };
    }
    const box = document.getElementById('listing-check');
    const shown = result.issues.filter((i) => i.severity !== 'low');
    const tips = result.issues.filter((i) => i.severity === 'low');
    if (!shown.length && !tips.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const level = result.blocked ? 'high' : (shown.length ? 'medium' : 'low');
    const title = result.blocked ? 'Please check this listing' : (shown.length ? 'Possible mismatch' : 'Tip');
    const suggestions = result.suggestions.length
      ? `<p class="listing-check-sub">Suggested categories:</p><div class="listing-check-suggestions">${result.suggestions.map((s) =>
        `<button type="button" class="btn btn-small btn-light-purple" data-apply-category="${escapeHtml(s.categoryId)}" data-apply-sub="${escapeHtml(s.subcategoryId)}">Use ${escapeHtml(s.path)}</button>`).join('')}</div>`
      : '';
    const f = flags || {};
    let actions = '';
    if (f.canSubmitForReview) {
      actions = `<div class="field listing-check-note"><label for="listing-review-note">If you think the listing is right, tell the reviewer why (optional)</label>
        <textarea id="listing-review-note" maxlength="500" rows="2"></textarea></div>
        <p><button type="button" class="btn btn-small" id="listing-submit-review">Submit for review</button></p>
        <p class="helper-text">It is saved but hidden from shoppers until an admin checks it.</p>`;
    } else if (f.canSaveAnyway) {
      actions = `<p><button type="button" class="btn btn-small" id="listing-save-anyway">Save anyway</button></p>
        <p class="helper-text">It goes live, and an admin may take a look.</p>`;
    }
    box.className = 'listing-check listing-check--' + level;
    box.innerHTML = `<p class="listing-check-title"><strong>${escapeHtml(title)}</strong></p>`
      + shown.map((i) => `<p>${escapeHtml(i.message)}</p>`).join('')
      + (shown.length ? '<p class="helper-text">Edit the product name or description above, or choose another category.</p>' : '')
      + suggestions
      + tips.map((i) => `<p class="helper-text">${escapeHtml(i.message)}</p>`).join('')
      + actions;
    box.hidden = false;
  }

  /** Re-checks a moment after typing stops, so it isn't redrawn on every key. */
  function schedule(readInput) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const input = readInput();
      if (!input.name.trim() || !input.categoryId) {
        render({ issues: [], suggestions: [] });
        return;
      }
      const result = check(input);
      render(result, held.flags && held.key === keyOf(input) ? held.flags : null);
    }, 350);
  }

  function categoryPath(id) { return listingCategoryPath(register, id); }

  return { load, remember, forget, isActive, fillSubcategories, parentOptionsHtml, check, render, schedule, categoryPath, get register() { return register; }, get lastInput() { return lastInput; } };
})();
