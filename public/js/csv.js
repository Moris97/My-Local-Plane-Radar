// Pure CSV building -- zero DOM dependency, same reasoning as chart.js/
// geo.js/aircraft-color.js: kept out of stats.js so it's testable under
// plain `node --test` instead of needing a browser.

// Quotes a field only when it actually needs it (contains a comma, quote,
// or newline), matching how spreadsheet apps themselves write CSV, rather
// than blanket-quoting every field.
function escapeField(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// `columns` is the same {key, label(), value(row, extra)} shape stats.js
// already uses to drive its on-screen tables -- value() is expected to
// mirror exactly what's rendered on screen (resolved airline names,
// locale-formatted dates), not the raw underlying field, so an exported
// file matches what the user was actually looking at. `extra` is passed
// through to every value() call (stats.js uses it for the airlines Map
// needed to resolve an ICAO code to a display name).
export function rowsToCsv(columns, rows, extra) {
  const header = columns.map((col) => escapeField(col.label())).join(',');
  const lines = rows.map((row) => columns.map((col) => escapeField(col.value(row, extra))).join(','));
  return [header, ...lines].join('\r\n');
}
