// Product photo gallery on the seller's product form (owner/products.html).
//
// Up to `max` photos (the backend says how many; default 6), cover first.
// Nothing is sent while the seller arranges them: Save Product saves the
// listing first, then apply() does the photo work in an order that never
// loses a photo that is already there -
//   1. replacements go up in place (the old file is deleted by the server
//      only after the new one is stored);
//   2. removals and the new order of the photos already saved;
//   3. new photos are added;
//   4. the final order is set if the new photos moved.
// A photo that fails stays on screen marked "didn't upload" with Retry, and
// a failed replacement keeps the old photo. Every upload carries its own
// requestId, so a retry after a dropped connection never stores it twice.
//
// Photos are made smaller in the browser first (optimizeProductPhoto) - the
// server still checks what the bytes really are (Images.gs).
const ProductPhotos = (() => {
  const $ = (id) => document.getElementById(id);
  // Longest side sent, and when a photo is already small enough to send as is.
  // 1280px / WebP 0.75 measured the same size as the old JPEG uploads (about
  // 100KB for a 12MP phone photo) while keeping transparency - see
  // docs/product-upload-testing.md. Larger settings doubled the data.
  const MAX_SIDE = 1280;
  const WEBP_QUALITY = 0.75;
  const KEEP_AS_IS_BYTES = 400 * 1024;
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

  let max = 6;
  let items = [];        // { key, id, url, file, preview, replaceOf, req, state: 'saved'|'pending'|'failed', error }
  let removed = [];      // saved photo ids the seller removed
  let serverOrder = [];  // the saved ids, in the order the server has them
  let replaceKey = null;
  let seq = 0;
  let onChange = () => {};

  function newReq() {
    return (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  }

  /* ---------- making a photo smaller ---------- */

  function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /**
   * { base64, mimeType } ready to upload, or throws Error(message for the seller).
   * Resizes to MAX_SIDE, prefers WebP (keeps transparency) where the browser
   * can write it, else JPEG on white. A JPEG/WebP that is already small and
   * not too big is sent untouched rather than re-compressed.
   */
  async function optimizeProductPhoto(file) {
    const heic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');
    let img;
    try {
      img = await decode(file);
    } catch (e) {
      throw new Error(heic
        ? `${file.name}: this phone or browser can't open HEIC photos. Set the camera to "Most compatible" (JPEG), or choose a JPEG or PNG.`
        : `${file.name} could not be read as a photo.`);
    }
    const w = img.width, h = img.height;
    if (!w || !h) throw new Error(`${file.name} could not be read as a photo.`);
    if (/^image\/(jpeg|webp)$/.test(file.type) && file.size <= KEEP_AS_IS_BYTES && Math.max(w, h) <= MAX_SIDE) {
      if (img.close) img.close();
      return { base64: await readAsBase64(file), mimeType: file.type };
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (img.close) img.close();
    let blob = await toBlob(canvas, 'image/webp', WEBP_QUALITY);
    if (!blob || blob.type !== 'image/webp') {
      // No WebP here (older Safari): JPEG, with see-through parts on white.
      const flat = document.createElement('canvas');
      flat.width = canvas.width; flat.height = canvas.height;
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#fff';
      fctx.fillRect(0, 0, flat.width, flat.height);
      fctx.drawImage(canvas, 0, 0);
      blob = await toBlob(flat, 'image/jpeg', WEBP_QUALITY);
    }
    if (!blob) throw new Error(`${file.name} could not be prepared for upload.`);
    for (let q = 0.7; blob.size > MAX_UPLOAD_BYTES && q > 0.3; q -= 0.15) blob = await toBlob(canvas, blob.type, q);
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is too large even after shrinking it.`);
    return { base64: await readAsBase64(blob), mimeType: blob.type };
  }

  /* ---------- state ---------- */

  function release(it) { if (it.preview) { URL.revokeObjectURL(it.preview); it.preview = ''; } }

  function load(images, opts) {
    items.forEach(release);
    items = (images || []).map((im) => ({ key: 'k' + (++seq), id: im.id, url: im.url, state: 'saved' }));
    if (opts && opts.duplicate) items = [];
    removed = [];
    serverOrder = items.map((it) => it.id);
    if (opts && opts.max) max = opts.max;
    setMsg('');
    render();
  }

  function setMax(n) { if (n > 0) { max = n; render(); } }

  function dirty() { onChange(); if (typeof UnsavedGuard !== 'undefined') UnsavedGuard.markDirty($('product-form')); }

  function addFiles(files) {
    setMsg('');
    const list = Array.from(files || []).filter((f) => f && (/^image\//.test(f.type) || /\.(hei[cf]|jpe?g|png|webp|gif)$/i.test(f.name || '')));
    if (!list.length) { setMsg('Choose photos (JPEG, PNG or WebP).'); return; }
    const room = max - items.length;
    if (room <= 0) { setMsg(`This product already has ${max} photos. Remove one to add another.`); return; }
    if (list.length > room) setMsg(`Only ${room} more photo${room === 1 ? '' : 's'} fit - the first ${room} were added.`);
    list.slice(0, room).forEach((file) => items.push({ key: 'k' + (++seq), file, preview: URL.createObjectURL(file), req: newReq(), state: 'pending' }));
    dirty();
    render();
  }

  function replaceWith(key, file) {
    const it = items.find((x) => x.key === key);
    if (!it || !file) return;
    release(it);
    // A saved photo is replaced in place; a photo not uploaded yet simply changes.
    if (it.id) it.replaceOf = it.replaceOf || it.id;
    it.file = file;
    it.preview = URL.createObjectURL(file);
    it.req = newReq();
    it.state = 'pending';
    it.error = '';
    dirty();
    render();
  }

  function removeItem(key) {
    const i = items.findIndex((x) => x.key === key);
    if (i === -1) return;
    const it = items[i];
    const savedId = it.replaceOf || it.id;
    if (savedId) removed.push(savedId);
    release(it);
    items.splice(i, 1);
    dirty();
    render();
  }

  function move(key, to) {
    const i = items.findIndex((x) => x.key === key);
    if (i === -1 || to < 0 || to >= items.length || to === i) return;
    const [it] = items.splice(i, 1);
    items.splice(to, 0, it);
    dirty();
    render(key);
  }

  /* ---------- drawing ---------- */

  function setMsg(text) { const m = $('photo-msg'); if (m) m.textContent = text || ''; }

  function itemHtml(it, i) {
    const src = it.preview || optimizedImageUrl(it.url, IMG_W.thumb);
    const n = i + 1;
    const status = it.state === 'failed'
      ? `<span class="pg-status pg-status--failed">Didn't upload${it.error ? ': ' + escapeHtml(it.error) : ''}</span>`
      : it.state === 'pending' ? `<span class="pg-status">${it.replaceOf ? 'Replaces the old photo when you save' : 'Uploads when you save'}</span>` : '';
    return `<li class="pg-item${i === 0 ? ' pg-item--cover' : ''}" data-key="${escapeHtml(it.key)}">
        <div class="pg-thumb"><img src="${escapeHtml(src)}" alt="Photo ${n}${i === 0 ? ' (cover)' : ''}" decoding="async"></div>
        ${i === 0 ? '<span class="pg-cover">Cover</span>' : ''}
        ${status}
        <div class="pg-actions">
          ${i > 0 ? `<button type="button" class="btn btn-small pg-act" data-act="cover">Make cover</button>` : ''}
          <button type="button" class="btn btn-small pg-act pg-icon" data-act="left" aria-label="Move photo ${n} earlier"${i === 0 ? ' disabled' : ''}>&#8249;</button>
          <button type="button" class="btn btn-small pg-act pg-icon" data-act="right" aria-label="Move photo ${n} later"${i === items.length - 1 ? ' disabled' : ''}>&#8250;</button>
          <button type="button" class="btn btn-small pg-act" data-act="replace" aria-label="Replace photo ${n}">Replace</button>
          <button type="button" class="btn btn-small btn-danger pg-act" data-act="remove" aria-label="Remove photo ${n}">Remove</button>
        </div>
      </li>`;
  }

  function render(focusKey) {
    const list = $('photo-list');
    if (!list) return;
    const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('.pg-item');
    const act = active && document.activeElement.dataset.act;
    list.innerHTML = items.map(itemHtml).join('');
    $('photo-count').textContent = `${items.length} of ${max}`;
    $('photo-add-row').hidden = items.length >= max;
    $('photo-add-row').classList.toggle('pg-add--empty', items.length === 0);
    // Keep keyboard focus on the moved photo's same button.
    const k = focusKey || (active && active.dataset.key);
    if (k && act) {
      const btn = list.querySelector(`.pg-item[data-key="${CSS.escape(k)}"] [data-act="${act}"]:not([disabled])`)
        || list.querySelector(`.pg-item[data-key="${CSS.escape(k)}"] [data-act="replace"]`);
      if (btn) btn.focus();
    }
  }

  function onListClick(e) {
    const b = e.target.closest('.pg-act');
    if (!b) return;
    const li = b.closest('.pg-item');
    const key = li.dataset.key;
    const i = items.findIndex((x) => x.key === key);
    const act = b.dataset.act;
    if (act === 'cover') move(key, 0);
    else if (act === 'left') move(key, i - 1);
    else if (act === 'right') move(key, i + 1);
    else if (act === 'remove') removeItem(key);
    else if (act === 'replace') { replaceKey = key; $('photo-replace-input').value = ''; $('photo-replace-input').click(); }
  }

  /* ---------- saving ---------- */

  async function upload(productId, it, replaceId) {
    let data;
    try { data = await optimizeProductPhoto(it.file); } catch (e) { return { ok: false, error: e.message, final: true }; }
    return Api.post('uploadProductPhoto', { token: Auth.getToken(), productId, imageBase64: data.base64, mimeType: data.mimeType,
      replaceId: replaceId || '', requestId: it.req });
  }

  function savedIdsInOrder() {
    // A replacement that has not gone up yet still holds its old photo's place.
    return items.map((it) => (it.state === 'saved' ? it.id : it.replaceOf || '')).filter(Boolean);
  }

  async function setOrder(productId, order) {
    const same = order.length === serverOrder.length && order.every((id, i) => id === serverOrder[i]);
    if (same) return { ok: true };
    const res = await Api.post('setProductPhotos', { token: Auth.getToken(), productId, order });
    if (res.ok) serverOrder = res.images.map((i) => i.id);
    return res;
  }

  /**
   * After the product is saved. onProgress(text) for the Save button.
   * Returns a list of problems (empty when everything went up).
   */
  async function apply(productId, onProgress) {
    const problems = [];
    const report = (it, res) => { it.state = 'failed'; it.error = res.error || 'try again'; problems.push(it.error); };
    const todo = items.filter((it) => it.state !== 'saved');
    let done = 0;
    const tick = () => onProgress && onProgress(`Uploading photo ${Math.min(++done, todo.length)} of ${todo.length}`);

    // 1. Replacements, in place.
    for (const it of items.filter((x) => x.state !== 'saved' && x.replaceOf)) {
      tick();
      const res = await upload(productId, it, it.replaceOf);
      if (!res.ok) { report(it, res); continue; }
      release(it);
      Object.assign(it, { id: res.imageId, url: (res.images.find((x) => x.id === res.imageId) || {}).url, state: 'saved', replaceOf: '', file: null, error: '' });
      serverOrder = res.images.map((x) => x.id);
    }
    // 2. Removals and the order of what is already saved.
    // (setOrder sends nothing when the server already has exactly this.)
    const kept = await setOrder(productId, savedIdsInOrder());
    if (!kept.ok) problems.push(kept.error || 'The photo order could not be saved.');
    else removed = [];
    // 3. New photos.
    for (const it of items.filter((x) => x.state !== 'saved' && !x.replaceOf)) {
      tick();
      const res = await upload(productId, it, '');
      if (!res.ok) { report(it, res); continue; }
      release(it);
      Object.assign(it, { id: res.imageId, url: (res.images.find((x) => x.id === res.imageId) || {}).url, state: 'saved', file: null, error: '' });
      serverOrder = res.images.map((x) => x.id);
    }
    // 4. Where the new ones sit.
    const finalOrder = savedIdsInOrder();
    if (finalOrder.length === serverOrder.length) {
      const res = await setOrder(productId, finalOrder);
      if (!res.ok) problems.push(res.error || 'The photo order could not be saved.');
    }
    render();
    return problems;
  }

  function hasPending() { return removed.length > 0 || items.some((it) => it.state !== 'saved') || savedIdsInOrder().some((id, i) => id !== serverOrder[i]); }

  /** For the shopper preview: what the seller will see once saved, cover first. */
  function previewUrls() { return items.map((it) => it.preview || it.url).filter(Boolean); }
  function count() { return items.length; }

  function init(opts) {
    onChange = (opts && opts.onChange) || onChange;
    $('photo-list').addEventListener('click', onListClick);
    $('photo-add-btn').addEventListener('click', () => $('photo-input').click());
    $('photo-camera-btn').addEventListener('click', () => $('photo-camera-input').click());
    // The whole tile is a target, not just its button - a big thumb-sized
    // place to tap on a phone.
    $('photo-add-row').addEventListener('click', (e) => { if (!e.target.closest('button, input')) $('photo-input').click(); });
    $('photo-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('photo-camera-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('photo-replace-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f && replaceKey) replaceWith(replaceKey, f);
      replaceKey = null;
    });
    // "Take a photo" opens the camera straight away on phones; elsewhere it
    // would just be a second "Add photos", so it is only shown on touch screens.
    $('photo-camera-btn').hidden = !(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    const drop = $('photo-section');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
      if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') === -1) return;
      e.preventDefault();
      drop.classList.add('is-dropping');
    }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => {
      if (t === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('is-dropping');
    }));
    drop.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    });
  }

  return { init, load, setMax, apply, hasPending, previewUrls, count, optimizeProductPhoto };
})();
