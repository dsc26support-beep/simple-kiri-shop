const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Code.gs', 'utf8');

function run(sheets, opts) {
  const sandbox = {
    ok: (d) => Object.assign({ ok: true }, d),
    fail: (e) => ({ ok: false, error: e }),
    jsonOut: (o) => o,
    getSheet: (n) => { if (!(n in sheets)) throw new Error('Sheet tab not found: ' + n); return n; },
    getHeaders: (n) => sheets[n],
    getAdminEmails: () => opts.admin ? ['a@b.com'] : [],
  };
  if (opts.files) FILE_PROBES.forEach((fn) => { sandbox[fn] = () => {}; });
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;__r = actionCheckSetup();', sandbox);
  return sandbox.__r;
}

// Derived from Code.gs rather than duplicated. A hardcoded copy silently went
// stale the moment REQUIRED_TABS gained Reviews, and the suite then failed for
// reasons that had nothing to do with the code under test.
const REQUIRED_TABS = (() => {
  const box = {};
  vm.createContext(box);
  vm.runInContext(code.match(/var REQUIRED_TABS = \{[\s\S]*?\n\};/)[0] + '\n;__t = REQUIRED_TABS;', box);
  return box.__t;
})();
const APP_VERSION = code.match(/var APP_VERSION = '([^']+)'/)[1];
const GOOD = JSON.parse(JSON.stringify(REQUIRED_TABS));

// One probe per hand-pasted .gs file, kept in step with actionCheckSetup.
const FILE_PROBES = ['actionRegisterCustomer', 'actionGetTips', 'actionSubmitReview'];

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra ? '  [' + extra + ']' : '')); } };

// 1: everything correct
let r = run(JSON.parse(JSON.stringify(GOOD)), { admin: true, files: true });
t('clean setup -> setupOk true, no problems', r.setupOk === true && r.problems.length === 0, JSON.stringify(r.problems));
t('clean setup reports the current APP_VERSION', r.version === APP_VERSION, r.version);
t('no row data leaked (only expected keys)',
  Object.keys(r).sort().join(',') === 'adminEmailsSet,missingFiles,ok,problems,setupOk,tabs,version', Object.keys(r).join(','));

// 2: the actual bug - trailing space on Purpose
let bad = JSON.parse(JSON.stringify(GOOD));
bad.CustomerCodes[3] = 'Purpose ';
r = run(bad, { admin: true, files: true });
t('trailing-space Purpose -> flagged as missing', /CustomerCodes is missing header\(s\): Purpose/.test(r.problems.join('|')), r.problems.join('|'));
t('trailing-space Purpose -> flagged as stray space', /stray spaces: Purpose /.test(r.problems.join('|')), r.problems.join('|'));
t('trailing-space -> setupOk false', r.setupOk === false);

// 3: misspelled header
bad = JSON.parse(JSON.stringify(GOOD)); bad.CustomerCodes[3] = 'Purposes';
r = run(bad, { admin: true, files: true });
t('misspelled header -> missing Purpose + unexpected Purposes',
  /missing header\(s\): Purpose/.test(r.problems.join('|')) &&
  r.tabs.find(x => x.tab === 'CustomerCodes').unexpectedHeaders.join() === 'Purposes',
  r.problems.join('|'));

// 4: missing tab does not abort the rest
bad = JSON.parse(JSON.stringify(GOOD)); delete bad.Featured;
r = run(bad, { admin: true, files: true });
t('missing tab reported', r.problems.some(p => p === 'Missing sheet tab: Featured'), r.problems.join('|'));
t('missing tab still reports every required tab', r.tabs.length === Object.keys(REQUIRED_TABS).length, `${r.tabs.length} of ${Object.keys(REQUIRED_TABS).length}`);
t('missing tab -> exists false', r.tabs.find(x => x.tab === 'Featured').exists === false);

// 5: empty .gs files detected (this session's actual failure)
r = run(JSON.parse(JSON.stringify(GOOD)), { admin: true, files: false });
t('every empty .gs file detected', r.missingFiles.length === FILE_PROBES.length, r.missingFiles.join(','));

// 6: ADMIN_EMAILS unset
r = run(JSON.parse(JSON.stringify(GOOD)), { admin: false, files: true });
t('ADMIN_EMAILS unset reported', r.adminEmailsSet === false && r.problems.some(p => /ADMIN_EMAILS/.test(p)));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
