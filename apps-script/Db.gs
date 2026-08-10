/**
 * Generic header-mapped access to the bound Google Sheet.
 * Every tab's row 1 is treated as field names, so scripts never hardcode
 * column numbers and the schema stays editable from the Sheet UI.
 */

function getSheet(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Sheet tab not found: ' + name);
  return sheet;
}

function getHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

/** Reads every data row into an array of {header: value} objects, plus a __row (1-indexed sheet row) for updates. */
function sheetToObjects(sheet) {
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || headers.length === 0) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[r][c];
    }
    obj.__row = r + 2;
    out.push(obj);
  }
  return out;
}

function findRowById(sheet, idField, idValue) {
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idField]) === String(idValue)) return rows[i];
  }
  return null;
}

/**
 * Same shape as findRowById, but for secret fields (Sessions.Token,
 * TwoFACodes.Token) where match timing must not leak how many leading
 * characters a guess got right. Deliberately NOT a change to findRowById -
 * that generic helper serves ~15+ non-secret id lookups elsewhere
 * (OwnerId, ProductId, VariantId, ConversationId, StoreSlug, ...) where
 * constant-time comparison buys nothing and would just be unnecessary
 * overhead on every plain lookup. Always runs a full constantTimeEquals
 * per row rather than short-circuiting on an early length mismatch -
 * an early-exit "optimization" here would reintroduce exactly the timing
 * signal this function exists to close.
 */
function findRowBySecret(sheet, idField, idValue) {
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (constantTimeEquals(String(rows[i][idField]), String(idValue))) return rows[i];
  }
  return null;
}

/**
 * Sheets (like Excel) interprets a cell value starting with =, +, -, or @ as
 * a formula - including when written via Range.setValue()/setValues() from
 * Apps Script, not just typed by hand. Left alone, that turns every free-text
 * field this app writes from untrusted input (order notes, customer/chat
 * names, chat messages, product descriptions, ...) into a formula-injection
 * vector against whoever opens the Sheet later (e.g. IMPORTXML exfiltrating
 * adjacent cells, or a HYPERLINK(...) phishing link). Prefixing with a
 * leading apostrophe is the same "force text" marker Sheets itself uses -
 * the stored/displayed value is unchanged, it just never evaluates as a
 * formula. Applied once here so every write through the app's one
 * data-access chokepoint is covered, with no per-call-site sanitization to
 * remember.
 */
function sanitizeForSheetCell(value) {
  if (typeof value !== 'string') return value;
  if (/^[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function appendRowFromObject(sheet, obj) {
  var headers = getHeaders(sheet);
  var row = headers.map(function (h) {
    return (obj[h] !== undefined && obj[h] !== null) ? sanitizeForSheetCell(obj[h]) : '';
  });
  sheet.appendRow(row);
}

/** Updates only the fields present in obj; every other column on that row is left untouched. */
function updateRowFromObject(sheet, rowNumber, obj) {
  var headers = getHeaders(sheet);
  var existing = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var newRow = headers.map(function (h, i) {
    return Object.prototype.hasOwnProperty.call(obj, h) ? sanitizeForSheetCell(obj[h]) : existing[i];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([newRow]);
}
