const DAY_MS = 24 * 60 * 60 * 1000;

// Confirmed granularity scheme: the longer the range, the coarser the
// buckets, so every chart stays at roughly 12-60 points regardless of how
// long the install has been running.
export function bucketGranularityForRange(range) {
  if (range === '24h') return 'hour';
  if (range === '7d' || range === '31d') return 'day';
  if (range === '1y') return 'week';
  return 'month'; // 'all'
}

export function rangeStartMs(range, now = Date.now()) {
  if (range === '24h') return now - DAY_MS;
  if (range === '7d') return now - 7 * DAY_MS;
  if (range === '31d') return now - 31 * DAY_MS;
  if (range === '1y') return now - 365 * DAY_MS;
  return 0; // 'all' -- no lower bound
}

function isoWeekKey(date) {
  // ISO 8601 week-numbering year + week, computed against a UTC-normalized
  // Thursday of the same week (the standard trick: the ISO week's year is
  // whichever year owns that week's Thursday).
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function bucketKey(dateMs, granularity) {
  const d = new Date(dateMs);
  const iso = d.toISOString();
  if (granularity === 'hour') return iso.slice(0, 13); // YYYY-MM-DDTHH
  if (granularity === 'day') return iso.slice(0, 10); // YYYY-MM-DD
  if (granularity === 'week') return isoWeekKey(d);
  return iso.slice(0, 7); // YYYY-MM
}

// items: any array. getTime/getValue extract what's needed per item.
// reducer(values) turns the list of per-bucket values into the bucket's
// output fields (e.g. { avg, max }). Buckets are returned sorted ascending
// by key, which sorts correctly for all four key formats above (ISO-ish
// strings, lexicographic order matches chronological order).
export function bucketize(items, { getTime, getValue, granularity, reducer }) {
  const buckets = new Map();
  for (const item of items) {
    const key = bucketKey(getTime(item), granularity);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(getValue(item));
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, values]) => ({ bucket: key, ...reducer(values) }));
}
