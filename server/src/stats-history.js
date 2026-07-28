const MAX_SAMPLES = 24 * 60;
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
let todaysRangeSamples = [];

function todayDateString(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Start of "today" (UTC midnight), matching the exact day boundary
// dailyAccumulator/todayDateString already use -- the "Ten dzień" Stats
// section reuses this same boundary rather than inventing a second,
// possibly-inconsistent definition of "today" (e.g. local time).
export function getTodayStartMs(now = Date.now()) {
  return new Date(`${todayDateString(now)}T00:00:00.000Z`).getTime();
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
  todaysRangeSamples = [];
  currentMinuteKey = null;
  currentMinuteBestKm = 0;
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

// Today's { maxRangeKm, rangeTopAvgKm } computed from the per-minute
// Haversine samples -- what actually gets written to daily_stats at
// rollover, and a more accurate "today's max" than the pre-existing
// readsb-derived accumulator.maxRangeKm (which only ever reflects readsb's
// own all-time running record's value as observed today, not a true daily
// max -- kept as-is for whatever else might read it, unrelated to this).
// Every per-minute best-range sample recorded today, each timestamped to
// the start of its minute -- lets callers (the 24h view of the range chart)
// bucket by hour using the same time-buckets.js machinery as everything
// else, rather than only ever seeing one pre-aggregated number for "today".
// Includes the current, still-in-progress minute so a read right after a
// burst of calls doesn't look stale for up to 60s.
export function getTodaysRangeSamples() {
  const samples = todaysRangeSamples.slice();
  if (currentMinuteKey !== null) samples.push({ km: currentMinuteBestKm, t: currentMinuteKey * 60000 });
  return samples;
}

export function getRangeSummary() {
  const values = getTodaysRangeSamples().map((s) => s.km);
  return {
    maxRangeKm: values.length ? Math.max(...values) : 0,
    rangeTopAvgKm: averageOfTopFraction(values, TOP_FRACTION),
  };
}

// Rolling last-60-minutes max, for the "Aktualnie" section's live range
// tile -- distinct from getRangeSummary() above, which is *today's* max
// (resets at midnight). Known edge case, same class as every other
// midnight-boundary reset in this file: for the first ~59 minutes after
// midnight, samples from just before midnight are gone (todaysRangeSamples
// was cleared by resetDailyAccumulator), so the window is effectively
// shorter than a full hour right after rollover. Not worth a cross-day
// buffer for a once-a-day, hour-long edge case.
export function getMaxRangeLastHourKm(now = Date.now()) {
  const since = now - 60 * 60 * 1000;
  const values = getTodaysRangeSamples()
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
  history.push(sample);
  if (history.length > MAX_SAMPLES) history.shift();

  dailyAccumulator.maxAircraft = Math.max(dailyAccumulator.maxAircraft, aircraftCount);
  dailyAccumulator.totalMessages += messagesPerMinute;
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
    if (currentMinuteKey !== null) todaysRangeSamples.push({ km: currentMinuteBestKm, t: currentMinuteKey * 60000 });
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
    todaysRangeSamples: todaysRangeSamples.slice(),
    currentMinuteKey,
    currentMinuteBestKm,
  };
}

// Restores in place, but only when the snapshot is from *today* -- one from
// yesterday (or older, e.g. the service was off overnight) would corrupt
// today's fresh numbers with a stale day's data instead of gap-filling like
// it's meant to. rolloverIfNewDay's own date check already handles a day
// boundary crossed while running; this is the equivalent guard for the
// one-time restore-at-startup path.
export function restoreFromSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.date !== todayDateString(now)) return;

  history.length = 0;
  history.push(...snapshot.history);

  Object.assign(dailyAccumulator, snapshot.dailyAccumulator);
  // Object.assign just copied the plain arrays snapshotForPersistence wrote
  // (Sets aren't JSON-serializable) -- convert them back. An older snapshot
  // taken before this field existed simply won't have them, leaving the
  // freshly-initialized empty Sets from resetDailyAccumulator in place.
  dailyAccumulator.uniqueHexes = new Set(snapshot.dailyAccumulator.uniqueHexes ?? []);
  dailyAccumulator.uniqueFlights = new Set(snapshot.dailyAccumulator.uniqueFlights ?? []);

  todaysRangeSamples = snapshot.todaysRangeSamples.slice();
  currentMinuteKey = snapshot.currentMinuteKey;
  currentMinuteBestKm = snapshot.currentMinuteBestKm;
}
