# POS Integration Hub — troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pages say "Not switched on" | `POS_HUB` not `on` | Set the Script Property; redeploy not needed |
| Stays *Waiting for first signal* | No correctly signed message yet | Check secret, `connectionId`, message format (`id.timestamp.payload`), that you follow the 302 redirect |
| `invalid_signature` | Wrong secret/ID, secret rotated, connection disconnected, payload changed after signing | Sign the exact string you send; create/rotate secret |
| `stale_timestamp` | Clock off by >5 minutes | Fix the till's clock |
| `rate_limited` | >120 requests/minute | Slow down; batch |
| `paused` | Seller paused the connection | Resume it |
| Sale "Needs matching" | An item has no exact ID/SKU/barcode match | Items to match → choose product → Retry the sale |
| Sale "Needs a decision" / oversold | Sale larger than Mwakete's stock, or below what online orders hold | Stock was applied (floor 0); count and correct in Inventory, then Mark handled |
| Refund "Waiting for its sale" | Refund arrived first | Applies automatically when the sale arrives, or Retry |
| Stock count in the log | Counts never apply on their own | Use their count / Keep mine |
| Orders not reaching your system | Address not tested, export off, paused, or your system answered non-2xx | Settings → Send a test; Orders sent → Try again |
| *Gave up* | Six failed deliveries or a 4xx answer | Fix the address/endpoint, press Try again |
| "This part of Mwakete is being updated" | Backend not redeployed with the new files | Paste files, new version, check `getVersion` |
| Receipt "today" wrong | Time zone offset | Set `POS_TZ_OFFSET_HOURS` |

Everything is in **Activity & reconciliation** and the Apps Script execution log. Secrets are never logged.
