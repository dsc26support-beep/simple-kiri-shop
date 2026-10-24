/**
 * Sign-in identities from Google and Facebook, kept apart from the customer
 * profile (ProviderIdentities sheet), and the rules for joining them to
 * accounts. Owner-approved model, Oct 2026.
 *
 * ProviderIdentities: CustomerId | Provider | ProviderUserId | Email | CreatedAt | LastUsedAt
 *   created on first use. (Provider, ProviderUserId) is unique - one Google or
 *   Facebook identity belongs to at most one Mwakete account. Email is what the
 *   provider reported, for the account page only; it is never used to match.
 *   ProviderUserId is stored as 'id:' + the provider's id: Google and Facebook
 *   ids are 17-21 digit numbers, which a sheet would otherwise turn into a
 *   rounded number and never match again.
 *
 * THE RULES
 *  1. An identity seen before signs in to the account it is linked to.
 *  2. A new identity whose email matches an existing account is NOT merged
 *     into it automatically. The shopper must first prove they own that
 *     account (password, or a code to its email) - the sign-in carries a
 *     short-lived providerLinkToken and the link is made only then, and only to that
 *     same account.
 *  3. Signed in already (account page, "Link Google"): the identity links to
 *     the signed-in account, unless it already belongs to another.
 *  4. Otherwise a new customer account is made. A provider-reported email
 *     counts as confirmed only when the provider says so in a checked claim
 *     (Google's email_verified). Facebook's email is treated as unconfirmed:
 *     it waits in PendingEmail until Mwakete's own code confirms it, and until
 *     then the account can browse but not order (requireCustomerAuth).
 *  5. Unlinking always leaves a way back in (a password, or a confirmed email
 *     for codes).
 *  6. Never a seller or admin permission from any of this: those live on the
 *     Owners side and are checked there.
 *
 * Accounts that signed in with Google before this file existed carry their
 * Google id in Customers.GoogleSub; that is honoured as an existing link and
 * copied into ProviderIdentities the first time it is used.
 */

var PROVIDER_LINK_TTL_SECONDS = 15 * 60;
var PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook' };

function providerIdentitiesSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName('ProviderIdentities');
  if (!sheet) {
    sheet = ss.insertSheet('ProviderIdentities');
    sheet.getRange(1, 1, 1, 6).setValues([['CustomerId', 'Provider', 'ProviderUserId', 'Email', 'CreatedAt', 'LastUsedAt']]);
  }
  return sheet;
}

function storedProviderUserId_(providerUserId) {
  return 'id:' + String(providerUserId);
}

function findProviderIdentity(provider, providerUserId) {
  if (!providerUserId) return null;
  var key = storedProviderUserId_(providerUserId);
  var rows = sheetToObjects(providerIdentitiesSheet_());
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Provider === provider && String(rows[i].ProviderUserId) === key) return rows[i];
  }
  return null;
}

function identitiesOfCustomer(customerId) {
  return sheetToObjects(providerIdentitiesSheet_()).filter(function (r) { return String(r.CustomerId) === String(customerId); });
}

/** Ways this account can sign in - for the account page and the unlink rule. */
function customerSignInMethods(customer) {
  var ids = identitiesOfCustomer(customer.CustomerId);
  var has = function (p) { return ids.some(function (r) { return r.Provider === p; }) || (p === 'google' && !!String(customer.GoogleSub || '')); };
  return {
    password: !!String(customer.PasswordHash || ''),
    emailCode: customerEmailVerified(customer),
    google: has('google'),
    facebook: has('facebook')
  };
}

/** Caller holds the script lock. */
function addProviderIdentity_(customerId, provider, providerUserId, email) {
  appendRowFromObject(providerIdentitiesSheet_(), {
    CustomerId: customerId, Provider: provider, ProviderUserId: storedProviderUserId_(providerUserId),
    Email: normalizeEmail(email), CreatedAt: nowIso(), LastUsedAt: nowIso()
  });
}

/** The legacy Customers.GoogleSub link, moved into ProviderIdentities. Caller holds the lock. */
function legacyGoogleCustomer_(sub) {
  if (!sub) return null;
  var rows = sheetToObjects(getSheet('Customers'));
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].GoogleSub || '') === String(sub)) {
      addProviderIdentity_(rows[i].CustomerId, 'google', sub, rows[i].Email);
      return rows[i];
    }
  }
  return null;
}

/**
 * Everything after a provider has been verified (CustomerOAuth.gs /
 * FacebookAuth.gs). profile: { provider, providerUserId, email,
 * emailVerified, name }. body: the request ({ sharedDevice, customerToken }).
 */
function resolveProviderSignIn(profile, body) {
  body = body || {};
  var provider = profile.provider;
  var label = PROVIDER_LABELS[provider];
  if (!profile.providerUserId) return fail(label + ' sign-in failed - please try again');
  var email = normalizeEmail(profile.email);

  var result = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var idSheet = providerIdentitiesSheet_();
    var identity = findProviderIdentity(provider, profile.providerUserId);
    var linkedCustomer = identity ? findRowById(getSheet('Customers'), 'CustomerId', identity.CustomerId)
      : (provider === 'google' ? legacyGoogleCustomer_(profile.providerUserId) : null);

    // Rule 3: linking from the account page.
    if (body.customerToken) {
      var me;
      try { me = requireCustomerAuth(body.customerToken, { allowUnverified: true }); } catch (e) { return fail(e.message || 'Please sign in again.'); }
      if (linkedCustomer && linkedCustomer.CustomerId !== me.CustomerId) {
        return fail('This ' + label + ' account is already linked to a different Mwakete account.');
      }
      if (!linkedCustomer) {
        if (customerSignInMethods(me)[provider]) return fail('Your account already has a different ' + label + ' account linked. Unlink it first.');
        addProviderIdentity_(me.CustomerId, provider, profile.providerUserId, email);
        logAuthEvent('link', me.CustomerId, provider);
      }
      result = { linkedTo: me, linked: provider };
    } else if (linkedCustomer) {
      // Rule 1.
      identity = findProviderIdentity(provider, profile.providerUserId);
      if (identity) updateRowFromObject(idSheet, identity.__row, { LastUsedAt: nowIso() });
      result = { customer: linkedCustomer };
    } else {
      var existing = email ? findCustomerByEmail(email) : null;
      if (existing) {
        // Rule 2: prove the existing account first.
        var linkToken = generateToken();
        CacheService.getScriptCache().put('providerlink:' + hashSecretToken(linkToken), JSON.stringify({
          provider: provider, providerUserId: String(profile.providerUserId), email: email, customerId: existing.CustomerId
        }), PROVIDER_LINK_TTL_SECONDS);
        result = { linkRequired: { linkToken: linkToken, provider: provider, email: email,
          sentTo: maskEmail(email), hasPassword: !!String(existing.PasswordHash || '') } };
      } else {
        // Rule 4: a new account.
        var sheet = getSheet('Customers');
        ensureColumn(sheet, 'PendingEmail');
        ensureColumn(sheet, 'AuthProvider');
        var confirmed = !!email && profile.emailVerified === true;
        var customerId = newId('cust');
        appendRowFromObject(sheet, {
          CustomerId: customerId,
          Name: String(profile.name || '').trim().slice(0, 100) || (email ? email.split('@')[0] : label + ' shopper'),
          Email: confirmed ? email : '',
          PendingEmail: confirmed ? '' : email,
          Phone: '',
          EmailVerified: confirmed ? 'true' : 'false',
          AuthProvider: provider,
          CreatedAt: nowIso(),
          UpdatedAt: nowIso()
        });
        addProviderIdentity_(customerId, provider, profile.providerUserId, email);
        result = { customer: findRowById(sheet, 'CustomerId', customerId), created: true };
        optInNewCustomer(result.customer);
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (result.linkRequired) {
    return ok({ linkRequired: true, providerLinkToken: result.linkRequired.linkToken, provider: result.linkRequired.provider,
      sentTo: result.linkRequired.sentTo, hasPassword: result.linkRequired.hasPassword, email: result.linkRequired.email });
  }
  if (result.linkedTo) {
    return ok({ customer: publicCustomerFields(result.linkedTo), signInMethods: customerSignInMethods(result.linkedTo), linked: result.linked });
  }
  var customer = result.customer;
  var signedIn = finishCustomerSignIn(customer, body, provider);
  if (!signedIn.ok) return signedIn;
  // An account whose email still needs Mwakete's own confirmation: send the
  // code now, so the shopper lands on the "check your email" step.
  if (result.created && !customerEmailVerified(customer)) {
    signedIn.needsEmail = !customer.PendingEmail;
    if (customer.PendingEmail && !customerCodeRateLimited(customer.PendingEmail)) {
      var issued = issueCustomerEmailCode(customer.PendingEmail, 'verify', { name: customer.Name, customerId: customer.CustomerId });
      coolDownCustomerResend_(issued.token);
      signedIn.verifyPendingToken = issued.token;
      signedIn.sentTo = maskEmail(customer.PendingEmail);
    }
  }
  return signedIn;
}

/**
 * Rule 2, second half: the shopper has just proven the account (password or
 * code). Links the waiting identity - only to the account it was waiting for.
 */
function completePendingProviderLink(linkToken, customer) {
  var cache = CacheService.getScriptCache();
  var key = 'providerlink:' + hashSecretToken(linkToken);
  var raw = cache.get(key);
  if (!raw) return fail('That link request has expired. Sign in, then link it again from your account page.');
  var pending = JSON.parse(raw);
  if (String(pending.customerId) !== String(customer.CustomerId)) {
    return fail('That ' + PROVIDER_LABELS[pending.provider] + ' sign-in can only be linked to the account it matched.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var identity = findProviderIdentity(pending.provider, pending.providerUserId);
    if (identity && String(identity.CustomerId) !== String(customer.CustomerId)) {
      return fail('That ' + PROVIDER_LABELS[pending.provider] + ' account is already linked to a different Mwakete account.');
    }
    if (!identity) addProviderIdentity_(customer.CustomerId, pending.provider, pending.providerUserId, pending.email);
  } finally {
    lock.releaseLock();
  }
  cache.remove(key);   // single use
  logAuthEvent('link', customer.CustomerId, pending.provider);
  return { ok: true, provider: pending.provider };
}

/** Account page: remove a Google / Facebook sign-in, leaving at least one way in. */
function actionUnlinkProvider(body) {
  var customer;
  try { customer = requireCustomerAuth(body.token, { allowUnverified: true }); } catch (e) { return fail(e.message || 'Not signed in'); }
  var provider = String(body.provider || '');
  if (!PROVIDER_LABELS[provider]) return fail('Unknown sign-in method');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var methods = customerSignInMethods(customer);
    if (!methods[provider]) return fail(PROVIDER_LABELS[provider] + ' is not linked to your account.');
    var others = Object.keys(methods).filter(function (k) { return k !== provider && methods[k]; });
    if (!others.length) {
      return fail('This is your only way to sign in. Confirm your email or set a password first, then you can unlink ' + PROVIDER_LABELS[provider] + '.');
    }
    var sheet = providerIdentitiesSheet_();
    identitiesOfCustomer(customer.CustomerId)
      .filter(function (r) { return r.Provider === provider; })
      .sort(function (a, b) { return b.__row - a.__row; })
      .forEach(function (r) { sheet.deleteRow(r.__row); });
    if (provider === 'google' && String(customer.GoogleSub || '')) {
      updateRowFromObject(getSheet('Customers'), customer.__row, { GoogleSub: '', UpdatedAt: nowIso() });
      customer.GoogleSub = '';
    }
  } finally {
    lock.releaseLock();
  }
  logAuthEvent('unlink', customer.CustomerId, provider);
  return ok({ signInMethods: customerSignInMethods(customer) });
}
