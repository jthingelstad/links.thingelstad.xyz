// The numbers behind /stats/ (DIRECTION.md, "Statistics"): linking volume
// along its dimensions, computed at build from the records src/lib/data.ts
// reads. Nothing here reads data/ itself.
//
// The helpers are pure functions over their arguments, so the tests can pin
// them on small inputs; statsOf() runs them over the whole corpus. Days,
// weekdays and hours are US Central, as everywhere on the site: the Central
// day comes from data.ts, the hour from Intl (DST-aware) here.
import { type Issue, type Link, appearances, issues, links } from './data.ts';

const zone = 'America/Chicago';
const hourOf = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  hour: '2-digit',
  hourCycle: 'h23',
});

// The hour of the day in Central, 0 to 23, for a UTC instant.
export function centralHour(iso: string) {
  const hour = hourOf
    .formatToParts(new Date(iso))
    .find((part) => part.type === 'hour')?.value;
  return Number(hour) % 24;
}

// Monday is 0 and Sunday 6, for a YYYY-MM-DD day (already Central).
export const weekdayOf = (day: string) =>
  (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
export const weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

// Labels for readers. Hours name the hour that starts there, in Central.
const clockName = (h: number) =>
  h % 24 === 0
    ? 'midnight'
    : h === 12
      ? 'noon'
      : `${h % 12} ${h < 12 ? 'AM' : 'PM'}`;
export const hourRange = (h: number) =>
  `${clockName(h)} to ${clockName(h + 1)}`;
export const hourTick = (h: number) =>
  `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;
const longDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
// A YYYY-MM-DD day (already Central), as "December 5, 2010".
export const dayLabel = (day: string) =>
  longDay.format(new Date(`${day}T12:00:00Z`));
// "December 5".
export const monthDay = (day: string) => dayLabel(day).replace(/, \d+$/, '');
// "a", "a and b", "a, b and c".
export const listOf = (items: string[]) =>
  items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
// Runs of consecutive numbers: [32, 33, 34, 213] is [[32, 34], [213, 213]].
export function ranges(numbers: number[]) {
  const out: [number, number][] = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

const dayNumber = (day: string) =>
  Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
export function addDays(day: string, n: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) =>
  dayNumber(to) - dayNumber(from);

export interface Span {
  days: number;
  from: string;
  to: string;
}
// The longest run of consecutive days that each have a link, and the longest
// stretch of days with none between two that do. Ties go to the earlier.
export function dayRuns(input: string[]): {
  run: Span | null;
  gap: Span | null;
} {
  const days = [...new Set(input)].sort();
  if (!days.length) return { run: null, gap: null };
  let run: Span = { days: 1, from: days[0], to: days[0] };
  let gap: Span | null = null;
  let start = days[0];
  for (let i = 1; i < days.length; i++) {
    const step = daysBetween(days[i - 1], days[i]);
    if (step > 1) {
      if (!gap || step - 1 > gap.days)
        gap = {
          days: step - 1,
          from: addDays(days[i - 1], 1),
          to: addDays(days[i], -1),
        };
      start = days[i];
    }
    const length = daysBetween(start, days[i]) + 1;
    if (length > run.days) run = { days: length, from: start, to: days[i] };
  }
  return { run, gap };
}

// What share of all links the N most-linked hosts hold, for each N.
export function concentration(counts: number[], tops: number[]) {
  const sorted = [...counts].sort((a, b) => b - a);
  const total = sorted.reduce((sum, n) => sum + n, 0);
  return tops.map((top) => {
    const links = sorted.slice(0, top).reduce((sum, n) => sum + n, 0);
    return {
      top,
      hosts: Math.min(top, sorted.length),
      links,
      share: total ? links / total : 0,
    };
  });
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A share as a reader should see it: whole percent, but never 0% for some
// or 100% for not quite all.
export function percent(n: number, d: number) {
  if (!d) return '0%';
  const p = (100 * n) / d;
  if (n > 0 && p < 0.5) return '<1%';
  if (n < d && p >= 99.5) return '>99%';
  return `${Math.round(p)}%`;
}

// Class breaks for a heatmap: k classes over the values above zero. By
// default at their quantiles, so each class holds about as many cells; with
// `halving`, each break is half the one above it, from the largest value
// (a log scale, for shares where a few cells dwarf the rest). Breaks are
// rounded to read well: whole numbers to two significant figures, or whole
// percents for shares. Zero is its own class, "none".
export function breaks(
  values: number[],
  classes = 5,
  { shares = false, halving = false } = {},
) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const round = (v: number) => {
    if (shares) return Math.round(v * 100) / 100;
    if (v < 100) return Math.round(v);
    const power = 10 ** (Math.floor(Math.log10(v)) - 1);
    return Math.round(v / power) * power;
  };
  const raw = halving
    ? Array.from(
        { length: classes - 1 },
        (_, i) => sorted[sorted.length - 1] / 2 ** (classes - 1 - i),
      )
    : Array.from(
        { length: classes - 1 },
        (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / classes)],
      );
  const out: number[] = [];
  for (const at of sorted.length ? raw : []) {
    const value = round(at);
    if (value > 0 && (!out.length || value > out[out.length - 1]))
      out.push(value);
  }
  return out;
}
// 0 for none, then 1 to breaks.length + 1.
export const classOf = (value: number, cuts: number[]) =>
  value > 0 ? 1 + cuts.filter((cut) => value > cut).length : 0;

const noteLength = (note: string) => [...note.trim()].length;
const isHttps = (url: string) => /^https:\/\//i.test(url);

function countBy<T>(items: T[], key: (item: T) => string) {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}
const byCount = (a: [string, number], b: [string, number]) =>
  b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

export const concentrationTops = [1, 10, 50, 100, 500, 1000];

// Everything the page draws, from the records. `inIssue` says whether a link
// appeared in a Weekly Thing issue (data.ts's appearances index).
export function statsOf(
  records: Link[],
  issueList: Issue[],
  inIssue: (id: string) => boolean,
  topHosts = 20,
) {
  const list = [...records].sort((a, b) =>
    a.saved < b.saved ? -1 : a.saved > b.saved ? 1 : 0,
  );
  const years = [...new Set(list.map((link) => link.year))].sort(
    (a, b) => a - b,
  );
  const first = list[0];
  const last = list[list.length - 1];

  // Per year.
  const seen = new Set<string>();
  const rows = new Map(
    years.map((year) => [
      year,
      {
        year,
        links: 0,
        withNote: 0,
        noteLengths: [] as number[],
        inIssue: 0,
        https: 0,
        days: new Set<string>(),
        hosts: new Set<string>(),
        newHosts: 0,
        weekdays: Array<number>(7).fill(0),
      },
    ]),
  );
  // Weekday by hour, Monday first.
  const clock = weekdays.map(() => Array<number>(24).fill(0));
  for (const link of list) {
    const row = rows.get(link.year)!;
    row.links++;
    if (link.hasNote) {
      row.withNote++;
      row.noteLengths.push(noteLength(link.note));
    }
    if (inIssue(link.id)) row.inIssue++;
    if (isHttps(link.url)) row.https++;
    row.days.add(link.day);
    row.hosts.add(link.host);
    if (!seen.has(link.host)) {
      seen.add(link.host);
      row.newHosts++;
    }
    const weekday = weekdayOf(link.day);
    row.weekdays[weekday]++;
    clock[weekday][centralHour(link.saved)]++;
  }
  const perYear = [...rows.values()].map((row) => ({
    year: row.year,
    links: row.links,
    withNote: row.withNote,
    bare: row.links - row.withNote,
    medianNote: Math.round(median(row.noteLengths)),
    inIssue: row.inIssue,
    https: row.https,
    days: row.days.size,
    hosts: row.hosts.size,
    newHosts: row.newHosts,
    returningHosts: row.hosts.size - row.newHosts,
    weekdays: row.weekdays,
  }));

  // Months, from the first link's month to the latest's; null outside.
  const monthCounts = countBy(list, (link) => link.day.slice(0, 7));
  const firstMonth = first.day.slice(0, 7);
  const lastMonth = last.day.slice(0, 7);
  const months = years.map((year) =>
    Array.from({ length: 12 }, (_, i) => {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      return key < firstMonth || key > lastMonth
        ? null
        : (monthCounts.get(key) ?? 0);
    }),
  );
  const [busiestMonthKey, busiestMonthCount] = [...monthCounts].sort(
    byCount,
  )[0];
  const emptyMonths = years.flatMap((year, y) =>
    months[y]
      .map((count, m) => (count === 0 ? { year, month: m + 1 } : null))
      .filter((m): m is { year: number; month: number } => m !== null),
  );

  // Days and weeks.
  const dayCounts = countBy(list, (link) => link.day);
  const busiestDays = [...dayCounts]
    .sort(byCount)
    .slice(0, 10)
    .map(([day, count]) => {
      const seconds = [
        ...countBy(
          list.filter((link) => link.day === day),
          (link) => link.saved,
        ),
      ].sort(byCount)[0];
      return { day, count, sameSecond: seconds[1], at: seconds[0] };
    });
  const [busiestWeek, busiestWeekCount] = [
    ...countBy(list, (link) => link.week),
  ].sort(byCount)[0];
  const { run, gap } = dayRuns([...dayCounts.keys()]);

  // Notes.
  const longestNote = list.reduce((best, link) =>
    noteLength(link.note) > noteLength(best.note) ? link : best,
  );

  // The Weekly Thing.
  const numbered = issueList
    .filter((issue) => issue.number !== null)
    .sort((a, b) => a.number! - b.number!);
  const issueRows = numbered.map((issue) => ({
    issue,
    number: issue.number!,
    links: issue.links.length,
    saved: issue.links.filter((row) => row.id).length,
  }));
  const emptyIssues = issueRows.filter((row) => row.links === 0);
  const listed = issueRows.filter((row) => row.links > 0);
  const firstIssue = [...issueList].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  )[0];

  // Tags (today only WT Builder's filing marks, docs/DATA.md).
  const tagCounts = [
    ...countBy(
      list.flatMap((link) => link.tags),
      (tag) => tag,
    ),
  ].sort(byCount);
  const tagYears = years
    .map((year) => {
      const own = list.filter((link) => link.year === year);
      return {
        year,
        counts: tagCounts.map(
          ([tag]) => own.filter((link) => link.tags.includes(tag)).length,
        ),
      };
    })
    .filter((row) => row.counts.some((n) => n > 0));
  const tagged = list.filter((link) => link.tags.length).length;
  const maxTags = Math.max(0, ...list.map((link) => link.tags.length));

  // Hosts.
  const hostCounts = [...countBy(list, (link) => link.host)].sort(byCount);
  const singles = hostCounts.filter(([, n]) => n === 1).length;
  const top = hostCounts.slice(0, topHosts).map(([host, count]) => {
    const own = list.filter((link) => link.host === host);
    return {
      host,
      count,
      perYear: years.map(
        (year) => own.filter((link) => link.year === year).length,
      ),
    };
  });

  return {
    first,
    last,
    years,
    perYear,
    links: list.length,
    withNote: list.filter((link) => link.hasNote).length,
    medianNote: Math.round(
      median(
        list
          .filter((link) => link.hasNote)
          .map((link) => noteLength(link.note)),
      ),
    ),
    inIssue: list.filter((link) => inIssue(link.id)).length,
    months,
    busiestMonth: {
      year: Number(busiestMonthKey.slice(0, 4)),
      month: Number(busiestMonthKey.slice(5, 7)),
      count: busiestMonthCount,
    },
    emptyMonths,
    clock,
    weekdayTotals: clock.map((hours) => hours.reduce((s, n) => s + n, 0)),
    hourTotals: Array.from({ length: 24 }, (_, h) =>
      clock.reduce((s, hours) => s + hours[h], 0),
    ),
    activeDays: dayCounts.size,
    spanDays: daysBetween(first.day, last.day) + 1,
    busiestDays,
    busiestWeek: { week: busiestWeek, count: busiestWeekCount },
    run,
    gap,
    longestNote: { link: longestNote, length: noteLength(longestNote.note) },
    issues: issueRows,
    emptyIssues,
    listedIssues: listed,
    issueLinks: issueRows.reduce((sum, row) => sum + row.links, 0),
    firstIssue,
    tags: tagCounts.map(([tag, count]) => ({ tag, count })),
    tagYears,
    tagged,
    maxTags,
    hosts: hostCounts.length,
    singles,
    concentration: concentration(
      hostCounts.map(([, n]) => n),
      concentrationTops.filter((n) => n < hostCounts.length),
    ),
    topHosts: top,
  };
}

// The whole corpus, as the page shows it.
export const stats = statsOf(links, issues, (id) => appearances.has(id));
