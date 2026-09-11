const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Orders.gs', 'utf8');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);

function build(method, deliveryCost, negotiated) {
  const sandbox = { SITE_BASE_URL: 'https://mwakete.com', getScriptProp: () => '' };
  vm.createContext(sandbox);
  vm.runInContext(code + `
;__r = buildSellerOrderEmail(
  { StoreName: 'Bong', Phone: '73001224' }, 'ORD-1', 'Ana', '73007552', 'a@b.com',
  'South Tarawa', 'Betio', ${JSON.stringify(method)}, ${JSON.stringify(deliveryCost)},
  [{ qty: 2, label: 'Rice 1kg', lineTotal: 100 }], 100, ${JSON.stringify(100 + (deliveryCost || 0))},
  '', ${JSON.stringify(negotiated)});`, sandbox);
  return sandbox.__r;
}

let e = build('truck', 15, false);
ok('fixed fee: email states the amount', /\$15\.00/.test(e), e.match(/Delivery.*/)?.[0]);
ok('fixed fee: not called negotiated', !/To Be Negotiated/.test(e));

e = build('pickPay', 0, false);
ok('Pick & Pay: still reads Free', /Free/.test(e));
ok('Pick & Pay: not called negotiated', !/To Be Negotiated/.test(e));

e = build('truck', 0, true);
ok('negotiated: email says To Be Negotiated', /To Be Negotiated/.test(e), e.match(/Delivery.*/)?.[0]);
ok('negotiated: never says Free', !/\bFree\b/.test(e), e.match(/Delivery.*/)?.[0]);
ok('negotiated: tells the vendor to agree the fee', /contact the customer to agree the fee/.test(e));

// The trailing param must be optional - any caller predating it behaves as before.
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(code + `;__r = buildSellerOrderEmail({StoreName:'B',Phone:'1'},'O','A','1','a@b.com','I','V','truck',0,[{qty:1,label:'x',lineTotal:1}],1,1,'');`, sandbox);
ok('omitting the new arg keeps the old behaviour (Free)', /Free/.test(sandbox.__r) && !/To Be Negotiated/.test(sandbox.__r));

let f = 0;
console.log('\n--- Orders.gs seller email ---');
for (const [s, n, x] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${x ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
