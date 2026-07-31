import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsToCsv } from './csv.js';

const COLUMNS = [
  { key: 'a', label: () => 'A', value: (row) => row.a },
  { key: 'b', label: () => 'B', value: (row) => row.b },
];

test('rowsToCsv writes a header row from label() plus one line per row', () => {
  const csv = rowsToCsv(COLUMNS, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  assert.equal(csv, 'A,B\r\n1,2\r\n3,4');
});

test('rowsToCsv quotes a field containing a comma', () => {
  const csv = rowsToCsv(COLUMNS, [{ a: 'LOT, Polish Airlines', b: '1' }]);
  assert.equal(csv, 'A,B\r\n"LOT, Polish Airlines",1');
});

test('rowsToCsv quotes and doubles internal quotes in a field containing a quote', () => {
  const csv = rowsToCsv(COLUMNS, [{ a: 'The "Spirit"', b: '1' }]);
  assert.equal(csv, 'A,B\r\n"The ""Spirit""",1');
});

test('rowsToCsv quotes a field containing a newline', () => {
  const csv = rowsToCsv(COLUMNS, [{ a: 'line1\nline2', b: '1' }]);
  assert.equal(csv, 'A,B\r\n"line1\nline2",1');
});

test('rowsToCsv leaves a plain field unquoted', () => {
  const csv = rowsToCsv(COLUMNS, [{ a: 'SP-LRA', b: '5' }]);
  assert.equal(csv, 'A,B\r\nSP-LRA,5');
});

test('rowsToCsv renders a null/undefined value as an empty field', () => {
  const csv = rowsToCsv(COLUMNS, [{ a: null, b: undefined }]);
  assert.equal(csv, 'A,B\r\n,');
});

test('rowsToCsv passes the extra argument through to every value()', () => {
  const columns = [{ key: 'x', label: () => 'X', value: (row, extra) => `${row.x}-${extra}` }];
  const csv = rowsToCsv(columns, [{ x: 'a' }, { x: 'b' }], 'suffix');
  assert.equal(csv, 'X\r\na-suffix\r\nb-suffix');
});

test('rowsToCsv with no rows is just the header', () => {
  const csv = rowsToCsv(COLUMNS, []);
  assert.equal(csv, 'A,B');
});
