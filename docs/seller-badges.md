# Seller badges

Eight badges that tell a shopper something true about who they are buying from.
This is the reference for how they are earned, where they appear, and what an
admin can change.

## The badges

Shown in this order everywhere, highest first. A dense product card shows the
top two and a counter; product pages, storefronts and the admin show all of
them.

Each badge has a short label a shopper **reads** and a fuller name a screen
reader **hears** — see "What a shopper reads vs what a screen reader hears"
below.

| | Reads | Announced as | Earned by | What the shopper is told |
|---|---|---|---|---|
| 1 | 🏆 Recommended | Mwakete Recommended | A very high performance score **plus** a real track record, or an admin grant | "Recommended by Mwakete based on seller performance and customer experience." |
| 2 | Top | Top Seller | A high score plus enough orders and reviews to mean it | "Consistently strong seller performance on Mwakete." |
| 3 | Verified | Verified Seller | **Admin only** — no automatic path | "Store verified by Mwakete." |
| 4 | Responsive | Responsive Seller | Median first reply within the threshold, over enough replies | "Usually responds quickly to customer messages." |
| 5 | Delivery | Reliable Delivery | A high share of orders reaching Fulfilled, over enough orders | "Strong record of successful fulfilment." |
| 6 | Favourite | Customer Favourite | Enough customers coming back, with good ratings | "Popular with returning and satisfied customers." |
| 7 | Popular | Popular Seller | In the busiest slice of stores by recent orders | "Currently receiving strong customer interest." |
| 8 | New | New Seller | Joined within the last *n* days | "Recently joined Mwakete." |

**Verified Seller has no automatic path at all.** It means a human checked the
store, and no amount of good data is a substitute for that.

## The performance score

Six weighted components, each normalised to 0–1:

| Component | Weight | Source |
|---|---|---|
| Ratings | 30% | Published rows in `Reviews`, per owner |
| Completed orders | 20% | `Orders` at `Fulfilled`, saturating at `target.orders` |
| Responsiveness | 15% | Median first reply in `Messages`, within the window |
| Successful fulfilment | 15% | Fulfilled ÷ all orders |
| Cancellation rate | 10% | 1 − (Cancelled ÷ all orders) |
| Complaints / disputes | 10% | **No data exists — see below** |

### A missing component is not a zero

The weights are renormalised across whichever components a seller actually has
data for. Scoring someone 0 for responsiveness because nobody has messaged them
yet measures *our data*, not them, and would make every new seller look like a
bad one.

A seller with nothing scorable gets `null`, which is **not** a low score: it
earns and loses nothing on its own, and the admin page says "Not enough data to
score" rather than showing a zero.

### There is no complaints data

No ticket, dispute or report is recorded anywhere in this application. By
default that 10% is unscored and its weight renormalised away, rather than
pretending to a measurement we do not have.

Setting `complaints.useLowStarProxy` to `true` substitutes the share of 1–2★
reviews. That is a proxy, not a measurement, and it partly restates the ratings
component — so it is off until someone decides the trade is worth making. When
real dispute records exist they slot into the same 10% and the flag goes away.

### Two deliberate choices

**Responsiveness is a median over a rolling window, not a mean over all time.**
One holiday would drag an otherwise prompt seller's mean past any threshold, and
"usually responds quickly" is a claim about the usual case. The window is what
stops a good record from last year masking neglect now. A customer sending three
messages in a row is waiting once, not three times.

**Popularity is relative** — the top slice of stores by recent orders, above a
floor. An absolute threshold would badge everyone in a good month and nobody in
a quiet one, which says more about the season than about the seller.

## Lifecycle

The snapshot is rebuilt wholesale on every run. A seller who no longer qualifies
simply is not in the new list — that is what makes losing a badge work with no
separate removal path — and a seller whose performance recovers is awarded it
again. **Nothing is permanent and no seller is locked out.**

## Who can change what

Nothing a seller controls affects any of this. Every input is a row only a
customer or the system writes: `Reviews` (customers only, enforced in
`Reviews.gs`), `Orders`, `Messages`, and the join date. `Badges.gs` never reads a
request body.

The two admin-controlled badges come from columns only an admin action writes,
and the admin actions are gated on `isOwnerAdmin` on top of the router's token
check.

### Overrides

Three states per control, not two:

| | Meaning |
|---|---|
| **Automatic** | Leave it to the data |
| **Granted** | Show it regardless |
| **Removed** | Hide it even if earned |

Plus **Hide all badges for this store**, for a seller under review.

**An override changes what is shown and never what the data said.** Both are
recorded, so the admin page shows "earned, not shown — removed by an admin"
rather than one merged answer that hides which is which.

## Where they appear

| Surface | Size | Interactive? |
|---|---|---|
| Product cards, search results, store directory, Tips | chip, top 2 + counter | No — read-only |
| Product page, storefront | detail, all | Yes — popover each |
| Admin | chip, all | No — status labels instead |

**Card badges are read-only on purpose.** Every card is a single `<a>`, and a
`<button>` inside an anchor is invalid HTML that navigates instead of
explaining. Those pages carry one **"What do seller badges mean?"** panel
instead, which renders only when a card on the page actually has a badge.

### What a shopper reads vs what a screen reader hears

Labels are one word each, so a chip never wraps on a phone card. That loses the
noun: "Top" or "New" under a product name could be read as describing the
*product* rather than the store.

A sighted shopper has the layout to disambiguate — the row sits with the store's
name and is announced as a group. Someone listening to a list of products has
none of that, so the full name is supplied for them at no visual cost:

```html
<span class="seller-badge-label" aria-hidden="true">Top</span>
<span class="sr-only">Top Seller</span>
```

The accessible name is computed from content rather than from `aria-label`,
because a card badge is a plain `<span>` (a `<button>` inside a card's `<a>`
would navigate) and `aria-label` is not reliably exposed on one.

The "+N" overflow counter names the **full** versions for the same reason.

### Colour is never the difference

Four treatments, told apart by fill, shape, border weight and font weight before
any hue is involved, so they survive a greyscale screen, forced-colours mode,
and a shopper who cannot separate the blue from the purple:

- **ribbon** — Mwakete Recommended: the only filled badge; square, 2px gold border, bold
- **shield** — Verified Seller: square, thin border, 3px stripe down the left edge
- **star** — Top Seller: pill, 2px border
- **chip** — the rest: pill, 1px border, category-tinted icon

The label is always `--color-ink`, so no badge's text contrast depends on its
category. Nothing communicates by movement.

## Tips

Mwakete Recommended stores **qualify** for Tips exposure. They are not
guaranteed it and they never displace a curated one: curated items keep every
slot, and recommended stores only fill what is left up to `TIPS_STORE_SLOTS`.

**There is no paid placement in this application, and this is not a route to
one.** If sponsored slots are ever added they must be a separate, labelled list
— never mixed into this array, where a shopper would read a purchase as
something a seller earned. The trust badges are the thing that must not become
buyable.

## How it is computed, and why it is cheap

`recomputeSellerBadges()` does **four full sheet reads once** — `Owners`,
`Orders`, `Reviews`, `Messages` — and writes one row per seller to
`SellerBadges` in a **single** `setValues` call.

Nothing runs on a customer request. The read path (`sellerBadgeIndex`) does one
cached read of that snapshot and nothing else, and every badge-bearing response
looks badges up **once per response, not once per product**. `searchProducts`
already reads four sheets in full on a cold cache; a lookup per card would have
turned one expensive request into twenty.

Only the id list leaves the backend — `sellerBadges: ["verified"]`. Labels,
icons and explanations live in `assets/js/badges.js`, fetched once and
service-worker cached, rather than repeated per product in every response. The
two id lists are compared by `tests/test-badges.js` so they cannot drift.

## Setup

Both tabs are created by `setupSheets()`.

**`SellerBadges`** — derived; only `recomputeSellerBadges` writes it
`OwnerId | Badges | Score | MetricsJson | ReasonJson | UpdatedAt`

**`BadgeConfig`** — key/value, so a new threshold never needs a schema change
`Key | Value | UpdatedAt`

**`Owners`** gains three columns, appended by `ensureBadgeColumns()` without
rewriting the header row: `BadgeVerified`, `BadgeRecommended`, `BadgeSuppressed`.

Every read path tolerates all of that being absent and degrades to "no badges",
so a deployment that has not run `setupSheets()` yet browses exactly as it did
before.

### Deploying

1. Paste in `Badges.gs` (new file), `Code.gs`, `Products.gs`, `Admin.gs`,
   `Auth.gs`, `Images.gs`
2. Run **`setupSheets`** — creates the two tabs
3. Run **`recomputeSellerBadges`** — seeds the first snapshot
4. Run **`installBadgeTrigger`** — six-hourly from then on
5. Deploy → Manage deployments → ✏️ → **Version: New version** → Deploy
6. `?action=getVersion` reports the running build; `?action=checkSetup` names
   anything that did not take

`installBadgeTrigger` is deliberately not reachable from `doGet`/`doPost`: the
web app is unauthenticated, and an endpoint able to create triggers must not be
on the internet.

## Settings

All editable from the admin page, all with working defaults.

| Key | Default | |
|---|---|---|
| `enabled.<badge>` | `true` | Switch one off site-wide |
| `weight.ratings` / `orders` / `responsiveness` / `fulfilment` / `cancellations` / `complaints` | 30 / 20 / 15 / 15 / 10 / 10 | Score weights |
| `min.orders` · `min.reviews` | 5 · 3 | Floors before any performance badge |
| `target.orders` | 25 | Where completed orders stop earning more score |
| `newSellerDays` | 30 | |
| `top.score` · `top.minRating` | 75 · 4.2 | |
| `recommended.score` · `minRating` · `minOrders` | 88 · 4.5 · 15 | |
| `responsive.maxMedianMinutes` · `minReplies` · `windowDays` | 360 · 5 · 90 | |
| `delivery.minFulfilRate` · `minOrders` | 0.9 · 5 | |
| `favourite.minRepeatRate` · `minRating` · `minOrders` | 0.25 · 4.0 · 5 | |
| `popular.windowDays` · `minRecentOrders` · `topFraction` | 30 · 3 · 0.2 | |
| `complaints.useLowStarProxy` | `false` | See above |

A key the build does not know is refused rather than stored and silently
ignored, and a threshold that is not a number is refused too.

**The floors are the important ones.** Without `min.orders` and `min.reviews`
the top badge on the site goes to whoever sold one item to a friend.

## Known limitations

- **No complaints or disputes data.** See above.
- **No favourites/wishlist system**, so Customer Favourite is built from repeat
  customers, ratings and completed orders.
- **A blank `Owners.CreatedAt`** is treated as "not new" rather than "joined at
  the epoch", so sellers who predate that column are not all labelled brand new.
  The flip side: if that column was backfilled, New Seller will be wrong for
  those stores.
- **On a young marketplace most sellers have no badges**, and the surfaces are
  built for that: a seller with none renders no markup at all, and the
  explanation panel does not appear.

## Tests

| Suite | |
|---|---|
| `tests/test-badges.js` | The engine: config, score, metrics, eligibility, overrides, lifecycle, the id-list drift guard |
| `tests/test-badge-wiring.js` | One lookup per response, cache keys, nothing private in a customer payload, Tips qualification |
| `tests/test-badge-admin.js` | Authorisation per action, the override and setting whitelists |
| `tests/verify-badges-ui.js` | The component: shape without colour, disclosure, keyboard, on-screen panels |
| `tests/verify-badges-surfaces.js` | Every customer surface, and CLS measured as a difference |
| `tests/verify-badge-admin-ui.js` | The admin section |
