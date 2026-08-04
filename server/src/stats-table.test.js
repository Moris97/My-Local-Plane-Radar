import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryTable, DEFAULT_PAGE_SIZE } from './stats-table.js';

const ROWS = [
  { name: 'Delta', code: 'DAL', count: 30 },
  { name: 'Alpha', code: 'ALP', count: 10 },
  { name: 'Charlie', code: 'CHA', count: 20 },
  { name: 'Bravo', code: null, count: 40 },
];

const SPEC = {
  searchFields: [(r) => r.name, (r) => r.code],
  sortFields: {
    name: (r) => r.name,
    code: (r) => r.code,
    count: (r) => r.count,
  },
  defaultSort: { key: 'count', dir: 'desc' },
};

function names(result) {
  return result.rows.map((r) => r.name);
}

test('falls back to the spec default sort when no sort is asked for', () => {
  const result = queryTable(ROWS, SPEC, {});
  assert.deepEqual(names(result), ['Bravo', 'Delta', 'Charlie', 'Alpha']);
  assert.equal(result.sort, 'count');
  assert.equal(result.dir, 'desc');
});

test('sorts numbers numerically, not as strings', () => {
  const rows = [{ name: 'a', count: 9 }, { name: 'b', count: 100 }, { name: 'c', count: 20 }];
  const result = queryTable(rows, SPEC, { sort: 'count', dir: 'asc' });
  assert.deepEqual(result.rows.map((r) => r.count), [9, 20, 100]);
});

// Same convention as list.js's live aircraft table: flipping the sort
// should reorder the rows that have data, not promote a column of blanks.
test('missing values sort last in both directions', () => {
  const asc = queryTable(ROWS, SPEC, { sort: 'code', dir: 'asc' });
  const desc = queryTable(ROWS, SPEC, { sort: 'code', dir: 'desc' });
  assert.equal(asc.rows[asc.rows.length - 1].name, 'Bravo');
  assert.equal(desc.rows[desc.rows.length - 1].name, 'Bravo');
});

test('search matches any search field, case-insensitively, and narrows the total', () => {
  const byName = queryTable(ROWS, SPEC, { search: 'delt' });
  assert.deepEqual(names(byName), ['Delta']);
  assert.equal(byName.total, 1);

  // Same row, found through the other field, and through a lowercase
  // needle against an uppercase code.
  const byCode = queryTable(ROWS, SPEC, { search: 'dal' });
  assert.deepEqual(names(byCode), ['Delta']);
});

test('pages the result and reports how many pages there are', () => {
  const result = queryTable(ROWS, SPEC, { sort: 'name', dir: 'asc', pageSize: 2, page: 2 });
  assert.deepEqual(names(result), ['Charlie', 'Delta']);
  assert.equal(result.total, 4);
  assert.equal(result.totalPages, 2);
  assert.equal(result.page, 2);
});

test('a page number past the end clamps to the last page instead of returning nothing', () => {
  const result = queryTable(ROWS, SPEC, { pageSize: 2, page: 99 });
  assert.equal(result.page, 2);
  assert.equal(result.rows.length, 2);
});

// The CSV export's own request: the current search/sort view in full,
// deliberately unpaged. Everything else is capped.
test('pageSize 0 returns every matching row', () => {
  const result = queryTable(ROWS, SPEC, { search: 'a', pageSize: 0 });
  assert.equal(result.rows.length, result.total);
  assert.equal(result.totalPages, 1);
});

test('an oversized pageSize is clamped, a missing one falls back to the default', () => {
  assert.equal(queryTable(ROWS, SPEC, { pageSize: 100000 }).pageSize <= 200, true);
  assert.equal(queryTable(ROWS, SPEC, {}).pageSize, DEFAULT_PAGE_SIZE);
});

// A query string is a view preference, not a command -- a stale bookmark or
// an old cached script asking for a column that no longer exists should get
// the default view, not an error.
test('an unknown sort key falls back to the default rather than erroring', () => {
  const result = queryTable(ROWS, SPEC, { sort: 'nonexistent', dir: 'asc' });
  assert.equal(result.sort, 'count');
});

test('does not mutate the caller\'s array', () => {
  const rows = [...ROWS];
  const before = rows.map((r) => r.name);
  queryTable(rows, SPEC, { sort: 'name', dir: 'asc' });
  assert.deepEqual(rows.map((r) => r.name), before);
});

test('an empty table is an empty page, not a crash', () => {
  const result = queryTable([], SPEC, { page: 3 });
  assert.deepEqual(result.rows, []);
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 1);
});
