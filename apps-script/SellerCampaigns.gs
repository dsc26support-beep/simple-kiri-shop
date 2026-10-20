/**
 * Seller Campaign Studio - sellers build, pay for and run their own email
 * campaigns (owner decisions, Oct 2026).
 *
 * WHAT A CAMPAIGN IS. Delivery is the existing marketing engine
 * (MarketingEngine.gs): one plain-and-designed email to customers who OPTED IN
 * to news, each customer at most once per campaign, inside the engine's
 * site-wide daily limit and per-customer frequency cap. A seller campaign
 * never bypasses any of that. When it goes live it gets a linked engine row in
 * `Campaigns` (Type SELLER_PROMOTION, CreatedBy 'seller:<OwnerId>'), so sends,
 * clicks and conversions are the engine's own CampaignEvents.
 *
 * PRICE. A$0.10 per active day (SC_DAILY_RATE, AUD - the currency of the ANZ
 * Kiribati account and of every price on Mwakete). Days are PREPAID: a
 * verified payment adds days; each Kiribati calendar day on which the campaign
 * is live uses one (runSellerCampaignSweep, idempotent per campaign and day).
 * Paused, stopped, pending and rejected campaigns are never charged. When the
 * paid days run out the campaign stops sending (EXHAUSTED) and never restarts
 * on its own. Unused paid days are refundable on request - an admin records it
 * (adminRecordCampaignRefund); there is no automatic payout.
 *
 * PAYMENT. The featuring bank transfer (Featuring.gs): an MWC reference, the
 * same ANZ account, a receipt screenshot, and the same receipt checks. The
 * checks only PRE-SCREEN: a definite failure is rejected so the seller can
 * re-upload, everything else waits for an admin. Nothing is ever verified or
 * activated automatically, and an uploaded receipt is not proof of payment.
 *
 * APPROVAL. After payment an admin approves the campaign's content before it
 * can send (and again after any edit to a paid campaign).
 *
 * CONTENT. A list of blocks the server validates and renders itself
 * (renderSellerCampaignEmail): headings and text (plain text, no < or >),
 * the seller's OWN product photos, product cards, a button with a fixed label,
 * dividers and spacers, with colours and sizes from fixed choices. No HTML or
 * image link from a seller ever reaches an email.
 *
 * Sheets, created on first use (payment data - like FeaturePurchases, NOT in
 * REQUIRED_TABS): SellerCampaigns, CampaignPayments, CampaignLedger,
 * SellerCampaignHistory. Campaigns gains two columns (BlocksJson, StyleJson).
 */

var SC_DAILY_RATE = 0.10;
var SC_CURRENCY = 'AUD';
var SC_CURRENCY_LABEL = 'A$';
var SC_MAX_DAYS = 60;
var SC_MAX_PRODUCTS = 4;
var SC_MAX_BLOCKS = 20;

var SC_STATUS = {
  DRAFT: 'DRAFT',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PAYMENT_REVIEW: 'PAYMENT_REVIEW',
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  EXHAUSTED: 'EXHAUSTED',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED'
};
// Paid campaigns whose content an admin has approved - the ones that can run.
var SC_APPROVED_STATES = ['SCHEDULED', 'ACTIVE', 'PAUSED', 'EXHAUSTED'];
var SC_FINAL_STATES = ['COMPLETED', 'STOPPED'];

var SC_PAY = {
  AWAITING: 'Awaiting payment',
  REVIEW: 'Under review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled'
};

var SC_HEADERS = ['CampaignId', 'OwnerId', 'StoreSlug', 'Name', 'Goal', 'Subject', 'PreviewText', 'BlocksJson',
  'StyleJson', 'ProductIdsJson', 'Audience', 'AudienceCategory', 'StartDate', 'Days', 'PaidDays', 'UsedDays',
  'Status', 'DailyRate', 'Currency', 'EngineCampaignId', 'ApprovedBy', 'ApprovedAt', 'StatusNote',
  'LowNoticeSentFor', 'CreatedAt', 'UpdatedAt'];
var SC_PAYMENT_HEADERS = ['PaymentId', 'CampaignId', 'OwnerId', 'StoreSlug', 'Kind', 'Days', 'Amount', 'Currency',
  'Method', 'Reference', 'Status', 'ScreenshotUrl', 'ScreenshotHash', 'ReceiptNo', 'CheckNotes', 'SubmittedAt',
  'DecidedBy', 'DecidedAt', 'AdminNote', 'CreatedAt', 'UpdatedAt'];
var SC_LEDGER_HEADERS = ['EntryId', 'OwnerId', 'CampaignId', 'EntryType', 'Days', 'Amount', 'Currency', 'BillingDay',
  'PaymentReference', 'IdempotencyKey', 'Note', 'By', 'CreatedAt'];
var SC_HISTORY_HEADERS = ['EntryId', 'CampaignId', 'OwnerId', 'FromStatus', 'ToStatus', 'Action', 'By', 'Note', 'At'];

function scCampaignsSheet() { return getSheetCreating('SellerCampaigns', SC_HEADERS); }
function scPaymentsSheet() { return getSheetCreating('CampaignPayments', SC_PAYMENT_HEADERS); }
function scLedgerSheet() { return getSheetCreating('CampaignLedger', SC_LEDGER_HEADERS); }
function scHistorySheet() { return getSheetCreating('SellerCampaignHistory', SC_HISTORY_HEADERS); }

/* ---------------------------------------------------------------------------
 * What a seller can choose. One copy, served to the studio by
 * getCampaignStudio, so the page and the server can never disagree.
 * ------------------------------------------------------------------------- */

var SC_GOALS = [
  { id: 'products', label: 'Promote selected products', explain: 'Show up to 4 of your products to people likely to want them.', products: 'required', template: 'spotlight' },
  { id: 'sales', label: 'Increase product sales', explain: 'Put your best sellers in front of customers with a clear button to buy.', products: 'required', template: 'spotlight' },
  { id: 'store', label: 'Promote my entire store', explain: 'Introduce your store, with a button to visit it. Products are optional.', products: 'optional', template: 'showcase' },
  { id: 'newProducts', label: 'Announce new products', explain: 'Tell customers about listings you have just added.', products: 'required', template: 'arrival' },
  { id: 'comeback', label: 'Bring previous customers back', explain: 'Email people who have ordered or booked from your store before.', products: 'optional', template: 'comeback', audience: 'STORE_CUSTOMERS' },
  { id: 'repeat', label: 'Increase repeat purchases', explain: 'Remind your past customers of what they can buy again.', products: 'optional', template: 'comeback', audience: 'STORE_CUSTOMERS' },
  { id: 'newCustomers', label: 'Attract new customers', explain: 'Reach everyone who asked Mwakete for news, not just your customers.', products: 'optional', template: 'showcase', audience: 'ALL_OPTED_IN' },
  { id: 'services', label: 'Promote services or bookings', explain: 'Show your rentals and services, with a link to book.', products: 'required', template: 'spotlight' },
  { id: 'seasonal', label: 'Promote a seasonal event', explain: 'Independence, Christmas, school term - say what you have for it.', products: 'optional', template: 'seasonal' },
  { id: 'custom', label: 'Create a custom campaign', explain: 'Start from a blank email and build it yourself.', products: 'optional', template: 'custom' },
  { id: 'sale', label: 'Promote a sale or special offer', comingSoon: 'Mwakete has no discount or offer prices yet, so an offer could not be shown or honoured at checkout.' },
  { id: 'winback', label: 'Win back customers who stopped buying', comingSoon: 'Finding a store\'s own lapsed customers is not built yet.' }
];

var SC_AUDIENCES = [
  { id: 'ALL_OPTED_IN', label: 'Everyone who asked for news', explain: 'Customers who opted in to emails from Mwakete and have used the site.' },
  { id: 'STORE_CUSTOMERS', label: 'Your previous customers', explain: 'Opted-in customers who have ordered or booked from your store.' },
  { id: 'CATEGORY_INTEREST', label: 'People who buy in a category', explain: 'Opted-in customers who have ordered in the category you pick.' }
];

// Button words are fixed: a seller-typed button label is one more place for a misleading claim.
var SC_CTA_LABELS = ['Shop now', 'View products', 'Visit our store', 'See what\'s new', 'Book now', 'Learn more'];
var SC_PALETTE = {
  background: ['#ffffff', '#f6f5fb', '#fff8db', '#fdecee', '#eef6f0'],
  accent: ['#332d63', '#ce1126', '#1f6f43', '#8a5a00']
};
var SC_PADDING = { compact: 12, normal: 20, roomy: 28 };
var SC_HEADING_SIZES = [20, 24, 28, 32];
var SC_TEXT_SIZES = [14, 16, 18];
var SC_SPACER_SIZES = [8, 16, 24, 32];

var SC_TEMPLATES = {
  spotlight: { label: 'Product Spotlight', style: { background: '#ffffff', accent: '#332d63', padding: 'normal' },
    blocks: [{ type: 'heading', text: 'New in at {{storeName}}', size: 24, align: 'left' },
      { type: 'text', text: 'Hi {{customerName}}, here are some things we think you will like.', size: 16, align: 'left' },
      { type: 'image', productIndex: 0 }, { type: 'products', layout: 'list' },
      { type: 'button', label: 'Shop now', target: 'store' }] },
  showcase: { label: 'Store Showcase', style: { background: '#f6f5fb', accent: '#332d63', padding: 'roomy' },
    blocks: [{ type: 'heading', text: 'Visit {{storeName}} on Mwakete', size: 28, align: 'center' },
      { type: 'text', text: 'Hi {{customerName}}, we would love to see you at our store.', size: 16, align: 'center' },
      { type: 'products', layout: 'grid' }, { type: 'button', label: 'Visit our store', target: 'store' }] },
  seasonal: { label: 'Seasonal Sale', style: { background: '#fff8db', accent: '#ce1126', padding: 'normal' },
    blocks: [{ type: 'heading', text: 'Ready for the season?', size: 28, align: 'center' },
      { type: 'text', text: 'Hi {{customerName}}, {{storeName}} has what you need.', size: 16, align: 'center' },
      { type: 'divider' }, { type: 'products', layout: 'grid' }, { type: 'button', label: 'Shop now', target: 'store' }] },
  arrival: { label: 'New Arrival', style: { background: '#ffffff', accent: '#1f6f43', padding: 'normal' },
    blocks: [{ type: 'heading', text: 'Just arrived at {{storeName}}', size: 24, align: 'left' },
      { type: 'image', productIndex: 0 },
      { type: 'text', text: 'Hi {{customerName}}, take a look before they go.', size: 16, align: 'left' },
      { type: 'products', layout: 'list' }, { type: 'button', label: 'See what\'s new', target: 'store' }] },
  comeback: { label: 'Customer Comeback', style: { background: '#eef6f0', accent: '#332d63', padding: 'roomy' },
    blocks: [{ type: 'heading', text: 'We miss you, {{customerName}}', size: 24, align: 'center' },
      { type: 'text', text: 'Thank you for shopping with {{storeName}}. Here is what is new since your last visit.', size: 16, align: 'center' },
      { type: 'products', layout: 'grid' }, { type: 'button', label: 'Visit our store', target: 'store' }] },
  custom: { label: 'Custom Promotion', style: { background: '#ffffff', accent: '#332d63', padding: 'normal' },
    blocks: [{ type: 'heading', text: 'Your headline', size: 24, align: 'left' },
      { type: 'text', text: 'Write your message here.', size: 16, align: 'left' },
      { type: 'button', label: 'Visit our store', target: 'store' }] }
};

function scMoney(n) { return Math.round(Number(n) * 100) / 100; }
function scAmountFor(days) { return scMoney(days * SC_DAILY_RATE); }
function scMoneyText(n) { return SC_CURRENCY_LABEL + scMoney(n).toFixed(2); }

/** Campaigns can take payment only when the engine would really send. */
function scCampaignsOpen(cfg) {
  cfg = cfg || marketingConfig();
  if (!cfg.enabled || cfg.dryRun) return { open: false, why: 'Campaign emails are not switched on yet. You can build and save drafts now; payment opens when sending starts.' };
  if (!cfg.siteBase) return { open: false, why: 'Campaigns are being set up. You can build and save drafts now.' };
  return { open: true, why: '' };
}

/* ---------------------------------------------------------------------------
 * Validation - everything a request sends is checked here, never trusted.
 * ------------------------------------------------------------------------- */

function scText(v, max, label, required) {
  var s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
  if (/[<>]/.test(s)) throw new Error(label + ': plain text only - no < or >');
  if (s.length > max) throw new Error(label + ': up to ' + max + ' characters');
  if (required && !s) throw new Error(label + ' is required');
  return s;
}

function scOneOf(v, list, fallback) { return list.indexOf(v) !== -1 ? v : fallback; }

/** Cleaned blocks, or throws. productIds: the campaign's own chosen products. */
function scCleanBlocks(raw, productIds) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > SC_MAX_BLOCKS) throw new Error('Up to ' + SC_MAX_BLOCKS + ' blocks');
  return raw.map(function (b, i) {
    var t = String((b && b.type) || '');
    var where = 'Block ' + (i + 1);
    var align = scOneOf(String(b.align || 'left'), ['left', 'center'], 'left');
    switch (t) {
      case 'heading': return { type: t, text: scText(b.text, 80, where + ' heading', false), size: scOneOf(Number(b.size), SC_HEADING_SIZES, 24), align: align };
      case 'text': return { type: t, text: scText(b.text, 600, where + ' text', false), size: scOneOf(Number(b.size), SC_TEXT_SIZES, 16), align: align };
      case 'image': {
        var idx = parseInt(b.productIndex, 10);
        if (!(idx >= 0 && idx < SC_MAX_PRODUCTS)) idx = 0;
        return { type: t, productIndex: idx };
      }
      case 'products': return { type: t, layout: scOneOf(String(b.layout), ['list', 'grid'], 'list') };
      case 'button': return { type: t, label: scOneOf(String(b.label), SC_CTA_LABELS, 'Visit our store'), target: scOneOf(String(b.target), ['store', 'product'], 'store') };
      case 'divider': return { type: t };
      case 'spacer': return { type: t, size: scOneOf(Number(b.size), SC_SPACER_SIZES, 16) };
      default: throw new Error(where + ': unknown block');
    }
  });
}

function scCleanStyle(raw) {
  raw = raw || {};
  return {
    background: scOneOf(String(raw.background || ''), SC_PALETTE.background, '#ffffff'),
    accent: scOneOf(String(raw.accent || ''), SC_PALETTE.accent, '#332d63'),
    padding: scOneOf(String(raw.padding || ''), Object.keys(SC_PADDING), 'normal')
  };
}

/** YYYY-MM-DD, a real date. */
function scDate(v) {
  var s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  var d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? '' : s;
}

/** Kiribati calendar day of a moment - the one billing day used everywhere. */
function scToday(ms) { return featureLocalDay(ms === undefined ? Date.now() : ms); }

/** What still has to be filled in before payment. Empty list = complete. */
function scMissing(c) {
  var goal = scGoal(c.Goal);
  var products = parseJsonArray(c.ProductIdsJson);
  var blocks = []; try { blocks = JSON.parse(c.BlocksJson || '[]'); } catch (e) { blocks = []; }
  var out = [];
  if (!goal || goal.comingSoon) out.push('a campaign goal');
  if (!String(c.Name || '').trim()) out.push('a campaign name');
  if (!String(c.Subject || '').trim()) out.push('an email subject line');
  if (goal && goal.products === 'required' && !products.length) out.push('at least one product');
  if (!c.Audience) out.push('who receives it');
  if (c.Audience === 'CATEGORY_INTEREST' && !c.AudienceCategory) out.push('the category for your audience');
  if (!blocks.some(function (b) { return (b.type === 'heading' || b.type === 'text') && String(b.text || '').trim(); })) out.push('some text in the email');
  if (!scDate(c.StartDate)) out.push('a start date');
  if (!(Number(c.Days) >= 1)) out.push('how many days');
  return out;
}

function scGoal(id) { return SC_GOALS.filter(function (g) { return g.id === id; })[0] || null; }

/* ---------------------------------------------------------------------------
 * The plain-language description - also built in the browser for live edits
 * (campaign-studio.js scDescribe); this server copy is what the review and
 * the seller's campaign page show.
 * ------------------------------------------------------------------------- */

function scDescribe(c) {
  var goal = scGoal(c.Goal);
  var n = parseJsonArray(c.ProductIdsJson).length;
  var aud = { ALL_OPTED_IN: 'everyone who asked Mwakete for news', STORE_CUSTOMERS: 'your previous customers who asked for news',
    CATEGORY_INTEREST: 'customers who asked for news and buy in ' + (categoryLabelForEmail(c.AudienceCategory) || 'a category') }[c.Audience] || 'customers you have not chosen yet';
  var tpl = (SC_TEMPLATES[c.Template] || {}).label;
  var days = Number(c.Days) || 0;
  var what = n ? 'promotes ' + n + ' selected product' + (n === 1 ? '' : 's') + ' from your store' : 'promotes your store';
  var when = {
    DRAFT: 'begins after payment is verified and the campaign is approved',
    AWAITING_PAYMENT: 'begins after payment is verified and the campaign is approved',
    PAYMENT_REVIEW: 'begins once Mwakete verifies your payment and approves the campaign',
    PAYMENT_REJECTED: 'begins once a corrected payment is verified',
    AWAITING_APPROVAL: 'begins once Mwakete approves the campaign',
    CHANGES_REQUESTED: 'begins once you make the requested changes and Mwakete approves them',
    SCHEDULED: 'is scheduled to start on ' + c.StartDate,
    ACTIVE: 'is running now',
    PAUSED: 'is paused (paused days are not charged)',
    EXHAUSTED: 'has used all its paid days and has stopped sending',
    COMPLETED: 'has finished',
    STOPPED: 'was stopped'
  }[c.Status] || 'begins after payment';
  return 'Your campaign ' + what + ' to ' + aud + (goal && !goal.comingSoon ? ' (' + goal.label.toLowerCase() + ')' : '') +
    (tpl ? ', using the ' + tpl + ' design' : '') + '. It ' + when + ', for ' + days + ' active day' + (days === 1 ? '' : 's') +
    ' at ' + scMoneyText(SC_DAILY_RATE) + ' per day - an estimated total of ' + scMoneyText(scAmountFor(days)) +
    '. Each customer receives it at most once.';
}

/* ---------------------------------------------------------------------------
 * Email rendering. Every value is escaped; links only to SITE_BASE_URL pages;
 * images only the seller's own product photos (https).
 * ------------------------------------------------------------------------- */

/**
 * m: { blocks, style, products: [{ name, meta, url, imageUrl }], storeName,
 *      storeUrl, base, unsubscribeUrl, vars }
 */
function renderSellerCampaignEmail(m) {
  var e = escapeHtmlForEmail;
  var style = scCleanStyle(m.style);
  var pad = SC_PADDING[style.padding];
  var base = m.base;
  var products = (m.products || []).slice(0, SC_MAX_PRODUCTS);
  var fill = function (s) { return fillMarketingVariables(String(s || ''), m.vars || {}); };
  var img = function (u) { return /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : ''; };
  var link = function (u) { return safeMarketingUrl(u, base); };
  var text = ['Mwakete', ''];
  var html = [];
  (m.blocks || []).forEach(function (b) {
    if (b.type === 'heading') {
      var h = fill(b.text);
      if (!h) return;
      text.push(h, '');
      html.push('<h1 style="margin:0 0 12px;font-size:' + b.size + 'px;line-height:1.25;color:' + style.accent + ';text-align:' + b.align + '">' + e(h) + '</h1>');
    } else if (b.type === 'text') {
      var t = fill(b.text);
      if (!t) return;
      text.push(t, '');
      html.push('<p style="margin:0 0 12px;font-size:' + b.size + 'px;line-height:1.5;text-align:' + b.align + '">' + e(t).replace(/\n/g, '<br>') + '</p>');
    } else if (b.type === 'image') {
      var p = products[b.productIndex];
      var src = p && img(p.imageUrl);
      if (!src) return;
      html.push('<p style="margin:0 0 12px"><a href="' + e(link(p.url) || base) + '"><img src="' + e(src) + '" alt="' + e(p.name) + '" width="480" style="display:block;width:100%;max-width:480px;height:auto;border-radius:10px"></a></p>');
    } else if (b.type === 'products') {
      if (!products.length) return;
      products.forEach(function (pr) { text.push('- ' + pr.name + (pr.meta ? ' (' + pr.meta + ')' : '') + (link(pr.url) ? '\n  ' + pr.url : '')); });
      text.push('');
      if (b.layout === 'grid') {
        var cells = products.map(function (pr) {
          var s = img(pr.imageUrl);
          return '<td width="50%" valign="top" style="padding:6px"><a href="' + e(link(pr.url) || base) + '" style="color:' + style.accent + ';text-decoration:none;font-weight:bold">'
            + (s ? '<img src="' + e(s) + '" alt="" width="220" style="display:block;width:100%;height:auto;border-radius:8px;margin-bottom:6px">' : '')
            + e(pr.name) + '</a>' + (pr.meta ? '<div style="color:#5f6368;font-size:12px">' + e(pr.meta) + '</div>' : '') + '</td>';
        });
        var rows = [];
        for (var i = 0; i < cells.length; i += 2) rows.push('<tr>' + cells[i] + (cells[i + 1] || '<td width="50%"></td>') + '</tr>');
        html.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px">' + rows.join('') + '</table>');
      } else {
        html.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px">' + products.map(function (pr) {
          var s = img(pr.imageUrl);
          return '<tr><td style="padding:8px 0;border-top:1px solid #e3e1ee"><table role="presentation" cellpadding="0" cellspacing="0"><tr>'
            + (s ? '<td style="padding-right:12px" valign="top"><img src="' + e(s) + '" width="64" height="64" alt="" style="display:block;border-radius:8px"></td>' : '')
            + '<td valign="top"><a href="' + e(link(pr.url) || base) + '" style="color:' + style.accent + ';font-weight:bold;text-decoration:none">' + e(pr.name) + '</a>'
            + (pr.meta ? '<div style="color:#5f6368;font-size:13px">' + e(pr.meta) + '</div>' : '') + '</td></tr></table></td></tr>';
        }).join('') + '</table>');
      }
    } else if (b.type === 'button') {
      var target = b.target === 'product' && products[0] ? link(products[0].url) : link(m.storeUrl);
      if (!target) return;
      text.push(b.label + ': ' + target, '');
      html.push('<p style="margin:16px 0;text-align:center"><a href="' + e(target) + '" style="background:' + style.accent + ';color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold">' + e(b.label) + '</a></p>');
    } else if (b.type === 'divider') {
      html.push('<hr style="border:0;border-top:1px solid #e3e1ee;margin:16px 0">');
    } else if (b.type === 'spacer') {
      html.push('<div style="height:' + b.size + 'px;line-height:' + b.size + 'px">&nbsp;</div>');
    }
  });
  var unsub = link(m.unsubscribeUrl);
  text.push('--', 'Sent by Mwakete for ' + (m.storeName || 'a store on Mwakete') + ', because you asked for news from Mwakete.',
    'Stop these emails: ' + (unsub || 'reply and ask'));
  var out = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;background:' + style.background + '">'
    + '<div style="background:#ce1126;border-bottom:4px solid #fcd116;padding:12px 16px;color:#fff;font-weight:bold;font-size:18px">Mwakete</div>'
    + '<div style="padding:' + pad + 'px">' + html.join('') + '</div>'
    + '<div style="padding:12px 16px;border-top:1px solid #e3e1ee;color:#5f6368;font-size:12px">'
    + 'Sent by Mwakete for ' + e(m.storeName || 'a store on Mwakete') + ', because you asked for news from Mwakete. '
    + (unsub ? '<a href="' + e(unsub) + '" style="color:#5f6368">Stop these emails</a>' : '') + '</div></div>';
  return { text: text.join('\n'), html: out };
}

/** Products in the campaign's order, as the renderer wants them. */
function scEmailProducts(ids, productById, ownerById, base, campaignId, eventId) {
  return ids.map(function (id) { return productById[id]; }).filter(Boolean).map(function (p) {
    var o = ownerById[p.OwnerId] || {};
    return {
      name: p.Name, imageUrl: p.ImageUrl,
      meta: [LISTING_WORD[p.ListingType], storeLocationForEmail(o)].filter(Boolean).join(' · '),
      url: marketingLink(base, 'product.html?store=' + encodeURIComponent(p.StoreSlug) + '&product=' + encodeURIComponent(p.ProductId), campaignId, eventId)
    };
  });
}

/* ---------------------------------------------------------------------------
 * Small shared pieces
 * ------------------------------------------------------------------------- */

function scLog(c, from, to, action, by, note) {
  appendRowFromObject(scHistorySheet(), {
    EntryId: newId('sch'), CampaignId: c.CampaignId, OwnerId: c.OwnerId, FromStatus: from || '', ToStatus: to || '',
    Action: action, By: by || 'system', Note: String(note || '').slice(0, 300), At: nowIso()
  });
}

/** Writes a new status (and any other fields) and logs it. Call under the lock. */
function scSet(sheet, c, patch, action, by, note) {
  var from = c.Status;
  patch.UpdatedAt = nowIso();
  updateRowFromObject(sheet, c.__row, patch);
  scLog(c, from, patch.Status || from, action, by, note);
  Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
}

/** A ledger line; refused (returns false) when its idempotency key already exists. */
function scLedger(entry) {
  var sheet = scLedgerSheet();
  var exists = sheetToObjects(sheet).some(function (r) { return r.IdempotencyKey === entry.IdempotencyKey; });
  if (exists) return false;
  appendRowFromObject(sheet, Object.assign({ EntryId: newId('led'), Currency: SC_CURRENCY, CreatedAt: nowIso(), By: 'system' }, entry));
  return true;
}

function scNotifySeller(ownerId, subject, body) {
  var o = findRowById(getSheet('Owners'), 'OwnerId', ownerId);
  if (!o || !o.Email) return;
  var url = siteBaseUrl() ? siteBaseUrl() + '/owner/campaigns.html' : '';
  try { sendAppEmail(o.Email, subject, body + (url ? '\n\nYour campaigns: ' + url : '')); } catch (e) { Logger.log('campaign notify failed: ' + e); }
}

function scNotifyAdmins(subject, body) {
  var url = siteBaseUrl() ? siteBaseUrl() + '/owner/admin.html#campaigns' : '';
  getAdminEmails().forEach(function (to) {
    try { sendAppEmail(to, subject, body + (url ? '\n\nReview it here: ' + url : '')); } catch (e) { Logger.log('campaign admin notify failed: ' + e); }
  });
}

function scOwnCampaign(owner, campaignId) {
  var sheet = scCampaignsSheet();
  var c = findRowById(sheet, 'CampaignId', String(campaignId || ''));
  if (!c || c.OwnerId !== owner.OwnerId) return null;   // someone else's answers exactly like a missing one
  return { sheet: sheet, c: c };
}

function scPublic(c) {
  var blocks = []; try { blocks = JSON.parse(c.BlocksJson || '[]'); } catch (e) { blocks = []; }
  var style = {}; try { style = JSON.parse(c.StyleJson || '{}'); } catch (e) { style = {}; }
  var paid = Number(c.PaidDays) || 0, used = Number(c.UsedDays) || 0;
  return {
    campaignId: c.CampaignId, name: c.Name, goal: c.Goal, subject: c.Subject, previewText: c.PreviewText,
    blocks: blocks, style: scCleanStyle(style), template: style.template || '',
    productIds: parseJsonArray(c.ProductIdsJson), audience: c.Audience, audienceCategory: c.AudienceCategory,
    startDate: c.StartDate, days: Number(c.Days) || 0, paidDays: paid, usedDays: used, remainingDays: Math.max(0, paid - used),
    status: c.Status, statusNote: c.StatusNote || '', dailyRate: Number(c.DailyRate) || SC_DAILY_RATE, currency: c.Currency || SC_CURRENCY,
    estimatedCost: scAmountFor(Number(c.Days) || 0), spent: scMoney(used * (Number(c.DailyRate) || SC_DAILY_RATE)),
    missing: scMissing(Object.assign({}, c, { Template: style.template })), description: scDescribe(Object.assign({}, c, { Template: style.template })),
    createdAt: c.CreatedAt, updatedAt: c.UpdatedAt
  };
}

function scPublicPayment(p) {
  return {
    paymentId: p.PaymentId, campaignId: p.CampaignId, kind: p.Kind, days: Number(p.Days), amount: Number(p.Amount),
    currency: p.Currency, reference: p.Reference, status: p.Status, submittedAt: p.SubmittedAt || '',
    decidedAt: p.DecidedAt || '', note: p.Status === SC_PAY.REJECTED ? (p.AdminNote || '') : '', createdAt: p.CreatedAt
  };
}

function scPaymentInstructions() {
  var d = featurePaymentDetails();
  return { accountName: d.accountName, accountNumber: d.accountNumber, bank: 'ANZ', currency: SC_CURRENCY, currencyLabel: SC_CURRENCY_LABEL };
}

/* ---------------------------------------------------------------------------
 * Seller actions (owner session; every one checks ownership on the server)
 * ------------------------------------------------------------------------- */

/** Everything the studio needs in one call: choices, prices, products, and this store's campaigns. */
function actionGetCampaignStudio(owner) {
  var products = sheetToObjects(getSheet('Products'))
    .filter(function (p) { return p.OwnerId === owner.OwnerId && p.Status === 'active'; })
    .map(function (p) {
      return { productId: p.ProductId, name: p.Name, imageUrl: p.ImageUrl || '', category: categoryIdOf(p.Category),
        listingType: listingTypeOfRow(p), createdAt: p.CreatedAt || '' };
    });
  var mine = sheetToObjects(scCampaignsSheet()).filter(function (c) { return c.OwnerId === owner.OwnerId; })
    .sort(function (a, b) { return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)); });
  var payments = sheetToObjects(scPaymentsSheet()).filter(function (p) { return p.OwnerId === owner.OwnerId; });
  var gate = scCampaignsOpen();
  return ok({
    config: {
      goals: SC_GOALS, audiences: SC_AUDIENCES, ctaLabels: SC_CTA_LABELS, palette: SC_PALETTE,
      paddings: Object.keys(SC_PADDING), headingSizes: SC_HEADING_SIZES, textSizes: SC_TEXT_SIZES, spacerSizes: SC_SPACER_SIZES,
      templates: Object.keys(SC_TEMPLATES).map(function (id) { return { id: id, label: SC_TEMPLATES[id].label, style: SC_TEMPLATES[id].style, blocks: SC_TEMPLATES[id].blocks }; }),
      categories: CATEGORY_IDS.map(function (id) { return { id: id, label: categoryLabelForEmail(id) }; }),
      dailyRate: SC_DAILY_RATE, currency: SC_CURRENCY, currencyLabel: SC_CURRENCY_LABEL, maxDays: SC_MAX_DAYS,
      maxProducts: SC_MAX_PRODUCTS, maxBlocks: SC_MAX_BLOCKS, today: scToday(),
      open: gate.open, closedReason: gate.why,
      refundPolicy: 'Unused paid days can be refunded on request: contact Mwakete. Days already used are not refunded.',
      billingRule: 'A day is used on each Kiribati calendar day the campaign is live, even for part of the day. Paused, stopped and unpaid campaigns are never charged.'
    },
    storeName: owner.StoreName, storeSlug: owner.StoreSlug, products: products,
    campaigns: mine.map(function (c) {
      var p = scPublic(c);
      var open = payments.filter(function (x) { return x.CampaignId === c.CampaignId && [SC_PAY.AWAITING, SC_PAY.REVIEW, SC_PAY.REJECTED].indexOf(x.Status) !== -1; })
        .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); })[0];
      p.openPayment = open ? scPublicPayment(open) : null;
      return p;
    })
  });
}

/**
 * body.campaignId (omit to create) and any of: name, goal, subject,
 * previewText, blocks, style, template, productIds, audience,
 * audienceCategory, startDate, days. Drafts may be incomplete. Editing a paid
 * campaign's content sends it back for approval and needs
 * body.confirmReapproval; its days change only through extendCampaign.
 */
function actionSaveCampaignDraft(owner, body) {
  var mineActive = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) {
    if (p.OwnerId === owner.OwnerId && p.Status === 'active') mineActive[p.ProductId] = true;
  });
  var fields;
  try {
    var goal = body.goal === undefined ? undefined : String(body.goal || '');
    if (goal && (!scGoal(goal) || scGoal(goal).comingSoon)) throw new Error('That goal is not available yet');
    var ids = body.productIds === undefined ? undefined : (Array.isArray(body.productIds) ? body.productIds.map(String) : []);
    if (ids) {
      ids = ids.filter(function (id, i) { return id && ids.indexOf(id) === i; });
      if (ids.length > SC_MAX_PRODUCTS) throw new Error('Choose up to ' + SC_MAX_PRODUCTS + ' products - an email shows at most ' + SC_MAX_PRODUCTS);
      if (!ids.every(function (id) { return mineActive[id]; })) throw new Error('One of those products is not an active listing in your store');
    }
    var audience = body.audience === undefined ? undefined : String(body.audience || '');
    if (audience && !SC_AUDIENCES.some(function (a) { return a.id === audience; })) throw new Error('That audience is not available');
    var cat = body.audienceCategory === undefined ? undefined : String(body.audienceCategory || '');
    if (cat && CATEGORY_IDS.indexOf(cat) === -1) throw new Error('Unknown category');
    var days = body.days === undefined ? undefined : parseInt(body.days, 10);
    if (days !== undefined && !(days >= 1 && days <= SC_MAX_DAYS)) throw new Error('Choose between 1 and ' + SC_MAX_DAYS + ' days');
    var start = body.startDate === undefined ? undefined : scDate(body.startDate);
    if (body.startDate !== undefined && body.startDate && !start) throw new Error('Check the start date');
    if (start && start < scToday()) throw new Error('The start date has already passed');
    fields = {};
    if (body.name !== undefined) fields.Name = scText(body.name, 60, 'Campaign name');
    if (goal !== undefined) fields.Goal = goal;
    if (body.subject !== undefined) fields.Subject = scText(body.subject, 100, 'Subject line').replace(/\s+/g, ' ');
    if (body.previewText !== undefined) fields.PreviewText = scText(body.previewText, 120, 'Preview text').replace(/\s+/g, ' ');
    if (ids !== undefined) fields.ProductIdsJson = JSON.stringify(ids);
    if (body.blocks !== undefined) fields.BlocksJson = JSON.stringify(scCleanBlocks(body.blocks));
    if (body.style !== undefined || body.template !== undefined) {
      var st = scCleanStyle(body.style);
      // undefined = keep the campaign's current template (filled in below, once it is loaded)
      st.template = body.template === undefined ? undefined : (SC_TEMPLATES[body.template] ? String(body.template) : '');
      fields.StyleJson = st;
    }
    if (audience !== undefined) fields.Audience = audience;
    if (cat !== undefined) fields.AudienceCategory = cat;
    if (start !== undefined) fields.StartDate = start;
    if (days !== undefined) fields.Days = days;
  } catch (e) {
    return fail(e.message);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = scCampaignsSheet();
    var styleWithTemplate = function (old) {
      if (!fields.StyleJson || typeof fields.StyleJson === 'string') return;
      if (fields.StyleJson.template === undefined) {
        var prev = {}; try { prev = JSON.parse(old || '{}'); } catch (e) { prev = {}; }
        fields.StyleJson.template = prev.template || '';
      }
      fields.StyleJson = JSON.stringify(fields.StyleJson);
    };
    if (!body.campaignId) {
      styleWithTemplate('');
      var id = newId('scmp');
      appendRowFromObject(sheet, Object.assign({
        CampaignId: id, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, Name: '', Goal: '', Subject: '', PreviewText: '',
        BlocksJson: '[]', StyleJson: JSON.stringify(scCleanStyle({})), ProductIdsJson: '[]', Audience: '', AudienceCategory: '',
        StartDate: '', Days: 7, PaidDays: 0, UsedDays: 0, Status: SC_STATUS.DRAFT, DailyRate: SC_DAILY_RATE, Currency: SC_CURRENCY,
        EngineCampaignId: '', ApprovedBy: '', ApprovedAt: '', StatusNote: '', LowNoticeSentFor: '', CreatedAt: nowIso(), UpdatedAt: nowIso()
      }, fields));
      var created = findRowById(sheet, 'CampaignId', id);
      scLog(created, '', SC_STATUS.DRAFT, 'create', 'seller', '');
      return ok({ campaign: scPublic(created) });
    }
    var c = findRowById(sheet, 'CampaignId', String(body.campaignId));
    if (!c || c.OwnerId !== owner.OwnerId) return fail('Campaign not found');
    if (SC_FINAL_STATES.indexOf(c.Status) !== -1) return fail('A finished campaign cannot be edited. Duplicate it to start a new one.');
    styleWithTemplate(c.StyleJson);
    if (c.Status === SC_STATUS.PAYMENT_REVIEW) return fail('Your payment is being checked. You can edit the campaign once it has been verified.');

    if (c.Status === SC_STATUS.DRAFT) {
      scSet(sheet, c, fields, 'edit', 'seller', '');
    } else if (c.Status === SC_STATUS.AWAITING_PAYMENT || c.Status === SC_STATUS.PAYMENT_REJECTED) {
      // Not paid yet: the open reference is cancelled (its amount may now be wrong) and it is a draft again.
      scCancelOpenPayments(c.CampaignId, 'Campaign edited before payment');
      scSet(sheet, c, Object.assign(fields, { Status: SC_STATUS.DRAFT }), 'edit', 'seller', 'Edited before payment - back to draft');
    } else {
      // Paid: content changes need approval again; days only through extendCampaign.
      if (fields.Days !== undefined && Number(fields.Days) !== Number(c.Days)) return fail('To add days to a paid campaign, use Extend.');
      delete fields.Days;
      if (fields.StartDate !== undefined && fields.StartDate !== c.StartDate && c.Status !== SC_STATUS.SCHEDULED
          && c.Status !== SC_STATUS.AWAITING_APPROVAL && c.Status !== SC_STATUS.CHANGES_REQUESTED) {
        return fail('This campaign has already started, so its start date cannot change.');
      }
      if (body.confirmReapproval !== true) {
        return Object.assign(fail('Changing a paid campaign sends it back to Mwakete for approval, and it stops sending until then. Please confirm.'), { needsConfirmation: true });
      }
      scPauseEngine(c);
      scSet(sheet, c, Object.assign(fields, { Status: SC_STATUS.AWAITING_APPROVAL, StatusNote: '' }), 'edit', 'seller', 'Edited after payment - needs approval again');
      scNotifyAdmins('Campaign to approve - ' + owner.StoreName, 'A paid campaign was edited and needs approval again.\n\nStore: ' + owner.StoreName + '\nCampaign: ' + c.Name + ' (' + c.CampaignId + ')');
    }
    return ok({ campaign: scPublic(findRowById(sheet, 'CampaignId', c.CampaignId)) });
  } finally {
    lock.releaseLock();
  }
}

/** Cancels the campaign's not-yet-decided payments that have no receipt under review. Under the lock. */
function scCancelOpenPayments(campaignId, why) {
  var ps = scPaymentsSheet();
  sheetToObjects(ps).forEach(function (p) {
    if (p.CampaignId === campaignId && (p.Status === SC_PAY.AWAITING || p.Status === SC_PAY.REJECTED)) {
      updateRowFromObject(ps, p.__row, { Status: SC_PAY.CANCELLED, AdminNote: why, UpdatedAt: nowIso() });
    }
  });
}

function scNewReference(rows) {
  var used = {};
  rows.forEach(function (r) { used[String(r.Reference)] = true; });
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (var attempt = 0; attempt < 20; attempt++) {
    var ref = 'MWC';
    for (var i = 0; i < 6; i++) ref += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    if (!used[ref]) return ref;
  }
  throw new Error('Could not issue a unique reference');
}

/** Issues (or returns the existing) payment for a complete draft: reference, amount and where to pay. */
function actionStartCampaignPayment(owner, body) {
  var gate = scCampaignsOpen();
  if (!gate.open) return fail(gate.why);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var own = scOwnCampaign(owner, body.campaignId);
    if (!own) return fail('Campaign not found');
    var c = own.c;
    var ps = scPaymentsSheet();
    var payments = sheetToObjects(ps);
    var open = payments.filter(function (p) { return p.CampaignId === c.CampaignId && p.Kind === 'initial' && (p.Status === SC_PAY.AWAITING || p.Status === SC_PAY.REJECTED || p.Status === SC_PAY.REVIEW); })[0];
    if (c.Status === SC_STATUS.AWAITING_PAYMENT || c.Status === SC_STATUS.PAYMENT_REJECTED || c.Status === SC_STATUS.PAYMENT_REVIEW) {
      if (open) return ok({ payment: scPublicPayment(open), instructions: scPaymentInstructions(), campaign: scPublic(c), thanks: scThanks() });
    }
    if (c.Status !== SC_STATUS.DRAFT) return fail('This campaign is not waiting for payment');
    var missing = scMissing(Object.assign({}, c, { Template: '' }));
    if (missing.length) return fail('Before paying, add ' + missing.join(', ') + '.');
    if (c.StartDate < scToday()) return fail('The start date has already passed. Please choose a new one.');
    // Products may have been unlisted since the draft was saved.
    var active = {};
    sheetToObjects(getSheet('Products')).forEach(function (p) { if (p.OwnerId === owner.OwnerId && p.Status === 'active') active[p.ProductId] = true; });
    if (!parseJsonArray(c.ProductIdsJson).every(function (id) { return active[id]; })) return fail('One of the chosen products is no longer listed. Please update the campaign.');
    var days = Number(c.Days);
    var record = {
      PaymentId: newId('cpay'), CampaignId: c.CampaignId, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, Kind: 'initial',
      Days: days, Amount: scAmountFor(days), Currency: SC_CURRENCY, Method: 'ANZ bank transfer', Reference: scNewReference(payments),
      Status: SC_PAY.AWAITING, ScreenshotUrl: '', ScreenshotHash: '', ReceiptNo: '', CheckNotes: '', SubmittedAt: '',
      DecidedBy: '', DecidedAt: '', AdminNote: '', CreatedAt: nowIso(), UpdatedAt: nowIso()
    };
    appendRowFromObject(ps, record);
    scSet(own.sheet, c, { Status: SC_STATUS.AWAITING_PAYMENT }, 'start_payment', 'seller', record.Reference);
    return ok({ payment: scPublicPayment(record), instructions: scPaymentInstructions(), campaign: scPublic(c), thanks: scThanks() });
  } finally {
    lock.releaseLock();
  }
}

function scThanks() {
  return 'Thank You for supporting this project! Your campaign fee helps keep Mwakete running and improving for every store and shopper in Kiribati.';
}

/**
 * body.paymentId, body.imageBase64, body.mimeType. Runs the featuring receipt
 * checks as a PRE-SCREEN only: a definite mismatch is rejected so the seller
 * can upload again; anything else waits for an admin. Never verifies.
 */
function actionSubmitCampaignPayment(owner, body) {
  if (isFeatureSubmitRateLimited(owner.OwnerId)) return fail('Too many uploads in the last hour. Please try again later.');
  var ps = scPaymentsSheet();
  var p = findRowById(ps, 'PaymentId', String(body.paymentId || ''));
  if (!p || p.OwnerId !== owner.OwnerId) return fail('Payment not found');
  if (p.Status !== SC_PAY.AWAITING && p.Status !== SC_PAY.REJECTED) {
    return fail(p.Status === SC_PAY.VERIFIED ? 'This payment is already verified.' : p.Status === SC_PAY.REVIEW ? 'This payment is already waiting for Mwakete to check it.' : 'This payment is no longer open.');
  }
  var mimeType = String(body.mimeType || '');
  var bytes;
  try { bytes = Utilities.base64Decode(String(body.imageBase64 || '')); } catch (e) { return fail('That file could not be read. Please choose the screenshot again.'); }
  if (!isValidPaymentImage(bytes, mimeType)) return fail('That file is not a PNG, JPG or WebP image. Please upload a screenshot of your bank receipt.');
  if (bytes.length > MAX_IMAGE_BYTES) return fail('That image is too large (max 5MB).');
  if (bytes.length < featureMinImageBytes()) return fail('That image looks too small or empty. Please upload the full screenshot.');
  var fileProblem = featureImageProblem(imageInfo(bytes));
  if (fileProblem) return fail(fileProblem);
  var hash = sha256Hex(bytes);
  var hashUsed = function () {
    return sheetToObjects(ps).some(function (r) { return r.ScreenshotHash === hash && r.PaymentId !== p.PaymentId; })
      || featureHashUsedElsewhere(sheetToObjects(getFeaturePurchasesSheet()), hash, '');
  };
  if (hashUsed()) return fail('That screenshot has already been used for another payment.');

  var url = saveFeatureScreenshot(bytes, mimeType, p.PaymentId);
  var ocr;
  try { ocr = ocrPaymentImage(bytes, mimeType); } catch (e) { ocr = null; }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var decision;
  try {
    var fresh = findRowById(ps, 'PaymentId', p.PaymentId);
    if (!fresh || (fresh.Status !== SC_PAY.AWAITING && fresh.Status !== SC_PAY.REJECTED)) return fail('This payment is already being checked. Please refresh.');
    if (hashUsed()) return fail('That screenshot has already been used for another payment.');
    // Receipt numbers already claimed by featuring or by another campaign payment.
    var ctx = featureDecisionContext(sheetToObjects(getFeaturePurchasesSheet()), { PurchaseId: '', OwnerId: '' }, Date.now());
    sheetToObjects(ps).forEach(function (r) {
      if (r.PaymentId !== fresh.PaymentId && (r.Status === SC_PAY.REVIEW || r.Status === SC_PAY.VERIFIED) && r.ReceiptNo) ctx.usedReceiptNumbers.push(String(r.ReceiptNo).toUpperCase());
    });
    var check = decideFeaturePayment(ocr, { PurchaseId: fresh.PaymentId, Reference: fresh.Reference, Amount: fresh.Amount, CreatedAt: fresh.CreatedAt, OwnerId: owner.OwnerId }, imageHasExif(bytes), ctx);
    var rejected = check.status === FEATURE_STATUS.REJECTED;
    decision = {
      status: rejected ? SC_PAY.REJECTED : SC_PAY.REVIEW,
      message: rejected ? check.message : 'Thanks - your payment evidence was submitted. Mwakete will check it with the bank and let you know. Your campaign does not start until the payment is verified.'
    };
    updateRowFromObject(ps, fresh.__row, {
      Status: decision.status, ScreenshotUrl: url, ScreenshotHash: hash, ReceiptNo: check.receiptNo || '',
      CheckNotes: (rejected ? 'pre-screen rejected: ' : 'pre-screen: ') + check.notes, SubmittedAt: nowIso(),
      AdminNote: rejected ? check.message : '', UpdatedAt: nowIso()
    });
    var own = scOwnCampaign(owner, fresh.CampaignId);
    if (own && fresh.Kind === 'initial') {
      scSet(own.sheet, own.c, { Status: rejected ? SC_STATUS.PAYMENT_REJECTED : SC_STATUS.PAYMENT_REVIEW }, 'submit_payment', 'seller', decision.status);
    } else if (own) {
      scLog(own.c, own.c.Status, own.c.Status, 'submit_extension_payment', 'seller', decision.status);
    }
  } finally {
    lock.releaseLock();
  }
  if (decision.status === SC_PAY.REVIEW) {
    scNotifyAdmins('Campaign payment to verify - ' + owner.StoreName, 'A campaign payment is waiting to be checked against the bank.\n\nStore: ' + owner.StoreName +
      '\nReference: ' + p.Reference + '\nAmount: ' + scMoneyText(p.Amount) + ' (' + p.Days + ' days)');
  }
  return ok({ payment: scPublicPayment(findRowById(ps, 'PaymentId', p.PaymentId)), message: decision.message });
}

/** body.campaignId, body.op: pause | resume | stop | duplicate. */
function actionCampaignAction(owner, body) {
  var op = String(body.op || '');
  if (['pause', 'resume', 'stop', 'duplicate'].indexOf(op) === -1) return fail('Unknown action');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var own = scOwnCampaign(owner, body.campaignId);
    if (!own) return fail('Campaign not found');
    var c = own.c;
    if (op === 'duplicate') {
      var id = newId('scmp');
      var copy = {};
      ['Name', 'Goal', 'Subject', 'PreviewText', 'BlocksJson', 'StyleJson', 'ProductIdsJson', 'Audience', 'AudienceCategory', 'Days'].forEach(function (k) { copy[k] = c[k]; });
      copy.Name = String(c.Name || 'Campaign').slice(0, 52) + ' (copy)';
      appendRowFromObject(own.sheet, Object.assign(copy, {
        CampaignId: id, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, StartDate: '', PaidDays: 0, UsedDays: 0,
        Status: SC_STATUS.DRAFT, DailyRate: SC_DAILY_RATE, Currency: SC_CURRENCY, EngineCampaignId: '', ApprovedBy: '', ApprovedAt: '',
        StatusNote: '', LowNoticeSentFor: '', CreatedAt: nowIso(), UpdatedAt: nowIso()
      }));
      var dup = findRowById(own.sheet, 'CampaignId', id);
      scLog(dup, '', SC_STATUS.DRAFT, 'duplicate', 'seller', 'From ' + c.CampaignId);
      return ok({ campaign: scPublic(dup) });
    }
    if (op === 'pause') {
      if (c.Status !== SC_STATUS.ACTIVE && c.Status !== SC_STATUS.SCHEDULED) return fail('Only a running or scheduled campaign can be paused');
      scPauseEngine(c);
      scSet(own.sheet, c, { Status: SC_STATUS.PAUSED }, 'pause', 'seller', '');
    } else if (op === 'resume') {
      if (c.Status !== SC_STATUS.PAUSED) return fail('Only a paused campaign can be resumed');
      if ((Number(c.PaidDays) || 0) <= (Number(c.UsedDays) || 0)) return fail('This campaign has no paid days left. Use Extend to add days.');
      var to = c.StartDate > scToday() ? SC_STATUS.SCHEDULED : SC_STATUS.ACTIVE;
      scSet(own.sheet, c, { Status: to }, 'resume', 'seller', '');
    } else if (op === 'stop') {
      if (SC_FINAL_STATES.indexOf(c.Status) !== -1) return fail('This campaign has already finished');
      if (body.confirm !== true) return Object.assign(fail('Stopping is permanent: a stopped campaign cannot be restarted. Please confirm.'), { needsConfirmation: true });
      scCancelEngine(c);
      scCancelOpenPayments(c.CampaignId, 'Campaign stopped');
      scSet(own.sheet, c, { Status: SC_STATUS.STOPPED }, 'stop', 'seller', '');
    }
    return ok({ campaign: scPublic(c) });
  } finally {
    lock.releaseLock();
  }
}

/** body.campaignId, body.days - issues a payment for more days on a campaign that was paid for. */
function actionExtendCampaign(owner, body) {
  var gate = scCampaignsOpen();
  if (!gate.open) return fail(gate.why);
  var days = parseInt(body.days, 10);
  if (!(days >= 1 && days <= SC_MAX_DAYS)) return fail('Choose between 1 and ' + SC_MAX_DAYS + ' days');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var own = scOwnCampaign(owner, body.campaignId);
    if (!own) return fail('Campaign not found');
    var c = own.c;
    var extendable = SC_APPROVED_STATES.concat([SC_STATUS.AWAITING_APPROVAL, SC_STATUS.CHANGES_REQUESTED]);
    if (extendable.indexOf(c.Status) === -1) return fail('Only a paid campaign that has not finished can be extended');
    var ps = scPaymentsSheet();
    var payments = sheetToObjects(ps);
    if (payments.some(function (p) { return p.CampaignId === c.CampaignId && (p.Status === SC_PAY.AWAITING || p.Status === SC_PAY.REVIEW || p.Status === SC_PAY.REJECTED); })) {
      return fail('This campaign already has a payment in progress. Finish or wait for that one first.');
    }
    var record = {
      PaymentId: newId('cpay'), CampaignId: c.CampaignId, OwnerId: owner.OwnerId, StoreSlug: owner.StoreSlug, Kind: 'extension',
      Days: days, Amount: scAmountFor(days), Currency: SC_CURRENCY, Method: 'ANZ bank transfer', Reference: scNewReference(payments),
      Status: SC_PAY.AWAITING, ScreenshotUrl: '', ScreenshotHash: '', ReceiptNo: '', CheckNotes: '', SubmittedAt: '',
      DecidedBy: '', DecidedAt: '', AdminNote: '', CreatedAt: nowIso(), UpdatedAt: nowIso()
    };
    appendRowFromObject(ps, record);
    scLog(c, c.Status, c.Status, 'start_extension', 'seller', record.Reference + ' ' + days + ' days');
    return ok({ payment: scPublicPayment(record), instructions: scPaymentInstructions(), campaign: scPublic(c), thanks: scThanks() });
  } finally {
    lock.releaseLock();
  }
}

/** One campaign with its payments, billing, history and results - this store's own only. */
function actionGetCampaignDetail(owner, body) {
  var own = scOwnCampaign(owner, body.campaignId);
  if (!own) return fail('Campaign not found');
  return ok(scDetail(own.c, false));
}

function scDetail(c, forAdmin) {
  var payments = sheetToObjects(scPaymentsSheet()).filter(function (p) { return p.CampaignId === c.CampaignId; })
    .sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
  var ledger = sheetToObjects(scLedgerSheet()).filter(function (l) { return l.CampaignId === c.CampaignId; });
  var history = sheetToObjects(scHistorySheet()).filter(function (h) { return h.CampaignId === c.CampaignId; });
  var pub = scPublic(c);
  return {
    campaign: pub,
    payments: payments.map(function (p) {
      var x = scPublicPayment(p);
      if (forAdmin) { x.screenshotUrl = p.ScreenshotUrl; x.checkNotes = p.CheckNotes; x.decidedBy = p.DecidedBy; x.adminNote = p.AdminNote; x.receiptNo = p.ReceiptNo; }
      return x;
    }),
    ledger: ledger.map(function (l) {
      return { type: l.EntryType, days: Number(l.Days) || 0, amount: Number(l.Amount) || 0, currency: l.Currency, day: l.BillingDay,
        reference: l.PaymentReference, note: l.Note, by: forAdmin ? l.By : (l.By === 'system' ? 'Mwakete (automatic)' : 'Mwakete'), at: l.CreatedAt };
    }),
    history: history.map(function (h) {
      return { from: h.FromStatus, to: h.ToStatus, action: h.Action, note: h.Note, at: h.At,
        by: forAdmin ? h.By : (h.By === 'seller' ? 'You' : h.By === 'system' ? 'Mwakete (automatic)' : 'Mwakete') };
    }),
    metrics: scMetrics(c),
    thanks: c.Status === SC_STATUS.AWAITING_APPROVAL && payments.some(function (p) { return p.Status === SC_PAY.VERIFIED; })
      ? 'Thank You for supporting this project! Your payment has been verified. Your campaign will start once Mwakete approves it.'
      : c.Status === SC_STATUS.SCHEDULED ? 'Thank You for supporting this project! Your payment has been verified. Your campaign is scheduled to start on ' + c.StartDate + '.'
      : c.Status === SC_STATUS.ACTIVE && (Number(c.UsedDays) || 0) <= 1 ? 'Thank You for supporting this project! Your payment has been verified. Your campaign is ready to go.' : ''
  };
}

/** Only what the engine really measures. Opens and impressions are not tracked. */
function scMetrics(c) {
  var out = { sent: 0, clicks: 0, conversions: 0, clickRate: null, spent: scMoney((Number(c.UsedDays) || 0) * (Number(c.DailyRate) || SC_DAILY_RATE)),
    remainingDays: Math.max(0, (Number(c.PaidDays) || 0) - (Number(c.UsedDays) || 0)), timeline: [],
    unavailable: ['Opens and impressions (not tracked)', 'Product-page visits from the email are counted as clicks'] };
  if (!c.EngineCampaignId) return out;
  var cfg = marketingConfig();
  var ev = sheetToObjects(getSheet('CampaignEvents')).filter(function (e) { return e.CampaignId === c.EngineCampaignId; });
  var sent = ev.filter(function (e) { return e.EventType === 'DELIVERY' && e.Status === 'SENT'; });
  var clicks = ev.filter(function (e) { return e.EventType === 'CLICK'; });
  var orders = sheetToObjects(getSheet('Orders')).filter(function (o) { return o.Status !== 'Cancelled' && o.StoreSlug === c.StoreSlug; });
  var win = cfg.attributionDays * DAY_MS;
  out.sent = sent.length;
  out.clicks = clicks.length;
  out.conversions = sent.filter(function (e) {
    var t = msOf(e.SentAt);
    return orders.some(function (o) { var ot = msOf(o.CreatedAt); return lc(o.CustomerEmail) === lc(e.Email) && ot >= t && ot <= t + win; });
  }).length;
  out.clickRate = out.sent ? Math.round((out.clicks / out.sent) * 1000) / 10 : null;
  var byDay = {};
  sent.forEach(function (e) { var d = scToday(msOf(e.SentAt)); (byDay[d] = byDay[d] || { day: d, sent: 0, clicks: 0 }).sent++; });
  clicks.forEach(function (e) { var d = scToday(msOf(e.CreatedAt)); (byDay[d] = byDay[d] || { day: d, sent: 0, clicks: 0 }).clicks++; });
  out.timeline = Object.keys(byDay).sort().map(function (d) { return byDay[d]; });
  out.attributionDays = cfg.attributionDays;
  return out;
}

/** How many opted-in customers this campaign could reach today - a count, never names. */
function actionEstimateCampaignReach(owner, body) {
  var own = scOwnCampaign(owner, body.campaignId);
  if (!own) return fail('Campaign not found');
  var c = own.c;
  if (!c.Audience) return ok({ count: 0, note: 'Choose who receives it first.' });
  var cfg = marketingConfig();
  var ctx = buildMarketingContext(cfg, Date.now());
  var fake = { CampaignId: 'estimate', Type: 'SELLER_PROMOTION', AudienceType: c.Audience,
    AudienceFilterJson: JSON.stringify({ category: c.AudienceCategory }), ProductIdsJson: c.ProductIdsJson,
    StoreSlugsJson: JSON.stringify([c.StoreSlug]), MaxRecipients: '' };
  var n = planCampaignRecipients(fake, Object.assign({}, ctx, { events: [] }), cfg).recipients.length;
  return ok({ count: n, dailyLimit: cfg.dailyLimit,
    note: 'About ' + n + ' customer' + (n === 1 ? '' : 's') + ' who opted in to news match today. Mwakete sends at most ' + cfg.dailyLimit +
      ' promotional emails a day across all campaigns, and no customer gets more than ' + cfg.maxPerWindow + ' a week, so sending can take several days.' });
}

/** The email exactly as the server would send it, with a sample customer. */
function actionPreviewSellerCampaign(owner, body) {
  var own = scOwnCampaign(owner, body.campaignId);
  if (!own) return fail('Campaign not found');
  return ok(scPreview(own.c));
}

function scPreview(c) {
  var cfg = marketingConfig();
  var base = cfg.siteBase || 'https://mwakete.com';
  var productById = {}, ownerById = {};
  sheetToObjects(getSheet('Products')).forEach(function (p) { productById[p.ProductId] = p; });
  sheetToObjects(getSheet('Owners')).forEach(function (o) { ownerById[o.OwnerId] = o; });
  var store = ownerById[c.OwnerId] || {};
  var blocks = []; try { blocks = JSON.parse(c.BlocksJson || '[]'); } catch (e) { blocks = []; }
  var style = {}; try { style = JSON.parse(c.StyleJson || '{}'); } catch (e) { style = {}; }
  var r = renderSellerCampaignEmail({
    blocks: blocks, style: style, base: base, storeName: store.StoreName,
    products: scEmailProducts(parseJsonArray(c.ProductIdsJson), productById, ownerById, base, 'preview', 'preview'),
    storeUrl: base + '/store.html?store=' + encodeURIComponent(store.StoreSlug || ''),
    unsubscribeUrl: base + '/unsubscribe.html', vars: { customerName: 'there', storeName: store.StoreName || '' }
  });
  return { subject: fillMarketingVariables(c.Subject || '', { customerName: 'there', storeName: store.StoreName || '' }), previewText: c.PreviewText || '', html: r.html, text: r.text };
}

/* ---------------------------------------------------------------------------
 * Engine link
 * ------------------------------------------------------------------------- */

function scEngineRow(c) {
  if (!c.EngineCampaignId) return null;
  var sheet = getSheet('Campaigns');
  var row = findRowById(sheet, 'CampaignId', c.EngineCampaignId);
  return row ? { sheet: sheet, row: row } : null;
}

function scPauseEngine(c) {
  var e = scEngineRow(c);
  if (e && ['READY', 'SCHEDULED', 'PROCESSING'].indexOf(e.row.Status) !== -1) updateRowFromObject(e.sheet, e.row.__row, { Status: 'PAUSED', UpdatedAt: nowIso() });
}

function scCancelEngine(c) {
  var e = scEngineRow(c);
  if (e && ['SENT', 'CANCELLED', 'FAILED'].indexOf(e.row.Status) === -1) updateRowFromObject(e.sheet, e.row.__row, { Status: 'CANCELLED', UpdatedAt: nowIso() });
}

/** Creates or refreshes the engine row and lets it send until the end of the paid days. */
function scRunEngine(c, campaignsSheet, nowMs) {
  var sheet = getSheet('Campaigns');
  ensureColumn(sheet, 'BlocksJson');
  ensureColumn(sheet, 'StyleJson');
  var remaining = Math.max(0, (Number(c.PaidDays) || 0) - (Number(c.UsedDays) || 0));
  var endAt = new Date(nowMs + (remaining + 1) * DAY_MS).toISOString();
  var content = {
    Name: 'Seller: ' + c.Name, Subject: c.Subject, PreviewText: c.PreviewText,
    BodyText: (function () { var b = []; try { b = JSON.parse(c.BlocksJson || '[]'); } catch (e) { b = []; } return b.filter(function (x) { return x.type === 'text' || x.type === 'heading'; }).map(function (x) { return x.text; }).join('\n\n'); })(),
    AudienceType: c.Audience, AudienceFilterJson: JSON.stringify({ category: c.AudienceCategory }),
    ProductIdsJson: c.ProductIdsJson, StoreSlugsJson: JSON.stringify([c.StoreSlug]),
    BlocksJson: c.BlocksJson, StyleJson: c.StyleJson, EndAt: endAt, UpdatedAt: nowIso()
  };
  var e = scEngineRow(c);
  if (!e) {
    var id = newId('cmp');
    appendRowFromObject(sheet, Object.assign({
      CampaignId: id, Type: 'SELLER_PROMOTION', Status: 'SCHEDULED', Objective: 'Seller campaign', BodyHtml: '',
      CTAUrl: '', CTAType: 'store', StartAt: new Date(nowMs).toISOString(), CreatedAt: nowIso(), CreatedBy: 'seller:' + c.OwnerId,
      MaxRecipients: '', SentCount: 0, FailedCount: 0, LastRunAt: '', SourceKey: 'seller:' + c.CampaignId
    }, content));
    updateRowFromObject(campaignsSheet, c.__row, { EngineCampaignId: id });
    c.EngineCampaignId = id;
    return 'SCHEDULED';
  }
  if (e.row.Status === 'PAUSED') content.Status = 'SCHEDULED';
  updateRowFromObject(e.sheet, e.row.__row, content);
  return content.Status || e.row.Status;
}

/* ---------------------------------------------------------------------------
 * The daily sweep - run from runMarketingSweep, AFTER its on/paused checks,
 * so nothing is charged while sending is switched off or paused.
 * ------------------------------------------------------------------------- */

function runSellerCampaignSweep(cfg, nowMs) {
  if (cfg.dryRun) return { skipped: 'dry run - seller campaigns neither start nor are charged' };
  var ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName('SellerCampaigns')) return { skipped: 'no seller campaigns yet' };
  var today = scToday(nowMs);
  var summary = { started: 0, charged: 0, exhausted: 0, completed: 0 };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = scCampaignsSheet();
    sheetToObjects(sheet).forEach(function (c) {
      if (c.Status === SC_STATUS.SCHEDULED && c.StartDate && c.StartDate <= today) {
        scSet(sheet, c, { Status: SC_STATUS.ACTIVE }, 'start', 'system', 'Start date reached');
        summary.started++;
      }
      if (c.Status !== SC_STATUS.ACTIVE) return;
      var e = scEngineRow(c);
      if (e && (e.row.Status === 'SENT' || e.row.Status === 'CANCELLED')) {
        // Everyone who could receive it has: finished. Remaining paid days are refundable on request.
        scSet(sheet, c, { Status: SC_STATUS.COMPLETED, StatusNote: 'Sent to everyone eligible' }, 'complete', 'system', 'Every eligible customer has received it');
        scNotifySeller(c.OwnerId, 'Your campaign has reached everyone - ' + c.Name,
          'Your campaign "' + c.Name + '" has been emailed to every customer it could reach, so it has finished. ' +
          'No more days will be charged. Unused paid days can be refunded on request: reply to this email.');
        summary.completed++;
        return;
      }
      var key = 'day:' + c.CampaignId + ':' + today;
      var charged = sheetToObjects(scLedgerSheet()).some(function (l) { return l.IdempotencyKey === key; });
      if (!charged) {
        if ((Number(c.UsedDays) || 0) >= (Number(c.PaidDays) || 0)) {
          scPauseEngine(c);
          scSet(sheet, c, { Status: SC_STATUS.EXHAUSTED }, 'exhausted', 'system', 'All paid days used');
          scNotifySeller(c.OwnerId, 'Your campaign has used its paid days - ' + c.Name,
            'Your campaign "' + c.Name + '" has used all its paid days and has stopped sending. It will not restart on its own. To keep it going, open it and choose Extend.');
          summary.exhausted++;
          return;
        }
        scLedger({ OwnerId: c.OwnerId, CampaignId: c.CampaignId, EntryType: 'DAY_CHARGE', Days: -1, Amount: -scMoney(Number(c.DailyRate) || SC_DAILY_RATE),
          BillingDay: today, PaymentReference: '', IdempotencyKey: key, Note: 'Active on ' + today + ' (Kiribati time)' });
        var used = (Number(c.UsedDays) || 0) + 1;
        updateRowFromObject(sheet, c.__row, { UsedDays: used, UpdatedAt: nowIso() });
        c.UsedDays = used;
        summary.charged++;
        if ((Number(c.PaidDays) || 0) - used === 0 && String(c.LowNoticeSentFor) !== String(c.PaidDays)) {
          updateRowFromObject(sheet, c.__row, { LowNoticeSentFor: c.PaidDays });
          scNotifySeller(c.OwnerId, 'Last paid day today - ' + c.Name,
            'Your campaign "' + c.Name + '" is on its last paid day. It stops sending tomorrow unless you add days with Extend.');
        }
      }
      scRunEngine(c, sheet, nowMs);
    });
  } finally {
    lock.releaseLock();
  }
  return summary;
}

/* ---------------------------------------------------------------------------
 * Admin actions (isOwnerAdmin on every one)
 * ------------------------------------------------------------------------- */

/** body.q (campaign id, store or reference), body.filter: 'review' | 'approval' | 'all'. */
function actionAdminListCampaigns(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var q = String((body && body.q) || '').trim().toLowerCase();
  var filter = String((body && body.filter) || 'review');
  var stores = {};
  sheetToObjects(getSheet('Owners')).forEach(function (o) { stores[o.OwnerId] = o.StoreName; });
  var payments = sheetToObjects(scPaymentsSheet());
  var list = sheetToObjects(scCampaignsSheet()).map(function (c) {
    var p = scPublic(c);
    p.storeName = stores[c.OwnerId] || c.StoreSlug;
    p.storeSlug = c.StoreSlug;
    var mine = payments.filter(function (x) { return x.CampaignId === c.CampaignId; });
    p.paymentsUnderReview = mine.filter(function (x) { return x.Status === SC_PAY.REVIEW; }).map(function (x) {
      var o = scPublicPayment(x); o.screenshotUrl = x.ScreenshotUrl; o.checkNotes = x.CheckNotes; o.receiptNo = x.ReceiptNo; return o;
    });
    p.references = mine.map(function (x) { return x.Reference; });
    return p;
  }).filter(function (p) {
    if (q && [p.campaignId, p.name, p.storeName, p.storeSlug].concat(p.references).join(' ').toLowerCase().indexOf(q) === -1) return false;
    if (filter === 'review') return p.paymentsUnderReview.length > 0;
    if (filter === 'approval') return p.status === SC_STATUS.AWAITING_APPROVAL;
    return true;
  }).sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); }).slice(0, 100);
  return ok({ campaigns: list, currencyLabel: SC_CURRENCY_LABEL });
}

function actionAdminGetCampaign(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var c = findRowById(scCampaignsSheet(), 'CampaignId', String(body.campaignId || ''));
  if (!c) return fail('Campaign not found');
  var d = scDetail(c, true);
  d.preview = scPreview(c);
  return ok(d);
}

/**
 * body.paymentId, body.verify (boolean), body.reason (required to reject),
 * body.confirm === true. Only a payment under review can be decided. Verifying
 * credits its days once (ledger key pay:<id>), never activates on its own.
 */
function actionAdminDecideCampaignPayment(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  if (body.confirm !== true) return fail('Please confirm this payment decision.');
  var verify = body.verify === true;
  var reason = String(body.reason || '').trim().slice(0, 300);
  if (!verify && reason.length < 5) return fail('Give the seller a reason (at least 5 characters).');
  var by = normalizeEmail(owner.Email);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var p, c;
  try {
    var ps = scPaymentsSheet();
    p = findRowById(ps, 'PaymentId', String(body.paymentId || ''));
    if (!p) return fail('Payment not found');
    if (p.Status !== SC_PAY.REVIEW) return fail('This payment is not waiting for a decision (it is ' + p.Status.toLowerCase() + ').');
    var cs = scCampaignsSheet();
    c = findRowById(cs, 'CampaignId', p.CampaignId);
    if (!c) return fail('Campaign not found');
    updateRowFromObject(ps, p.__row, { Status: verify ? SC_PAY.VERIFIED : SC_PAY.REJECTED, DecidedBy: by, DecidedAt: nowIso(), AdminNote: reason, UpdatedAt: nowIso() });
    if (!verify) {
      if (p.Kind === 'initial') scSet(cs, c, { Status: SC_STATUS.PAYMENT_REJECTED, StatusNote: reason }, 'payment_rejected', by, reason);
      else scLog(c, c.Status, c.Status, 'extension_payment_rejected', by, reason);
    } else {
      scLedger({ OwnerId: c.OwnerId, CampaignId: c.CampaignId, EntryType: 'PAYMENT_VERIFIED', Days: Number(p.Days), Amount: scMoney(p.Amount),
        BillingDay: '', PaymentReference: p.Reference, IdempotencyKey: 'pay:' + p.PaymentId, Note: p.Kind + ' payment verified', By: by });
      var patch = { PaidDays: (Number(c.PaidDays) || 0) + Number(p.Days) };
      if (p.Kind === 'initial') {
        patch.Status = SC_STATUS.AWAITING_APPROVAL;
        patch.StatusNote = '';
      } else if (c.Status === SC_STATUS.EXHAUSTED) {
        // Never restarts on its own after running out: the seller resumes it.
        patch.Status = SC_STATUS.PAUSED;
        patch.StatusNote = 'More days added - press Resume to start sending again';
      }
      scSet(cs, c, patch, verify ? 'payment_verified' : 'payment_rejected', by, p.Reference);
    }
  } finally {
    lock.releaseLock();
  }
  scNotifySeller(c.OwnerId, verify ? 'Payment verified - ' + c.Name : 'Payment not verified - ' + c.Name, verify
    ? 'Thank You for supporting this project! Your payment ' + p.Reference + ' (' + scMoneyText(p.Amount) + ') has been verified.' +
      (p.Kind === 'initial' ? ' Mwakete will now check the campaign and approve it before it starts.' : ' ' + p.Days + ' days have been added to "' + c.Name + '".')
    : 'We could not verify your payment ' + p.Reference + ' for "' + c.Name + '".\n\nReason: ' + reason + '\n\nYou can upload a corrected receipt from your campaign page.');
  return ok({ paymentId: p.PaymentId, status: verify ? SC_PAY.VERIFIED : SC_PAY.REJECTED });
}

/** body.campaignId, body.approve (boolean), body.reason (required to request changes). */
function actionAdminReviewCampaign(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var approve = body.approve === true;
  var reason = String(body.reason || '').trim().slice(0, 300);
  if (!approve && reason.length < 5) return fail('Tell the seller what to change (at least 5 characters).');
  var by = normalizeEmail(owner.Email);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var c;
  try {
    var cs = scCampaignsSheet();
    c = findRowById(cs, 'CampaignId', String(body.campaignId || ''));
    if (!c) return fail('Campaign not found');
    if (c.Status !== SC_STATUS.AWAITING_APPROVAL) return fail('This campaign is not waiting for approval');
    if (!approve) {
      scSet(cs, c, { Status: SC_STATUS.CHANGES_REQUESTED, StatusNote: reason }, 'changes_requested', by, reason);
    } else {
      if ((Number(c.PaidDays) || 0) <= (Number(c.UsedDays) || 0)) return fail('This campaign has no verified paid days');
      var to = c.StartDate > scToday() ? SC_STATUS.SCHEDULED : SC_STATUS.ACTIVE;
      scSet(cs, c, { Status: to, ApprovedBy: by, ApprovedAt: nowIso(), StatusNote: '' }, 'approved', by, '');
      if (c.EngineCampaignId) {
        // Approved edits reach the next emails; it sends again only while ACTIVE (the sweep resumes it).
        var e = scEngineRow(c);
        if (e) updateRowFromObject(e.sheet, e.row.__row, { Subject: c.Subject, PreviewText: c.PreviewText, BlocksJson: c.BlocksJson, StyleJson: c.StyleJson,
          ProductIdsJson: c.ProductIdsJson, AudienceType: c.Audience, AudienceFilterJson: JSON.stringify({ category: c.AudienceCategory }), UpdatedAt: nowIso() });
      }
    }
  } finally {
    lock.releaseLock();
  }
  scNotifySeller(c.OwnerId, approve ? 'Campaign approved - ' + c.Name : 'Changes needed - ' + c.Name, approve
    ? 'Thank You for supporting this project! Your payment has been verified and "' + c.Name + '" is approved. ' + (c.Status === SC_STATUS.SCHEDULED ? 'It starts on ' + c.StartDate + '.' : 'Your campaign is ready to go.')
    : 'Mwakete asked for a change to "' + c.Name + '" before it can start:\n\n' + reason + '\n\nEdit the campaign and it will come back for approval.');
  return ok({ campaign: scPublic(c) });
}

/** body.campaignId, body.op: pause | stop, body.reason, body.confirm === true (policy or operational). */
function actionAdminCampaignAction(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  var op = String(body.op || '');
  if (op !== 'pause' && op !== 'stop') return fail('Unknown action');
  if (body.confirm !== true) return fail('Please confirm.');
  var reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return fail('Give a reason (at least 5 characters).');
  var by = normalizeEmail(owner.Email);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var c;
  try {
    var cs = scCampaignsSheet();
    c = findRowById(cs, 'CampaignId', String(body.campaignId || ''));
    if (!c) return fail('Campaign not found');
    if (SC_FINAL_STATES.indexOf(c.Status) !== -1) return fail('This campaign has already finished');
    if (op === 'pause') {
      if (c.Status !== SC_STATUS.ACTIVE && c.Status !== SC_STATUS.SCHEDULED) return fail('Only a running or scheduled campaign can be paused');
      scPauseEngine(c);
      scSet(cs, c, { Status: SC_STATUS.PAUSED, StatusNote: 'Paused by Mwakete: ' + reason }, 'admin_pause', by, reason);
    } else {
      scCancelEngine(c);
      scCancelOpenPayments(c.CampaignId, 'Campaign stopped by Mwakete');
      scSet(cs, c, { Status: SC_STATUS.STOPPED, StatusNote: 'Stopped by Mwakete: ' + reason }, 'admin_stop', by, reason);
    }
  } finally {
    lock.releaseLock();
  }
  scNotifySeller(c.OwnerId, (op === 'pause' ? 'Campaign paused by Mwakete - ' : 'Campaign stopped by Mwakete - ') + c.Name,
    'Mwakete ' + (op === 'pause' ? 'paused' : 'stopped') + ' your campaign "' + c.Name + '".\n\nReason: ' + reason +
    (op === 'stop' ? '\n\nUnused paid days can be refunded on request: reply to this email.' : ''));
  return ok({ campaign: scPublic(c) });
}

/**
 * Records a refund of unused paid days that Mwakete has paid back by hand.
 * body.campaignId, body.days, body.reason, body.confirm === true. The
 * campaign must not be sending (paused, exhausted, completed or stopped).
 */
function actionAdminRecordCampaignRefund(owner, body) {
  if (!isOwnerAdmin(owner)) return fail('Not authorized');
  if (body.confirm !== true) return fail('Please confirm the refund.');
  var days = parseInt(body.days, 10);
  var reason = String(body.reason || '').trim().slice(0, 300);
  if (!(days >= 1)) return fail('Enter the number of days refunded');
  if (reason.length < 5) return fail('Give a reason (at least 5 characters).');
  var by = normalizeEmail(owner.Email);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cs = scCampaignsSheet();
    var c = findRowById(cs, 'CampaignId', String(body.campaignId || ''));
    if (!c) return fail('Campaign not found');
    if ([SC_STATUS.PAUSED, SC_STATUS.EXHAUSTED, SC_STATUS.COMPLETED, SC_STATUS.STOPPED].indexOf(c.Status) === -1) return fail('Pause or stop the campaign before refunding days');
    var unused = (Number(c.PaidDays) || 0) - (Number(c.UsedDays) || 0);
    if (days > unused) return fail('Only ' + unused + ' unused paid day' + (unused === 1 ? '' : 's') + ' can be refunded');
    var rate = Number(c.DailyRate) || SC_DAILY_RATE;
    scLedger({ OwnerId: c.OwnerId, CampaignId: c.CampaignId, EntryType: 'REFUND', Days: -days, Amount: -scMoney(days * rate),
      BillingDay: '', PaymentReference: '', IdempotencyKey: 'refund:' + newId('r'), Note: reason, By: by });
    scSet(cs, c, { PaidDays: (Number(c.PaidDays) || 0) - days }, 'refund', by, days + ' days, ' + scMoneyText(days * rate) + ': ' + reason);
    return ok({ campaign: scPublic(c) });
  } finally {
    lock.releaseLock();
  }
}
