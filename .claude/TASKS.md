# Open tasks (Mwakete)

Read first in a new session. One line per task: status - task - PR - what "done" still needs.
Kept in .claude/ so GitHub Pages never publishes it.

- [owner] Contacts & SMS go-live - set Script Property `CONTACTS_SMS=on` (docs/contacts-sms-deploy.md section 2)
- [owner] Android app live test on a real phone + SIM (docs/contacts-sms-deploy.md section 6)
- [owner, optional] Release signing key for the app - 4 GitHub secrets (docs/contacts-sms-deploy.md section 4)
- [owner, optional] Sheets add-on first live install (sheets-addon/README.md)

Backend deployed 10 Nov 2026, getVersion = welcome1-2026-11-07 confirmed by the owner (covers #157, #160, #162, #163, #164). Each line below now only needs the owner to see it live:
- [deployed #157] Seller one-account sign-in - check mwakete.com/owner/login.html opens the store
- [deployed #160] Admin SMS buttons: campaigns + cancel, phones, places - check owner/admin.html#sms
- [merged #161] Dashboard Quick actions removed; red counts on the bottom bar + menu - check owner/dashboard.html
- [deployed #162] Code clean-up (store-password leftovers, daily PosChanges trim, unused code) - nothing to see; done once a week passes with no errors
- [merged #163] Internal folders kept off mwakete.com - check the site still loads
- [deployed #163] Shopper sign-in by emailed link - check the email arrives and the link signs you in (customer-login.html)
- [deployed #164, #165] Welcome screen: photo, headline, live counts (English only since 11 Nov); sign-in is email box + button + Google - check on a phone (customer-login.html, and mwakete.com in a private tab for the first-visit version)
- [merged #166] Sign-in pages: video removed (shopper + seller sign-in, one column on a computer); "Continue as guest" under Google on the shopper sign-in - needs owner check (customer-login.html, owner/login.html)
- [merged #167] Remove the English / Kiribati switch from the sign-in welcome (English only, Kiribati draft deleted; first-visit X kept) - needs owner check on customer-login.html
- [planned] Mwakete POS on Google Play (owner, 11 Nov 2026: Play only; business account MainKT Enterprise; US$25 Play fee approved; SMS app stays on the direct APK link; no Apple for now). Plan: (1) owner gets a free D-U-N-S number for MainKT Enterprise, then opens a Play Console organisation account; (2) Claude builds a Trusted Web Activity for mwakete.com/pos/ (package com.mwakete.pos) in GitHub Actions, adds mwakete.com/.well-known/assetlinks.json (+ _config.yml include), store listing text, screenshots, data-safety answers; (3) owner uploads the signed bundle to an internal test, then production review.
- [in PR #168] Speed: all six site-scan fixes (early main request, chat checks only after a chat, batched view counts, getProduct + kept product copy, wider cache warming, no jumps on seller/help pages) - needs merge + backend deploy (getVersion = speed2-2026-11-12) + warmPublicCaches 5-minute trigger on + owner check on a phone
