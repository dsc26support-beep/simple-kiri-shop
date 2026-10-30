/**
 * Mwakete Contacts & SMS - contacts (Oct 2026, docs/contacts-sms-architecture.md).
 *
 * Every store (an Owners row: retailer, wholesaler, distributor) has its own
 * contact list. Every read and write here is scoped by owner.OwnerId on the
 * server - a store can never name another store's contact, group or template.
 * Behind Script Property CONTACTS_SMS = on.
 *
 * Phone numbers are checked with smsNormalisePhone (SmsCore.gs): the stored
 * Phone is +<country><number>; the number as typed is kept in PhoneRaw. A
 * number that does not check out is kept as typed and marked invalid for the
 * store to correct - never changed into a different number.
 *
 * Consent is per kind (transactional / promotional / service): yes | no |
 * unknown. Importing a number never grants promotional consent. Every change
 * is logged (ContactConsentLog). An opt-out also goes on the store's
 * suppression list (SmsSuppression), keyed by number, so the same number
 * re-imported or re-added stays opted out.
 */

var CONTACT_HEADERS = ['ContactId', 'OwnerId', 'FirstName', 'LastName', 'BusinessName', 'Phone', 'PhoneRaw', 'PhoneStatus', 'AltPhone',
  'Email', 'Category', 'Island', 'Village', 'Atoll', 'Country', 'BusinessType', 'Source', 'Notes', 'TagsJson', 'ExtraJson',
  'ConsentTransactional', 'ConsentPromotional', 'ConsentService', 'ConsentSource', 'ConsentAt', 'UnsubscribedAt',
  'Status', 'MergedInto', 'CreatedAt', 'UpdatedAt'];
var CONTACT_CONSENT_LOG_HEADERS = ['LogId', 'OwnerId', 'ContactId', 'Phone', 'Kind', 'From', 'To', 'Source', 'At', 'By'];
var SMS_SUPPRESSION_HEADERS = ['OwnerId', 'Phone', 'Kinds', 'Source', 'At', 'By'];
var CONTACT_GROUP_HEADERS = ['GroupId', 'OwnerId', 'Name', 'Status', 'CreatedAt', 'UpdatedAt'];
var CONTACT_MEMBER_HEADERS = ['GroupId', 'ContactId', 'OwnerId', 'AddedAt'];
var CONTACT_CATEGORY_HEADERS = ['OwnerId', 'CategoryId', 'Label', 'CreatedAt'];
var SMS_TEMPLATE_HEADERS = ['TemplateId', 'OwnerId', 'Name', 'Body', 'Kind', 'Status', 'CreatedAt', 'UpdatedAt'];
var GEO_PLACE_HEADERS = ['PlaceId', 'Island', 'Village', 'Atoll', 'Country', 'Status', 'UpdatedAt', 'UpdatedBy'];

var CONTACT_DEFAULT_CATEGORIES = [
  ['customer', 'Customers'], ['vendor', 'Vendors'], ['retailer', 'Retailers'], ['wholesaler', 'Wholesalers'],
  ['supplier', 'Suppliers'], ['store_owner', 'Store owners'], ['staff', 'Staff'], ['partner', 'Business partners'],
  ['personal', 'Personal contacts'], ['other', 'Other']];
var CONTACT_CONSENT_VALUES = ['yes', 'no', 'unknown'];
var CONTACT_IMPORT_MAX = 2000;
var CONTACT_FIELD_MAX = { FirstName: 60, LastName: 60, BusinessName: 120, Email: 160, Island: 60, Village: 60, Atoll: 60,
  Country: 60, BusinessType: 60, Notes: 1000, Source: 60, AltPhone: 30 };


/**
 * Rows for the contacts & SMS tabs. The formula guard writes "+686..." as
 * "'+686..."; Sheets drops that apostrophe when it stores the cell, but take
 * it off here too so a number always compares as "+686...".
 */
function smsObjects(sheet) {
  return sheetToObjects(sheet).map(function (r) {
    Object.keys(r).forEach(function (k) { if (typeof r[k] === 'string' && r[k].charAt(0) === "'") r[k] = r[k].slice(1); });
    return r;
  });
}
function smsRows(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  return s ? smsObjects(s) : [];
}

function contactsSmsEnabled() {
  return String(PropertiesService.getScriptProperties().getProperty('CONTACTS_SMS') || 'off').trim().toLowerCase() === 'on';
}
function smsOff() { return fail('Contacts & SMS is not switched on yet.'); }

function contactsSheet() { return hubSheet('Contacts', CONTACT_HEADERS); }
function contactConsentLogSheet() { return hubSheet('ContactConsentLog', CONTACT_CONSENT_LOG_HEADERS); }
function smsSuppressionSheet() { return hubSheet('SmsSuppression', SMS_SUPPRESSION_HEADERS); }
function contactGroupsSheet() { return hubSheet('ContactGroups', CONTACT_GROUP_HEADERS); }
function contactMembersSheet() { return hubSheet('ContactGroupMembers', CONTACT_MEMBER_HEADERS); }
function contactCategoriesSheet() { return hubSheet('ContactCategories', CONTACT_CATEGORY_HEADERS); }
function smsTemplatesSheet() { return hubSheet('SmsTemplates', SMS_TEMPLATE_HEADERS); }
function geoPlacesSheet() { return hubSheet('GeoPlaces', GEO_PLACE_HEADERS); }

/** This store's live contact rows (not merged or deleted). */
function ownerContactRows(owner, includeGone) {
  return smsRows('Contacts').filter(function (c) {
    return c.OwnerId === owner.OwnerId && (includeGone || (c.Status !== 'deleted' && c.Status !== 'merged'));
  });
}
function findOwnerContact(owner, contactId) {
  var id = String(contactId || '');
  return smsRows('Contacts').filter(function (c) { return c.OwnerId === owner.OwnerId && c.ContactId === id && c.Status !== 'deleted' && c.Status !== 'merged'; })[0] || null;
}

function ctParse(text, fallback) { try { var v = JSON.parse(text || ''); return v == null ? fallback : v; } catch (e) { return fallback; } }
function ctText(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max || 200); }

/** Shape sent to the browser. Same for every caller - nothing secret lives on a contact. */
function contactView(c) {
  return {
    contactId: c.ContactId, firstName: c.FirstName || '', lastName: c.LastName || '', businessName: c.BusinessName || '',
    phone: c.Phone || '', phoneRaw: c.PhoneRaw || '', phoneStatus: c.PhoneStatus || '', altPhone: c.AltPhone || '',
    email: c.Email || '', category: c.Category || '', island: c.Island || '', village: c.Village || '', atoll: c.Atoll || '',
    country: c.Country || '', businessType: c.BusinessType || '', source: c.Source || '', notes: c.Notes || '',
    tags: ctParse(c.TagsJson, []), extra: ctParse(c.ExtraJson, {}),
    consent: { transactional: c.ConsentTransactional || 'unknown', promotional: c.ConsentPromotional || 'unknown', service: c.ConsentService || 'unknown' },
    consentSource: c.ConsentSource || '', consentAt: c.ConsentAt || '', unsubscribedAt: c.UnsubscribedAt || '',
    status: c.Status || 'active', createdAt: c.CreatedAt || '', updatedAt: c.UpdatedAt || ''
  };
}
function contactDisplayName(c) {
  var n = [c.FirstName, c.LastName].filter(function (x) { return x; }).join(' ');
  return n || c.BusinessName || c.Phone || c.PhoneRaw || 'Contact';
}

/* ==================== categories ==================== */

function ownerCategories(owner) {
  var own = smsRows('ContactCategories').filter(function (r) { return r.OwnerId === owner.OwnerId; });
  return CONTACT_DEFAULT_CATEGORIES.map(function (d) { return { id: d[0], label: d[1], builtIn: true }; })
    .concat(own.map(function (r) { return { id: r.CategoryId, label: r.Label, builtIn: false }; }));
}

function actionContactCategories(owner) { return ok({ categories: ownerCategories(owner) }); }

/** body: label. Adds a category of this store's own. */
function actionContactCategoryAdd(owner, body) {
  var label = ctText(body && body.label, 40);
  if (label.length < 2) return fail('Give the category a name.');
  var cats = ownerCategories(owner);
  if (cats.some(function (c) { return c.label.toLowerCase() === label.toLowerCase(); })) return fail('You already have that category.');
  if (cats.length >= 60) return fail('That is a lot of categories - remove some first.');
  var id = 'c_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) + '_' + Utilities.getUuid().slice(0, 4);
  appendRowFromObject(contactCategoriesSheet(), { OwnerId: owner.OwnerId, CategoryId: id, Label: label, CreatedAt: nowIso() });
  return ok({ category: { id: id, label: label, builtIn: false } });
}

/* ==================== consent & suppression ==================== */

function ownerSuppressed(owner) {
  var map = {};
  smsRows('SmsSuppression').filter(function (s) { return s.OwnerId === owner.OwnerId; }).forEach(function (s) {
    map[s.Phone] = String(s.Kinds || '').split(',').filter(function (k) { return k; });
  });
  return map;
}

/** May this contact receive a message of this kind from this store? { ok, reason } */
function contactMaySend(c, kind, suppressed) {
  if (!c.Phone || c.PhoneStatus === 'invalid' || c.PhoneStatus === 'missing') return { ok: false, reason: 'invalid_number' };
  if (c.PhoneStatus === 'check') return { ok: false, reason: 'not_mobile' };
  var sup = (suppressed || {})[c.Phone] || [];
  if (sup.indexOf(kind) !== -1 || sup.indexOf('all') !== -1) return { ok: false, reason: 'opted_out' };
  var consent = kind === 'promotional' ? c.ConsentPromotional : kind === 'service' ? c.ConsentService : c.ConsentTransactional;
  if (consent === 'no') return { ok: false, reason: 'opted_out' };
  // Promotions need a recorded yes; updates and announcements go unless the person said no.
  if (kind === 'promotional' && consent !== 'yes') return { ok: false, reason: 'no_consent' };
  return { ok: true };
}

function logConsent(owner, c, kind, from, to, source, by) {
  appendRowFromObject(contactConsentLogSheet(), { LogId: newId('cl'), OwnerId: owner.OwnerId, ContactId: c.ContactId || '', Phone: c.Phone || '',
    Kind: kind, From: from || 'unknown', To: to, Source: ctText(source, 120), At: nowIso(), By: by || owner.OwnerId });
}

/** Puts a number on (or takes it off) this store's suppression list for the given kinds. */
function setSuppression(owner, phone, kinds, add, source, by) {
  if (!phone) return;
  var sheet = smsSuppressionSheet();
  var row = smsObjects(sheet).filter(function (s) { return s.OwnerId === owner.OwnerId && s.Phone === phone; })[0];
  var have = row ? String(row.Kinds || '').split(',').filter(function (k) { return k; }) : [];
  kinds.forEach(function (k) {
    var i = have.indexOf(k);
    if (add && i === -1) have.push(k);
    if (!add && i !== -1) have.splice(i, 1);
  });
  var fields = { Kinds: have.join(','), Source: ctText(source, 120), At: nowIso(), By: by || owner.OwnerId };
  if (row) updateRowFromObject(sheet, row.__row, fields);
  else if (add) appendRowFromObject(sheet, Object.assign({ OwnerId: owner.OwnerId, Phone: phone }, fields));
}

/** body: contactId, kind (or 'all'), value yes|no, source. */
function actionContactSetConsent(owner, body) {
  var c = findOwnerContact(owner, body && body.contactId);
  if (!c) return fail('Contact not found.');
  var kinds = body.kind === 'all' ? SMS_KINDS : [String(body.kind || '')];
  if (kinds.some(function (k) { return SMS_KINDS.indexOf(k) === -1; })) return fail('Unknown message type.');
  var value = String(body.value || '');
  if (CONTACT_CONSENT_VALUES.indexOf(value) === -1) return fail('Consent is yes, no or unknown.');
  var source = ctText(body.source, 120);
  if (value === 'yes' && source.length < 3) return fail('Say how this person agreed (for example "signed up in store, 30 Oct").');
  var col = { transactional: 'ConsentTransactional', promotional: 'ConsentPromotional', service: 'ConsentService' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var fields = { UpdatedAt: nowIso() };
    kinds.forEach(function (k) {
      if (c[col[k]] === value) return;
      logConsent(owner, c, k, c[col[k]], value, source || 'changed by the store', owner.OwnerId);
      fields[col[k]] = value;
    });
    if (value === 'yes') { fields.ConsentSource = source; fields.ConsentAt = nowIso(); }
    if (value === 'no') fields.UnsubscribedAt = nowIso();
    updateRowFromObject(contactsSheet(), c.__row, fields);
    setSuppression(owner, c.Phone, kinds, value === 'no', source || 'opted out', owner.OwnerId);
    if (value !== 'no') setSuppression(owner, c.Phone, kinds, false, source, owner.OwnerId);
    return ok({ contact: contactView(Object.assign({}, c, fields)) });
  } finally { lock.releaseLock(); }
}

function actionContactConsentHistory(owner, body) {
  var c = findOwnerContact(owner, body && body.contactId);
  if (!c) return fail('Contact not found.');
  var rows = smsRows('ContactConsentLog').filter(function (l) { return l.OwnerId === owner.OwnerId && (l.ContactId === c.ContactId || (c.Phone && l.Phone === c.Phone)); });
  return ok({ history: rows.map(function (l) { return { kind: l.Kind, from: l.From, to: l.To, source: l.Source, at: l.At }; }) });
}

function actionSmsSuppressionList(owner) {
  return ok({ suppressed: smsRows('SmsSuppression').filter(function (s) { return s.OwnerId === owner.OwnerId && s.Kinds; })
    .map(function (s) { return { phone: s.Phone, kinds: String(s.Kinds).split(','), source: s.Source, at: s.At }; }) });
}

/**
 * Public. body: storeSlug, phone. Someone asking a store to stop sending them
 * promotions and announcements (order updates still go - they asked for an
 * order). Answers the same whatever the number, so it cannot be used to learn
 * who is on a store's list. Rate-limited.
 */
function actionSmsOptOut(body) {
  if (!contactsSmsEnabled()) return smsOff();
  var slug = ctText(body && body.storeSlug, 80);
  var check = smsNormalisePhone(body && body.phone);
  if (check.status === 'invalid' || check.status === 'missing') return fail('Please type your phone number.');
  if (rateLimitHit('smsoptout:' + check.e164, 5, 3600) || rateLimitHit('smsoptout-store:' + slug, 200, 3600)) return fail('Please try again later.');
  var owner = smsRows('Owners').filter(function (o) { return o.StoreSlug === slug; })[0];
  var answer = ok({ done: true, message: 'Done. That store will not send promotions or announcements to this number.' });
  if (!owner) return answer;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    setSuppression(owner, check.e164, ['promotional', 'service'], true, 'opt-out page', 'customer');
    smsRows('Contacts').filter(function (c) { return c.OwnerId === owner.OwnerId && c.Phone === check.e164 && c.Status !== 'deleted'; }).forEach(function (c) {
      ['promotional', 'service'].forEach(function (k) {
        var colName = k === 'promotional' ? 'ConsentPromotional' : 'ConsentService';
        if (c[colName] !== 'no') logConsent(owner, c, k, c[colName], 'no', 'opt-out page', 'customer');
      });
      updateRowFromObject(contactsSheet(), c.__row, { ConsentPromotional: 'no', ConsentService: 'no', UnsubscribedAt: nowIso(), UpdatedAt: nowIso() });
    });
    appendAudit({ actorId: 'customer', actorRole: 'customer', action: 'SMS_OPT_OUT', entityType: 'store', entityId: owner.OwnerId, next: 'opt-out page' });
  } finally { lock.releaseLock(); }
  return answer;
}

/* ==================== contacts ==================== */

function ctConsentIn(v) { var s = String(v || '').toLowerCase(); return CONTACT_CONSENT_VALUES.indexOf(s) !== -1 ? s : 'unknown'; }

/** Cleans what a browser or the Sheets add-on sent into Contacts columns. */
function contactFieldsFrom(body) {
  var f = {};
  [['firstName', 'FirstName'], ['lastName', 'LastName'], ['businessName', 'BusinessName'], ['email', 'Email'], ['island', 'Island'],
    ['village', 'Village'], ['atoll', 'Atoll'], ['country', 'Country'], ['businessType', 'BusinessType'], ['notes', 'Notes'],
    ['altPhone', 'AltPhone'], ['category', 'Category']].forEach(function (p) {
    if (body[p[0]] !== undefined) f[p[1]] = ctText(body[p[0]], CONTACT_FIELD_MAX[p[1]] || 60);
  });
  if (f.Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.Email)) f.__emailError = 'That email address does not look right.';
  if (body.tags !== undefined) {
    var tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',')).map(function (t) { return ctText(t, 30); }).filter(function (t) { return t; });
    f.TagsJson = JSON.stringify(tags.filter(function (t, i) { return tags.indexOf(t) === i; }).slice(0, 20));
  }
  if (body.extra !== undefined && body.extra && typeof body.extra === 'object') {
    var ex = {};
    Object.keys(body.extra).slice(0, 20).forEach(function (k) { ex[ctText(k, 40)] = ctText(body.extra[k], 200); });
    f.ExtraJson = JSON.stringify(ex);
  }
  return f;
}

/**
 * body: contactId? (edit), the fields, phone, consent { transactional, promotional, service }, consentSource.
 * A new contact whose number this store already has is refused (duplicateOf), unless it is that contact.
 */
function actionContactSave(owner, body) {
  body = body || {};
  var f = contactFieldsFrom(body);
  if (f.__emailError) return fail(f.__emailError);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = body.contactId ? findOwnerContact(owner, body.contactId) : null;
    if (body.contactId && !existing) return fail('Contact not found.');
    var now = nowIso();
    if (body.phone !== undefined) {
      var check = smsNormalisePhone(body.phone);
      f.PhoneRaw = ctText(body.phone, 40);
      f.Phone = check.e164;
      f.PhoneStatus = check.status;
      if (check.e164) {
        var dup = ownerContactRows(owner).filter(function (c) { return c.Phone === check.e164 && (!existing || c.ContactId !== existing.ContactId); })[0];
        if (dup) { var r = fail('You already have ' + contactDisplayName(dup) + ' with this number.'); r.duplicateOf = dup.ContactId; return r; }
      }
    } else if (!existing) {
      f.Phone = ''; f.PhoneRaw = ''; f.PhoneStatus = 'missing';
    }
    var name = (f.FirstName !== undefined ? f.FirstName : existing && existing.FirstName) || (f.BusinessName !== undefined ? f.BusinessName : existing && existing.BusinessName) ||
      (f.LastName !== undefined ? f.LastName : existing && existing.LastName);
    if (!name && !(f.Phone || (existing && existing.Phone))) return fail('Give the contact a name or a phone number.');
    if (f.Category && !ownerCategories(owner).some(function (c) { return c.id === f.Category; })) return fail('Choose a category from the list.');
    var suppressed = ownerSuppressed(owner);
    var phone = f.Phone !== undefined ? f.Phone : existing && existing.Phone;
    if (existing) {
      f.UpdatedAt = now;
      updateRowFromObject(contactsSheet(), existing.__row, f);
      var merged = Object.assign({}, existing, f);
      if (body.consent) applyConsentEdits(owner, merged, body.consent, body.consentSource);
      return ok({ contact: contactView(findOwnerContact(owner, existing.ContactId) || merged) });
    }
    if (ownerContactRows(owner).length >= contactsLimit()) return fail('Your contact list is full (' + contactsLimit() + '). Remove old contacts first.');
    var row = Object.assign({ ContactId: newId('ct'), OwnerId: owner.OwnerId, Source: ctText(body.source, 60) || 'manual', Country: f.Country || (smsNormalisePhone(phone).country === 'KI' ? 'Kiribati' : ''),
      ConsentTransactional: 'unknown', ConsentPromotional: 'unknown', ConsentService: 'unknown', Status: 'active', CreatedAt: now, UpdatedAt: now }, f);
    // A number this store was asked to stop messaging stays stopped.
    var sup = suppressed[phone] || [];
    if (sup.indexOf('promotional') !== -1) row.ConsentPromotional = 'no';
    if (sup.indexOf('service') !== -1) row.ConsentService = 'no';
    if (sup.indexOf('transactional') !== -1) row.ConsentTransactional = 'no';
    appendRowFromObject(contactsSheet(), row);
    if (body.consent) applyConsentEdits(owner, row, body.consent, body.consentSource);
    return ok({ contact: contactView(findOwnerContact(owner, row.ContactId) || row) });
  } finally { lock.releaseLock(); }
}

/** Consent from the contact form. Lock held by the caller. A suppressed number is never turned back to yes here. */
function applyConsentEdits(owner, c, consent, source) {
  var col = { transactional: 'ConsentTransactional', promotional: 'ConsentPromotional', service: 'ConsentService' };
  var sup = ownerSuppressed(owner)[c.Phone] || [];
  var fields = {};
  SMS_KINDS.forEach(function (k) {
    if (consent[k] === undefined) return;
    var v = ctConsentIn(consent[k]);
    if (v === 'yes' && sup.indexOf(k) !== -1) return;   // opted out by the person - only the explicit consent action can undo it
    if (v === 'yes' && ctText(source, 120).length < 3 && c[col[k]] !== 'yes') return;
    if (c[col[k]] === v) return;
    logConsent(owner, c, k, c[col[k]], v, source || 'contact form', owner.OwnerId);
    fields[col[k]] = v;
    if (v === 'no') setSuppression(owner, c.Phone, [k], true, source || 'contact form', owner.OwnerId);
  });
  if (Object.keys(fields).length) {
    if (Object.keys(fields).some(function (k) { return fields[k] === 'yes'; })) { fields.ConsentSource = ctText(source, 120); fields.ConsentAt = nowIso(); }
    fields.UpdatedAt = nowIso();
    var fresh = findOwnerContact(owner, c.ContactId);
    if (fresh) updateRowFromObject(contactsSheet(), fresh.__row, fields);
  }
}

function contactsLimit() {
  var n = Number(smsLimits().maxContactsPerStore);
  return n > 0 ? n : 10000;
}

/**
 * body: q, category, island, village, groupId, consent (promotional yes|no|unknown), phoneStatus, offset, limit.
 * Answers one page plus the totals the dashboard shows.
 */
function actionContactsList(owner, body) {
  body = body || {};
  var rows = ownerContactRows(owner);
  var q = String(body.q || '').trim().toLowerCase();
  var digits = q.replace(/\D/g, '');
  var members = null;
  if (body.groupId) {
    members = {};
    smsRows('ContactGroupMembers').filter(function (m) { return m.OwnerId === owner.OwnerId && m.GroupId === body.groupId; }).forEach(function (m) { members[m.ContactId] = true; });
  }
  var filtered = rows.filter(function (c) {
    if (members && !members[c.ContactId]) return false;
    if (body.category && c.Category !== body.category) return false;
    if (body.island && c.Island !== body.island) return false;
    if (body.village && c.Village !== body.village) return false;
    if (body.phoneStatus && c.PhoneStatus !== body.phoneStatus) return false;
    if (body.consent && (c.ConsentPromotional || 'unknown') !== body.consent) return false;
    if (!q) return true;
    var hay = [c.FirstName, c.LastName, c.BusinessName, c.Email, c.Village, c.Island, c.Notes, c.TagsJson].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1 || (digits.length >= 3 && String(c.Phone || c.PhoneRaw).replace(/\D/g, '').indexOf(digits) !== -1);
  });
  filtered.sort(function (a, b) { return contactDisplayName(a).toLowerCase() < contactDisplayName(b).toLowerCase() ? -1 : 1; });
  var offset = Math.max(0, Number(body.offset) || 0);
  var limit = Math.min(500, Math.max(1, Number(body.limit) || 50));
  return ok({ contacts: filtered.slice(offset, offset + limit).map(contactView), total: filtered.length, all: rows.length, offset: offset, limit: limit });
}

function actionContactGet(owner, body) {
  var c = findOwnerContact(owner, body && body.contactId);
  if (!c) return fail('Contact not found.');
  var groups = {};
  smsRows('ContactGroupMembers').filter(function (m) { return m.OwnerId === owner.OwnerId && m.ContactId === c.ContactId; }).forEach(function (m) { groups[m.GroupId] = true; });
  return ok({ contact: contactView(c), groupIds: Object.keys(groups) });
}

/** Soft delete: the row is kept as 'deleted' (and its opt-outs stay on the suppression list). */
function actionContactDelete(owner, body) {
  var ids = Array.isArray(body && body.contactIds) ? body.contactIds : [body && body.contactId];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var want = {};
    ids.forEach(function (i) { want[String(i)] = true; });
    var n = 0;
    ownerContactRows(owner).forEach(function (c) {
      if (!want[c.ContactId]) return;
      updateRowFromObject(contactsSheet(), c.__row, { Status: 'deleted', UpdatedAt: nowIso() });
      n++;
    });
    if (!n) return fail('Contact not found.');
    return ok({ deleted: n });
  } finally { lock.releaseLock(); }
}

/* ==================== duplicates & merge ==================== */

/** Groups of this store's contacts that look like the same person: same number, same email, or same full name. */
function actionContactsDuplicates(owner) {
  var rows = ownerContactRows(owner);
  var groups = [], seen = {};
  var by = function (keyFn, reason) {
    var map = {};
    rows.forEach(function (c) { var k = keyFn(c); if (k) (map[k] = map[k] || []).push(c); });
    Object.keys(map).forEach(function (k) {
      var list = map[k];
      if (list.length < 2) return;
      var sig = list.map(function (c) { return c.ContactId; }).sort().join('|');
      if (seen[sig]) return;
      seen[sig] = true;
      groups.push({ reason: reason, contacts: list.map(contactView) });
    });
  };
  by(function (c) { return c.Phone; }, 'same number');
  by(function (c) { return String(c.Email || '').toLowerCase(); }, 'same email');
  by(function (c) { var n = [c.FirstName, c.LastName].join(' ').trim().toLowerCase(); return n.length > 3 ? n : ''; }, 'same name');
  by(function (c) { var n = String(c.BusinessName || '').trim().toLowerCase(); return n.length > 3 ? 'b:' + n : ''; }, 'same business name');
  return ok({ groups: groups });
}

/**
 * body: keepId, mergeIds[]. Blank fields of the kept contact are filled from
 * the others, tags and groups are combined, and consent takes the most
 * cautious answer (any "no" wins; "yes" only if one said yes and none said
 * no). The others are kept as 'merged' rows pointing at the kept one, so
 * their consent history stays.
 */
function actionContactsMerge(owner, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var keep = findOwnerContact(owner, body && body.keepId);
    if (!keep) return fail('Contact not found.');
    var others = (Array.isArray(body.mergeIds) ? body.mergeIds : []).filter(function (id) { return id !== keep.ContactId; })
      .map(function (id) { return findOwnerContact(owner, id); });
    if (!others.length || others.some(function (o) { return !o; })) return fail('Choose the contacts to merge.');
    var fields = {};
    ['FirstName', 'LastName', 'BusinessName', 'AltPhone', 'Email', 'Category', 'Island', 'Village', 'Atoll', 'Country', 'BusinessType'].forEach(function (k) {
      if (!keep[k]) { var from = others.filter(function (o) { return o[k]; })[0]; if (from) fields[k] = from[k]; }
    });
    if (!keep.Phone) { var withPhone = others.filter(function (o) { return o.Phone; })[0]; if (withPhone) { fields.Phone = withPhone.Phone; fields.PhoneRaw = withPhone.PhoneRaw; fields.PhoneStatus = withPhone.PhoneStatus; } }
    var altPhones = others.map(function (o) { return o.Phone; }).filter(function (p) { return p && p !== (fields.Phone || keep.Phone); });
    if (altPhones.length && !keep.AltPhone && !fields.AltPhone) fields.AltPhone = altPhones[0];
    var notes = [keep.Notes].concat(others.map(function (o) { return o.Notes; })).filter(function (n) { return n; });
    if (notes.length > 1) fields.Notes = notes.join('\n').slice(0, 1000);
    var tags = ctParse(keep.TagsJson, []);
    others.forEach(function (o) { ctParse(o.TagsJson, []).forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); }); });
    fields.TagsJson = JSON.stringify(tags.slice(0, 20));
    var all = [keep].concat(others);
    [['ConsentTransactional', 'transactional'], ['ConsentPromotional', 'promotional'], ['ConsentService', 'service']].forEach(function (p) {
      var vals = all.map(function (c) { return c[p[0]] || 'unknown'; });
      var v = vals.indexOf('no') !== -1 ? 'no' : vals.indexOf('yes') !== -1 ? 'yes' : 'unknown';
      if (v !== (keep[p[0]] || 'unknown')) { fields[p[0]] = v; logConsent(owner, keep, p[1], keep[p[0]], v, 'merged contacts', owner.OwnerId); }
    });
    var src = others.filter(function (o) { return o.ConsentSource; })[0];
    if (!keep.ConsentSource && src) { fields.ConsentSource = src.ConsentSource; fields.ConsentAt = src.ConsentAt; }
    fields.UpdatedAt = nowIso();
    updateRowFromObject(contactsSheet(), keep.__row, fields);
    var mSheet = contactMembersSheet();
    var members = smsObjects(mSheet).filter(function (m) { return m.OwnerId === owner.OwnerId; });
    var keepGroups = {};
    members.filter(function (m) { return m.ContactId === keep.ContactId; }).forEach(function (m) { keepGroups[m.GroupId] = true; });
    others.forEach(function (o) {
      members.filter(function (m) { return m.ContactId === o.ContactId && !keepGroups[m.GroupId]; }).forEach(function (m) {
        keepGroups[m.GroupId] = true;
        appendRowFromObject(mSheet, { GroupId: m.GroupId, ContactId: keep.ContactId, OwnerId: owner.OwnerId, AddedAt: nowIso() });
      });
      updateRowFromObject(contactsSheet(), o.__row, { Status: 'merged', MergedInto: keep.ContactId, UpdatedAt: nowIso() });
    });
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'CONTACTS_MERGED', entityType: 'contact', entityId: keep.ContactId, next: others.length + ' merged' });
    return ok({ contact: contactView(findOwnerContact(owner, keep.ContactId)), merged: others.length });
  } finally { lock.releaseLock(); }
}

/* ==================== import & export ==================== */

/** Column names people actually use, matched to contact fields. */
var CONTACT_IMPORT_ALIASES = {
  firstName: ['first name', 'firstname', 'given name', 'first', 'name'], lastName: ['last name', 'lastname', 'surname', 'family name'],
  businessName: ['business', 'business name', 'company', 'organisation', 'organization', 'store'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'cell', 'number', 'tel', 'telephone', 'phone 1 - value'],
  altPhone: ['alternative phone', 'other phone', 'phone 2', 'phone 2 - value', 'alt phone'], email: ['email', 'e-mail', 'email address', 'e-mail 1 - value'],
  category: ['category', 'type', 'group'], island: ['island'], village: ['village', 'town'], atoll: ['atoll'], country: ['country'],
  businessType: ['business type', 'industry'], notes: ['notes', 'note', 'comments'], tags: ['tags', 'labels']
};

function contactImportRow(raw, headerMap) {
  var row = {};
  Object.keys(headerMap).forEach(function (col) {
    var v = raw[col];
    if (v !== undefined && v !== null && String(v).trim() !== '' && !row[headerMap[col]]) row[headerMap[col]] = v;
  });
  if (!row.firstName && !row.lastName && raw.name) row.firstName = raw.name;
  return row;
}

/** { originalHeader: field } for every column in the file. */
function contactHeaderMap(columns, explicit) {
  var map = {};
  if (explicit && typeof explicit === 'object') {
    Object.keys(explicit).forEach(function (col) { if (CONTACT_IMPORT_ALIASES[explicit[col]]) map[col] = explicit[col]; });
    return map;
  }
  Object.keys(columns || {}).forEach(function (col) {
    var k = String(col).trim().toLowerCase();
    Object.keys(CONTACT_IMPORT_ALIASES).forEach(function (field) {
      if (!map[col] && (k === field.toLowerCase() || CONTACT_IMPORT_ALIASES[field].indexOf(k) !== -1)) map[col] = field;
    });
  });
  return map;
}

/**
 * Checks an import without writing anything. body: rows [{column: value}],
 * columns? {column: field}. Each row comes back as new | update | duplicate
 * (already in the list) | repeat (twice in this file) | invalid.
 */
function contactsImportPlan(owner, body) {
  var rows = Array.isArray(body && body.rows) ? body.rows : [];
  if (!rows.length) return { error: 'The file has no rows.' };
  if (rows.length > CONTACT_IMPORT_MAX) return { error: 'At most ' + CONTACT_IMPORT_MAX + ' rows per import - split the file.' };
  var allCols = {};
  rows.forEach(function (r) { Object.keys(r || {}).forEach(function (k) { allCols[k] = ''; }); });
  var map = contactHeaderMap(allCols, body.columns);
  if (!Object.keys(map).some(function (c) { return map[c] === 'phone'; })) return { error: 'No phone number column found. Name it "Phone".', columns: map };
  var byPhone = {};
  ownerContactRows(owner).forEach(function (c) { if (c.Phone) byPhone[c.Phone] = c; });
  var inFile = {};
  var plan = rows.map(function (raw, i) {
    var r = contactImportRow(raw, map);
    var check = smsNormalisePhone(r.phone);
    var item = { line: i + 2, row: r, phone: check.e164, phoneStatus: check.status, note: check.note };
    if (!r.firstName && !r.lastName && !r.businessName && !check.e164) { item.action = 'invalid'; item.note = 'No name or number'; }
    else if (check.status === 'invalid' || check.status === 'missing') { item.action = 'invalid'; }
    else if (inFile[check.e164]) { item.action = 'repeat'; item.note = 'Same number as line ' + inFile[check.e164]; }
    else if (byPhone[check.e164]) { item.action = body.onDuplicate === 'update' ? 'update' : 'duplicate'; item.existingId = byPhone[check.e164].ContactId; item.note = 'Already in your contacts (' + contactDisplayName(byPhone[check.e164]) + ')'; }
    else item.action = 'new';
    if (check.e164 && !inFile[check.e164]) inFile[check.e164] = i + 2;
    return item;
  });
  var counts = {};
  plan.forEach(function (p) { counts[p.action] = (counts[p.action] || 0) + 1; });
  return { plan: plan, counts: counts, columns: map };
}

function actionContactsImportPreview(owner, body) {
  var p = contactsImportPlan(owner, body);
  if (p.error) { var r = fail(p.error); r.columns = p.columns; return r; }
  return ok({ counts: p.counts, columns: p.columns, rows: p.plan.slice(0, 500).map(function (x) { return { line: x.line, action: x.action, note: x.note || '', phone: x.phone, name: [x.row.firstName, x.row.lastName].join(' ').trim() || x.row.businessName || '' }; }) });
}

/**
 * Writes an import. body: rows, columns?, source, onDuplicate skip|update,
 * category?, groupId?, consent? { transactional|promotional|service: yes }, consentSource.
 * Consent is only ever recorded when the store says the people agreed and how;
 * otherwise new contacts start "unknown". Invalid numbers are kept (marked
 * invalid) only if keepInvalid is set, so the store can fix them later.
 */
function actionContactsImportApply(owner, body) {
  body = body || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var p = contactsImportPlan(owner, body);
    if (p.error) return fail(p.error);
    var source = ctText(body.source, 40) || 'import';
    var consent = body.consent || {};
    var consentSource = ctText(body.consentSource, 120);
    var giveConsent = {};
    SMS_KINDS.forEach(function (k) { if (consent[k] === 'yes') giveConsent[k] = true; });
    if (Object.keys(giveConsent).length && consentSource.length < 3) return fail('Say how these people agreed to messages (for example "customer sign-up sheet, Oct 2026").');
    if (body.category && !ownerCategories(owner).some(function (c) { return c.id === body.category; })) return fail('Choose a category from the list.');
    var group = body.groupId ? smsRows('ContactGroups').filter(function (g) { return g.OwnerId === owner.OwnerId && g.GroupId === body.groupId && g.Status !== 'deleted'; })[0] : null;
    if (body.groupId && !group) return fail('Group not found.');
    var room = contactsLimit() - ownerContactRows(owner).length;
    var suppressed = ownerSuppressed(owner);
    var sheet = contactsSheet();
    var now = nowIso();
    var added = 0, updated = 0, skipped = 0, invalid = 0, newIds = [];
    var existingById = {};
    ownerContactRows(owner).forEach(function (c) { existingById[c.ContactId] = c; });
    p.plan.forEach(function (item) {
      if (item.action === 'repeat' || item.action === 'duplicate') { skipped++; return; }
      if (item.action === 'invalid' && !body.keepInvalid) { invalid++; return; }
      var f = contactFieldsFrom(item.row);
      delete f.__emailError;
      if (body.category && !f.Category) f.Category = body.category;
      if (f.Category && !ownerCategories(owner).some(function (c) { return c.id === f.Category; })) {
        var byLabel = ownerCategories(owner).filter(function (c) { return c.label.toLowerCase() === String(f.Category).toLowerCase(); })[0];
        f.Category = byLabel ? byLabel.id : '';
      }
      if (item.action === 'update') {
        var ex = existingById[item.existingId];
        var upd = {};
        Object.keys(f).forEach(function (k) { if (f[k] && !ex[k]) upd[k] = f[k]; });
        upd.UpdatedAt = now;
        updateRowFromObject(sheet, ex.__row, upd);
        updated++;
        newIds.push(ex.ContactId);
        return;
      }
      if (room <= 0) { skipped++; return; }
      room--;
      var sup = suppressed[item.phone] || [];
      var row = Object.assign({ ContactId: newId('ct'), OwnerId: owner.OwnerId, Source: source, Status: 'active', CreatedAt: now, UpdatedAt: now,
        Phone: item.phone, PhoneRaw: ctText(item.row.phone, 40), PhoneStatus: item.phoneStatus,
        Country: f.Country || (smsNormalisePhone(item.row.phone).country === 'KI' ? 'Kiribati' : '') }, f);
      [['transactional', 'ConsentTransactional'], ['promotional', 'ConsentPromotional'], ['service', 'ConsentService']].forEach(function (k) {
        row[k[1]] = sup.indexOf(k[0]) !== -1 ? 'no' : giveConsent[k[0]] ? 'yes' : 'unknown';
      });
      if (Object.keys(giveConsent).length) { row.ConsentSource = consentSource; row.ConsentAt = now; }
      appendRowFromObject(sheet, row);
      Object.keys(giveConsent).forEach(function (k) { if (row[k === 'promotional' ? 'ConsentPromotional' : k === 'service' ? 'ConsentService' : 'ConsentTransactional'] === 'yes') logConsent(owner, row, k, 'unknown', 'yes', consentSource, owner.OwnerId); });
      added++;
      newIds.push(row.ContactId);
    });
    if (group && newIds.length) contactsAddToGroupLocked(owner, group.GroupId, newIds);
    appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'CONTACTS_IMPORTED', entityType: 'contact', entityId: source, next: added + ' added, ' + updated + ' updated' });
    return ok({ added: added, updated: updated, skipped: skipped, invalid: invalid, full: room <= 0 && skipped > 0 });
  } finally { lock.releaseLock(); }
}

/**
 * This store's customers from its Mwakete orders, as import rows (not written -
 * the store reviews them with the normal import preview). They ordered, so
 * order and delivery updates are expected; promotions still need a yes.
 */
function actionContactsFromOrders(owner) {
  var seen = {};
  var rows = [];
  smsRows('Orders').filter(function (o) { return o.OwnerId === owner.OwnerId && o.CustomerPhone; }).forEach(function (o) {
    var check = smsNormalisePhone(o.CustomerPhone);
    var key = check.e164 || String(o.CustomerPhone);
    if (seen[key]) return;
    seen[key] = true;
    var parts = String(o.CustomerName || '').trim().split(/\s+/);
    rows.push({ 'First name': parts.shift() || '', 'Last name': parts.join(' '), Phone: String(o.CustomerPhone), Email: o.CustomerEmail || '',
      Island: o.CustomerIsland || o.Island || '', Village: o.CustomerVillage || o.Village || '', Category: 'customer' });
  });
  return ok({ rows: rows.slice(0, CONTACT_IMPORT_MAX), source: 'mwakete_orders' });
}

function csvCell(v) {
  var s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a cell a spreadsheet would run as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** body: groupId?, category?. This store's contacts as CSV text. Audited. */
function actionContactsExport(owner, body) {
  var res = actionContactsList(owner, Object.assign({}, body || {}, { offset: 0, limit: 500 }));
  var all = [];
  var offset = 0;
  while (true) {
    var page = actionContactsList(owner, Object.assign({}, body || {}, { offset: offset, limit: 500 }));
    all = all.concat(page.contacts);
    offset += 500;
    if (offset >= page.total) break;
  }
  var head = ['First name', 'Last name', 'Business name', 'Phone', 'Phone check', 'Alternative phone', 'Email', 'Category', 'Island', 'Village', 'Atoll', 'Country',
    'Business type', 'Tags', 'Notes', 'Order updates', 'Promotions', 'Announcements', 'Consent source', 'Unsubscribed', 'Source', 'Created', 'Updated', 'Mwakete ID'];
  var lines = [head.map(csvCell).join(',')].concat(all.map(function (c) {
    return [c.firstName, c.lastName, c.businessName, c.phone || c.phoneRaw, c.phoneStatus, c.altPhone, c.email, c.category, c.island, c.village, c.atoll, c.country,
      c.businessType, c.tags.join(';'), c.notes, c.consent.transactional, c.consent.promotional, c.consent.service, c.consentSource, c.unsubscribedAt, c.source, c.createdAt, c.updatedAt, c.contactId].map(csvCell).join(',');
  }));
  appendAudit({ actorId: owner.OwnerId, actorRole: 'seller', action: 'CONTACTS_EXPORTED', entityType: 'contact', entityId: owner.OwnerId, next: all.length + ' rows' });
  return ok({ csv: lines.join('\n'), count: all.length, total: res.total });
}

/** For the Sheets add-on: contacts changed since an ISO time (deleted and merged included, so a sheet can drop them). */
function actionContactsChanges(owner, body) {
  var since = String((body && body.since) || '');
  var rows = ownerContactRows(owner, true).filter(function (c) { return !since || String(c.UpdatedAt) > since; });
  rows.sort(function (a, b) { return String(a.UpdatedAt) < String(b.UpdatedAt) ? -1 : 1; });
  var page = rows.slice(0, 1000);
  return ok({ contacts: page.map(contactView), more: rows.length > page.length, until: page.length ? String(page[page.length - 1].UpdatedAt) : since, serverTime: nowIso() });
}

/* ==================== groups ==================== */

function ownerGroups(owner) {
  return smsRows('ContactGroups').filter(function (g) { return g.OwnerId === owner.OwnerId && g.Status !== 'deleted'; });
}

function actionContactGroups(owner) {
  var counts = {};
  var live = {};
  ownerContactRows(owner).forEach(function (c) { live[c.ContactId] = true; });
  smsRows('ContactGroupMembers').filter(function (m) { return m.OwnerId === owner.OwnerId && live[m.ContactId]; }).forEach(function (m) { counts[m.GroupId] = (counts[m.GroupId] || 0) + 1; });
  return ok({ groups: ownerGroups(owner).map(function (g) { return { groupId: g.GroupId, name: g.Name, members: counts[g.GroupId] || 0, createdAt: g.CreatedAt }; }) });
}

/** body: groupId? name. */
function actionContactGroupSave(owner, body) {
  var name = ctText(body && body.name, 60);
  if (name.length < 2) return fail('Give the group a name.');
  var groups = ownerGroups(owner);
  if (groups.some(function (g) { return g.Name.toLowerCase() === name.toLowerCase() && g.GroupId !== body.groupId; })) return fail('You already have a group with that name.');
  if (body.groupId) {
    var g = groups.filter(function (x) { return x.GroupId === body.groupId; })[0];
    if (!g) return fail('Group not found.');
    updateRowFromObject(contactGroupsSheet(), g.__row, { Name: name, UpdatedAt: nowIso() });
    return ok({ group: { groupId: g.GroupId, name: name } });
  }
  if (groups.length >= 200) return fail('That is a lot of groups - remove some first.');
  var id = newId('grp');
  appendRowFromObject(contactGroupsSheet(), { GroupId: id, OwnerId: owner.OwnerId, Name: name, Status: 'active', CreatedAt: nowIso(), UpdatedAt: nowIso() });
  return ok({ group: { groupId: id, name: name, members: 0 } });
}

function actionContactGroupDelete(owner, body) {
  var g = ownerGroups(owner).filter(function (x) { return x.GroupId === (body && body.groupId); })[0];
  if (!g) return fail('Group not found.');
  updateRowFromObject(contactGroupsSheet(), g.__row, { Status: 'deleted', UpdatedAt: nowIso() });
  return ok({ deleted: true });
}

function contactsAddToGroupLocked(owner, groupId, contactIds) {
  var sheet = contactMembersSheet();
  var have = {};
  smsObjects(sheet).filter(function (m) { return m.OwnerId === owner.OwnerId && m.GroupId === groupId; }).forEach(function (m) { have[m.ContactId] = true; });
  var mine = {};
  ownerContactRows(owner).forEach(function (c) { mine[c.ContactId] = true; });
  var n = 0;
  contactIds.forEach(function (id) {
    if (!mine[id] || have[id]) return;
    have[id] = true;
    appendRowFromObject(sheet, { GroupId: groupId, ContactId: id, OwnerId: owner.OwnerId, AddedAt: nowIso() });
    n++;
  });
  return n;
}

/** body: groupId, add [contactIds], remove [contactIds]. Only this store's contacts and groups. */
function actionContactGroupMembers(owner, body) {
  var g = ownerGroups(owner).filter(function (x) { return x.GroupId === (body && body.groupId); })[0];
  if (!g) return fail('Group not found.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var added = contactsAddToGroupLocked(owner, g.GroupId, Array.isArray(body.add) ? body.add.map(String) : []);
    var removeSet = {};
    (Array.isArray(body.remove) ? body.remove : []).forEach(function (id) { removeSet[String(id)] = true; });
    var removed = 0;
    if (Object.keys(removeSet).length) {
      var sheet = contactMembersSheet();
      var rows = smsObjects(sheet).filter(function (m) { return m.OwnerId === owner.OwnerId && m.GroupId === g.GroupId && removeSet[m.ContactId]; });
      rows.sort(function (a, b) { return b.__row - a.__row; }).forEach(function (m) { sheet.deleteRow(m.__row); removed++; });
    }
    return ok({ added: added, removed: removed });
  } finally { lock.releaseLock(); }
}

/* ==================== templates ==================== */

function actionSmsTemplates(owner) {
  return ok({ templates: smsRows('SmsTemplates').filter(function (t) { return t.OwnerId === owner.OwnerId && t.Status !== 'deleted'; })
    .map(function (t) { return { templateId: t.TemplateId, name: t.Name, body: t.Body, kind: t.Kind, info: smsSegmentInfo(t.Body), updatedAt: t.UpdatedAt }; }) });
}

/** body: templateId?, name, body, kind. */
function actionSmsTemplateSave(owner, body) {
  var name = ctText(body && body.name, 60);
  var text = String((body && body.body) || '').slice(0, 2000);
  var kind = SMS_KINDS.indexOf(body && body.kind) !== -1 ? body.kind : 'promotional';
  if (name.length < 2) return fail('Give the template a name.');
  if (!text.trim()) return fail('Write the message.');
  if (smsSegmentInfo(text).segments > SMS_MAX_SEGMENTS) return fail('That message is too long (more than ' + SMS_MAX_SEGMENTS + ' SMS).');
  var unknown = smsRender(text, {}).unknown;
  if (unknown.length) return fail('Unknown field {' + unknown[0] + '}. Use ' + SMS_FIELDS.map(function (f) { return '{' + f + '}'; }).join(', ') + '.');
  var mine = smsRows('SmsTemplates').filter(function (t) { return t.OwnerId === owner.OwnerId && t.Status !== 'deleted'; });
  if (body.templateId) {
    var t = mine.filter(function (x) { return x.TemplateId === body.templateId; })[0];
    if (!t) return fail('Template not found.');
    updateRowFromObject(smsTemplatesSheet(), t.__row, { Name: name, Body: text, Kind: kind, UpdatedAt: nowIso() });
    return ok({ template: { templateId: t.TemplateId, name: name, body: text, kind: kind } });
  }
  if (mine.length >= 200) return fail('That is a lot of templates - remove some first.');
  var id = newId('tpl');
  appendRowFromObject(smsTemplatesSheet(), { TemplateId: id, OwnerId: owner.OwnerId, Name: name, Body: text, Kind: kind, Status: 'active', CreatedAt: nowIso(), UpdatedAt: nowIso() });
  return ok({ template: { templateId: id, name: name, body: text, kind: kind } });
}

function actionSmsTemplateDelete(owner, body) {
  var t = smsRows('SmsTemplates').filter(function (x) { return x.OwnerId === owner.OwnerId && x.TemplateId === (body && body.templateId) && x.Status !== 'deleted'; })[0];
  if (!t) return fail('Template not found.');
  updateRowFromObject(smsTemplatesSheet(), t.__row, { Status: 'deleted', UpdatedAt: nowIso() });
  return ok({ deleted: true });
}

/* ==================== islands & villages ==================== */

/** Public. The admin-maintained place list (the site's built-in list is the fallback when this is empty). */
function actionGeoPlaces() {
  return ok({ places: smsRows('GeoPlaces').filter(function (p) { return p.Status !== 'deleted'; })
    .map(function (p) { return { placeId: p.PlaceId, island: p.Island, village: p.Village, atoll: p.Atoll, country: p.Country || 'Kiribati' }; }) });
}

/** Admin. body: placeId? island, village, atoll, country, remove. */
function actionAdminGeoSave(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var island = ctText(body && body.island, 60);
  if (!island) return fail('Island is required.');
  var sheet = geoPlacesSheet();
  var rows = smsObjects(sheet);
  if (body.placeId) {
    var p = rows.filter(function (r) { return r.PlaceId === body.placeId; })[0];
    if (!p) return fail('Place not found.');
    updateRowFromObject(sheet, p.__row, body.remove ? { Status: 'deleted', UpdatedAt: nowIso(), UpdatedBy: owner.OwnerId }
      : { Island: island, Village: ctText(body.village, 60), Atoll: ctText(body.atoll, 60), Country: ctText(body.country, 60) || 'Kiribati', UpdatedAt: nowIso(), UpdatedBy: owner.OwnerId });
    return ok({ saved: true });
  }
  var village = ctText(body.village, 60);
  if (rows.some(function (r) { return r.Status !== 'deleted' && r.Island === island && r.Village === village; })) return fail('That place is already on the list.');
  appendRowFromObject(sheet, { PlaceId: newId('geo'), Island: island, Village: village, Atoll: ctText(body.atoll, 60), Country: ctText(body.country, 60) || 'Kiribati', Status: 'active', UpdatedAt: nowIso(), UpdatedBy: owner.OwnerId });
  return ok({ saved: true });
}
