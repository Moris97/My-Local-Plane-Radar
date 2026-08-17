import { createGzip, gunzipSync } from 'node:zlib';

// The .mlpr container: gzip-compressed UTF-8 JSON. Everything about the
// *contents* lives in config-backup.js -- this module only knows how to get
// bytes in and out, so it has no database and no Fastify dependency and can
// be unit-tested on its own.
//
// Why gzip at all, beyond size: a gzip member carries a CRC32 and an
// uncompressed-length trailer, so a backup truncated by a crash mid-export
// fails to decode loudly at restore time instead of importing as a silently
// half-complete file. A bare JSON stream has no such check -- a truncated
// one either fails to parse (if you're lucky) or, for an array that happens
// to end at a plausible boundary, doesn't.

// Decompressed-JSON ceiling. This is not really about disk or transfer size
// -- it is about the object graph JSON.parse builds, which runs around 1.5x
// the JSON text. 64 MiB of JSON is therefore roughly 95 MB of heap, already
// uncomfortable against the systemd unit's --max-old-space-size=192. It is
// also the gzip-bomb guard: without a cap, a 100 KB crafted file expands to
// gigabytes and the Pi dies.
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

// Level 6 is zlib's default and measurably the right point on this data:
// on a 100k-row sample, level 1 gave 1.69 MB in 46 ms, level 6 gave 1.60 MB
// in 98 ms, level 9 gave 1.57 MB in 401 ms. Level 9 pays 4x the CPU (on a
// Pi 3, rather more) for 2% -- not a trade worth making on this hardware.
const GZIP_LEVEL = 6;

export function looksGzipped(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export class BackupFileError extends Error {}

// Accepts both container formats on purpose: a v2 .mlpr (gzipped), and a
// plain uncompressed JSON buffer, which is what every backup taken before
// this feature existed looks like (mlpr-backup-YYYY-MM-DD.json). Sniffing
// the gzip magic rather than trusting the filename means a file renamed on
// its way between machines still restores.
export function decodeBackupFile(buffer, { maxBytes = MAX_DECOMPRESSED_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new BackupFileError('Backup file must be raw bytes');

  let text;
  if (looksGzipped(buffer)) {
    try {
      text = gunzipSync(buffer, { maxOutputLength: maxBytes }).toString('utf8');
    } catch (err) {
      throw new BackupFileError(`Could not decompress the backup file: ${err.message}`);
    }
  } else {
    text = buffer.toString('utf8');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new BackupFileError('Backup file is not valid JSON');
  }
}

// Compresses an iterable of JSON string fragments (config-backup.js's
// backupChunks generator) into a readable stream Fastify can send straight
// to the client.
//
// createGzip, not gzipSync, and the reason is event-loop responsiveness --
// NOT memory, which is the intuitive guess and is wrong. Measured on a
// ~203k-row install (x86; a Pi 3 is several times slower):
//
//   streamed:  543 ms, a 10 ms heartbeat timer fired 33 times during the
//              export, worst single stall 59 ms
//   buffered:  382 ms -- faster overall, but the same heartbeat fired
//              ZERO times: the loop was blocked end to end
//
// So the buffered variant would freeze the aircraft poll and every
// connected WebSocket for the whole export (~1.5-2 s on a Pi 3), which is
// exactly what this app must not do. Peak heap is actually slightly
// *higher* streamed (~51 MB vs ~34 MB under the unit's
// --max-old-space-size=192), because the async pump gives V8 fewer good GC
// points -- V8 regulates it fine, the export still completes under a 64 MB
// cap, so this is a trade of a little memory for a live event loop.
export function gzipChunkStream(chunks) {
  const gzip = createGzip({ level: GZIP_LEVEL });

  // Floating on purpose -- the pump owns the stream's lifetime from here,
  // and any failure is reported by destroying the stream (the client then
  // sees a truncated response, which the CRC above makes detectable).
  (async () => {
    try {
      for (const chunk of chunks) {
        if (!gzip.write(chunk)) {
          // Both listeners are removed either way -- a plain pair of
          // once() handlers would leave the loser attached on every drain,
          // which over a multi-megabyte export accumulates into a
          // MaxListenersExceededWarning.
          await new Promise((resolve, reject) => {
            const onDrain = () => {
              gzip.off('error', onError);
              resolve();
            };
            const onError = (err) => {
              gzip.off('drain', onDrain);
              reject(err);
            };
            gzip.once('drain', onDrain);
            gzip.once('error', onError);
          });
        }
      }
      gzip.end();
    } catch (err) {
      gzip.destroy(err);
    }
  })();

  return gzip;
}
