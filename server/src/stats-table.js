// Search + sort + page over an in-memory row array, shared by the Stats
// panel's two lazy tables (registrations, all-airlines).
//
// These used to be answered by shipping the whole table to the browser and
// letting it filter/sort/paginate client-side. That was fine at a few
// hundred rows and stopped being fine as it grew: the registrations
// response was already 88 KB two days into an install (~135 bytes a row,
// growing by every airframe the receiver ever sees), all of it held in the
// Pi's memory and the phone's just to display twenty rows of it. The
// pagination control was real, the paging wasn't.
//
// Pure and DOM-free on purpose, like csv.js and chart.js on the other side:
// everything here is testable under plain `node --test`.

export const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

// Missing data sorts last in *both* directions -- flipping the sort should
// reorder the rows that have a value, not promote a column of dashes to the
// top. Same convention list.js documents for the live aircraft table.
function isMissing(value) {
  return value === null || value === undefined || value === '';
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// pageSize 0 means "every matching row", which only the CSV export asks
// for: it downloads the current search/sort view in full, deliberately, and
// is a rare explicit click rather than something that happens on panel
// open. Anything else is clamped into a sane range.
function resolvePageSize(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PAGE_SIZE;
  if (parsed === 0) return 0;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

// spec:
//   searchFields: [(row) => string]      -- any match counts (case-insensitive substring)
//   sortFields:   { key: (row) => value } -- also the whitelist of accepted `sort` values
//   defaultSort:  { key, dir }
//
// A `sort` the spec doesn't know falls back to the default rather than
// erroring: the query string is a view preference, not a command, and a
// stale bookmark shouldn't produce a 400.
export function queryTable(rows, spec, params = {}) {
  const search = String(params.search ?? '').trim().toLowerCase();
  const filtered = search
    ? rows.filter((row) => spec.searchFields.some((field) => String(field(row) ?? '').toLowerCase().includes(search)))
    : rows.slice();

  const sort = Object.hasOwn(spec.sortFields, params.sort ?? '') ? params.sort : spec.defaultSort.key;
  const dir = params.dir === 'asc' || params.dir === 'desc' ? params.dir : spec.defaultSort.dir;
  const accessor = spec.sortFields[sort];
  const sign = dir === 'asc' ? 1 : -1;

  filtered.sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    const missing = (isMissing(av) ? 1 : 0) - (isMissing(bv) ? 1 : 0);
    if (missing !== 0) return missing;
    if (missing === 0 && isMissing(av)) return 0;
    return compareValues(av, bv) * sign;
  });

  const total = filtered.length;
  const pageSize = resolvePageSize(params.pageSize);
  if (pageSize === 0) {
    return { rows: filtered, total, page: 1, pageSize: 0, totalPages: 1, sort, dir };
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number.parseInt(params.page, 10);
  const page = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), totalPages);

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    totalPages,
    sort,
    dir,
  };
}
