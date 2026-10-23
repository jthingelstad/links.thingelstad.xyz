// The pick of the day, in Central. The build and the front page's script
// both use it, so they choose the same: the build renders the day it runs,
// and the script turns to today's pick, since a static page may be days old.
// It imports nothing, so it can run in the browser.
const partsOf = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// The Central date as yyyy-mm-dd (centralDay in data.ts, for a Date).
export function centralDate(date: Date) {
  const parts = Object.fromEntries(
    partsOf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// An index into a list of `count`: the same all day, usually another the
// next.
export function dayIndex(count: number, now = new Date()) {
  let seed = 0;
  for (const char of centralDate(now))
    seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return seed % count;
}

export function ofTheDay<T>(pool: readonly T[], now = new Date()) {
  return pool.length ? pool[dayIndex(pool.length, now)] : undefined;
}
