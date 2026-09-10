const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Code.gs', 'utf8');
const CC = ['Token','Email','Code','Purpose','Name','Phone','CreatedAt','ExpiresAt','Attempts'];

function run(headers, rows) {
  const logged = [];
  const sandbox = {
    Logger: { log: m => logged.push(m) },
    getSheet: () => ({}),
    getHeaders: () => headers,
    sheetToObjects: () => rows,
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;__r = debugCustomerCodes();', sandbox);
  return { report: sandbox.__r, logged };
}

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); } };
const TOK = 'a'.repeat(72);
const future = new Date(Date.now() + 6e5).toISOString();

// healthy row
let r = run(CC, [{ __row: 2, Token: TOK, Email: 'a@b.com', Code: '123456', Purpose: 'signup', Attempts: 0, ExpiresAt: future }]);
t('reports headers match', /Headers match: true/.test(r.report), r.report);
t('masks token as prefix + length', /Token=aaaaaaaa\.\.\.\(len 72\)/.test(r.report), r.report);
t('never prints the full token', r.report.indexOf(TOK) === -1);
t('shows Purpose quoted', /Purpose="signup"/.test(r.report), r.report);
t('healthy row not expired', /expired=false/.test(r.report));
t('logs the report', r.logged.length === 1 && r.logged[0] === r.report);

// the invisible-character case this exists to catch
r = run(CC, [{ __row: 2, Token: TOK, Email: 'a@b.com', Code: '123456', Purpose: 'signup ', Attempts: 0, ExpiresAt: future }]);
t('reveals a trailing space in a VALUE', /Purpose="signup "/.test(r.report), r.report);

// blank Purpose (the broken-header symptom)
r = run(CC, [{ __row: 2, Token: TOK, Email: '', Code: '', Purpose: '', Attempts: 0, ExpiresAt: '' }]);
t('blank Purpose shown as empty string', /Purpose=""/.test(r.report), r.report);
t('unparseable ExpiresAt flagged', /expired=UNPARSEABLE/.test(r.report), r.report);

// broken headers
r = run(['Token','Email ','Code','Purpose ','Name','Phone','CreatedAt','ExpiresAt','Attempts'], []);
t('reports headers do NOT match', /Headers match: false/.test(r.report));
t('prints actual headers verbatim', /"Email "/.test(r.report) && /"Purpose "/.test(r.report), r.report);
t('no rows -> guidance line', /no rows - request a code/.test(r.report));

// caps at 5 newest
r = run(CC, Array.from({length: 9}, (_, i) => ({ __row: i + 2, Token: TOK, Email: 'a@b', Code: '1', Purpose: 'signup', Attempts: 0, ExpiresAt: future })));
t('prints only the 5 newest rows', (r.report.match(/^row /gm) || []).length === 5, String((r.report.match(/^row /gm) || []).length));
t('newest rows are the last ones', /row 10/.test(r.report) && !/row 2 /.test(r.report));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
