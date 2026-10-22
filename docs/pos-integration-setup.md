# POS Integration Hub — setup guide

## 1. Deploy and switch on (owner)

1. Paste the changed backend files into Apps Script (see [DEPLOY.md](../DEPLOY.md)): `Code.gs`, `Auth.gs`, `Inventory.gs`, `InventorySync.gs`, `Orders.gs`, `Reminders.gs` and the **new** files `IntegrationHub.gs`, `IntegrationOutbox.gs`, `Pos.gs`. Deploy a new version.
2. Open `<web app URL>?action=getVersion` — it must show `pos1-2026-10-22`. Open `?action=checkSetup`; `missingFiles` must be empty.
3. Script Properties: `POS_HUB` = `on`. Optional `POS_TZ_OFFSET_HOURS` (default `12`, Kiribati) for "today" in reports.
4. Seller menu now shows **Point of Sale** and **POS & Integrations**.

To switch off: set `POS_HUB` to `off`. Pages explain the feature is off; no data is deleted.

## 2. Connect a till or shop system (seller)

1. POS & Integrations → **Connect a system** → name it → copy the **Connection ID** and **Secret** (shown once).
2. Your system POSTs JSON to the Mwakete web app URL (follow redirects):

```json
{ "action": "posPush", "connectionId": "conn_…", "timestamp": 1760000000000,
  "payload": "{\"type\":\"ping\"}", "signature": "<hex>" }
```

`signature` = hex HMAC-SHA256, key = your secret, message = `connectionId + "." + timestamp + "." + payload` (payload is the exact string sent). `timestamp` is milliseconds (or seconds) since 1970, within 5 minutes of now.

Node example:
```js
const ts = Date.now(), payload = JSON.stringify({ type: 'ping' });
const signature = require('crypto').createHmac('sha256', SECRET).update(`${ID}.${ts}.${payload}`).digest('hex');
```

3. A signed `ping` turns the status from *Waiting for first signal* to *Connected*. Nothing else does.

### Events (`payload`)

* `sale`: `{type:'sale', id, version?, occurredAt, storeId?, lines:[{lineId?, sku|barcode|externalVariantId|externalProductId, name?, qty, unitPrice, discount?}], discount?, tax?, total?, payment:{method,status}}`
* `refund`: `{type:'refund', id, saleId, lines:[{lineId?|sku…, qty, restock?}], amount?, reason?}`
* `stock`: `{type:'stock', id, asOf, items:[{sku|barcode|…, qty}]}` (never applied automatically)
* Same `id` again is ignored (duplicate). A higher `version` of a sale updates it; an older one is ignored. A refund that arrives first waits for its sale.

Settings per connection: take sold items off stock, apply returns, restock rule (only when flagged / always / never), stock counts (review / ignore), location mapping (wholesalers only).

## 3. Send online orders to your system

Settings → address (https, a domain name, no port) → **Send a test** (must succeed) → tick *Send my online orders*. You receive `order.created`, `order.paid`, `order.cancelled`, `order.completed` with headers `X-Mwakete-Signature` (HMAC-SHA256 of `timestamp.body` with your secret), `X-Mwakete-Timestamp`, `X-Mwakete-Idempotency-Key`, `X-Mwakete-Event`. Answer 2xx. De-duplicate on the idempotency key: a timeout is retried with the same key (up to six tries, backing off), then the message shows *Gave up* and can be retried by hand. Customer name/phone/email are included only if you tick that box.

## 4. Native POS

Point of Sale: scan or search, add, take cash or record card / mobile payment, complete, print. Sales need a connection. Settings: biggest discount (default 10%), tax shown on receipt, returns policy, footer. Owner-only for now.

Config template: [pos-integration-config.template.md](pos-integration-config.template.md).
