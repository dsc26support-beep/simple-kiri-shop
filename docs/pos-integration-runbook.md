# POS Integration Hub — runbook

**Daily/weekly:** open POS & Integrations; clear *Needs attention* (match items, resolve stock differences, retry or acknowledge); check *Orders sent* for *Gave up*.

**Monitor:** attention count on the Hub; `IntegrationEvents` rows with `ReconStatus=open`; `IntegrationOutbox` rows `dead`; Apps Script executions for errors containing `posPush`.

**Retry:** events — Retry in Activity (after mapping). Outbox — Try again / Send waiting messages now. The hourly sweep (`runReminderSweep` → `runPosOutbox`) also sends.

**Reconcile:** compare till totals with Reports (in-store, online, connected). Stock: Inventory → count; a connected system's count appears as *Stock count to review*.

**Incident — wrong stock from a connection:** Pause it → find events in the log (before/after are recorded) → correct in Inventory (every change is a ledger row) → fix the mapping → Resume.

**Incident — leaked secret:** New secret (old one dies at once) → update your system → check the log for unexpected events.

**Disconnect:** Settings → Disconnect: secret deleted, mappings retired, pending outbox cancelled, history kept.

**Rollback:** set `POS_HUB=off` (UI and endpoints stop; data untouched). To remove the code, redeploy the previous `.gs` set; the extra tabs and the `pushApi` rows are ignored by older code. Do not delete tabs without a backup.

**Backup before first use:** File → Make a copy of the Mwakete spreadsheet.
