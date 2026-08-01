// Snapshots that arrive over the WebSocket before the map has finished
// initialising, replayed in order once it has (app.js's map.on('load')).
//
// Pulled out of app.js purely so it can be unit-tested: app.js instantiates
// maplibregl.Map at module scope and therefore can't be imported under plain
// `node --test` -- the same reasoning that put aircraft-color.js and
// geo.js in their own modules.
//
// Bounded because "the map finishes initialising" is not guaranteed to ever
// happen: if the Map constructor throws -- which it does when a WebGL
// context can't be created, a documented real failure mode for this app --
// the socket keeps delivering a snapshot a second forever. Unbounded, that
// is a straightforward memory leak in exactly the situation where nothing
// is being rendered anyway.

// ~5 minutes of ticks. Generous enough that a genuinely slow start
// (fetching icon-types.json, the basemap style, a first daylight check)
// never loses anything, small enough that a map which never comes up stays
// harmless.
export const MAX_PENDING_MESSAGES = 300;

// Mutates `queue` in place and returns it, so callers can keep holding the
// same array reference (app.js drains it with splice(0)).
export function queuePendingMessage(queue, snapshot, maxLength = MAX_PENDING_MESSAGES) {
  // A full snapshot supersedes everything queued before it -- handleSnapshot
  // starts by calling resetAll() -- so keeping the older entries would just
  // mean replaying work that is about to be thrown away.
  if (snapshot.type === 'full') queue.length = 0;

  queue.push(snapshot);

  // Drop from the front rather than refusing new ones: the newest state is
  // the useful state. Losing an old delta only means a few aircraft stay
  // stale until their next update, which arrives within seconds for
  // anything actually flying.
  if (queue.length > maxLength) {
    queue.splice(0, queue.length - maxLength);
  }

  return queue;
}
