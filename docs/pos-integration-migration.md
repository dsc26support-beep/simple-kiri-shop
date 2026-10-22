# Migration

Additive only. Existing sheets, columns and actions are unchanged. New tabs are created on first use with their headers: `IntegrationMappings`, `IntegrationEvents`, `ExternalSales`, `IntegrationOutbox`, `PosSales`, `PosSaleLines`, `PosPayments`, `PosRefunds`, `PosSettings`. `InventoryConnections` gains rows of `Type=pushApi` only when a seller creates one.

1. Backup the spreadsheet (copy).
2. Paste backend files, new version, check `getVersion` = `pos1-2026-10-22` and `checkSetup`.
3. Test with `POS_HUB` off: existing pages behave as before.
4. Set `POS_HUB=on` for yourself first; create a test connection and send a signed ping.
5. Roll out to sellers; rollback = `POS_HUB=off`.

Order-event export, if switched on, uses `Orders.gs`/`Inventory.gs` hooks that do nothing unless a seller has a verified address and export enabled.
