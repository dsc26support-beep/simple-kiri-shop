/** Header adverts (Oct 2026) on the REAL backend sources (gas-harness). */
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);
const J = (x) => JSON.stringify(x).slice(0, 300);
const box = makeBox({ Owners: [['OwnerId', 'StoreSlug', 'StoreName', 'Status', 'Email'], ['own_a', 'adm', 'Admin', 'active', 'admin@x.test'], ['own_s', 'bong', 'Bong', 'active', 's@x.test']] });
box.__props.ADMIN_EMAILS = 'admin@x.test';
const [A, S] = box.__sheets.Owners.objects();
const pub = () => { Object.keys(box.__cache).forEach((k) => delete box.__cache[k]); return box.actionGetHeaderAds(); };
const save = (o, who) => box.actionAdminSaveHeaderAd(who || A, o);
const today = box.headerAdToday();
const day = (n) => box.headerAdToday(Date.now() + n * 86400000);

ok('no tab yet: no adverts (the built-in lines show)', pub().ok && pub().ads.length === 0);
let r = save({ text: '20% off rice at Teaube', link: 'store.html?store=tea' });
ok('admin adds an advert', r.ok && /^ad_/.test(r.adId), J(r));
const first = r.adId;
ok('it shows straight away (cache cleared)', pub().ads.map((a) => a.text).join() === '20% off rice at Teaube');
save({ text: 'Solar sale', link: 'https://example.com/solar' });
save({ text: 'Starts tomorrow', link: 'index.html', startDate: day(1) });
save({ text: 'Ended yesterday', link: 'index.html', endDate: day(-1) });
save({ text: 'Runs today only', link: 'index.html', startDate: today, endDate: today });
save({ text: 'Switched off', link: 'index.html', status: 'off' });
ok('dates and on/off decide what shows (start/end inclusive, Kiribati days)', pub().ads.map((a) => a.text).join('|') === '20% off rice at Teaube|Solar sale|Runs today only', J(pub().ads));
ok('shoppers get only text and link', Object.keys(pub().ads[0]).sort().join() === 'link,text');

const bad = (o, re, n) => { const x = save(Object.assign({ text: 'x', link: 'index.html' }, o)); ok(n, !x.ok && re.test(x.error), J(x)); };
bad({ link: 'javascript:alert(1)' }, /https/, 'a javascript: link is refused');
bad({ link: 'http://example.com' }, /https/, 'plain http is refused');
bad({ link: 'data:text/html,x' }, /https/, 'a data: link is refused');
bad({ link: 'evil.html' }, /https/, 'an unknown page is refused');
bad({ text: '' }, /Write/, 'empty text is refused');
bad({ text: 'x'.repeat(81) }, /80 characters/, 'over 80 characters is refused');
bad({ text: '<img src=x>' }, /cannot contain/, 'markup in the text is refused');
bad({ startDate: day(3), endDate: day(1) }, /before the start/, 'end before start is refused');
ok('product and category links are allowed', save({ text: 'Rice', link: 'product.html?store=bong&product=p1' }).ok && save({ text: 'Solar', link: 'categories.html?category=solar' }).ok);

r = save({ text: 'Mine', link: 'index.html' }, S);
ok('a seller cannot add an advert', !r.ok && r.error === 'Not authorized');
ok('...or list, reorder or delete them', !box.actionAdminListHeaderAds(S).ok && !box.actionAdminReorderHeaderAds(S, { order: [] }).ok && !box.actionAdminDeleteHeaderAd(S, { adId: first }).ok);

let list = box.actionAdminListHeaderAds(A);
ok('admin list shows every advert with whether it is running', list.ok && list.ads.length === 8 && list.ads.find((a) => a.text === 'Starts tomorrow').running === false
  && list.ads.find((a) => a.text === 'Solar sale').running === true, J(list.ads.map((a) => [a.text, a.running])));
const ids = list.ads.map((a) => a.adId);
const solar = list.ads.find((a) => a.text === 'Solar sale').adId;
r = box.actionAdminReorderHeaderAds(A, { order: [solar].concat(ids.filter((x) => x !== solar)) });
ok('reorder: Solar sale now shows first', r.ok && pub().ads[0].text === 'Solar sale');
ok('reorder with a stale list is refused', !box.actionAdminReorderHeaderAds(A, { order: ids.slice(1) }).ok);
r = save({ adId: first, text: '25% off rice at Teaube', link: 'store.html?store=tea' });
ok('edit keeps its place and id', r.ok && r.adId === first && pub().ads.some((a) => a.text === '25% off rice at Teaube'));
r = box.actionAdminDeleteHeaderAd(A, { adId: solar });
ok('delete removes it from shoppers and from the admin list (row kept, marked deleted)', r.ok && !pub().ads.some((a) => a.text === 'Solar sale')
  && box.actionAdminListHeaderAds(A).ads.length === 7 && box.__sheets.HeaderAds.objects().some((x) => x.AdId === solar && x.Status === 'deleted'));
ok('dates typed into the sheet by hand (read back as Date) still work', box.headerAdDay(new Date(Date.UTC(2026, 9, 11, 12))) === '2026-10-12'
  && box.headerAdDay('2026-10-12') === '2026-10-12' && box.headerAdDay('soon') === '');

let fails = 0;
console.log('\n--- header adverts ---');
for (const [s, n, x] of R) { if (s === 'FAIL') fails++; console.log(`${s}  ${n}${x !== '' ? '  [' + x + ']' : ''}`); }
console.log(`\n${R.length - fails}/${R.length} passed`);
process.exit(fails ? 1 : 0);
