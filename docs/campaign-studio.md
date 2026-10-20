# Seller Campaign Studio

Sellers build, pay for and run their own email campaigns.

- **Sellers:** `owner/campaigns.html`, under **My Campaigns** in the seller menu.
- **Admin:** the **Seller campaigns** section of `owner/admin.html`.
- **Backend:** `apps-script/SellerCampaigns.gs`. It sends through the existing marketing engine (see [marketing-engine.md](marketing-engine.md)).

## The rules (owner decisions, Oct 2026)

| Topic | Rule |
|---|---|
| Price | **A$0.10 per active day**, in AUD (`SC_DAILY_RATE`). Days are prepaid, and a campaign runs for at most 60 days. |
| Channel | **Email only**, sent only to customers who opted in to news. Each customer gets a campaign at most once. The engine's daily limit (30) and its cap of 2 emails per customer per 7 days still apply. |
| Payment | ANZ bank transfer with an `MWC…` reference and a receipt screenshot. These go to the same Mwakete account featuring uses (`featurePaymentDetails()`), so the bank details are not repeated here. |
| Receipt checks | **Pre-screen only.** A definite failure is rejected so the seller can upload again. Everything else waits for an admin, who **always verifies against the bank**. Nothing is verified or started automatically. |
| Content | An admin **approves every campaign** before it sends. A paid campaign needs approval again after any edit. |
| Templates | The designs are fixed: Spotlight, Showcase, Seasonal, New arrival, Come back, and Custom. Every block is plain text or the seller's own product. Sellers cannot add HTML or image links. |
| Store colour | Every email uses the **store's own colour**, taken from its logo, so customers recognise the store. See "Store colour" below. The colour is locked: a campaign cannot choose another. |
| Refunds | **Unused paid days are refundable on request.** The admin pays the seller back by hand, then records it. There is no automatic payout. |
| Engine off | **Payment is closed** until `MARKETING_ENABLED=true` and `MARKETING_DRY_RUN=false`. Sellers can still build and save drafts. |

## Store colour

Customers already know their own stores, so seller emails look like the store, not like Mwakete.

- **Picking it:** the first time a seller with a logo opens My Campaigns, the page reads the logo's main colours and suggests the strongest one. The seller taps **Use this colour** to confirm it, or picks another colour from the logo.
  - The page reads the logo through `getStoreLogoData`. That action returns only the signed-in seller's own logo, as image data, because a logo served from another site can't be read by the page.
  - The colour is saved to `Owners.BrandColor` (and `BrandColorSetAt`). Both columns are added on first use.
  - The seller can change it later with **Change colour**.
- **In the email** (`scBrand` in SellerCampaigns.gs):

  | Part | Colour |
  |---|---|
  | Top bar (with the store's logo and name), buttons, footer line | The true colour, with white or dark text, whichever reads better |
  | Headings and product names | The colour darkened until it reads on white (WCAG AA, 4.5:1) |
  | Background | A very pale tint of the colour |

- **Mwakete** appears only in the footer: "Sent by Mwakete for <store>", with the unsubscribe link.
- **Locked:** the editor offers no colour choices. Any colour saved in an older campaign's style is ignored.
- **Fallback:** a store with no colour yet, no logo, or a near-white colour gets Mwakete purple (#332d63).
- **When it applies:** the colour is read when each email is built. A seller who changes their store colour changes how later emails from all their campaigns look. This doesn't need new approval, because the colour can only come from their own logo's palette and the readable variants are made by the server.

## States

```
DRAFT → AWAITING_PAYMENT → PAYMENT_REVIEW → AWAITING_APPROVAL → SCHEDULED → ACTIVE → COMPLETED
                               ↓                   ↓                          ↓  ↑
                        PAYMENT_REJECTED   CHANGES_REQUESTED              PAUSED  (resume)
                                                                              ↓
                                                    EXHAUSTED (paid days used) → Extend → PAUSED → resume
Any state except COMPLETED → STOPPED (final)
```

- **ACTIVE:** the campaign has a linked engine row in `Campaigns` with Type `SELLER_PROMOTION` and CreatedBy `seller:<OwnerId>`. The marketing admin table labels these rows "Seller" and won't approve or pause them there. They are managed in Seller campaigns.
- **COMPLETED:** the engine has emailed everyone the campaign can reach. Charging stops, and any unused days are refundable.
- **EXHAUSTED:** the paid days have run out, so sending pauses. It never restarts on its own: the seller extends and then resumes.

## Billing

- The hourly `runMarketingSweep` calls `runSellerCampaignSweep`.
- Each **Kiribati calendar day (UTC+12)** on which a campaign is ACTIVE uses one paid day.
  - Each day is written to `CampaignLedger` as a `DAY_CHARGE` row with key `day:<campaignId>:<YYYY-MM-DD>`, so a day is never charged twice.
- Paused, scheduled, pending, rejected, stopped and completed campaigns are never charged.
- **Dry run:** the sweep skips seller campaigns completely. They neither start nor get charged.
- **Ledger entry types:**

  | Entry | Days | Amount |
  |---|---|---|
  | `PAYMENT_VERIFIED` | +days | +amount |
  | `DAY_CHARGE` | -1 | -A$0.10 |
  | `REFUND` | -days | -amount |

- Every row records who made it and when.

## Admin procedure (Seller campaigns section)

1. **Payments to check** (the default view). Search by campaign ID, store or MWC reference.
2. Open a campaign. **View screenshot**, then read the receipt number and pre-screen notes.
3. **Check the ANZ account:** the exact amount must be there with the exact MWC reference.
   - If it is there, press **Verify**. The paid days are added and the campaign moves to Awaiting approval.
   - If it isn't, press **Reject** and give a reason. The seller is emailed the reason and can upload again.
4. Read the **email preview**. It is the server's own render, shown in a sandbox.
   - **Approve campaign:** it starts on its start date, at the next hourly sweep.
   - **Request changes** with a note. The seller edits the campaign, and it comes back for approval.
5. **Pause** or **Stop** needs a reason, which the seller sees. Stop is final, and any open payments are cancelled.
6. **Refund:** pay the seller back first. Then, on a paused, used-up, completed or stopped campaign, use **Record a refund** with the number of days and a reason. Only unused days can be refunded.
7. **Billing** and **History** show each campaign's full audit trail, including who did what.

Every decision is checked again on the server. The server checks that:
- the session is an admin;
- the campaign is in a state where that decision is allowed;
- the action was confirmed;
- a reason is given, at least 5 characters long.

## Sheets (created on first use, not in `REQUIRED_TABS`)

| Sheet | What it holds |
|---|---|
| `SellerCampaigns` | One row per campaign: content as JSON (blocks, style, products), audience, start date, days, PaidDays/UsedDays, status, approval details. |
| `CampaignPayments` | Each payment, `initial` or `extension`: MWC reference, amount, status (Awaiting payment / Under review / Verified / Rejected / Cancelled), screenshot URL and hash, receipt number, check notes, and who decided it. |
| `CampaignLedger` | The money and days ledger above. `IdempotencyKey` makes every entry happen once. |
| `SellerCampaignHistory` | Every state change: from, to, action, note, by, at. |

`Campaigns` (the engine) gains the `BlocksJson` and `StyleJson` columns. They are added on first use, and existing columns are untouched.

## Deployment

1. Paste these files into the Apps Script project:
   - `SellerCampaigns.gs` (new)
   - `Code.gs`, `Marketing.gs`, `MarketingEngine.gs` (changed)
2. **Deploy → Manage deployments → Edit → New version.**
3. Open `<web app URL>?action=getVersion` and check that it shows `brand1-2026-10-20` or later.
4. Sellers can build drafts straight away. Payment opens only when the engine is live:
   - `MARKETING_ENABLED=true`
   - `MARKETING_DRY_RUN=false`
   - the hourly `runMarketingSweep` trigger is installed (see marketing-engine.md, "Enabling it").

## Manual test plan (Apps Script, after deploying)

1. As a seller, create a campaign, go through all six steps and save. Check that the price shows "A$0.10 × days".
2. With the engine in dry run, check that Pay says payment is not open yet.
3. Make the engine live. Pay, upload a receipt, and check that the campaign shows **Payment under review**, not Active.
4. In Admin → Seller campaigns:
   - find it by its MWC reference;
   - Reject it with a reason, and check that the seller is emailed the reason;
   - have the seller upload again, then Verify, and check that the ledger shows `PAYMENT_VERIFIED`.
5. Request changes, have the seller edit, then Approve. Check that the status becomes Scheduled or Active.
6. After the next hourly sweep, check that `CampaignLedger` has one `DAY_CHARGE` for today. Run the sweep again by hand and check that no second charge appears.
7. Pause it, record a refund of 1 day, and check that PaidDays went down by 1 and a `REFUND` row of -A$0.10 appears.
8. Stop it, and check that it can't be resumed and that the seller got the email.
