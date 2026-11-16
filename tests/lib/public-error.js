// The real publicErrorMessage (and its pattern) from apps-script/Utils.gs, as
// source text, for tests that load only some backend functions into a sandbox.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../apps-script/Utils.gs'), 'utf8');
const pattern = src.match(/^var INTERNAL_ERROR_PATTERN = .*;$/m);
const fn = src.match(/function publicErrorMessage\b[\s\S]*?\n}/);
if (!pattern || !fn) throw new Error('publicErrorMessage not found in Utils.gs');
module.exports = pattern[0] + '\n' + fn[0] + '\n';
