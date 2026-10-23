/**
 * Passwords.gs on the REAL source (gas-harness): PBKDF2-HMAC-SHA256 matches
 * Node's crypto.pbkdf2Sync and the RFC 7914 test vector; stored hashes verify,
 * carry their round count, upgrade from the legacy single SHA-256, and never
 * contain the password.
 */
const crypto = require('crypto');
const { makeBox } = require('./lib/gas-harness.js');
const R = []; const ok = (n, c, e) => R.push([c ? 'PASS' : 'FAIL', n, e === undefined ? '' : e]);

const box = makeBox({}, { guest: true });
box.__props.PEPPER = 'test-pepper';
const bytes = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => (b > 127 ? b - 256 : b));
const hex = (arr) => Buffer.from(arr.map((b) => b & 255)).toString('hex');

// RFC 7914 section 11: PBKDF2-HMAC-SHA256 (P="passwd", S="salt", c=1) - first 32 bytes.
ok('RFC 7914 vector (c=1)', hex(box.pbkdf2Sha256_(bytes('passwd'), bytes('salt'), 1)) ===
  '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
// RFC 7914: P="Password", S="NaCl", c=80000.
ok('RFC 7914 vector (c=80000)', hex(box.pbkdf2Sha256_(bytes('Password'), bytes('NaCl'), 80000)) ===
  '4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56');
for (const [p, s, c] of [['coconut99', 'abc', 2], ['päss wörd', 'x'.repeat(40), 1000], ['', 'salt', 3]]) {
  ok(`matches Node pbkdf2Sync (${c} rounds)`, hex(box.pbkdf2Sha256_(bytes(p), bytes(s), c)) === crypto.pbkdf2Sync(p, s, c, 32, 'sha256').toString('hex'));
}

const h = box.hashPasswordV2('coconut99');
ok('stored form is pbkdf2$sha256$rounds$salt$hash', /^pbkdf2\$sha256\$4000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(h), h);
ok('the stored hash never contains the password', !h.includes('coconut99'));
ok('right password verifies', box.verifyPassword('coconut99', h, '') === true);
ok('wrong password does not', box.verifyPassword('coconut98', h, '') === false);
ok('two hashes of one password differ (random salt)', box.hashPasswordV2('coconut99') !== h);
ok('a changed pepper no longer verifies (sheet alone is not enough)', (() => {
  box.__props.PEPPER = 'other'; const r = box.verifyPassword('coconut99', h, ''); box.__props.PEPPER = 'test-pepper'; return r === false;
})());
ok('a forged round count outside the limits is refused', box.verifyPassword('coconut99', h.replace('$4000$', '$1$'), '') === false);
ok('blank stored hash never verifies', box.verifyPassword('', '', '') === false);

const legacySalt = 'salt123';
const legacy = box.hashPassword('oldpass1', legacySalt);
ok('legacy SHA-256 store hash still verifies', box.verifyPassword('oldpass1', legacy, legacySalt) === true);
ok('...wrong password on it does not', box.verifyPassword('oldpass2', legacy, legacySalt) === false);
ok('legacy hash needs a rehash', box.passwordNeedsRehash(legacy) === true);
ok('a current PBKDF2 hash does not', box.passwordNeedsRehash(h) === false);
box.__props.PASSWORD_ITERATIONS = '8000';
ok('raising PASSWORD_ITERATIONS marks older hashes for upgrade', box.passwordNeedsRehash(h) === true);
box.__props.PASSWORD_ITERATIONS = '5';
ok('PASSWORD_ITERATIONS below the floor is clamped to 1000', box.passwordIterations() === 1000);
delete box.__props.PASSWORD_ITERATIONS;

ok('policy: 7 characters refused', !!box.passwordPolicyError('1234567'));
ok('policy: 8 characters fine', box.passwordPolicyError('12345678') === '');
ok('policy: over 200 refused', !!box.passwordPolicyError('x'.repeat(201)));
ok('burnPasswordCheck is always false', box.burnPasswordCheck('anything') === false);

const codes = new Set(); for (let i = 0; i < 200; i++) codes.add(box.generate6DigitCode());
ok('6-digit codes are 6 digits and varied', [...codes].every((c) => /^\d{6}$/.test(c)) && codes.size > 190);

R.forEach((r) => console.log(r[0], r[1], r[2]));
const failed = R.filter((r) => r[0] === 'FAIL').length;
console.log(`${R.length - failed}/${R.length} passed`);
process.exit(failed ? 1 : 0);
