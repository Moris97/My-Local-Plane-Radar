const MAX_SAMPLES = 24 * 60;

const history = [];
let lastSampleEnd = null;

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

const dailyAccumulator = {
  date: todayDateString(),
  maxAircraft: 0,
  totalMessages: 0,
  maxRangeKm: 0,
};

export function getHistory() {
  return history;
}

export function getDailyAccumulator() {
  return dailyAccumulator;
}

export function ingestStats(stats) {
  const last1min = stats?.last1min;
  if (!last1min || typeof last1min.end !== 'number') return null;
  if (lastSampleEnd !== null && last1min.end <= lastSampleEnd) return null;
  lastSampleEnd = last1min.end;

  const aircraftCount =
    (typeof stats.aircraft_with_pos === 'number' ? stats.aircraft_with_pos : 0) +
    (typeof stats.aircraft_without_pos === 'number' ? stats.aircraft_without_pos : 0);
  const messagesPerMinute = typeof last1min.messages === 'number' ? last1min.messages : 0;
  const maxRangeKm = typeof stats.total?.max_distance === 'number' ? stats.total.max_distance / 1000 : 0;

  const sample = { t: last1min.end, aircraftCount, messagesPerMinute, maxRangeKm };
  history.push(sample);
  if (history.length > MAX_SAMPLES) history.shift();

  const today = todayDateString();
  if (dailyAccumulator.date !== today) {
    dailyAccumulator.date = today;
    dailyAccumulator.maxAircraft = 0;
    dailyAccumulator.totalMessages = 0;
    dailyAccumulator.maxRangeKm = 0;
  }
  dailyAccumulator.maxAircraft = Math.max(dailyAccumulator.maxAircraft, aircraftCount);
  dailyAccumulator.totalMessages += messagesPerMinute;
  dailyAccumulator.maxRangeKm = Math.max(dailyAccumulator.maxRangeKm, maxRangeKm);

  return sample;
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
  dailyAccumulator.date = todayDateString();
  dailyAccumulator.maxAircraft = 0;
  dailyAccumulator.totalMessages = 0;
  dailyAccumulator.maxRangeKm = 0;
}
