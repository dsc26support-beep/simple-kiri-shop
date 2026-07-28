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

function appendRowFromObject(sheet, obj) {
  var headers = getHeaders(sheet);
  var row = headers.map(function (h) {
    return (obj[h] !== undefined && obj[h] !== null) ? obj[h] : '';
  });
  sheet.appendRow(row);
}

/** Updates only the fields present in obj; every other column on that row is left untouched. */
function updateRowFromObject(sheet, rowNumber, obj) {
  var headers = getHeaders(sheet);
  var existing = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var newRow = headers.map(function (h, i) {
    return Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : existing[i];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([newRow]);
}
