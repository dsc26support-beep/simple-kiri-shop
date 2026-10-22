# Config template (placeholders only — never commit real values)

Apps Script → Project Settings → Script Properties:

| Property | Value | Notes |
|---|---|---|
| `POS_HUB` | `on` / `off` | Feature flag. Default off. |
| `POS_TZ_OFFSET_HOURS` | `12` | Shop-day offset from UTC for reports. |
| `POSSECRET_<connectionId>` | *(created by the app)* | Do not edit by hand. Deleted on disconnect. |

Your system's side (keep out of any web page or mobile app a customer can open):

```
MWAKETE_URL=https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
MWAKETE_CONNECTION_ID=<conn_…>
MWAKETE_SECRET=<shown once when you created the connection>
RECEIVE_ORDERS_URL=https://<your-domain>/<path>    # https, domain name, no port
```
