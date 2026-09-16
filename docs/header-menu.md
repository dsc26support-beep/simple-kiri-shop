# The header menu

The three-dot button in the top-right corner of the browsing pages, and the
list behind it.

## Why it exists

The header nav rows had drifted apart. Four pages carried four different
answers to "where else can I go":

| Page | Before |
|---|---|
| Home | Tips · Create Store · Sign In |
| All Stores | Home · Create Store |
| Browse | Home · Stores |
| Product | Home · Store |

Adding a fifth destination to any of them meant finding room for a fifth link
on a phone header, which there is not. One control that is the same on every
page costs one corner and holds as many items as the list needs.

## Where it is

Six pages: **home, All Stores, Browse, a storefront, a product, Tips**.

**Not** on checkout, cart, my-carts or either login page. A menu beside a
payment step is an invitation to leave it, and the cart pages already have the
bottom nav.

The button sits in the top-right of the **content column**, not the window —
`.header-top-row` is `position: relative` and capped at 1100px, which is where
the cart button has always sat. On a wide screen a control pinned to the glass
is adrift from everything else on the page.

Above 700px the cart button steps one width to the left to share the corner.
Below 700px it is `display:none` (the bottom nav carries Cart there) and the
menu has the corner to itself.

## The list

| | Goes to | Shown |
|---|---|---|
| Stores | `stores.html` | Always |
| Categories | `categories.html` | Always |
| Create Store | `owner/login.html?tab=register` | **Unless this device holds a seller token** |
| Help & Support | `mailto:admin@mwakete.com?subject=Mwakete Enquiry` | Always |
| Tips | `customer-tips.html` | Always |
| My Account | Dashboard, login, or the chooser — see below | Always |
| Recent Stores | `stores.html#cart-stores` | **Only when this device has a cart** |

### Both conditions are read from the device, with no request

A menu that has to wait for the backend before it can be opened is a menu that
is wrong for the first second of every page. Create Store checks
`Auth.getToken()` — the same rule, and the same check, the homepage nav used
before this menu replaced it. Recent Stores counts non-empty `skiri_cart_*`
keys through `cartStoreSlugs()`, the helper that already backs the bottom-nav
cart badge.

### My Account has three answers

| Session | Destination |
|---|---|
| Customer signed in | `customer-dashboard.html` |
| Seller only | The Customer / Seller chooser |
| Neither | `customer-login.html` |

The chooser is `showLoginChooser()`, lifted unchanged out of `home-nav.js`.
Someone holding a seller token but no customer one has two honest answers to
"my account", and guessing sends half of them to a login form for an account
they do not have.

### Recent Stores is not Favourites

There is no favourites or wishlist feature in this application. This item
points at **"Pick up where you left off"** on `stores.html` — the stores this
*device* has a cart with, from localStorage. It is not per-person, does not
follow anyone to a second phone, and nothing was favourited. Hence the label.

Building real favourites means a saved-stores tab keyed on a customer account,
a control on storefronts and cards, and a page to list them. That is its own
piece of work; this is an honest link to something that already exists.

## What was removed

The homepage nav row — Tips, Create Store, Sign In — and `home-nav.js` with it.
Every one of those destinations is in the menu, and Create Store keeps the
visibility rule it had. **Sign In is no longer one tap from the homepage**; it
is "My Account", one tap inside the menu.

`stores.html` also loses its Create Store link, which duplicated the menu's and
did not disappear for sellers the way the homepage one did.

The `.site-nav .nav-tips` rule went with the row it hid.

`Home`, `Stores`, `Store` and `Browse Stores` links in the other headers stay.
Those are back-navigation, not an overflow list, and the menu has no Home item.

## Behaviour

Injected by `header-menu.js` at `DOMContentLoaded`, for the reason
`header-cart.js` gives for doing the same: the headers are not a shared
component, and six hand-written copies of one list is how they drift.

Both the button and the panel are **out of flow**. A deferred script runs after
the first paint, so anything it adds to the flow moves the page under the
reader's thumb — the cause of every CLS regression in this codebase so far.

- Opens on click, Enter/Space, or ArrowDown (which lands on the first item)
- Closes on click again, Escape, a click outside, or tabbing past the last item
- Escape returns focus to the button
- Arrow keys walk the list and wrap; Home and End jump to the ends
- Every item is at least 44px tall
- The current page keeps its entry and is marked with `aria-current="page"`,
  told apart by weight and an inset rule, never by colour alone
- Every item carries an icon **and** a text label; no icon stands alone

The panel sits at `z-index: 1002` — above the chat FAB and chat window, below
the cookie notice and the login chooser, both of which are meant to be answered
before anything else.

## Tests

`tests/verify-header-menu.js` — presence and absence per page, the full item
list, both conditional items, the three My Account routes, keyboard and
dismissal, geometry at 320/390/1366, a hit test against the chat FAB, and CLS
on all six pages measured as a difference against the same page with the script
blocked.

The homepage's own CLS is dominated by a pre-existing footer shift unrelated to
this menu, which is why that measurement is a difference and not an absolute.
