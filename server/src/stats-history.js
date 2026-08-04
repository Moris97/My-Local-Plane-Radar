// Both in-memory series below are *rolling 24h windows*, pruned by age
// rather than by a raw sample count, plus an hour of slack so a bucket
// right at the 24h edge is still complete. They are what the Stats view's
// 24h charts read; nothing here is a day-scoped ("today") series -- only
// dailyAccumulator is, and it keeps its own UTC-midnight rollover.
const WINDOW_MS = 25 * 60 * 60 * 1000;
// Safety net only -- age pruning is the real bound. Sized well above the
// ~1440 entries a minute-deduped 25h window can actually hold.
const MAX_SAMPLES = 2 * 25 * 60;
// "Averaged from the best few %" (the user's own phrasing) -- not a
// percentile cutoff value, the mean of the top slice of the day's per-
// minute best-range samples. Robust against a single noisy MLAT spike
// (it's still just one sample among ~1440/day) while still reflecting
// genuinely good reception, not just the single best instant.
const TOP_FRACTION = 0.1;

const history = [];
let lastSampleEnd = null;

// Per-minute range sampling, fed by index.js's per-tick Haversine
// computation (server/src/range.js) -- independent of the stats.json poll
// this file otherwise ingests. Only the running best-per-minute value is
// kept; the raw per-tick readings are discarded immediately (hard rule 4).
let currentMinuteKey = null;
let currentMinuteBestKm = 0;
let rangeSamples = [];

// Keeps the last WINDOW_MS of whatever timeline the samples themselves are
// on -- the cutoff comes from the newest entry, not from Date.now(). The
// history series is timestamped by readsb's own clock (last1min.end), so
// measuring the window against our clock would let a disagreement between
// the two silently evict live data. Both series are append-only and
// time-ordered, so pruning is one splice off the front rather than a
// filter that reallocates the array every tick.
// `referenceMs` lets the restore path additionally measure the window
// against the wall clock (a snapshot from last week is stale no matter how
// self-consistent its own timestamps are); the later of the two wins, so a
// skewed readsb clock still can't evict live data.
function pruneWindow(samples, timeOfMs, referenceMs = -Infinity) {
  if (samples.length === 0) return;
  const cutoff = Math.max(timeOfMs(samples[samples.length - 1]), referenceMs) - WINDOW_MS;
  let drop = 0;
  while (drop < samples.length && timeOfMs(samples[drop]) < cutoff) drop += 1;
  if (drop > 0) samples.splice(0, drop);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

const historyTimeMs = (s) => s.t * 1000;
const rangeSampleTimeMs = (s) => s.t;

function todayDateString(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function dayStartMs(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`).getTime();
}

// Start of "today" (UTC midnight), matching the exact day boundary
// dailyAccumulator/todayDateString already use -- the "Ten dzień" Stats
// section reuses this same boundary rather than inventing a second,
// possibly-inconsistent definition of "today" (e.g. local time).
export function getTodayStartMs(now = Date.now()) {
  return dayStartMs(todayDateString(now));
}

function minuteKey(now) {
  return Math.floor(now / 60000);
}

export function averageOfTopFraction(values, fraction) {
  if (values.length === 0) return 0;
  const sortedDesc = [...values].sort((a, b) => b - a);
  const count = Math.max(1, Math.ceil(values.length * fraction));
  const top = sortedDesc.slice(0, count);
  return top.reduce((sum, v) => sum + v, 0) / top.length;
}

const dailyAccumulator = {
  date: todayDateString(),
  maxAircraft: 0,
  totalMessages: 0,
  maxRangeKm: 0,
  sumAircraft: 0,
  sumWithPos: 0,
  maxWithPos: 0,
  sumWithoutPos: 0,
  maxWithoutPos: 0,
  sampleCount: 0,
  // Distinct hexes/flight-callsigns seen at any point today -- reset at
  // midnight same as everything else here. Answers "how many different
  // aircraft/flights today", which first_seen_at columns alone can't:
  // an aircraft first seen last month that's also flying today must still
  // count towards today's unique total.
  uniqueHexes: new Set(),
  uniqueFlights: new Set(),
};

function resetDailyAccumulator(date) {
  dailyAccumulator.date = date;
  dailyAccumulator.maxAircraft = 0;
  dailyAccumulator.totalMessages = 0;
  dailyAccumulator.maxRangeKm = 0;
  dailyAccumulator.sumAircraft = 0;
  dailyAccumulator.sumWithPos = 0;
  dailyAccumulator.maxWithPos = 0;
  dailyAccumulator.sumWithoutPos = 0;
  dailyAccumulator.maxWithoutPos = 0;
  dailyAccumulator.sampleCount = 0;
  dailyAccumulator.uniqueHexes = new Set();
  dailyAccumulator.uniqueFlights = new Set();
  // Deliberately does NOT clear rangeSamples/history: those are rolling
  // 24h windows now, not "today"'s data. Clearing them at midnight is
  // exactly what used to truncate the 24h charts to "since 00:00 UTC".
}

// Called once per poll tick per currently tracked aircraft (not just this
// tick's delta) -- same reasoning as index.js's other per-tick sightings:
// a stationary aircraft with nothing changed wouldn't necessarily show up
// in a delta every tick, but it's still "seen today".
export function recordDailyUnique(hex, flight, now = Date.now()) {
  rolloverIfNewDay(now);
  if (hex) dailyAccumulator.uniqueHexes.add(hex);
  if (flight) dailyAccumulator.uniqueFlights.add(flight);
}

export function getDailyUniqueCounts() {
  return {
    uniqueAircraftCount: dailyAccumulator.uniqueHexes.size,
    uniqueFlightsCount: dailyAccumulator.uniqueFlights.size,
  };
}

// Called defensively from both ingestStats (every ~15s) and
// recordRangeSample (every ~1s) -- idempotent, only actually resets once
// per real day change, so it's safe for either entry point to trigger it.
function rolloverIfNewDay(now) {
  const today = todayDateString(now);
  if (dailyAccumulator.date !== today) {
    resetDailyAccumulator(today);
  }
}

export function getHistory() {
  return history;
}

export function getDailyAccumulator() {
  return dailyAccumulator;
}

// Every per-minute best-range sample in the rolling window, each
// timestamped to the start of its minute -- lets callers (the 24h view of
// the range chart) bucket by hour using the same time-buckets.js machinery
// as everything else, rather than only ever seeing one pre-aggregated
// number. Includes the current, still-in-progress minute so a read right
// after a burst of calls doesn't look stale for up to 60s.
export function getRangeSamples() {
  const samples = rangeSamples.slice();
  if (currentMinuteKey !== null) samples.push({ km: currentMinuteBestKm, t: currentMinuteKey * 60000 });
  return samples;
}

// The subset of the rolling window belonging to the day the accumulator is
// currently filling -- what gets reduced into that day's daily_stats row.
// Keyed off dailyAccumulator.date rather than "now" on purpose: a flush
// landing in the second between midnight and the next rollover call must
// still summarize the day the row is actually being written for.
export function getTodaysRangeSamples() {
  const start = dayStartMs(dailyAccumulator.date);
  return getRangeSamples().filter((s) => s.t >= start);
}

// Today's { maxRangeKm, rangeTopAvgKm } computed from the per-minute
// Haversine samples -- what actually gets written to daily_stats at
// rollover, and a more accurate "today's max" than the pre-existing
// readsb-derived accumulator.maxRangeKm (which only ever reflects readsb's
// own all-time running record's value as observed today, not a true daily
// max -- kept as-is for whatever else might read it, unrelated to this).
export function getRangeSummary() {
  const values = getTodaysRangeSamples().map((s) => s.km);
  return {
    maxRangeKm: values.length ? Math.max(...values) : 0,
    rangeTopAvgKm: averageOfTopFraction(values, TOP_FRACTION),
  };
}

// Rolling last-60-minutes max, for the "Aktualnie" section's live range
// tile -- distinct from getRangeSummary() above, which is *today's* max
// (resets at midnight). Reads the rolling window, so it stays a true full
// hour across midnight too; it used to read a day-scoped array that was
// cleared at rollover, leaving a short window for the first ~59 minutes
// of every day.
export function getMaxRangeLastHourKm(now = Date.now()) {
  const since = now - 60 * 60 * 1000;
  const values = getRangeSamples()
    .filter((s) => s.t >= since)
    .map((s) => s.km);
  return values.length ? Math.max(...values) : 0;
}

export function ingestStats(stats, now = Date.now()) {
  rolloverIfNewDay(now);

  const last1min = stats?.last1min;
  if (!last1min || typeof last1min.end !== 'number') return null;
  if (lastSampleEnd !== null && last1min.end <= lastSampleEnd) return null;
  lastSampleEnd = last1min.end;

  const withPos = typeof stats.aircraft_with_pos === 'number' ? stats.aircraft_with_pos : 0;
  const withoutPos = typeof stats.aircraft_without_pos === 'number' ? stats.aircraft_without_pos : 0;
  const aircraftCount = withPos + withoutPos;
  const messagesPerMinute = typeof last1min.messages === 'number' ? last1min.messages : 0;
  const maxRangeKm = typeof stats.total?.max_distance === 'number' ? stats.total.max_distance / 1000 : 0;

  const sample = { t: last1min.end, aircraftCount, withPos, withoutPos, messagesPerMinute, maxRangeKm };
  // readsb's `last1min` is a *sliding* 60-second window whose `end` is
  // simply "now" at write time -- so a 15s stats poll gets a fresh `end`
  // (and a fresh sample) on every single poll, four per minute, not one.
  // history keeps at most one entry per minute, the newest one winning,
  // then prunes by age: the old "push everything, cap at 1440 entries"
  // shape silently held only ~6 hours of what the UI calls a 24h chart.
  const last = history[history.length - 1];
  const sameMinute = last !== undefined && minuteKey(last.t * 1000) === minuteKey(sample.t * 1000);
  if (sameMinute) {
    history[history.length - 1] = sample;
  } else {
    history.push(sample);
    // Counted once per minute for the same reason: last1min.messages is a
    // rolling 60s count, so adding it on every poll counted most messages
    // ~4 times over into the day's total.
    dailyAccumulator.totalMessages += messagesPerMinute;
  }
  pruneWindow(history, historyTimeMs);

  dailyAccumulator.maxAircraft = Math.max(dailyAccumulator.maxAircraft, aircraftCount);
  dailyAccumulator.maxRangeKm = Math.max(dailyAccumulator.maxRangeKm, maxRangeKm);
  dailyAccumulator.sumAircraft += aircraftCount;
  dailyAccumulator.sumWithPos += withPos;
  dailyAccumulator.maxWithPos = Math.max(dailyAccumulator.maxWithPos, withPos);
  dailyAccumulator.sumWithoutPos += withoutPos;
  dailyAccumulator.maxWithoutPos = Math.max(dailyAccumulator.maxWithoutPos, withoutPos);
  dailyAccumulator.sampleCount += 1;

  return sample;
}

// Called every poll tick (~1s) from index.js with the best (largest)
// distance-to-home found among that tick's aircraft positions. Skip calling
// this entirely on a tick with no positioned aircraft -- there's nothing
// meaningful to record, not even a zero.
export function recordRangeSample(km, now = Date.now()) {
  rolloverIfNewDay(now);

  const key = minuteKey(now);
  if (currentMinuteKey === null || key !== currentMinuteKey) {
    if (currentMinuteKey !== null) rangeSamples.push({ km: currentMinuteBestKm, t: currentMinuteKey * 60000 });
    pruneWindow(rangeSamples, rangeSampleTimeMs);
    currentMinuteKey = key;
    currentMinuteBestKm = km;
    return;
  }
  currentMinuteBestKm = Math.max(currentMinuteBestKm, km);
}

export function getLatestStatsValues() {
  const latest = history[history.length - 1];
  return {
    messagesPerSec: latest ? latest.messagesPerMinute / 60 : null,
    maxRangeKm: latest ? latest.maxRangeKm : null,
  };
}

export function resetStatsHistory() {
  history.length = 0;
  lastSampleEnd = null;
  rangeSamples = [];
  currentMinuteKey = null;
  currentMinuteBestKm = 0;
  resetDailyAccumulator(todayDateString());
}

// Everything needed to resume today's in-progress stats exactly where they
// left off: the fine-grained per-minute `history` (feeds the 24h charts),
// the running `dailyAccumulator` (what eventually gets upserted into
// daily_stats), and the range-sampling state. All of this otherwise lives
// only in RAM and is lost on restart -- index.js persists this via
// GET/setConfigJSON on a slower cadence than the small daily_stats row
// (hourly by default, see index.js), since this blob is far bigger and SD
// wear matters (hard rule: batch writes, minimize SD wear).
export function snapshotForPersistence() {
  return {
    date: dailyAccumulator.date,
    // Sets aren't JSON-serializable -- spread to arrays for the snapshot,
    // restored back into Sets in restoreFromSnapshot below.
    dailyAccumulator: {
      ...dailyAccumulator,
      uniqueHexes: [...dailyAccumulator.uniqueHexes],
      uniqueFlights: [...dailyAccumulator.uniqueFlights],
    },
    history: history.slice(),
    rangeSamples: rangeSamples.slice(),
    currentMinuteKey,
    currentMinuteBestKm,
  };
}

// Restores in place, in two parts with deliberately different guards:
//
// - The rolling 24h series (history, range samples) are restored from
//   *any* snapshot and then pruned by age like they would be at runtime.
//   They aren't day-scoped, so a snapshot written at 23:50 is exactly the
//   right thing to resume from after a restart at 00:10 -- the old
//   all-or-nothing "today only" guard threw away a full day of 24h-chart
//   data for every restart that happened to cross midnight.
// - dailyAccumulator IS day-scoped, so it's only restored when the
//   snapshot is from today; one from yesterday (e.g. the service was off
//   overnight) would corrupt today's fresh numbers instead of gap-filling.
//   rolloverIfNewDay's own date check already handles a day boundary
//   crossed while running; this is the equivalent guard for the one-time
//   restore-at-startup path.
export function restoreFromSnapshot(snapshot, now = Date.now()) {
  if (!snapshot) return;

  history.length = 0;
  history.push(...(snapshot.history ?? []));
  pruneWindow(history, historyTimeMs, now);

  // `todaysRangeSamples` is the pre-rolling-window key name -- read as a
  // fallback so an existing install's stored snapshot still restores.
  rangeSamples = (snapshot.rangeSamples ?? snapshot.todaysRangeSamples ?? []).slice();
  pruneWindow(rangeSamples, rangeSampleTimeMs, now);
  // The in-progress minute is part of the same window -- resumed only if it
  // is still inside it, otherwise getRangeSamples() would keep appending a
  // sample from an old run forever.
  const restoredMinute = snapshot.currentMinuteKey ?? null;
  const minuteInWindow = restoredMinute !== null && restoredMinute * 60000 >= now - WINDOW_MS;
  currentMinuteKey = minuteInWindow ? restoredMinute : null;
  currentMinuteBestKm = minuteInWindow ? (snapshot.currentMinuteBestKm ?? 0) : 0;

  if (snapshot.date !== todayDateString(now) || !snapshot.dailyAccumulator) return;

  Object.assign(dailyAccumulator, snapshot.dailyAccumulator);
  // Object.assign just copied the plain arrays snapshotForPersistence wrote
  // (Sets aren't JSON-serializable) -- convert them back. An older snapshot
  // taken before this field existed simply won't have them, leaving the
  // freshly-initialized empty Sets from resetDailyAccumulator in place.
  dailyAccumulator.uniqueHexes = new Set(snapshot.dailyAccumulator.uniqueHexes ?? []);
  dailyAccumulator.uniqueFlights = new Set(snapshot.dailyAccumulator.uniqueFlights ?? []);
}
