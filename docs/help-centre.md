# Help Centre

`help.html` (served at `https://mwakete.com/help`). Website-only: no Apps Script, no Sheets, no backend calls.

## Files

| File | What it is |
| --- | --- |
| `assets/js/help-content.js` | **The content.** Categories, FAQs, guides, blog posts (empty) and every UI string (`HELP_STRINGS.en`). Edit this, nothing else, to change what the Help Centre says. |
| `tools/build-help.js` | Writes the topic cards, FAQ and guide markup **and** the FAQPage / BreadcrumbList JSON-LD into `help.html`, between `<!-- help:NAME:start/end -->` markers. Run by `npm run build`. |
| `assets/js/help-search.js` | The unified search: one ranked, in-memory search over FAQs, guides and blog posts. Pure functions. |
| `assets/js/help-icons.js` | The Mwakete icon set (`mwaketeIcon(name, {size, label})`): 24-unit box, 2px rounded stroke, `currentColor`. Used at build time and in the browser. |
| `assets/js/help.js` | Page behaviour: accordion, search box, filters, deep links, zero-result state. |
| `assets/css/styles.css` | The `Help Centre` block at the end. |

## Changing content

1. Edit `assets/js/help-content.js`. Plain text only; a blank line starts a paragraph. Links go in `action` (`{ label, href }`, internal pages or the support mailto) or `related` (ids of other FAQs/guides).
2. `npm run build` (rebuilds `help.html` and the `.min` files).
3. Bump `CACHE` in `sw.js` so installed copies pick it up.
4. `node tests/test-help.js && node tests/verify-help.js`.

Keep answers true to the Terms of Service: Mwakete never takes payment, holds money, refunds or delivers; prices, delivery and timing are the seller's. `tests/test-help.js` rejects common over-promises ("guarantee", "buyer protection", ...).

An FAQ's `id` is its public URL (`help.html#faq-<id>`) - do not rename one that has been shared.

## Search

- Query is lower-cased, accents folded, filler words dropped ("how can I ..."), words stemmed (selling -> sell, payments -> pay) and widened with a small synonym list (ship -> delivery, scam -> fraud).
- Ranking: exact title > title phrase > per-word matches weighted title 12, category 9, keywords 7, subtitle 5, description 3, guide steps 2. Prefix matches and one-typo matches count. An entry must match at least half the query's words; results under 35% of the best word-score are dropped, max 20.
- `?q=` and `?topic=` in the URL run a search on load, so searches can be shared.

## Blog

Mwakete has no blog yet, so `HELP_BLOG_POSTS` is empty and the Blog filter is hidden. When a blog exists, map each post into `{ id, title, subtitle, description, category, tags, url, publishedAt, minutes }` and push it into `HELP_BLOG_POSTS` (or load it into the same shape) - search, labels and filters pick it up with no other change.

## Not done on purpose

- **Analytics / zero-result logging.** The Privacy Policy says Mwakete runs no analytics or tracking. Logging searches would need a policy change and a new Sheet tab - an owner decision.
- **Kiribati translation.** Strings and content are structured for it (`HELP_STRINGS[lang]`), but a translation must be written and approved by a person, not machine-made.
