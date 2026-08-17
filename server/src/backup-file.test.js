import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buffer as readAll } from 'node:stream/consumers';

import { looksGzipped, decodeBackupFile, gzipChunkStream, BackupFileError } from './backup-file.js';

test('looksGzipped recognises the gzip magic bytes and nothing else', () => {
  assert.equal(looksGzipped(gzipSync('{}')), true);
  assert.equal(looksGzipped(Buffer.from('{"version":2}')), false);
  assert.equal(looksGzipped(Buffer.from([0x1f])), false, 'a one-byte buffer must not read past its end');
  assert.equal(looksGzipped(Buffer.alloc(0)), false);
  assert.equal(looksGzipped('not a buffer'), false);
});

test('a gzipped payload round-trips back to the original object', () => {
  const payload = { version: 2, config: { homeLat: '50' }, tables: { seenFlights: [{ flight: 'LOT1' }] } };
  const decoded = decodeBackupFile(gzipSync(JSON.stringify(payload)));
  assert.deepEqual(decoded, payload);
});

test('a plain uncompressed JSON buffer is still accepted -- that is what every pre-v2 backup looks like', () => {
  const decoded = decodeBackupFile(Buffer.from(JSON.stringify({ version: 1, config: { port: '1090' } })));
  assert.deepEqual(decoded, { version: 1, config: { port: '1090' } });
});

test('garbage is rejected with a typed error rather than a raw parser crash', () => {
  assert.throws(() => decodeBackupFile(Buffer.from('this is not JSON at all')), BackupFileError);
  assert.throws(() => decodeBackupFile(Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02])), BackupFileError);
  assert.throws(() => decodeBackupFile('not a buffer'), BackupFileError);
});

test('a gzip bomb is stopped by maxOutputLength instead of exhausting the heap', () => {
  // ~1 MB of a single repeated character compresses to about a kilobyte;
  // the cap is set well below it here so the guard is what fires.
  const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0x41));
  assert.ok(bomb.length < 8 * 1024, 'the fixture really is a compression bomb in miniature');
  assert.throws(() => decodeBackupFile(bomb, { maxBytes: 4096 }), BackupFileError);
});

test('a truncated gzip fails to decode rather than importing as a half-complete backup', () => {
  // This is the property that makes an export interrupted mid-stream safe:
  // gzip's trailing CRC32/ISIZE means the loss is detectable, where a bare
  // truncated JSON stream might not be.
  const full = gzipSync(JSON.stringify({ version: 2, config: {}, tables: {} }));
  const truncated = full.subarray(0, full.length - 4);
  assert.throws(() => decodeBackupFile(truncated), BackupFileError);
});

test('gzipChunkStream compresses an iterable of fragments into a decodable file', async () => {
  const chunks = ['{"version":2', ',"config":{"homeLat":"50"}', ',"tables":{}}'];
  const bytes = await readAll(gzipChunkStream(chunks));

  assert.equal(looksGzipped(bytes), true);
  assert.deepEqual(decodeBackupFile(bytes), { version: 2, config: { homeLat: '50' }, tables: {} });
});

test('gzipChunkStream survives enough fragments to hit backpressure without leaking listeners', async () => {
  // Big enough to fill zlib's write buffer several times over, which is the
  // path where the drain/error listener pair has to clean itself up.
  const rows = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ hex: `a${i}`, firstSeenAt: i }));
  function* chunks() {
    yield '{"version":2,"config":{},"tables":{"seenAircraft":[';
    for (let i = 0; i < rows.length; i += 1) yield i === 0 ? rows[i] : `,${rows[i]}`;
    yield ']}}';
  }

  const stream = gzipChunkStream(chunks());
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    const decoded = decodeBackupFile(await readAll(stream));
    assert.equal(decoded.tables.seenAircraft.length, 5000);
    assert.equal(decoded.tables.seenAircraft[4999].hex, 'a4999');
  } finally {
    process.off('warning', onWarning);
  }
  assert.equal(
    warnings.some((w) => w.name === 'MaxListenersExceededWarning'),
    false,
    'the drain/error listener pair must not accumulate across backpressure cycles',
  );
});

test('a failure part-way through the chunk iterable destroys the stream instead of ending it cleanly', async () => {
  function* chunks() {
    yield '{"version":2';
    throw new Error('table read blew up');
  }

  await assert.rejects(readAll(gzipChunkStream(chunks())), /table read blew up/);
});
