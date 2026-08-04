const DAY_MS = 24 * 60 * 60 * 1000;

// Granularity is chosen from how much data the selected range *actually*
// covers, not from the range's name: a two-day-old install asking for
// "1y"/"all" used to get one single monthly bar (or a lone dot on a line
// chart), because the name alone said "month". The span is whichever is
// shorter -- the range window, or the time since the earliest recorded
// data -- so every range keeps roughly 2-60 points and a young install's
// "all" view reads like the 7d one until there's genuinely more to show.
//
// Never finer than 'day' outside 24h: everything but the 24h view is
// served from daily_stats, which has exactly one row per day, and mixing
// granularities across the Stats screen's charts would be worse than a
// coarse one.
const DAY_BUCKET_MAX_DAYS = 70;
const WEEK_BUCKET_MAX_DAYS = 400;

export function granularityForRange(range, { earliestDataMs = null, now = Date.now() } = {}) {
  if (range === '24h') return 'hour';

  const windowStart = rangeStartMs(range, now);
  const start = earliestDataMs === null ? windowStart : Math.max(windowStart, earliestDataMs);
  const spanDays = Math.max(0, now - start) / DAY_MS;

  if (spanDays <= DAY_BUCKET_MAX_DAYS) return 'day';
  if (spanDays <= WEEK_BUCKET_MAX_DAYS) return 'week';
  return 'month';
}

export function rangeStartMs(range, now = Date.now()) {
  if (range === '24h') return now - DAY_MS;
  if (range === '7d') return now - 7 * DAY_MS;
  if (range === '31d') return now - 31 * DAY_MS;
  if (range === '1y') return now - 365 * DAY_MS;
  return 0; // 'all' -- no lower bound
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Every bucket key and every day boundary in the stats layer is in the
// *local* timezone of the machine running this -- the Pi and the person
// reading the charts are in the same zone, and UTC boundaries meant "today"
// rolled over at 02:00 local on a UTC+2 receiver while hour labels read two
// hours behind the wall clock. Nothing here should ever go back to
// toISOString(): that is UTC by definition.
export function localDayString(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The inverse: midnight *local* time of that calendar day. Deliberately not
// `new Date('YYYY-MM-DD')`, which JS parses as UTC midnight -- that is
// exactly the mismatch this pair exists to remove.
export function startOfLocalDayMs(dayString) {
  const [year, month, day] = dayString.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

function isoWeekKey(date) {
  // ISO 8601 week-numbering year + week, computed against a UTC-normalized
  // Thursday of the same week (the standard trick: the ISO week's year is
  // whichever year owns that week's Thursday). Seeded from the *local*
  // calendar date -- the UTC normalization below is only there to make the
  // day arithmetic DST-free, not to move the date into UTC.
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function bucketKey(dateMs, granularity) {
  const d = new Date(dateMs);
  const day = localDayString(dateMs); // YYYY-MM-DD, local
  if (granularity === 'hour') return `${day}T${pad(d.getHours())}`; // YYYY-MM-DDTHH
  if (granularity === 'day') return day;
  if (granularity === 'week') return isoWeekKey(d);
  return day.slice(0, 7); // YYYY-MM
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
