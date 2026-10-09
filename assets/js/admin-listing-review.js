// Admin: listing review queue and category register (owner/admin.html,
// backend ListingReview.gs). Every number and row here comes from the
// backend; every action is re-checked there (admin email, case version,
// allowed status change), so nothing on this page is trusted by the server.
const ListingReviewAdmin = (() => {
  const STATUS_LABEL = {
    PENDING: 'Pending', IN_REVIEW: 'In review', AWAITING_SELLER: 'Awaiting seller', CORRECTION_REQUIRED: 'Correction requested',
    APPROVED: 'Approved', REJECTED: 'Rejected', DISMISSED: 'Dismissed', CLOSED: 'Closed'
  };
  const ISSUE_LABEL = {
    NAME_DESCRIPTION_MISMATCH: 'Name vs description', CATEGORY_NAME_MISMATCH: 'Name vs category',
    CATEGORY_DESCRIPTION_MISMATCH: 'Description vs category', ATTRIBUTE_REQUIRED: 'Missing detail',
    CATEGORY_REQUEST: 'New category request', CATEGORY_REQUEST_DUPLICATE: 'Category request (possible duplicate)'
  };
  const state = { page: 0, sellers: {}, register: null, openId: '' };
  const $ = (id) => document.getElementById(id);

  function requestId() {
    return (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
  }

  function stat(value, label) {
    return `<div class="admin-stat"><span class="admin-stat-value">${escapeHtml(String(value))}</span><span class="admin-stat-label">${escapeHtml(label)}</span></div>`;
  }

  function filters() {
    return {
      status: $('lr-status').value, severity: $('lr-severity').value, issueType: $('lr-issue').value, categoryId: $('lr-category').value,
      sellerId: $('lr-seller').value, from: $('lr-from').value, to: $('lr-to').value, q: $('lr-q').value.trim(),
      periodDays: Number($('lr-period').value) || 30
    };
  }

  async function loadRegister() {
    const res = await Api.get('listCategories', {});
    if (res.ok && res.categories) {
      state.register = buildListingRegister(res.categories);
    } else if (!state.register) {
      state.register = buildListingRegister(LISTING_CATEGORY_SEED);
    }
    const tops = state.register.list.filter((r) => !r.parentId);
    $('lr-category').innerHTML = '<option value="">Any category</option>' + tops.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  }

  async function load() {
    const status = $('lr-list-status');
    status.textContent = 'Loading…';
    const res = await Api.post('listReviewCases', Object.assign({ token: Auth.getToken(), page: state.page, pageSize: 20 }, filters()));
    if (!res.ok || !res.metrics || !Array.isArray(res.cases)) {
      // Includes an Apps Script deployment older than this page ("Unknown action").
      status.textContent = (res && res.error) || 'Could not load the review queue.';
      return;
    }
    const m = res.metrics;
    $('lr-metrics').innerHTML = stat(m.pending, 'Pending') + stat(m.highPriority, 'High priority') + stat(m.categoryRequests, 'Category requests')
      + stat(m.disputed, 'Disputed by seller') + stat(m.resolvedInPeriod, 'Resolved, last ' + m.periodDays + ' days');
    res.cases.forEach((c) => { if (c.storeName) state.sellers[c.sellerId] = c.storeName; });
    const keep = $('lr-seller').value;
    $('lr-seller').innerHTML = '<option value="">Any seller</option>' + Object.keys(state.sellers).sort((a, b) => state.sellers[a].localeCompare(state.sellers[b]))
      .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(state.sellers[id])}</option>`).join('');
    $('lr-seller').value = keep;
    status.textContent = res.total ? `${res.total} case(s). Page ${res.page + 1} of ${Math.max(1, Math.ceil(res.total / res.pageSize))}.` : 'No cases match.';
    $('lr-list').innerHTML = res.cases.map(caseRowHtml).join('');
    $('lr-prev').disabled = res.page === 0;
    $('lr-next').disabled = !res.hasMore;
    if (state.openId && res.cases.some((c) => c.reviewId === state.openId)) openCase(state.openId);
  }

  function caseRowHtml(c) {
    const title = c.caseType === 'CATEGORY_REQUEST' ? 'Category request: ' + (c.proposedCategoryName || '') : (c.productName || c.productId);
    return `<article class="lr-case" data-review-id="${escapeHtml(c.reviewId)}">
      <div class="lr-case-head">
        <span class="lr-sev lr-sev--${escapeHtml(c.severity || 'low')}">${escapeHtml(c.severity || '-')}</span>
        <strong>${escapeHtml(title)}</strong>
        <span class="lr-status">${escapeHtml(STATUS_LABEL[c.status] || c.status)}</span>
        <button type="button" class="btn btn-small lr-open" data-open="${escapeHtml(c.reviewId)}" aria-expanded="false">Open</button>
      </div>
      <p class="helper-text">${escapeHtml([c.storeName, ISSUE_LABEL[c.issueType] || c.issueType, c.categoryPath, c.disputed ? 'seller disputes' : '', String(c.submittedAt || '').slice(0, 10)].filter(Boolean).join(' · '))}</p>
      <p class="helper-text">${escapeHtml(c.reason || '')}</p>
      <div class="lr-detail" hidden></div>
    </article>`;
  }

  function categoryOptionsHtml(selected, opts) {
    const reg = state.register;
    const rows = reg.list.filter((r) => r.active && (!opts || !opts.topOnly || !r.parentId));
    return rows.map((r) => `<option value="${escapeHtml(r.id)}"${r.id === selected ? ' selected' : ''}>${escapeHtml(listingCategoryPath(reg, r.id))}</option>`).join('');
  }

  function subOptionsHtml(parentId, selected) {
    return '<option value="">(no subcategory)</option>' + state.register.list.filter((r) => r.parentId === parentId && r.active)
      .map((r) => `<option value="${escapeHtml(r.id)}"${r.id === selected ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  }

  function issuesHtml(v) {
    if (!v || !v.issues || !v.issues.length) return '<p class="helper-text">No problems found.</p>';
    return '<ul>' + v.issues.map((i) => `<li><span class="lr-sev lr-sev--${escapeHtml(i.severity)}">${escapeHtml(i.severity)}</span> ${escapeHtml(i.message)}</li>`).join('') + '</ul>';
  }

  function detailHtml(c) {
    const open = ['PENDING', 'IN_REVIEW', 'AWAITING_SELLER', 'CORRECTION_REQUIRED'].indexOf(c.status) !== -1;
    const decided = ['APPROVED', 'REJECTED', 'DISMISSED'].indexOf(c.status) !== -1;
    const rows = [];
    const dl = (k, v) => rows.push(`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v == null || v === '' ? '-' : String(v))}</dd>`);
    let body = '';
    if (c.caseType === 'LISTING') {
      dl('Store', c.storeName);
      dl('Submitted name', c.productName);
      dl('Submitted description', c.descriptionSnapshot);
      dl('Submitted category', c.categoryPath);
      dl('Seller’s note', c.sellerNote);
      if (c.product) {
        dl('Product now', c.product.name + ' (' + c.product.status + ')');
        dl('Category now', c.product.categoryPath);
        dl('Options', c.product.variants.map((x) => x.label + ' ' + formatMoney(x.price)).join(', '));
      } else {
        dl('Product now', 'No longer exists');
      }
      body += `<dl>${rows.join('')}</dl>`
        + (c.product && c.product.imageUrl ? `<p><img src="${escapeHtml(optimizedImageUrl(c.product.imageUrl, IMG_W.card))}" alt="Product photo" style="max-width:10rem;border-radius:8px"></p>` : '')
        + '<h4>When submitted</h4>' + issuesHtml(c.validationAtSubmit)
        + (c.currentValidation ? '<h4>Checked again now</h4>' + issuesHtml(c.currentValidation) : '')
        + (c.suggestions && c.suggestions.length ? '<p class="helper-text">Suggested: ' + c.suggestions.map((s) => escapeHtml(s.path)).join('; ') + '</p>' : '');
    } else {
      dl('Store', c.storeName);
      dl('Proposed name', c.proposedCategoryName);
      dl('Suggested parent', c.proposedParentPath || 'Not sure');
      dl('What would go in it', c.sellerNote);
      dl('Example products', c.examples);
      dl('Possible duplicate of', c.duplicatePath || c.duplicateOf);
      body += `<dl>${rows.join('')}</dl>`;
    }
    if (c.resolutionType) body += `<p class="helper-text">Decision: ${escapeHtml(c.resolutionType)}${c.resolutionReason ? ' — ' + escapeHtml(c.resolutionReason) : ''}</p>`;

    let actions = `<div class="field"><label for="lr-reason-${escapeHtml(c.reviewId)}">Reason (shown to the seller for a correction or rejection; kept in the audit log)</label>
      <textarea id="lr-reason-${escapeHtml(c.reviewId)}" class="lr-reason" rows="2" maxlength="1000"></textarea></div>`;
    const btn = (decision, label, cls) => `<button type="button" class="btn btn-small ${cls || ''}" data-decision="${decision}">${escapeHtml(label)}</button>`;
    if (c.caseType === 'LISTING' && open) {
      const catNow = c.product ? c.product.categoryId : c.selectedCategoryId;
      const subNow = c.product ? c.product.subcategoryId : c.selectedSubcategoryId;
      actions += `<div class="lr-actions-row">${c.status === 'IN_REVIEW' ? btn('release', 'Release') : btn('start', 'Start review')}${btn('approve', 'Approve', 'btn-light-purple')}</div>
        <div class="lr-filters">
          <div class="field"><label for="lr-assign-cat-${escapeHtml(c.reviewId)}">Assign category</label>
            <select id="lr-assign-cat-${escapeHtml(c.reviewId)}" class="lr-assign-cat">${categoryOptionsHtml(catNow, { topOnly: true })}</select></div>
          <div class="field"><label for="lr-assign-sub-${escapeHtml(c.reviewId)}">Subcategory</label>
            <select id="lr-assign-sub-${escapeHtml(c.reviewId)}" class="lr-assign-sub">${subOptionsHtml(catNow, subNow)}</select></div>
          <div class="field">${btn('assignCategory', 'Assign & re-check')}</div>
        </div>
        <div class="lr-actions-row">${btn('requestCorrection', 'Request correction')}${btn('reject', 'Reject', 'btn-danger')}${btn('dismiss', 'Dismiss (false positive)')}${btn('override', 'Override & publish')}</div>`;
    } else if (c.caseType === 'CATEGORY_REQUEST' && open) {
      actions += `<div class="lr-filters">
          <div class="field"><label for="lr-cat-name-${escapeHtml(c.reviewId)}">Name</label><input id="lr-cat-name-${escapeHtml(c.reviewId)}" class="lr-cat-name" maxlength="40" value="${escapeHtml(c.proposedCategoryName || '')}"></div>
          <div class="field"><label for="lr-cat-parent-${escapeHtml(c.reviewId)}">Parent</label><select id="lr-cat-parent-${escapeHtml(c.reviewId)}" class="lr-cat-parent">${categoryOptionsHtml(c.proposedParentId, { topOnly: true })}</select></div>
          <div class="field"><label for="lr-cat-kw-${escapeHtml(c.reviewId)}">Keywords (comma separated)</label><input id="lr-cat-kw-${escapeHtml(c.reviewId)}" class="lr-cat-kw" maxlength="500"></div>
          <div class="field">${btn('approveCategory', 'Approve category', 'btn-light-purple')}</div>
        </div>
        <div class="lr-filters">
          <div class="field"><label for="lr-merge-${escapeHtml(c.reviewId)}">Or merge into</label><select id="lr-merge-${escapeHtml(c.reviewId)}" class="lr-merge">${categoryOptionsHtml(c.duplicateOf)}</select></div>
          <div class="field">${btn('mergeCategory', 'Merge')}</div>
          <div class="field">${btn('reject', 'Reject', 'btn-danger')}</div>
        </div>`;
    } else {
      actions += `<div class="lr-actions-row">${decided ? btn('close', 'Close (final)') : ''}${btn('reopen', 'Reopen')}</div>`;
    }
    body += `<div class="lr-actions" data-version="${escapeHtml(String(c.version))}">${actions}<p class="lr-msg form-error" role="alert"></p></div>`;
    body += '<h4>History</h4><ol class="lr-history">' + (c.history || []).map((h) =>
      `<li>${escapeHtml(String(h.at || '').replace('T', ' ').slice(0, 16))} — ${escapeHtml(h.role || '')}: ${escapeHtml((h.from || 'new') + ' → ' + h.to)}${h.note ? ' — ' + escapeHtml(h.note) : ''}</li>`).join('') + '</ol>';
    if (c.otherCases && c.otherCases.length) {
      body += '<p class="helper-text">Earlier cases on this product: ' + c.otherCases.map((o) => escapeHtml(o.reviewId + ' ' + (STATUS_LABEL[o.status] || o.status))).join('; ') + '</p>';
    }
    return body;
  }

  async function openCase(reviewId) {
    const article = document.querySelector(`.lr-case[data-review-id="${CSS.escape(reviewId)}"]`);
    if (!article) return;
    const detail = article.querySelector('.lr-detail');
    detail.hidden = false;
    detail.textContent = 'Loading…';
    article.querySelector('[data-open]').setAttribute('aria-expanded', 'true');
    state.openId = reviewId;
    const res = await Api.post('getReviewCase', { token: Auth.getToken(), reviewId });
    if (!res.ok) {
      detail.textContent = res.error || 'Could not load this case.';
      return;
    }
    detail.innerHTML = detailHtml(res.case);
    detail.dataset.caseType = res.case.caseType;
  }

  const CONFIRM = {
    approve: 'Approve and publish this listing?', override: 'Override the checks and publish this listing? Your reason is logged.',
    dismiss: 'Dismiss as a false positive and publish? Your reason is logged.', reject: 'Reject this? The seller is told your reason.',
    approveCategory: 'Add this category to the register? Sellers can use it straight away.', mergeCategory: 'Merge this request into the chosen category?',
    reopen: 'Reopen this case? A listing that fails the checks is hidden again.', requestCorrection: 'Send this correction request to the seller?',
    assignCategory: 'Move the listing to this category and re-check it?'
  };

  async function decide(article, decision, button) {
    const reviewId = article.dataset.reviewId;
    const detail = article.querySelector('.lr-detail');
    const box = detail.querySelector('.lr-actions');
    const msg = box.querySelector('.lr-msg');
    msg.textContent = '';
    if (CONFIRM[decision] && !confirm(CONFIRM[decision])) return;
    const payload = { token: Auth.getToken(), reviewId, decision, expectedVersion: Number(box.dataset.version),
      reason: (box.querySelector('.lr-reason') || {}).value || '', requestId: button.dataset.requestId || (button.dataset.requestId = requestId()) };
    if (decision === 'assignCategory') {
      payload.categoryId = box.querySelector('.lr-assign-cat').value;
      payload.subcategoryId = box.querySelector('.lr-assign-sub').value;
    } else if (decision === 'approveCategory') {
      payload.name = box.querySelector('.lr-cat-name').value.trim();
      payload.parentId = box.querySelector('.lr-cat-parent').value;
      payload.keywords = box.querySelector('.lr-cat-kw').value.trim();
    } else if (decision === 'mergeCategory') {
      payload.categoryId = box.querySelector('.lr-merge').value;
    }
    button.disabled = true;
    const res = await Api.post('reviewCaseAction', payload);
    button.disabled = false;
    if (!res.ok) {
      if (!/^Network error/.test(res.error || '')) delete button.dataset.requestId;
      msg.textContent = res.error || 'That did not work.';
      if (res.conflict) openCase(reviewId);
      return;
    }
    delete button.dataset.requestId;
    if (decision === 'approveCategory') await loadRegister();
    await load();
    const after = document.querySelector(`.lr-case[data-review-id="${CSS.escape(reviewId)}"] .lr-msg`);
    const text = res.message || ('Done: ' + (STATUS_LABEL[res.status] || res.status) + '.');
    $('lr-list-status').textContent = text;
    if (after) after.textContent = res.stillBlocked ? text : '';
  }

  /* ---- category register ---- */
  async function loadCategories() {
    const status = $('lr-cats-status');
    status.textContent = 'Loading…';
    const res = await Api.post('adminListCategories', { token: Auth.getToken() });
    if (!res.ok) {
      status.textContent = res.error || 'Could not load categories.';
      return;
    }
    status.textContent = '';
    const byId = {};
    res.categories.forEach((c) => { byId[c.id] = c; });
    const path = (c) => (c.parentId && byId[c.parentId] ? byId[c.parentId].name + ' → ' : '') + c.name;
    const sorted = res.categories.slice().sort((a, b) => path(a).localeCompare(path(b)));
    $('lr-cats').querySelector('tbody').innerHTML = sorted.map((c) => `<tr data-category-id="${escapeHtml(c.id)}">
      <td>${escapeHtml(path(c))}<br><span class="helper-text">${escapeHtml(c.id)}</span></td>
      <td>${escapeHtml(c.status === 'inactive' ? 'off' : 'on')}</td>
      <td>${escapeHtml(String(c.products))}</td>
      <td><label class="sr-only" for="kw-${escapeHtml(c.id)}">Keywords for ${escapeHtml(c.name)}</label><input id="kw-${escapeHtml(c.id)}" class="lr-kw" value="${escapeHtml(c.keywords || '')}" maxlength="1000"></td>
      <td><button type="button" class="btn btn-small" data-cat-save>Save keywords</button>
        ${c.id === 'other' ? '' : `<button type="button" class="btn btn-small" data-cat-toggle="${c.status === 'inactive' ? 'active' : 'inactive'}">${c.status === 'inactive' ? 'Switch on' : 'Switch off'}</button>`}</td>
    </tr>`).join('');
  }

  async function onCategoryClick(e) {
    const row = e.target.closest('tr[data-category-id]');
    if (!row) return;
    const id = row.dataset.categoryId;
    let payload = null;
    if (e.target.closest('[data-cat-toggle]')) {
      const to = e.target.closest('[data-cat-toggle]').dataset.catToggle;
      if (!confirm(to === 'inactive' ? 'Switch this category off? Listings already in it stay; new listings cannot choose it.' : 'Switch this category back on?')) return;
      payload = { categoryId: id, status: to };
    } else if (e.target.closest('[data-cat-save]')) {
      payload = { categoryId: id, keywords: row.querySelector('.lr-kw').value };
    }
    if (!payload) return;
    const res = await Api.post('adminSaveCategory', Object.assign({ token: Auth.getToken(), requestId: requestId() }, payload));
    $('lr-cats-status').textContent = res.ok ? 'Saved.' : (res.error || 'Could not save.');
    if (res.ok) { loadCategories(); loadRegister(); }
  }

  function init() {
    if (!$('listing-review')) return;
    $('lr-filter-form').addEventListener('submit', (e) => { e.preventDefault(); state.page = 0; load(); });
    $('lr-filter-form').addEventListener('change', (e) => { if (e.target.id !== 'lr-q') { state.page = 0; load(); } });
    $('lr-prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); load(); });
    $('lr-next').addEventListener('click', () => { state.page += 1; load(); });
    $('lr-list').addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) {
        const article = opener.closest('.lr-case');
        const detail = article.querySelector('.lr-detail');
        if (!detail.hidden) { detail.hidden = true; opener.setAttribute('aria-expanded', 'false'); state.openId = ''; return; }
        openCase(opener.dataset.open);
        return;
      }
      const d = e.target.closest('[data-decision]');
      if (d) decide(d.closest('.lr-case'), d.dataset.decision, d);
    });
    $('lr-list').addEventListener('change', (e) => {
      if (!e.target.classList.contains('lr-assign-cat')) return;
      e.target.closest('.lr-actions').querySelector('.lr-assign-sub').innerHTML = subOptionsHtml(e.target.value, '');
    });
    $('lr-cats-panel').addEventListener('toggle', () => { if ($('lr-cats-panel').open) loadCategories(); });
    $('lr-cats').addEventListener('click', onCategoryClick);
    loadRegister().then(load);
  }

  return { init };
})();
