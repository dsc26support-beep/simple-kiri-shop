/**
 * The Browse page's category column is a drawer behind the ☰ button on phones
 * and tablets (below 1024px, Oct 2026) and always showing on a computer.
 * Tests that use the column open it first where it is a drawer; on a computer
 * these do nothing extra.
 */
async function openRail(page) {
  const btn = page.locator('#browse-menu-btn');
  if (await btn.isVisible() && (await btn.getAttribute('aria-expanded')) !== 'true') {
    await btn.click();
    await page.waitForTimeout(300);   // the slide-in
  }
}

/** Picks a category the way a shopper would: ☰ (if shown), then the entry. */
async function pickCategory(page, selector) {
  await openRail(page);
  await page.click(selector);
  await page.waitForTimeout(300);     // the slide-out
}

module.exports = { openRail, pickCategory };
