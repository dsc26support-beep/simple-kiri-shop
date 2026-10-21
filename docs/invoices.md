# Invoices and receipts

Sellers can send buyers an invoice, and buyers get a receipt when they pay.

- **Backend:** `apps-script/Invoices.gs`.
- **Document page:** `invoice.html` (with `assets/js/invoice-view.js`). Each document's link and QR code open it.
- **Seller design screen:** `owner/invoices.html` (**Invoices** in the seller menu). It switches the feature on, picks the template and colours (with a live preview of the invoice and the receipt), and sets VAT, notes and business details.
- **Checkout:** an **I need an invoice** tick box, shown only for a store that offers invoices.
- **Seller's Orders:** a "Buyer asked for an invoice" flag, **Send invoice** (and **Send invoice again**), and links to the invoice and receipt.
- **Order room:** both buyer and seller see the invoice and receipt links. The buyer is told the invoice is coming.

## How it works (owner decisions, Oct 2026)

| | |
|---|---|
| **Switching it on** | A store switches invoices and receipts on in Settings. It is off by default, so nothing changes for a store until it does. |
| **Invoice** | **Only on request.** At checkout the buyer ticks **I need an invoice**, and the seller is told in the new-order email. The seller sends the invoice from the order, before the buyer pays. Sending again emails the same invoice; it never makes a new number. |
| **Receipt** | **Automatic when paid.** When the order becomes Paid, the receipt is issued and emailed to the buyer, once. It happens whether the seller changed the status in the dropdown or the order room's payment check confirmed it. Every order of a store with the feature on gets one, with or without an invoice. |
| **Numbers** | Each store numbers its own: `INV-BONG-0001` and `RCT-BONG-0001`, counting up without repeating. The prefix comes from the store name and is unique across stores (a second "bong" becomes `BONG2`). It is kept once given. |
| **Genuine check** | Every document has a random 40-character code. Its **QR code**, with the store logo in the middle, opens `invoice.html?d=<code>`, which shows the document exactly as Mwakete holds it under a **Genuine** banner. An unknown code says the document may be a fake. |
| **Watermark** | The store logo is printed faintly behind the document. |
| **Getting it** | By email (designed, with a link), on the document page (with **Print or save as PDF**), and in the order room. |
| **Templates** | **Classic** (colour band, boxed table), **Modern** (big colour header, rounded cards, pill total) and **Minimal** (white, thin coloured lines). |
| **Colours** | A main colour, which starts from the store colour picked from the logo, and an accent. Text on either is always white or dark, whichever reads better. |
| **VAT** | Optional. Turning it on needs a VAT number and a rate (0–30%). Prices on Mwakete already include it, so the document shows **"Includes VAT (12.5%): $x"**. It never adds to what the buyer pays. |
| **Other details** | Due date (0–90 days to pay, 0 = none), the store's payment options ("We accept IB, MPaisa…"), an invoice note and a receipt note (e.g. bank details for this buyer, or a thank-you), and business name, address and phone. |
| **Snapshot** | A document keeps what it said when it was issued: items, totals, store details, template and colours. Editing settings later never changes an issued invoice or receipt. |
| **Safety** | Everything a seller or buyer typed is plain text and escaped. The page shows the document in a sandboxed frame with scripts off. |

## Sheets (created or extended on first use)

| Where | What |
|---|---|
| `Invoices` (new) | One row per document: `DocId`, `Kind` (invoice / receipt), `Number`, `OrderId`, `Token`, dates, item and total snapshot, VAT, note, buyer, template and colour snapshot (`StyleJson`), store snapshot (`StoreJson`), `InvoiceNumber` (on a receipt), `SentAt`, `SendCount`. |
| `Owners` | `InvoiceSettingsJson`, `InvoicePrefix`, `InvoiceSeq`, `ReceiptSeq`. |
| `Orders` | `InvoiceRequested` (`yes` when the buyer ticked the box). |

## Actions

| Action | Who | What |
|---|---|---|
| `getInvoiceSettings`, `saveInvoiceSettings` | Seller | Read and save the design and details. Every value is checked. |
| `previewInvoiceDesign` | Seller | Draws a sample invoice or receipt in an unsaved design. |
| `sendInvoice` | Seller | Sends (or re-sends) the invoice for an order that asked for one. |
| `listOrderDocuments` | Seller | Lists the invoice and receipt for one of their orders. |
| `listOwnerOrders` | Seller | Each order now also gives `invoiceRequested` and `documents`. |
| `getTxRoom` | Buyer, seller | The order room now also gives `invoice: { requested, documents }`. |
| `getInvoiceDocument` | Public (GET) | Opens a document by its code. |
| `createOrder` | Buyer | Accepts `wantInvoice: true`. |
| `getStorePublicInfo` | Public | Now says `invoicesOffered`. |

## Deploy

1. Paste `Invoices.gs`, `Orders.gs`, `Transactions.gs`, `Products.gs` and `Code.gs`.
2. Go to **Deploy → Manage deployments → Edit → New version**.
3. Open `?action=getVersion` and check it shows `invoices2-2026-10-21`.
4. `SITE_BASE_URL` must be set, because document links and QR codes use it.
