# Open tasks (Mwakete)

Read first in a new session. One line per task: status - task - PR - what "done" still needs.
Kept in .claude/ so GitHub Pages never publishes it.

- [owner] Contacts & SMS go-live - set Script Property `CONTACTS_SMS=on` (docs/contacts-sms-deploy.md section 2)
- [owner] Android app live test on a real phone + SIM (docs/contacts-sms-deploy.md section 6)
- [owner] Seller one-account sign-in - check mwakete.com/owner/login.html opens the store (PR #157 merged, backend oneacct-2026-11-02 deployed)
- [owner, optional] Release signing key for the app - 4 GitHub secrets (docs/contacts-sms-deploy.md section 4)
- [owner, optional] Sheets add-on first live install (sheets-addon/README.md)
- [merged #160] Admin SMS buttons: campaigns + cancel, phones, places - needs backend deploy (getVersion = smsadmin-2026-11-03) + owner check on owner/admin.html#sms
- [merged #161] Remove dashboard Quick actions (all screens); red counts for orders/bookings/messages moved to bottom bar + menu - needs merge + owner check on owner/dashboard.html
- [merged #162] Code clean-up (store-password leftovers, daily PosChanges trim, unused functions/CSS) - needs merge + backend deploy (getVersion = cleanup1-2026-11-05)
- [merged #163] Keep internal folders off mwakete.com (_config.yml exclude) - needs owner check that the site still loads
- [merged #163] Shopper sign-in by emailed link (Lexigo style), password optional - needs backend deploy (getVersion = signin2-2026-11-06) + owner test on customer-login.html
- [planned, waiting for "Go"] Welcome screen (Billdu-inspired). On customer-login.html, and shown once on a first visit to the homepage (signed-in shoppers and shared store/product links skip it). Owner choices (7 Nov 2026): live counts via a new public `siteStats` action, cached 1h (backend deploy needed); brand-face photo on phones (~30-40 KB); "Add to home screen" button; English/Kiribati switch (Kiribati draft checked by owner). Layout: photo, headline, counts, email + Continue (sign-in link), browse as guest, password/Google, "Sell on Mwakete", home-screen button.
