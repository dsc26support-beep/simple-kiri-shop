const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Products.gs', 'utf8');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

// Exercise the real cost-write block from actionUpdateOwnerProfile.
const block = src.match(/var costFieldMap = \{[\s\S]*?\n  \}\);/)[0];
function write(body) {
  const sandbox = { body, update: {} };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  return sandbox.update;
}

ok('null -> blank (negotiated)', write({ deliveryTruckCost: null }).DeliveryTruckCost === '', JSON.stringify(write({ deliveryTruckCost: null })));
ok("'' -> blank (negotiated)", write({ deliveryTruckCost: '' }).DeliveryTruckCost === '');
ok('0 -> 0 (genuinely free, NOT negotiated)', write({ deliveryTruckCost: 0 }).DeliveryTruckCost === 0);
ok('15 -> 15', write({ deliveryTruckCost: 15 }).DeliveryTruckCost === 15);
ok("'12.5' -> 12.5", write({ deliveryTruckCost: '12.5' }).DeliveryTruckCost === 12.5);
ok('negative -> blank', write({ deliveryTruckCost: -3 }).DeliveryTruckCost === '');
ok('garbage -> blank', write({ deliveryTruckCost: 'abc' }).DeliveryTruckCost === '');
ok('undefined -> field untouched', !('DeliveryTruckCost' in write({})));
ok('all three methods handled', Object.keys(write({ deliveryTruckCost: null, deliveryShipCost: 5, deliveryAirCargoCost: 0 })).sort().join(',') === 'DeliveryAirCargoCost,DeliveryShipCost,DeliveryTruckCost');

let f = 0;
console.log('\n--- updateOwnerProfile delivery-cost write ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
