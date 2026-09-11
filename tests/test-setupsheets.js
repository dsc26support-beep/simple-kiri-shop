const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('/home/user/simple-kiri-shop/apps-script/Code.gs', 'utf8');

function makeSheet(rows) {
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: (r, c, nr, nc) => ({
      getValues: () => [((rows[r - 1] || []).slice(c - 1, c - 1 + nc))],
      setValues: (vals) => {
        while (rows.length < r) rows.push([]);
        vals[0].forEach((v, i) => { rows[r - 1][c - 1 + i] = v; });
      },
    }),
  };
}

function run(tabs) {
  const sheets = {};
  Object.keys(tabs).forEach(n => { sheets[n] = makeSheet(tabs[n].map(r => r.slice())); });
  const logged = [];
  const sandbox = {
    SpreadsheetApp: { getActive: () => ({
      getSheetByName: (n) => sheets[n] || null,
      insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; },
    })},
    Logger: { log: (m) => logged.push(m) },
    getHeaders: (sh) => { const lc = sh.getLastColumn(); return lc === 0 ? [] : sh.getRange(1, 1, 1, lc).getValues()[0]; },
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;__r = setupSheets();', sandbox);
  return { report: sandbox.__r, sheets, logged };
}

const CC = ['Token','Email','Code','Purpose','Name','Phone','CreatedAt','ExpiresAt','Attempts'];
const ALL = {
  Customers: [['CustomerId','Name','Email','Phone','EmailVerified','CreatedAt','UpdatedAt']],
  CustomerSessions: [['Token','CustomerId','CreatedAt','ExpiresAt']],
  CustomerCodes: [CC.slice()],
  Featured: [['FeaturedId','Type','RefId','SortOrder','CreatedAt']],
};
const clone = (o) => JSON.parse(JSON.stringify(o));

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (e ? '  [' + e + ']' : '')); } };

// 1: everything already correct -> OK, nothing rewritten
let r = run(clone(ALL));
t('all correct -> every tab reported OK', (r.report.match(/OK        /g) || []).length === 4, r.report);
t('all correct -> headers untouched', r.sheets.CustomerCodes.rows[0].join() === CC.join());

// 2: the real-world break - 7 headers carry a trailing space
let broken = clone(ALL);
broken.CustomerCodes[0] = ['Token','Email ','Code ','Purpose ','Name ','Phone ','CreatedAt ','ExpiresAt ','Attempts'];
broken.CustomerCodes.push(['tok-1','','','','','','','', 0]);   // junk row written while broken
r = run(broken);
t('broken headers -> REPAIRED', /REPAIRED  CustomerCodes/.test(r.report), r.report);
t('broken headers -> row 1 now exact', r.sheets.CustomerCodes.rows[0].join() === CC.join(), r.sheets.CustomerCodes.rows[0].join());
const wasLine = r.report.split('\n').filter(l => /was:/.test(l))[0] || '';
t('repair logs the previous headers verbatim (spaces intact)',
  wasLine.indexOf('Token | Email  | Code  | Purpose ') !== -1, JSON.stringify(wasLine));
t('repair warns that data rows exist', /already has data rows/.test(r.report));
t('NEVER writes below row 1', r.sheets.CustomerCodes.rows[1].join() === ['tok-1','','','','','','','',0].join(), r.sheets.CustomerCodes.rows[1].join());
t('other tabs still OK', (r.report.match(/OK        /g) || []).length === 3);

// 3: missing tab -> created
let missing = clone(ALL); delete missing.Featured;
r = run(missing);
t('missing tab -> CREATED', /CREATED   Featured/.test(r.report), r.report);
t('created tab has exact headers', r.sheets.Featured.rows[0].join() === 'FeaturedId,Type,RefId,SortOrder,CreatedAt');

// 4: correct names in a different order -> left alone (Db.gs matches by name)
let reordered = clone(ALL);
reordered.CustomerCodes[0] = ['Attempts','Token','Email','Code','Purpose','Name','Phone','CreatedAt','ExpiresAt'];
reordered.CustomerCodes.push(['0','tok-9','a@b.com','111111','signup','N','P','c','e']);
r = run(reordered);
t('reordered-but-valid headers left untouched',
  r.sheets.CustomerCodes.rows[0][0] === 'Attempts' && /OK        CustomerCodes/.test(r.report), r.report);
t('reordered tab data preserved', r.sheets.CustomerCodes.rows[1][1] === 'tok-9');

// 5: empty existing tab -> repaired from (empty)
let empty = clone(ALL); empty.CustomerSessions = [];
r = run(empty);
t('empty tab -> repaired, logged as (empty)', /REPAIRED  CustomerSessions[\s\S]*was: \(empty\)/.test(r.report), r.report);

// 6: report is logged
t('report written to Logger', r.logged.length === 1 && r.logged[0] === r.report);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
