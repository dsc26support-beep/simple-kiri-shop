/**
 * Which islands can actually send to which, for ship and air cargo.
 *
 * Run against the REAL sources, both of them. This rule is written twice - in
 * checkout.js so a shopper is not offered something that will be refused, and
 * in Orders.gs which actually refuses it - and the two drifting apart is the
 * failure that matters most here. A shopper offered Air Cargo to an island the
 * backend will reject fills in the whole form and is turned away at the end.
 *
 * So: the shared rule is asserted byte-identical between the two files, AND
 * both copies are executed over all 23x23 island pairs and required to agree.
 *
 * THE LINE ISLANDS CORRIDOR is the new rule. Tabuaeran and Teraina have no
 * freight route of their own - everything moves through Kiritimati - so they
 * connect to Kiritimati and nowhere else, in either direction. That REMOVES
 * four routes that worked before (Tabuaeran/Teraina to and from South Tarawa),
 * which the owner confirmed deliberately, so those removals are asserted here
 * rather than left to be noticed later as a bug.
 */
const fs = require('fs');
const vm = require('vm');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e || '']);
const REPO = '/home/user/simple-kiri-shop/';

const checkoutSrc = fs.readFileSync(REPO + 'assets/js/checkout.js', 'utf8');
const ordersSrc = fs.readFileSync(REPO + 'apps-script/Orders.gs', 'utf8');

const ISLANDS = ['South Tarawa', 'North Tarawa', 'Makin', 'Butaritari', 'Marakei', 'Abaiang',
  'Maiana', 'Kuria', 'Aranuka', 'Abemama', 'Nonouti', 'Tabiteuea North', 'Tabiteuea South',
  'Beru', 'Nikunau', 'Onotoa', 'Tamana', 'Arorae', 'Banaba', 'Kiritimati', 'Tabuaeran',
  'Teraina', 'Kanton'];

const grab = (src, name) => {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}'));
  if (!m) throw new Error('could not find ' + name + ' in source');
  return m[0];
};

/* ---------- 1. the rule is written once, in two places, identically -------- */
{
  const a = grab(checkoutSrc, 'offIslandRouteExists');
  const b = grab(ordersSrc, 'offIslandRouteExists');
  ok('the route rule is byte-identical in checkout.js and Orders.gs', a === b,
    a === b ? '' : 'they have drifted');
  const la = grab(checkoutSrc, 'isLineOuterIsland');
  const lb = grab(ordersSrc, 'isLineOuterIsland');
  ok('and so is the corridor-island test', la === lb);
}

/* ---------- 2. run BOTH copies over every island pair ---------------------- */
function loadRoute(src) {
  const box = {};
  vm.createContext(box);
  vm.runInContext(grab(src, 'isLineOuterIsland') + '\n' + grab(src, 'offIslandRouteExists'), box);
  return box.offIslandRouteExists;
}
const routeFront = loadRoute(checkoutSrc);
const routeBack = loadRoute(ordersSrc);
{
  const disagreements = [];
  for (const from of ISLANDS) for (const to of ISLANDS) {
    if (routeFront(from, to) !== routeBack(from, to)) disagreements.push(from + ' -> ' + to);
  }
  ok('the two copies agree on all ' + (ISLANDS.length * ISLANDS.length) + ' island pairs',
    disagreements.length === 0, disagreements.slice(0, 5).join(' | '));
}

/* ---------- 3. the eight rules the owner wrote ----------------------------- */
const route = routeFront;
for (const [from, to] of [
  ['South Tarawa', 'Kiritimati'],
  ['Kiritimati', 'South Tarawa'],
  ['Tabuaeran', 'Kiritimati'],
  ['Teraina', 'Kiritimati'],
  ['Kiritimati', 'Tabuaeran'],
  ['Kiritimati', 'Teraina']
]) ok('YES: ' + from + ' -> ' + to, route(from, to) === true);

for (const [from, to] of [
  // "to and from Tarawa: no to all"
  ['Tabuaeran', 'South Tarawa'], ['South Tarawa', 'Tabuaeran'],
  ['Teraina', 'South Tarawa'], ['South Tarawa', 'Teraina'],
  ['Tabuaeran', 'North Tarawa'], ['North Tarawa', 'Tabuaeran'],
  ['Teraina', 'North Tarawa'], ['North Tarawa', 'Teraina'],
  // "to and from islands outside South Tarawa: no"
  ['Tabuaeran', 'Abaiang'], ['Abaiang', 'Tabuaeran'],
  ['Teraina', 'Butaritari'], ['Butaritari', 'Teraina'],
  // falls out of "Kiritimati only": neither of these IS Kiritimati
  ['Tabuaeran', 'Teraina'], ['Teraina', 'Tabuaeran']
]) ok('NO: ' + from + ' -> ' + to, route(from, to) === false);

/* ---------- 4. the four routes this REMOVES, stated as removals ------------ */
{
  // Asserted separately from rule 3 so the diff is honest about what changed:
  // these worked before the corridor rule and deliberately do not now.
  const removed = [['Tabuaeran', 'South Tarawa'], ['Teraina', 'South Tarawa'],
                   ['South Tarawa', 'Tabuaeran'], ['South Tarawa', 'Teraina']];
  ok('the four Tarawa <-> Tabuaeran/Teraina routes are closed, as confirmed',
    removed.every(([f, t]) => route(f, t) === false));
}

/* ---------- 5. everywhere else is untouched -------------------------------- */
{
  const OUTER = ISLANDS.filter((i) => ['South Tarawa', 'North Tarawa', 'Kiritimati',
    'Tabuaeran', 'Teraina'].indexOf(i) === -1);
  ok('every other island still reaches South Tarawa',
    OUTER.every((i) => route(i, 'South Tarawa') === true),
    OUTER.filter((i) => !route(i, 'South Tarawa')).join(','));
  ok('and South Tarawa still reaches every one of them',
    OUTER.every((i) => route('South Tarawa', i) === true),
    OUTER.filter((i) => !route('South Tarawa', i)).join(','));
  ok('and they still cannot reach each other',
    OUTER.every((from) => OUTER.every((to) => from === to || route(from, to) === false)));
  ok('North Tarawa still reaches South Tarawa', route('North Tarawa', 'South Tarawa') === true);
  ok('and South Tarawa still reaches North Tarawa', route('South Tarawa', 'North Tarawa') === true);
  ok('no island has a route to itself - that is truck or pick-up, not freight',
    ISLANDS.every((i) => route(i, i) === false));
}

/* ---------- 6. the whole thing, end to end, through the REAL backend ------- */
function backendEligible(storeIsland, customerIsland, subtotal, village) {
  const box = {
    wordsAreEquivalent: (a, b) => a === b,
    console
  };
  vm.createContext(box);
  vm.runInContext([
    "var TRUCK_ELIGIBLE_VILLAGES = ['buota', 'abatao', 'tabiteuea'];",
    grab(ordersSrc, 'customerVillageMatchesTruckList'),
    grab(ordersSrc, 'isLineOuterIsland'),
    grab(ordersSrc, 'offIslandRouteExists'),
    grab(ordersSrc, 'computeEligibleDeliveryMethods')
  ].join('\n'), box);
  const owner = { Island: storeIsland, DeliveryTruck: 'true', DeliveryShip: 'true',
    DeliveryAirCargo: 'true', DeliveryPickPay: 'true' };
  return box.computeEligibleDeliveryMethods(owner, customerIsland, village || 'Somewhere', subtotal);
}
{
  const kirToTab = backendEligible('Kiritimati', 'Tabuaeran', 600);
  ok('backend: Kiritimati -> Tabuaeran offers Ship and Air Cargo',
    kirToTab.indexOf('ship') !== -1 && kirToTab.indexOf('airCargo') !== -1, kirToTab.join(','));
  const tabToKir = backendEligible('Tabuaeran', 'Kiritimati', 600);
  ok('backend: Tabuaeran -> Kiritimati offers Ship and Air Cargo',
    tabToKir.indexOf('ship') !== -1 && tabToKir.indexOf('airCargo') !== -1, tabToKir.join(','));

  const tabToST = backendEligible('Tabuaeran', 'South Tarawa', 600);
  ok('backend: Tabuaeran -> South Tarawa offers NO freight at all',
    tabToST.indexOf('ship') === -1 && tabToST.indexOf('airCargo') === -1
      && tabToST.indexOf('truck') === -1, tabToST.join(','));
  // The store is still reachable in person, which is the honest fallback.
  ok('backend: but Pick & Pay survives, because collection needs no boat',
    tabToST.indexOf('pickPay') !== -1, tabToST.join(','));

  const stToTab = backendEligible('South Tarawa', 'Tabuaeran', 600);
  ok('backend: South Tarawa -> Tabuaeran offers no freight either',
    stToTab.indexOf('ship') === -1 && stToTab.indexOf('airCargo') === -1, stToTab.join(','));

  // The $500 ship floor holds on the new corridor exactly as everywhere else.
  const cheap = backendEligible('Kiritimati', 'Teraina', 499);
  ok('backend: under $500 the new corridor offers Air Cargo but not Ship',
    cheap.indexOf('ship') === -1 && cheap.indexOf('airCargo') !== -1, cheap.join(','));
  const atFloor = backendEligible('Kiritimati', 'Teraina', 500);
  ok('backend: at exactly $500 Ship appears', atFloor.indexOf('ship') !== -1, atFloor.join(','));

  // Unchanged behaviour, spot-checked through the real function.
  const abaiangToST = backendEligible('Abaiang', 'South Tarawa', 600);
  ok('backend: an outer island still reaches South Tarawa by both',
    abaiangToST.indexOf('ship') !== -1 && abaiangToST.indexOf('airCargo') !== -1,
    abaiangToST.join(','));
  const ntAnywhere = backendEligible('North Tarawa', 'South Tarawa', 600);
  ok('backend: North Tarawa still ships to South Tarawa and still never flies',
    ntAnywhere.indexOf('ship') !== -1 && ntAnywhere.indexOf('airCargo') === -1,
    ntAnywhere.join(','));
  const stToNT = backendEligible('South Tarawa', 'North Tarawa', 600);
  ok('backend: South Tarawa -> North Tarawa still ships and still never flies',
    stToNT.indexOf('ship') !== -1 && stToNT.indexOf('airCargo') === -1, stToNT.join(','));
  const sameIsland = backendEligible('Kiritimati', 'Kiritimati', 600, 'London');
  ok('backend: same-island still offers the truck, and no freight',
    sameIsland.indexOf('truck') !== -1 && sameIsland.indexOf('ship') === -1
      && sameIsland.indexOf('airCargo') === -1, sameIsland.join(','));
}

/* ---------- 7. the backend is still the one that decides ------------------- */
ok('createOrder still re-derives eligibility and refuses anything else',
  /eligibleMethods\.indexOf\(deliveryMethod\) === -1/.test(ordersSrc));
ok('and checkout.js says out loud that it is not the authority',
  /Orders\.gs decides again/.test(checkoutSrc));

let f = 0;
console.log('\n--- Delivery routes, including the Line Islands corridor ---');
for (const [s, n, e] of R) { if (s === 'FAIL') f++; console.log(`${s}  ${n}${e ? '  [' + e + ']' : ''}`); }
console.log(`\n${R.length - f}/${R.length} passed`);
process.exit(f ? 1 : 0);
