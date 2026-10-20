/**
 * Guests are viewers (owner decision, Oct 2026): checkout, booking and
 * sending a chat message need a signed-in customer. The pages decide that
 * from the session saved on this phone, so a browser test that is about
 * something else signs its context in here. The profile has no email or
 * name on purpose: checkout then keeps whatever the test types, and chat
 * still asks for a name.
 */
async function signInShopper(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('skiri_customer_token', 'test-shopper-session');
      localStorage.setItem('skiri_customer_profile', '{}');
    } catch (e) { /* storage blocked - the test will show it */ }
  });
}

module.exports = { signInShopper };
