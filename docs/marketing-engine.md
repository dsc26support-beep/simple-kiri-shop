# Mwakete Marketing Engine

Promotional email to customers who **opted in**, built on the existing stack: Apps Script, Sheets and `sendAppEmail`. Off by default.

- Backend: `apps-script/Marketing.gs` (settings, consent, template, copy, admin and customer actions) and `apps-script/MarketingEngine.gs` (audience, interest, generation, queue, sweep, stats).
- Admin screen: the **Marketing** section of `owner/admin.html` (`assets/js/admin-marketing.js`, loaded on that page only).
- Customers: an opt-in box on `customer-dashboard.html`, a one-tap `unsubscribe.html`, and a "Promotional emails" section in `privacy.html`.

## What already existed (kept exactly as it was)

`runReminderSweep` (Reminders.gs, hourly trigger) still sends:
- the abandoned-cart reminder, 1 hour after a cart is saved, once;
- the "call your customer" email to sellers when an order has no email address;
- featuring renewal emails, scheduled stock syncs, session cleanup and archiving.

Login, sign-up and 2FA codes, password resets, order and booking emails and chat notifications are untouched. All of them are transactional; the engine never sends or blocks any of them.

The abandoned-cart reminder stays the **only** abandoned-cart email. The engine has no abandoned-cart campaign. Its `PRODUCT_INTEREST` campaign reaches only opted-in customers, 3 to 30 days after that one reminder, if the item is still listed and was never ordered.

## Sheets (new tabs only)

Created by `setupSheets()` and checked by `?action=checkSetup` (`REQUIRED_TABS` in Code.gs):

| Tab | Headers |
| --- | --- |
| `Campaigns` | CampaignId, Name, Type, Status, Objective, AudienceType, AudienceFilterJson, ProductIdsJson, StoreSlugsJson, Subject, PreviewText, BodyHtml, BodyText, CTAUrl, CTAType, StartAt, EndAt, CreatedAt, UpdatedAt, CreatedBy, MaxRecipients, SentCount, FailedCount, LastRunAt, **SourceKey** |
| `CampaignEvents` | EventId, CampaignId, CustomerId, Email, EventType, Status, CreatedAt, SentAt, FailureReason, MetadataJson, **Attempts** |
| `MarketingPreferences` | CustomerId, Email, PromotionalEmailOptIn, FrequencyLimit, LastPromotionalEmailAt, UpdatedAt, **OptInAt**, **UnsubscribeToken** |

The **bold** headers were added to the brief's list. SourceKey makes automatic campaigns one per period. Attempts drives the retry limit. OptInAt records when consent was given. UnsubscribeToken powers the one-tap link.

`BodyHtml` is never filled: emails are rendered from plain text at send time, and no HTML from a cell or form ever reaches an email.

There is no `MarketingActivity` tab. Activity is read from Orders, Bookings, Reviews and AbandonedCarts, which Mwakete already keeps.

## Script Properties

| Property | Default | Meaning |
| --- | --- | --- |
| `MARKETING_ENABLED` | `false` | Master switch. Anything but `true` = nothing runs. |
| `MARKETING_DRY_RUN` | `true` | Records who *would* be emailed; sends nothing. Only an exact `false` turns it off. |
| `MARKETING_PAUSED` | `false` | Soft pause; also the admin page's Pause/Resume button. |
| `MARKETING_AUTO_APPROVE` | `false` | `false`: automatic campaigns wait as DRAFT for an admin. `true`: they go straight to READY. |
| `MARKETING_DAILY_EMAIL_LIMIT` | `30` | Promotional emails per day, all campaigns. |
| `MARKETING_BATCH_SIZE` | `10` | Emails per hourly run. |
| `MARKETING_FREQUENCY_DAYS` / `MARKETING_MAX_PER_WINDOW` | `7` / `2` | At most 2 promotional emails per customer per 7 days. |
| `MARKETING_MAX_RETRIES` | `2` | Attempts before an email is marked FAILED. |
| `MARKETING_INACTIVE_DAYS` | `30` | No order, booking, review or cart for this long = lapsed. |
| `MARKETING_ATTRIBUTION_DAYS` | `7` | An order this soon after an email counts as a conversion. |
| `MARKETING_TRANSACTIONAL_RESERVE` | `40` | When Resend is not set up, marketing stops while MailApp has this many or fewer sends left today, so sign-in and order emails always have room. |
| `SITE_BASE_URL` | (existing) | Required for email links. Without it nothing sends. |

The defaults are below the brief's suggested 50/day. Without Resend, Gmail's MailApp allows about 100 emails a day *in total*, and sign-in codes and order emails share that quota.

## How it runs

One extra time-driven trigger: **`runMarketingSweep`, hourly**. It is deliberately separate from `runReminderSweep`, so a slow or failing marketing run can't delay a cart reminder or session cleanup.

```
runMarketingSweep
  ├─ off / paused?            -> stop
  ├─ another sweep running?   -> stop
  ├─ generateMarketingOpportunities   creates campaign RECORDS only, never sends
  └─ processMarketingQueue            small batches, stops cleanly at its limits
```

### Generation

Only creates a campaign when somebody would actually receive it.

| Campaign | When | Who |
| --- | --- | --- |
| `NEW_PRODUCTS` (weekly) | 3+ new listings this week | Opted in; their categories first |
| `CATEGORY_TRENDING` (weekly) | Popular listings exist (`Products.Views`) | Customers with that category in their orders |
| `STORE_UPDATE` (per store, weekly) | The store added listings this week | Customers who ordered, booked, reviewed or carted there |
| `PRODUCT_INTEREST` (weekly) | Cart reminded 3-30 days ago, item still listed, not ordered | That customer |
| `INACTIVE_CUSTOMER` (monthly) | No activity for 30+ days, new listings since, not asked in 60 days | That customer |
| `RETURNING_CUSTOMER` (monthly) | At least one completed order; new listings from their stores or categories | That customer |

Admin-only campaigns: `SELLER_PROMOTION` (one store, up to 4 of its products) and `SEASONAL`. Both start as DRAFT.

### Statuses

```
DRAFT -(approve)-> SCHEDULED -> PROCESSING -> SENT
        READY (auto-approve) ---^         \-> SCHEDULED (more to send next run)
any active -(pause)-> PAUSED -(resume)-> SCHEDULED      any -> CANCELLED
```

A draft nobody approved before its end date becomes CANCELLED.

### Queue

For each due campaign, at most 3 per run:
1. Retry earlier failures under the retry limit.
2. Work out who qualifies now.
3. Skip anyone already handled and defer anyone over the frequency cap.
4. **Claim** a `CampaignEvents` row under the script lock, re-checking first.
5. Send through `sendAppEmail` and record SENT, RETRY or FAILED.

The run stops at the batch size, the daily limit, the MailApp reserve, or 4.5 minutes, and the next hourly run carries on.

## Interest score

Deterministic:
- Weights: completed order 6, placed order 3, booking 3, abandoned cart 4, review 3.
- Decay by age: 0-7 days ×1, 8-30 days ×0.6, 31-90 days ×0.25, over 90 days ignored.
- A store or category needs a score of 3 or more (about one recent order) to count as an interest.

Constants are at the top of MarketingEngine.gs.

Not built:
- **HIGH_VALUE_CUSTOMER:** order totals are seller-entered and could mislead.
- **View-based interest:** nothing records who viewed what. That's by design and the Privacy Policy promises it.

## Security and privacy

- **Admins only:** every admin action calls `isOwnerAdmin` on the server. Sellers have no marketing access in this version; an admin creates a seller's promotion.
- **No addresses in the browser:** no API returns a customer email address. The preview shows counts and a sample addressed "there".
- **Consent tied to the session:** the customer actions use the session's customer, never an id or email from the request.
- **Unsubscribe:** the token is random and per customer, and an unknown token answers exactly like a known one, so tokens can't be probed. The page needs a button press, so email scanners that open links can't unsubscribe anyone.
- **Plain text only:** campaign text is refused if it contains `<` or `>`. Every value is escaped when the email is built, and links are only `SITE_BASE_URL` https pages.
- **Seller promotions:** the store must be open and not the hidden admin store, and every product must be live and belong to that store.
- **No invented claims:** copy comes from real names, stores and places only. The engine never adds prices, discounts, stock, delivery times or superlatives.
- **Clicks:** `?mc=&me=` on a product or store link is counted once, and only for an email that was really sent for that campaign. Opens are not tracked.

## Enabling it

1. Paste the new and changed `.gs` files, Deploy → New version, then check `?action=getVersion`.
2. Run `setupSheets` once from the editor. It creates the three tabs and leaves every other tab alone.
3. Script Properties: confirm `SITE_BASE_URL` is set; leave the marketing ones unset (defaults are safe).
4. Triggers → Add trigger → `runMarketingSweep`, Time-driven, Hour timer, Every hour.
5. **Dry run:** set `MARKETING_ENABLED = true`, keeping `MARKETING_DRY_RUN` unset or `true`. Approve a campaign on the admin page, then check `CampaignEvents` for `DRY_RUN` rows and look at Preview.
6. **Live:** set `MARKETING_DRY_RUN = false`.
7. **Turning it off:** Pause on the admin page (soft), or `MARKETING_ENABLED = false` (hard).

## Troubleshooting

- **Nothing sends:**
  - The admin page's status line says why: Off, Paused, Dry run, or "SITE_BASE_URL is not set".
  - Drafts must be approved.
  - Nobody opted in = nobody to email.
- **Fewer emails than expected:** this is usually the 2-per-7-days cap (deferred, not lost), the daily limit, or the MailApp reserve.
- **FAILED rows:** the email service refused the address twice. Other recipients carry on.
- **"another sweep is running" forever:** the `MARKETING_SWEEP_LOCK` Script Property expires by itself after 15 minutes. You can delete it.

## Later (extension points, not built)

- **AI copy:** `generateCampaignCopy` is the single place to add it, with today's text kept as the fallback.
- **Other channels:** WhatsApp, SMS or push would add a sender beside `deliverMarketingEmail`. See Notify.gs for the SMS options.
- **Seller self-serve campaigns:** they would need their own store-scoped actions.
