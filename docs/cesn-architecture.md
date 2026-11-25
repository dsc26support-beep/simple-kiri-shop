# Mwakete Customer Engagement & Smart Notifications (CESN) — Architecture & Inspection Report

**Status:** Stage 1 deliverable (design only — no implementation yet).
**Author:** Claude (chief engineer), for the owner's review before the foundation build.
**Date:** 23 Nov 2026.

This report maps what Mwakete already has, what CESN adds, how the pieces fit, the
data model, the Web-Push delivery design (with the owner-only setup steps), the
security/privacy model, the Google Apps Script limits that shape the design, and a
staged delivery plan with its testing and rollback strategy. **It proposes building
CESN as an extension of the existing engine, never a parallel system.**

---

## 1. Repository inspection

### 1.1 Frontend
- **Static site on GitHub Pages**, vanilla JS (no framework). HTML pages at the repo
  root and under `owner/`, `pos/`. Shared helpers in `assets/js/` (`helpers.js`,
  `config.js`, `customer-login.js`, `store.js`, `customer-dashboard.js`, …).
- A **build step** (`npm run build`) minifies JS/CSS to `*.min` and injects a strict
  **CSP** (`tools/build-csp.js`, SHA-256 per inline script across all `*.html`);
  `npm run build:check` gates consistency. HTML is not minified.
- **PWA**: `manifest.json` (standalone, icons, theme `#332d63`) + service worker
  `sw.js` (versioned `CACHE`, a `PRECACHE` list, an image cache). **No push code.**
- API calls go through `Api.post(action, body)`; customer identity via
  `CustomerAuth.getToken()` (token in the request body).

### 1.2 Backend — Google Apps Script
- ~51 `.gs` files in `apps-script/`, deployed as one web app. Entry points
  `doGet`/`doPost` in `Code.gs`; `doPost` reads `body.action` and dispatches.
  A `PUBLIC_POST_ACTIONS` allowlist (`Code.gs:11`) marks unauthenticated actions;
  all others self-validate (`requireCustomerAuth(body.token)` or owner auth) inside
  the handler. Sub-routers exist for SMS (`dispatchSmsAction`) and POS.
- Data lives in **Google Sheets tabs** (one spreadsheet). Access helpers: `getSheet`,
  `sheetToObjects`, `updateRowFromObject`, `nowIso`; **atomic writes via
  `LockService.getScriptLock()`**. `REQUIRED_TABS` (`Code.gs:207`) + `CRITICAL_TABS`
  (`Code.gs:238`) drive `checkSetup` (hardened in PR #181) and `setupSheets`.

### 1.3 Existing data (tabs)
`Customers` (CustomerId, Name, Email, Phone, EmailVerified, …), `CustomerSessions`,
`CustomerCodes`, `Owners` (= **stores**; stores also carry a **slug**, seen as
`StoreSlug` on `Reviews`), `Products`, `Variants` (`Price`, `StockQty`, `Status`,
tiered/bulk pricing via `priceTiersOf`/`minOrderQtyOf`), `Orders` (→ a store's
**purchasers**), `Reviews`, `Featured`, `SellerBadges`/`BadgeConfig`, and the
marketing tabs `Campaigns`, `CampaignEvents`, `MarketingPreferences`.

### 1.4 Authentication & ownership
- **Customers**: email sign-in-link / code + Google / Facebook OAuth; session tokens
  in `CustomerSessions`; `requireCustomerAuth` resolves a token → customer server-side.
  A handler **never** trusts a customer id/email from the request body
  (see `actionSetMarketingPreference`).
- **Sellers/owners**: own a store (`Owners`); owner auth + store-ownership checks
  gate every seller action. Admins gated by `ADMIN_EMAILS` (kept out of public
  responses). This is the model CESN's authorisation reuses verbatim.

### 1.5 Existing engagement / marketing / notifications
- **Marketing engine** (`Marketing.gs` + `MarketingEngine.gs`) — the core reuse:
  explicit **email** opt-in (`MarketingPreferences.PromotionalEmailOptIn`, with
  `OptInAt`, `UnsubscribeToken`), **strictly separated from transactional mail**
  (login codes, orders, chat, reminders always go through `sendAppEmail`). Admin-
  configurable frequency caps via Script Properties (`MARKETING_DAILY_EMAIL_LIMIT`,
  `MARKETING_MAX_PER_WINDOW`, `MARKETING_FREQUENCY_DAYS`, `MARKETING_TRANSACTIONAL_RESERVE`),
  kill-switch/dry-run/pause/auto-approve. Campaign lifecycle (`Campaigns`,
  statuses DRAFT→READY→SCHEDULED→PROCESSING→SENT/PAUSED/CANCELLED/FAILED), per-event
  ledger (`CampaignEvents`), queue + **dedup** (`claimMarketingEvent`, `SourceKey`),
  scheduled sweep (`runMarketingSweep`), stats (`computeMarketingStats`), one-tap
  unsubscribe. Customer opt-in UI already in `customer-dashboard.js`.
- **SMS engine** (`SmsCampaigns`/`SmsCore`/`Contacts`/`SmsDevices`): a separate
  channel that sends from seller phones, with its own consent/groups/frequency/audit.
- **Transactional email/notify**: `Notify.gs`, `Reminders.gs`.
- **Audit/logging**: present across the backend (`Code.gs`, `Auth.gs`, `Utils.gs`,
  SMS/POS, etc.) — CESN reuses the existing audit approach rather than inventing one.
- **No browser/OS push, no in-app notification centre, no follow/like/favourite.**

### 1.6 Hosting / deploy / environment
- Frontend auto-deploys via **GitHub Pages** on merge to `main`.
- Backend deploys are **manual and unverifiable from this sandbox** (no network to
  script.google.com): the owner runs `clasp push` / pastes, then confirms with
  `?action=getVersion` (shows `APP_VERSION`) and `?action=checkSetup` (`setupOk`).
- Secrets live in **Script Properties**, never in frontend code.

---

## 2. Integration analysis (per CESN area)

| Area | Existing | Required change | Missing | Dependencies | Security | Compatibility |
|---|---|---|---|---|---|---|
| Marketing consent | `MarketingPreferences` (global opt-in), UI, unsubscribe | Make it **per-store** (add `StoreSlug`); migrate existing rows | Per-store opt-in UI on store page | Customers, Owners | Consent is security-sensitive; server-side only | Keep global row as "all stores" fallback during migration |
| Follow / Like | none | new tabs + actions + UI | everything | Customers, Owners | Must not leak audiences cross-store | Two **distinct** buttons (spec) |
| Favourite Stores | none | new customer-dashboard section | everything | StoreFollows | Customer-scoped only | Mobile-first |
| Notification Centre | none | new tab + actions + UI | everything | Notifications tab | Customer-scoped | Survives push failure (in-app persists) |
| Web Push | none | **FCM relay** + client + subscriptions | everything | Firebase (free), VAPID, service account | Token = PII-ish; never shown to sellers; key in Script Property | CSP + `worker-src`; permission only on explicit gesture |
| Campaign engine | email campaigns + queue + dedup + freq | extend to event-triggered, per-store/-category, multi-channel | push/in-app channels, per-category rules | Marketing engine | No consent bypass via manual audience | Shared frequency service for auto + manual |
| Price-drop | tiered pricing exists | price-history + detector | history tab + detector + anti-inflation | Products/Variants | Audit each trigger; no misleading claims | Retail (`Price`) vs wholesale (tiers) separate |
| Admin panel | marketing admin actions | extend (limits, categories, volumes, abuse, audit) | per-category toggles, push metrics | Admin.gs | Permission-controlled + audited | Free for sellers preserved |

---

## 3. Target architecture

**One unified engagement layer, three independent relationships** (Follow, Like,
Marketing-consent), feeding **one notification engine** that delivers over **three
channels** (in-app centre, Web Push, email), governed by **one consent + frequency +
dedup + audit service** — the existing Marketing engine, extended.

```
 Customer actions            Engine (extended Marketing engine)        Channels
 ----------------            ----------------------------------        --------
 Follow / Unfollow  ─┐       eligibility  (store + relationship)       in-app centre
 Like / Unlike       ├─────▶ audience     (Followers/Likers/            (Notifications tab)
 Marketing opt-in   ─┘        Purchasers/Subscribers, de-duped)        Web Push (FCM)
 (per store)                 frequency    (Script-Property caps)        email (existing)
                             dedup        (SourceKey / claim)
 Events (price drop,         retries + failure handling
 new arrival, back-          audit        (existing audit)
 in-stock, …)        ─────▶  category rules (11 types)
```

Relationship independence (hard rules, enforced server-side): a **Like** is not a
Follow and not Favourites; a **Follow** does not require a purchase; a **purchase is
never** automatic marketing consent; a **marketing subscriber** is not a follower or
liker. Only the store a customer engaged with may use that relationship for
eligibility. An explicit opt-out is never overridden.

---

## 4. Data dictionary (new + extended tabs)

Google Sheets has **no native keys, foreign keys, unique constraints or indexes**.
We emulate them in code: a synthetic id column as PK, composite "unique keys"
enforced under `LockService` (read-check-write), and lookups by scanning
`sheetToObjects` (acceptable at current scale; see §8 for the large-list mitigation).
All tabs carry `CreatedAt`/`UpdatedAt` ISO timestamps.

**New tabs**
- `StoreFollows`: `FollowId` (PK), `CustomerId`, `StoreSlug`, `Status`
  (`active`/`removed`), `CreatedAt`, `UpdatedAt`. Unique: (CustomerId, StoreSlug) active.
- `StoreLikes`: `LikeId` (PK), `CustomerId`, `StoreSlug`, `Status`, `CreatedAt`,
  `UpdatedAt`. Unique: (CustomerId, StoreSlug) active.
- `Notifications` (in-app centre): `NotificationId` (PK), `CustomerId`, `StoreSlug`,
  `Category`, `Title`, `Body`, `ImageUrl`, `DeepLink`, `CampaignId`, `ReadAt`,
  `CreatedAt`. Retention: keep 90 days read / 180 days total (configurable), pruned
  by the existing sweep.
- `PushSubscriptions`: `SubId` (PK), `CustomerId`, `FcmToken`, `UserAgent`,
  `Platform`, `Status` (`active`/`unregistered`), `LastSeenAt`, `CreatedAt`. Unique:
  `FcmToken`. **Never exposed to sellers.**
- `PriceHistory`: `EntryId` (PK), `ProductId`, `VariantId`, `PriceType`
  (`retail`/`wholesale`), `Price`, `ValidFrom`, `Source`, `CreatedAt`. Drives the
  price-drop detector and the anti-inflation guard.
- `NotificationRules` (optional config tab) + reuse of Script Properties for limits.

**Extended tabs**
- `MarketingPreferences`: add `StoreSlug` (per-store consent). Migration: existing
  global rows become a `StoreSlug='*'` fallback; the UI writes per-store rows going
  forward; consent **withdrawal history** preserved by never hard-deleting — status +
  `UpdatedAt` changes are appended to the audit log.
- `Campaigns`/`CampaignEvents`: add `Channel` (`email`/`push`/`inapp`) and
  `Category` (the 11 types); reuse everything else.

**Migration & rollback.** All changes are **additive** (new tabs, new columns at the
end of existing header rows — never reordering or rewriting live-data headers, per
the `CRITICAL_TABS` rule). Rollback = stop writing the new columns/tabs and revert the
`.gs`/frontend; existing rows are ignored by the old code. Each stage's deploy is a
new `APP_VERSION`, so rollback is "redeploy the previous version".

---

## 5. Delivery: Web Push via FCM (free; Apps-Script-compatible)

Pure Apps Script cannot perform Web Push payload encryption (ECDH + HKDF +
aes128gcm). **Firebase Cloud Messaging (FCM)** does the encryption for us and is
**free with no paid tier**:

- **Client**: Firebase JS SDK (pinned version, from an allowed CDN) + a messaging
  handler in the service worker. On an **explicit customer gesture** ("Turn on
  notifications"), call `Notification.requestPermission()` then `getToken(VAPID_PUBLIC)`
  → an FCM registration token, saved via a new `registerPushSubscription` action.
  Following or liking **never** silently triggers the OS permission prompt.
- **Backend** (`Push.gs`): send via **FCM HTTP v1** (`POST
  https://fcm.googleapis.com/v1/projects/<id>/messages:send`) authorised by a Google
  **service-account JWT** that Apps Script signs and exchanges for an OAuth token via
  `UrlFetchApp`. Multi-device per customer; on a `404/UNREGISTERED` response, mark the
  token `unregistered` and stop using it; bounded-backoff retries; dedupe by the
  engine's `SourceKey`. If FCM is unreachable, the in-app `Notifications` row still
  exists (graceful fallback).
- **CSP**: allow `https://fcm.googleapis.com`, `https://fcmregistrations.googleapis.com`,
  `https://*.googleapis.com`, `https://www.gstatic.com` (SDK) in `connect-src`/`script-src`
  as needed, and keep `worker-src 'self'`. Added via `tools/build-csp.js`.

### 5.1 Owner-only setup runbook (I cannot do these — console/OAuth)
1. Create a **free Firebase project** (console.firebase.google.com) — no billing needed.
2. **Project settings → Cloud Messaging**: ensure the API is enabled.
3. **Web Push certificates**: generate a **VAPID key pair**. Give me the **public**
   key → it goes in `assets/js/config.js` (safe to expose) + the Firebase web config
   (apiKey/projectId/appId/messagingSenderId — these are not secrets).
4. **Service accounts → generate a private key** (JSON). Paste it into the Apps
   Script project as Script Property `FCM_SERVICE_ACCOUNT` — **secret, never in
   frontend, never in the repo.**
5. Tell me when done; I verify with a real test-device send.

---

## 6. The eleven notification categories

Every category shares the engine's eligibility → audience → frequency → dedup →
validation → analytics → audit pipeline. Audience is always the **eligible** set only
(relationship + per-store consent + channel permission), de-duplicated across
Follower/Liker/Purchaser/Subscriber overlap by `(CustomerId, SourceKey)`.

1. **Significant price reductions** — auto; trigger ≥10% on a verified valid price
   (see §7); audience = eligible followers/subscribers interested in the product/store.
2. **New arrivals** — auto on product publish; store followers/subscribers.
3. **Flash sales** — manual, time-boxed.
4. **Back in stock** — auto when `StockQty` crosses 0→positive and `Status` is live;
   customers who asked/were interested.
5. **Exclusive discounts** — follower-restricted manual.
6. **Seasonal campaigns** — manual (Christmas/New Year/local).
7. **Bundle deals** — on bundle publish.
8. **Store announcements** — manual (hours/closure/branches).
9. **Popular products** — only from **verified marketplace activity** (orders/views),
   never seller-asserted.
10. **Loyalty & rewards** — manual appreciation/milestones.
11. **Manual promotional campaigns** — seller-authored, eligibility enforced.

Each has: eligibility rules, audience rules, per-category frequency, duplicate
prevention, content validation (no unverifiable superlatives/claims — mirrors
`generateCampaignCopy`'s existing discipline), analytics, audit.

---

## 7. Price-drop intelligence

`percent = ((prevValidPrice − currentValidPrice) / prevValidPrice) × 100`, trigger
when `percent ≥ 10`. Uses the new `PriceHistory` tab:
- Compare against the **previous valid, published** selling price only; ignore
  unpublished/invalid/zero prices.
- **Retail (`Variants.Price`) and wholesale (tier prices) tracked separately** — a
  wholesale change never fires a retail-price notification and vice-versa.
- **Anti-inflation guard**: if the "previous" price was set very recently and is
  itself above a trailing baseline (a price raised then dropped), suppress — do not
  advertise a manufactured discount.
- **Dedupe**: one notification per genuine reduction per product per eligible customer
  (engine `SourceKey`), respecting per-customer and per-category frequency.
- Currency/precision/rounding follow Mwakete's existing pricing conventions.
- Every trigger records the inputs + computed percent to the audit log.

---

## 8. Google Apps Script / Sheets limits & mitigations

- **Execution time** (~6 min/run) and **triggers**: the engine already works in
  **batches** on a scheduled sweep (`MARKETING_BATCH_SIZE`, hourly). CESN keeps that —
  push/in-app sends are batched the same way, never inline with a shopper request.
- **Email quota**: existing `MARKETING_TRANSACTIONAL_RESERVE` protects login/order
  mail; push (FCM) has no such quota, easing the busiest channel.
- **Concurrency**: `LockService` already serialises writes; follow/like/consent use it.
- **Large-list performance**: scanning a whole tab per lookup is the real scale risk
  (seller dashboards with big follower lists, §13 performance tests). Mitigation:
  server-side pagination for audience reads, cached counts (like `SellerBadges`),
  and append-only writes. If a tab grows past a safe row count we document a move of
  that tab to a dedicated spreadsheet — **no backend replacement** is proposed now.
- **Conclusion**: the current stack supports CESN **except** Web Push encryption,
  which FCM (free) resolves. No new always-on server, no paid infra.

---

## 9. Security & privacy

Server-side authorisation on every action; store-ownership verified for seller
actions; customer identity only from the session token (never body-supplied ids);
**cross-store isolation** (a seller sees only their own audiences); audiences exclude
**push tokens and device data**; input validation + output encoding (existing CSP +
escaping); audit logs for every consent change and campaign action; rate limiting and
`LockService` against replay/concurrency; admin actions permission-gated + audited.
Sellers can **never** send for another store, read another store's audience, add
customers without permission, change a customer's consent, send after opt-out, or
exceed Mwakete's caps. Follows applicable e-marketing/consent norms.

---

## 10. Admin control panel

Extend the existing marketing admin actions: global frequency limits (Script
Properties), per-category enable/disable, notification volumes, delivery failures,
abuse investigation, campaign activity, platform rules, service health, audit review,
template management, operational delivery limits. All permission-controlled + audited.

---

## 11. Free for every seller

No paid subscriptions, campaign access, credits, premium categories, per-send
charges, or artificial free-tier caps. Mwakete's platform-wide limits are
**anti-abuse/infra controls, not a paid feature**. FCM (free) + email (existing quota)
keep marginal cost ~zero; costs are monitored, never passed to sellers.

---

## 12. Staged delivery & acceptance

1. **Architecture report** (this doc) + kick off owner Firebase setup. *(now)*
2. **Foundation PR**: `StoreFollows`/`StoreLikes`/`Notifications` tabs + per-store
   consent; `Engagement.gs` (atomic follow/like/consent/notification actions);
   Follow+Like buttons & counts on `store.html`; Favourite Stores + Notification
   Centre + preferences in the customer dashboard; seller "Customer Engagement"
   audiences (distinct, no dup records, no device data); harness + UI tests.
3. **Push** (`Push.gs` + FCM client + `PushSubscriptions` + permission UX + retry/prune).
4. **Smart engine extension** (event-triggered, per-store/-category, multi-channel,
   shared frequency, critical≠promo).
5. **Price-drop intelligence** (`PriceWatch.gs` + `PriceHistory`).
6. **11 categories** fully wired.
7. **Seller campaign management + honest analytics** (delivery/open/click distinct).
8. **Admin panel** extension.
9. **Integration/security/performance testing + staged deploy + verification.**

**Acceptance = the spec's Phase-13 test list**, executed as real tests with real
results (never fabricated): following/liking distinctness, purchase≠consent, consent
withdrawal honoured, 9.9%/10%/>10% price thresholds, anti-inflation, retail≠wholesale,
dedup across overlapping audiences, cross-store rejection, no-consent-bypass, failure
handling, deep links, unsubscribe/unfollow, large-list dashboard performance.

---

## 13. Testing strategy
- **Backend**: Node `vm` harness tests (pattern of `tests/test-checksetup.js`,
  `tests/test-sms-integration.js`) — no Google APIs needed. New:
  `test-engagement.js`, `test-pricewatch.js`, `test-push.js`; extend
  `test-checksetup.js` for the new tabs/files.
- **Frontend**: `npm run build:check`; Playwright render checks at 390/768/1280.
- **Push**: real end-to-end once the owner's keys are set.

## 14. Deploy & rollback
- Frontend ships on merge to `main` (Pages). Backend: owner `clasp push`/paste, then
  `?action=getVersion` + `?action=checkSetup`; I never claim a deploy landed without
  that. Rollback = redeploy the previous `APP_VERSION`; additive schema means old code
  ignores new columns/tabs.

## 15. Unresolved limitations / outstanding work
- **Owner-gated**: Firebase project + VAPID public key + `FCM_SERVICE_ACCOUNT` Script
  Property; each backend deploy; (later) confirming push on a real device.
- **iOS Web Push** requires the user to "Add to Home Screen" (Apple limitation) — we
  surface this, can't change it.
- **Open/read metrics** are only as reliable as the channel allows — reported
  honestly, never asserted when unverifiable.
- **Large-list scale**: mitigated by pagination/caching; a per-tab spreadsheet split
  is documented as the escape hatch if a tab outgrows a safe size.
- **Branch/PR**: lands after PR #187 merges (single dev branch) unless the owner asks
  to bundle.
