/**
 * POS Integration Hub (IntegrationHub.gs) on the REAL backend sources against an
 * in-memory spreadsheet: connection lifecycle, the signed push receiver
 * (signature, replay, idempotency, stale time, versions, echo), mapping
 * (never by name), sales / refunds / stock counts, oversell flags, and
 * seller isolation. Nothing is sent to a real POS provider.
 */
const crypto = require('crypto');
const { makeBox } = require('./lib/gas-harness.js');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e === undefined ? '' : '  [' + e + ']')); } };

const vHead = ['VariantId', 'ProductId', 'OwnerId', 'Label', 'Price', 'SKU', 'StockQty', 'Status', 'ReservedQty', 'Barcode'];
const box = makeBox({
  Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'StoreType'], ['own_a', 'a', 'A', 'active', ''], ['own_b', 'b', 'B', 'active', '']],
  Products: [['ProductId', 'OwnerId', 'Name', 'Status', 'Category'], ['prod_a', 'own_a', 'Rice', 'active', 'food'], ['prod_b', 'own_b', 'Flour', 'active', 'food']],
  Variants: [vHead,
    ['v1', 'prod_a', 'own_a', '1kg', 2, 'R1', 10, 'active', 2, '9300001'],
    ['v2', 'prod_a', 'own_a', '5kg', 9, 'R5', 3, 'active', 0, ''],
    ['v3', 'prod_a', 'own_a', '10kg', 18, 'R10', 5, 'active', 0, ''],
    ['vb', 'prod_b', 'own_b', '25kg', 30, 'R1', 100, 'active', 0, '']]
});
const A = { OwnerId: 'own_a', StoreSlug: 'a', StoreType: '' };
const B = { OwnerId: 'own_b', StoreSlug: 'b', StoreType: '' };
const v = (id) => box.__sheets.Variants.objects().find((r) => r.VariantId === id);
const stock = (id) => Number(v(id).StockQty);
const events = () => (box.__sheets.IntegrationEvents ? box.__sheets.IntegrationEvents.objects() : []);

// --- feature flag off by default
ok('hub is off by default', box.actionPosHubStatus(A).enabled === false);
ok('creating a connection is refused while off', !box.actionCreatePosConnection(A, { name: 'Till' }).ok);
ok('a push is refused while off', box.actionPosPush({ connectionId: 'x', payload: '{}', signature: 'a', timestamp: Date.now() }).code === 'not_enabled');
box.__props.POS_HUB = 'on';
ok('hub on after the flag is set', box.actionPosHubStatus(A).enabled === true);

// --- create
let c = box.actionCreatePosConnection(A, { name: 'Main till', providerName: 'My POS' });
ok('connection created, secret shown once', c.ok && /^[A-Za-z0-9_-]{32,}$/.test(c.secret), JSON.stringify(c));
const id = c.connectionId, secret = c.secret;
let st = box.actionPosHubStatus(A).connections.find((x) => x.connectionId === id);
ok('status is "Waiting for first signal" before any signed signal', /waiting/i.test(st.displayStatus), st.displayStatus);
ok('status never contains the secret', JSON.stringify(box.actionPosHubStatus(A)).indexOf(secret) === -1);
ok('other seller cannot see the connection', !box.actionPosHubStatus(B).connections.some((x) => x.connectionId === id));

// --- push helper
const send = (obj, o) => {
  o = o || {};
  const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const ts = o.ts !== undefined ? o.ts : Date.now();
  const sig = o.sig || crypto.createHmac('sha256', o.secret || secret).update(`${o.id || id}.${ts}.${payload}`).digest('hex');
  return box.actionPosPush({ connectionId: o.id || id, timestamp: ts, payload, signature: sig });
};
const sale = (extra) => Object.assign({ type: 'sale', id: 'S1', occurredAt: new Date().toISOString(), lines: [{ sku: 'R5', qty: 2, unitPrice: 9 }], payment: { method: 'cash', status: 'paid' } }, extra);

// --- signature / timing
ok('bad signature rejected', send({ type: 'ping' }, { sig: 'f'.repeat(64) }).code === 'invalid_signature');
ok('wrong secret rejected', send({ type: 'ping' }, { secret: 'nope' }).code === 'invalid_signature');
ok('unknown connection looks the same as a bad signature', send({ type: 'ping' }, { id: 'conn_nope' }).code === 'invalid_signature');
ok('stale timestamp rejected', send({ type: 'ping' }, { ts: Date.now() - 20 * 60000 }).code === 'stale_timestamp');
ok('still waiting after only failed attempts', /waiting/i.test(box.actionPosHubStatus(A).connections.find((x) => x.connectionId === id).displayStatus));
let r = send({ type: 'ping' });
ok('signed ping verifies the connection', r.ok && r.verified === true, JSON.stringify(r));
ok('status now Connected', /connected/i.test(box.actionPosHubStatus(A).connections.find((x) => x.connectionId === id).displayStatus));
ok('not JSON rejected', send('not json').code === 'bad_payload');
ok('unknown event type rejected', send({ type: 'launch' }).code === 'bad_payload');

// --- sale: unmapped by name must not auto-match
r = send(sale({ id: 'N1', lines: [{ name: 'Rice 5kg', qty: 1, unitPrice: 9, externalVariantId: 'ext-77' }] }));
ok('item known only by an unknown id goes to review, stock untouched', r.ok && r.status === 'needs_mapping' && stock('v2') === 3, JSON.stringify(r));

// --- sale: SKU match applies a delta
r = send(sale());
ok('sale by SKU is applied', r.ok && r.status === 'applied', JSON.stringify(r));
ok('stock reduced by exactly the sold quantity', stock('v2') === 1, stock('v2'));
const ledger = box.__sheets.StockMovements.objects();
ok('ledger has an EXTERNAL sale movement of -2', ledger.some((m) => m.VariantId === 'v2' && Number(m.Quantity) === -2), JSON.stringify(ledger.slice(-1)));
ok('Orders sheet untouched by a walk-in sale', !box.__sheets.Orders || box.__sheets.Orders.objects().length === 0);

// --- idempotency / replay
const before = stock('v2');
r = send(sale());
ok('same sale again is a duplicate, no second deduction', r.ok && r.duplicate === true && stock('v2') === before, JSON.stringify(r));
const raw = JSON.stringify(sale({ id: 'S2', lines: [{ sku: 'R5', qty: 1, unitPrice: 9 }] }));
const ts0 = Date.now();
const first = send(raw, { ts: ts0 });
const afterFirst = stock('v2');
const replay = send(raw, { ts: ts0 });
ok('exact replay of a signed request does not double count', first.ok && afterFirst === before - 1 && replay.duplicate === true && stock('v2') === afterFirst, `${before} ${afterFirst} ${stock('v2')}`);

// --- oversell is a fact, flagged, never negative
r = send(sale({ id: 'S3', lines: [{ sku: 'R5', qty: 5, unitPrice: 9 }] }));
ok('oversold sale recorded, stock floors at 0', stock('v2') === 0 && r.ok, JSON.stringify(r));
ok('oversell raised for attention', events().some((e) => e.ExternalId === 'S3' && e.ReconStatus === 'open'), JSON.stringify(events().filter((e) => e.ExternalId === 'S3')));

// --- sale is all-or-nothing on mapping
const s1 = stock('v1'), s3 = stock('v3');
r = send(sale({ id: 'S4', lines: [{ sku: 'R10', qty: 1, unitPrice: 18 }, { sku: 'UNKNOWN', qty: 1, unitPrice: 5 }] }));
ok('one unmapped line holds the WHOLE sale', r.status === 'needs_mapping' && stock('v3') === s3 && stock('v1') === s1, JSON.stringify(r));
const ev = events().find((e) => e.ExternalId === 'S4');
const map = box.actionSaveIntegrationMapping(A, { connectionId: id, externalSku: 'UNKNOWN', variantId: 'v1' });
ok('seller maps the unknown item', map.ok, JSON.stringify(map));
r = box.actionResolveIntegrationEvent(A, { eventId: ev.EventId, resolution: 'retry' });
ok('retry after mapping applies the sale', r.ok && r.status === 'applied' && stock('v3') === s3 - 1 && stock('v1') === s1 - 1, JSON.stringify(r));

// --- other seller's variant cannot be mapped
ok('cannot map to another seller\'s product', !box.actionSaveIntegrationMapping(A, { connectionId: id, externalVariantId: 'X9', variantId: 'vb' }).ok);
ok('other seller cannot resolve my event', !box.actionResolveIntegrationEvent(B, { eventId: ev.EventId, resolution: 'acknowledge' }).ok);
ok('other seller cannot map on my connection', !box.actionSaveIntegrationMapping(B, { connectionId: id, externalVariantId: 'X8', variantId: 'vb' }).ok);

// --- refund with restock
const sBefore = stock('v3');
r = send({ type: 'refund', id: 'R1', saleId: 'S4', lines: [{ sku: 'R10', qty: 1, restock: true }] });
ok('refund with restock puts the unit back', r.ok && r.status === 'applied' && stock('v3') === sBefore + 1, JSON.stringify(r));
r = send({ type: 'refund', id: 'R2', saleId: 'S4', lines: [{ sku: 'R10', qty: 1, restock: true }] });
ok('cannot refund more than was sold', r.status !== 'applied' && stock('v3') === sBefore + 1, JSON.stringify(r));
r = send({ type: 'refund', id: 'R3', saleId: 'NOT-YET', lines: [{ sku: 'R10', qty: 1, restock: true }] });
ok('refund before its sale waits', r.status === 'pending_parent', JSON.stringify(r));

// --- stock count never moves stock directly
const pre = stock('v1');
r = send({ type: 'stock', id: 'C1', asOf: new Date().toISOString(), items: [{ sku: 'R1', qty: 99 }] });
ok('a stock count is queued for review, not applied', r.ok && stock('v1') === pre, JSON.stringify(r));

// --- stale version
r = send(sale({ id: 'V1', version: '10', lines: [{ sku: 'R10', qty: 1, unitPrice: 18 }] }));
const afterV = stock('v3');
r = send(sale({ id: 'V1', version: '9', lines: [{ sku: 'R10', qty: 3, unitPrice: 18 }] }));
ok('older version (9 < 10 numerically) ignored', stock('v3') === afterV, JSON.stringify(r));

// --- pause / disconnect
ok('pause works', box.actionSetPosConnectionState(A, { connectionId: id, state: 'pause' }).ok);
ok('paused connection refuses pushes', send({ type: 'ping' }).code === 'paused');
ok('resume works', box.actionSetPosConnectionState(A, { connectionId: id, state: 'resume' }).ok);
ok('other seller cannot disconnect my connection', !box.actionSetPosConnectionState(B, { connectionId: id, state: 'disconnect' }).ok);
c = box.actionRotatePosSecret(A, { connectionId: id });
ok('rotate gives a new secret; old one stops working', c.ok && c.secret !== secret && send({ type: 'ping' }).code === 'invalid_signature');
const secret2 = c.secret;
ok('new secret works', send({ type: 'ping' }, { secret: secret2 }).ok);
ok('disconnect works', box.actionSetPosConnectionState(A, { connectionId: id, state: 'disconnect' }).ok);
ok('disconnected secret is deleted', !box.__props['POSSECRET_' + id]);
ok('disconnected connection refuses pushes', send({ type: 'ping' }, { secret: secret2 }).code === 'invalid_signature');

// --- formula injection / secrets in logs
const c2 = box.actionCreatePosConnection(A, { name: '=HYPERLINK("http://evil")', providerName: '+cmd' });
const nameCell = c2.ok ? String(box.__sheets.InventoryConnections.objects().find((x) => x.ConnectionId === c2.connectionId).Name) : '';
ok('a name starting with = is refused or stored as plain text', !c2.ok || !/^[=+\-@]/.test(nameCell), nameCell);
ok('events never contain a secret', !JSON.stringify(events()).includes(secret) && !JSON.stringify(events()).includes(secret2));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
