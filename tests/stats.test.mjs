// The statistics page's numbers (src/lib/stats.ts) and chart geometry
// (src/lib/charts.ts): the pure helpers pinned on small inputs, then the
// corpus figures checked against data.ts's own derivations.
// Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  axisLeft,
  classLabels,
  columnPath,
  compact,
  textWidth,
  ticks,
} from '../src/lib/charts.ts';
import * as data from '../src/lib/data.ts';
import {
  addDays,
  breaks,
  centralHour,
  classOf,
  concentration,
  dayLabel,
  dayRuns,
  daysBetween,
  hourRange,
  hourTick,
  listOf,
  median,
  monthDay,
  percent,
  ranges,
  stats,
  statsOf,
  weekdayOf,
} from '../src/lib/stats.ts';

test('hours are Central across the spring DST change', () => {
  // 2026-03-08: 2:00 AM CST becomes 3:00 AM CDT at 08:00 UTC.
  assert.equal(centralHour('2026-03-08T07:59:59Z'), 1);
  assert.equal(centralHour('2026-03-08T08:00:00Z'), 3);
  assert.equal(centralHour('2026-03-08T05:59:59Z'), 23);
  assert.equal(centralHour('2026-03-08T06:00:00Z'), 0);
});

test('hours are Central across the autumn DST change', () => {
  // 2025-11-02: 2:00 AM CDT falls back to 1:00 AM CST at 07:00 UTC, so
  // the 1 AM hour happens twice.
  assert.equal(centralHour('2025-11-02T05:30:00Z'), 0);
  assert.equal(centralHour('2025-11-02T06:30:00Z'), 1);
  assert.equal(centralHour('2025-11-02T07:30:00Z'), 1);
  assert.equal(centralHour('2025-11-02T08:30:00Z'), 2);
  // Summer and winter offsets.
  assert.equal(centralHour('2026-07-01T17:00:00Z'), 12);
  assert.equal(centralHour('2026-01-01T17:00:00Z'), 11);
});

test('weekdays run Monday to Sunday on the Central day', () => {
  assert.equal(weekdayOf('2026-10-19'), 0);
  assert.equal(weekdayOf('2026-10-22'), 3);
  assert.equal(weekdayOf('2026-10-25'), 6);
  // 03:00 UTC on a Monday is Sunday evening in Central.
  const day = data.centralDay('2026-10-19T03:00:00Z');
  assert.equal(day, '2026-10-18');
  assert.equal(weekdayOf(day), 6);
});

test('labels for readers', () => {
  assert.equal(hourRange(0), 'midnight to 1 AM');
  assert.equal(hourRange(11), '11 AM to noon');
  assert.equal(hourRange(12), 'noon to 1 PM');
  assert.equal(hourRange(23), '11 PM to midnight');
  assert.deepEqual([0, 3, 11, 12, 15, 23].map(hourTick), [
    '12a',
    '3a',
    '11a',
    '12p',
    '3p',
    '11p',
  ]);
  assert.equal(dayLabel('2010-12-05'), 'December 5, 2010');
  assert.equal(dayLabel('2005-08-02'), 'August 2, 2005');
  assert.equal(monthDay('2005-08-02'), 'August 2');
  assert.equal(listOf([]), '');
  assert.equal(listOf(['a']), 'a');
  assert.equal(listOf(['a', 'b']), 'a and b');
  assert.equal(listOf(['a', 'b', 'c']), 'a, b and c');
  assert.deepEqual(ranges([213, 32, 33, 34, 322]), [
    [32, 34],
    [213, 213],
    [322, 322],
  ]);
  assert.deepEqual(ranges([]), []);
});

test('day arithmetic crosses months, leap days and DST', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2025-11-01', '2025-11-03'), 2);
  assert.equal(daysBetween('2024-01-01', '2025-01-01'), 366);
});

test('the longest run and the longest gap', () => {
  assert.deepEqual(dayRuns([]), { run: null, gap: null });
  assert.deepEqual(dayRuns(['2026-10-01']), {
    run: { days: 1, from: '2026-10-01', to: '2026-10-01' },
    gap: null,
  });
  // A run across the leap day and into March, unsorted and with repeats.
  const { run, gap } = dayRuns([
    '2024-03-02',
    '2024-02-27',
    '2024-02-28',
    '2024-02-29',
    '2024-02-29',
    '2024-03-01',
    '2024-02-20',
    '2024-02-10',
    '2024-02-11',
  ]);
  assert.deepEqual(run, { days: 5, from: '2024-02-27', to: '2024-03-02' });
  // 12 Feb to 19 Feb are empty: 8 days, the first and last of them named.
  assert.deepEqual(gap, { days: 8, from: '2024-02-12', to: '2024-02-19' });
});

test('runs and gaps that tie go to the earlier', () => {
  const { run, gap } = dayRuns([
    '2026-01-01',
    '2026-01-02',
    '2026-01-05',
    '2026-01-06',
    '2026-01-09',
  ]);
  assert.deepEqual(run, { days: 2, from: '2026-01-01', to: '2026-01-02' });
  assert.deepEqual(gap, { days: 2, from: '2026-01-03', to: '2026-01-04' });
});

test('host concentration', () => {
  const rows = concentration([2, 5, 3], [1, 2, 10]);
  assert.deepEqual(rows, [
    { top: 1, hosts: 1, links: 5, share: 0.5 },
    { top: 2, hosts: 2, links: 8, share: 0.8 },
    { top: 10, hosts: 3, links: 10, share: 1 },
  ]);
  assert.deepEqual(concentration([], [1]), [
    { top: 1, hosts: 0, links: 0, share: 0 },
  ]);
});

test('medians and shares', () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percent(0, 0), '0%');
  assert.equal(percent(0, 10), '0%');
  assert.equal(percent(1, 1000), '<1%');
  assert.equal(percent(5, 1000), '1%');
  assert.equal(percent(999, 1000), '>99%');
  assert.equal(percent(1000, 1000), '100%');
  assert.equal(percent(1, 3), '33%');
});

test('heatmap classes', () => {
  const values = [0, 0, ...Array.from({ length: 100 }, (_, i) => i + 1)];
  const cuts = breaks(values, 5);
  assert.deepEqual(cuts, [21, 41, 61, 81]);
  assert.equal(classOf(0, cuts), 0);
  assert.equal(classOf(1, cuts), 1);
  assert.equal(classOf(21, cuts), 1);
  assert.equal(classOf(22, cuts), 2);
  assert.equal(classOf(100, cuts), 5);
  // Breaks never repeat, so a skewed set has fewer classes.
  assert.deepEqual(breaks([1, 1, 1, 1, 1, 1, 9], 5), [1]);
  assert.deepEqual(breaks([0, 0], 5), []);
  // Large values round to two significant figures.
  assert.deepEqual(breaks([1234, 5678], 2), [5700]);
  // Halving: each break half the one above it, from the largest value.
  assert.deepEqual(
    breaks([0.01, 0.64], 5, { shares: true, halving: true }),
    [0.04, 0.08, 0.16, 0.32],
  );
  assert.deepEqual(classLabels([0.04, 0.08], true), [
    'up to 4%',
    '4% to 8%',
    'over 8%',
  ]);
  assert.deepEqual(classLabels([2, 5, 9, 14]), [
    '1 to 2',
    '3 to 5',
    '6 to 9',
    '10 to 14',
    '15 or more',
  ]);
  assert.deepEqual(classLabels([1, 2]), ['1', '2', '3 or more']);
});

test('chart geometry', () => {
  assert.deepEqual(ticks(883), [0, 250, 500, 750, 1000]);
  assert.deepEqual(ticks(1), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(ticks(36), [0, 10, 20, 30, 40]);
  assert.deepEqual(ticks(0), [0, 1]);
  assert.equal(compact(750), '750');
  assert.equal(compact(1000), '1K');
  assert.equal(compact(1500), '1.5K');
  assert.equal(columnPath(0, 0, 10, 0), '');
  assert.match(columnPath(0, 0, 10, 20), /^M0,20V4Q0,0 4,0H6Q10,0 10,4V20Z$/);
  assert.ok(textWidth('100%') > textWidth('75%'));
  assert.ok(textWidth('>99%', 15, true) > textWidth('>99%'));
  assert.ok(axisLeft(['0%', '100%']) > axisLeft(['0', '40']));
});

// A few links built the way data.ts builds them.
function link(id, saved, url, note = '', tags = []) {
  const day = data.centralDay(saved);
  return {
    id,
    hash: id,
    url,
    title: id,
    note,
    saved,
    tags,
    toread: false,
    meta: '',
    host: data.hostOf(url),
    year: Number(day.slice(0, 4)),
    month: Number(day.slice(5, 7)),
    day,
    week: data.weekOf(day),
    hasNote: note.trim() !== '',
    voice: null,
  };
}

test('statsOf on a handful of links', () => {
  const records = [
    // 03:00 UTC on New Year's Day is 9 PM Central the night before.
    link('a', '2026-01-01T03:00:00Z', 'https://example.com/a', 'one'),
    link('b', '2025-06-02T15:00:00Z', 'http://example.com/b'),
    link('c', '2025-06-02T15:00:00Z', 'https://other.org/c', 'three', [
      '_brief',
    ]),
    link('d', '2025-06-03T15:00:00Z', 'https://other.org/d', 'four!'),
  ];
  const issue = {
    number: 1,
    slug: 'one',
    title: 'One',
    subject: '',
    date: '2025-06-06',
    url: '',
    links: [
      { position: 1, id: 'c', url: '', text: null, section: null },
      { position: 2, id: null, url: '', text: null, section: null },
    ],
  };
  const s = statsOf(records, [issue], (id) => id === 'c', 5);
  assert.equal(s.links, 4);
  assert.deepEqual(s.years, [2025]);
  assert.equal(s.first.id, 'b');
  assert.equal(s.last.id, 'a');
  const [row] = s.perYear;
  assert.equal(row.links, 4);
  assert.equal(row.withNote, 3);
  assert.equal(row.bare, 1);
  assert.equal(row.https, 3);
  assert.equal(row.inIssue, 1);
  assert.equal(row.days, 3);
  assert.equal(row.hosts, 2);
  assert.equal(row.newHosts, 2);
  // Link a is Wednesday 2025-12-31, 9 PM Central.
  assert.equal(records[0].day, '2025-12-31');
  assert.equal(s.clock[2][21], 1);
  assert.equal(s.clock[0][10], 2);
  assert.equal(s.clock[1][10], 1);
  assert.equal(
    s.clock.flat().reduce((a, b) => a + b, 0),
    4,
  );
  assert.deepEqual(s.busiestDays[0], {
    day: '2025-06-02',
    count: 2,
    sameSecond: 2,
    at: '2025-06-02T15:00:00Z',
  });
  assert.deepEqual(s.run, { days: 2, from: '2025-06-02', to: '2025-06-03' });
  assert.equal(s.gap.days, daysBetween('2025-06-03', '2025-12-31') - 1);
  assert.equal(s.longestNote.link.id, 'c');
  assert.equal(s.longestNote.length, 5);
  assert.equal(s.months[0][5], 3);
  assert.equal(s.months[0][11], 1);
  assert.equal(s.months[0][0], null);
  assert.equal(s.months[0][7], 0);
  assert.deepEqual(s.busiestMonth, { year: 2025, month: 6, count: 3 });
  assert.equal(s.issues[0].links, 2);
  assert.equal(s.issues[0].saved, 1);
  assert.deepEqual(s.tags, [{ tag: '_brief', count: 1 }]);
  assert.equal(s.hosts, 2);
  assert.equal(s.singles, 0);
});

test('the corpus figures agree with data.ts', () => {
  const all = data.links;
  assert.equal(stats.links, all.length);
  assert.equal(
    stats.perYear.reduce((sum, row) => sum + row.links, 0),
    all.length,
  );
  assert.equal(
    stats.perYear.reduce((sum, row) => sum + row.withNote + row.bare, 0),
    all.length,
  );
  assert.equal(stats.withNote, data.counts.withNote);
  assert.equal(stats.inIssue, data.counts.inIssues);
  assert.equal(
    stats.clock.flat().reduce((a, b) => a + b, 0),
    all.length,
  );
  assert.equal(
    stats.months
      .flat()
      .filter((n) => n !== null)
      .reduce((a, b) => a + b, 0),
    all.length,
  );
  assert.equal(stats.hosts, data.hosts.length);
  assert.equal(
    stats.perYear.reduce((sum, row) => sum + row.newHosts, 0),
    stats.hosts,
  );
  assert.equal(stats.singles, data.hosts.filter((h) => h.count === 1).length);
  const top10 = [...data.hosts]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .reduce((sum, h) => sum + h.count, 0);
  const row10 = stats.concentration.find((row) => row.top === 10);
  assert.equal(row10.links, top10);
  assert.equal(row10.share, top10 / all.length);
  assert.equal(stats.activeDays, new Set(all.map((l) => l.day)).size);
  assert.ok(stats.run.days >= 1 && stats.gap.days >= 1);
  assert.equal(stats.first.saved, data.counts.first);
  // Each top host's years add up to its count.
  for (const host of stats.topHosts)
    assert.equal(
      host.perYear.reduce((a, b) => a + b, 0),
      host.count,
    );
});
