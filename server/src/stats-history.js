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
  todaysRangeSamples = [];
  currentMinuteKey = null;
  currentMinuteBestKm = 0;
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
