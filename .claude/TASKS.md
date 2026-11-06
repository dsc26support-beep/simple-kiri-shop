# Open tasks (Mwakete)

Read first in a new session. One line per task: status - task - PR - what "done" still needs.
Kept in .claude/ so GitHub Pages never publishes it.

- [owner] Contacts & SMS go-live - set Script Property `CONTACTS_SMS=on` (docs/contacts-sms-deploy.md section 2)
- [owner] Android app live test on a real phone + SIM (docs/contacts-sms-deploy.md section 6)
- [owner] Seller one-account sign-in - check mwakete.com/owner/login.html opens the store (PR #157 merged, backend oneacct-2026-11-02 deployed)
- [owner, optional] Release signing key for the app - 4 GitHub secrets (docs/contacts-sms-deploy.md section 4)
- [owner, optional] Sheets add-on first live install (sheets-addon/README.md)
- [merged #160] Admin SMS buttons: campaigns + cancel, phones, places - needs backend deploy (getVersion = smsadmin-2026-11-03) + owner check on owner/admin.html#sms
- [in PR] Remove dashboard Quick actions (all screens); red counts for orders/bookings/messages moved to bottom bar + menu - needs merge + owner check on owner/dashboard.html
- [in PR] Code clean-up (store-password leftovers, daily PosChanges trim, unused functions/CSS) - needs merge + backend deploy (getVersion = cleanup1-2026-11-05)
- [in PR] Keep internal folders off mwakete.com (_config.yml exclude) - needs merge + owner check that the site still loads
