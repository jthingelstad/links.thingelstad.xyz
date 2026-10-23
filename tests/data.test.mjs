// The build's derivations (src/lib/data.ts), checked on the real data/.
// Run: npm test (node --test, then the Python tests).
//
// Counts are checked against the files read directly, so a sync does not
// break them; the pinned facts are historical and do not move.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as data from '../src/lib/data.ts';
import * as day from '../src/lib/day.ts';
import { normalizeUrl } from '../src/lib/normalize.ts';

const raw = readdirSync('data/links')
  .filter((name) => /^\d{4}\.json$/.test(name))
  .flatMap((name) => JSON.parse(readFileSync(`data/links/${name}`, 'utf8')));
const rawIssues = JSON.parse(
  readFileSync('data/derived/issues.json', 'utf8'),
).issues;

test('counts match the files', () => {
  assert.equal(data.links.length, raw.length);
  assert.ok(data.links.length >= 16524);
  assert.equal(data.counts.links, raw.length);
  assert.equal(
    data.counts.withNote,
    raw.filter((link) => link.note.trim()).length,
  );
  assert.equal(data.counts.issues, rawIssues.length);
  const linked = new Set(
    rawIssues.flatMap((issue) =>
      issue.links.map((row) => row.id).filter(Boolean),
    ),
  );
  assert.equal(data.counts.inIssues, linked.size);
  assert.equal(
    data.hosts.reduce((sum, host) => sum + host.count, 0),
    raw.length,
  );
  assert.equal(data.counts.first, '2005-08-02T16:49:06Z');
  assert.equal(
    data.years.length,
    new Set(data.links.map((link) => link.year)).size,
  );
});

test('every id is md5 of the URL as saved, never recomputed', () => {
  for (const link of data.links) {
    const md5 = createHash('md5').update(link.url, 'utf8').digest('hex');
    assert.equal(link.id, md5.slice(0, 12), link.url);
  }
  assert.equal(data.linkById.size, data.links.length);
});

test('a known record', () => {
  const link = data.linkById.get('8a9eb5b9974b');
  assert.ok(link);
  assert.equal(
    link.url,
    'https://feedbin.com/blog/2017/05/22/feedbin-supports-json-feed/',
  );
  assert.equal(link.host, 'feedbin.com');
  // Saved 03:36 UTC on May 23, which is the evening of May 22 in Central.
  assert.equal(link.saved, '2017-05-23T03:36:22Z');
  assert.equal(link.day, '2017-05-22');
  assert.equal(link.week, '2017-05-22');
  assert.equal(data.dateLabel(link.saved), 'May 22, 2017');
  assert.equal(link.voice, 'jamie');
  assert.equal(data.linkPath(link.id), '/links/8a9eb5b9974b/');
  assert.equal(data.linkJsonPath(link.id), '/links/8a9eb5b9974b.json');
  assert.deepEqual(
    data.appearances.get(link.id)?.map((a) => [a.issue.number, a.section]),
    [[3, 'Links 📌']],
  );
  // Mentioned in a note: the macdrifter link links to this one.
  assert.ok(data.mentionedBy.get(link.id)?.includes('c440292ac432'));
  assert.ok(data.mentions.get('c440292ac432')?.includes(link.id));
  const c = data.connectionsOf(link);
  assert.equal(
    c.sameHost.total,
    data.links.filter((l) => l.host === 'feedbin.com').length - 1,
  );
  assert.ok(c.sameHost.nearest.every((l) => l.host === 'feedbin.com'));
  assert.ok(c.sameWeek.nearest.every((l) => l.week === link.week));
  assert.ok(![...c.sameHost.nearest, ...c.sameWeek.nearest].includes(link));
});

test('years, months and weeks are Central', () => {
  // 04:58 UTC on New Year's Day 2011 is still 2010 in Central.
  const link = data.linkById.get('698e834d2c11');
  assert.equal(link?.saved, '2011-01-01T04:58:05Z');
  assert.equal(link?.year, 2010);
  assert.equal(link?.day, '2010-12-31');
  assert.equal(data.centralDay('2026-03-08T07:59:59Z'), '2026-03-08');
  assert.equal(data.centralDay('2026-03-08T05:59:59Z'), '2026-03-07');
  // Weeks start on Monday.
  assert.equal(data.weekOf('2017-05-28'), '2017-05-22');
  assert.equal(data.weekOf('2017-05-22'), '2017-05-22');
  for (const link of data.links.slice(0, 500))
    assert.equal(new Date(`${link.week}T00:00:00Z`).getUTCDay(), 1);
});

test('appearances for a known issue', () => {
  const issue = data.issues.find((i) => i.number === 3);
  assert.equal(issue?.slug, 'weekly-thing-for-may-27-2017');
  assert.equal(issue?.links.length, 33);
  const carried = [...data.appearances]
    .filter(([, list]) => list.some((a) => a.issue === issue))
    .map(([id]) => id);
  const expected = new Set(
    rawIssues
      .find((i) => i.number === 3)
      .links.map((row) => row.id)
      .filter(Boolean),
  );
  assert.equal(carried.length, 32);
  assert.deepEqual(new Set(carried), expected);
  // Each issue at most once per link, in issue order.
  for (const list of data.appearances.values()) {
    const slugs = list.map((a) => a.issue.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  }
  // A missing section is null, never the string "null".
  for (const list of data.appearances.values())
    for (const a of list) {
      assert.notEqual(a.section, 'null');
      assert.notEqual(a.section, '');
    }
  assert.equal(
    data.issues.find((i) => i.number === null)?.url,
    'https://weekly.thingelstad.com/archive/140-special/',
  );
});

test('saved twice groups are symmetric and normalise alike', () => {
  const groups = new Set(
    [...data.savedTwice].map(([id, others]) => [id, ...others].sort().join()),
  );
  assert.equal(
    groups.size,
    new Set(
      [...Map.groupBy(data.links, (link) => normalizeUrl(link.url)).values()]
        .filter((group) => group.length > 1)
        .map((group) =>
          group
            .map((link) => link.id)
            .sort()
            .join(),
        ),
    ).size,
  );
  assert.deepEqual(data.savedTwice.get('0abeb3f187d1'), ['79ab6c018852']);
  assert.deepEqual(data.savedTwice.get('79ab6c018852'), ['0abeb3f187d1']);
  for (const [id, others] of data.savedTwice)
    for (const other of others) {
      assert.ok(data.savedTwice.get(other)?.includes(id));
      assert.equal(
        normalizeUrl(data.linkById.get(id).url),
        normalizeUrl(data.linkById.get(other).url),
      );
    }
});

test('a mention resolves by the join rule', () => {
  const [a, b] = ['0abeb3f187d1', '79ab6c018852'].map((id) =>
    data.linkById.get(id),
  );
  const [older, newer] = a.saved < b.saved ? [a, b] : [b, a];
  // Exactly as saved wins.
  assert.equal(data.resolveUrl(older.url, newer.saved), older.id);
  // Otherwise the latest saved at or before the moment, else the earliest.
  const variant = `${older.url}?utm_source=test`;
  assert.equal(data.resolveUrl(variant, newer.saved), newer.id);
  assert.equal(data.resolveUrl(variant, older.saved), older.id);
  assert.equal(data.resolveUrl(variant, '2000-01-01T00:00:00Z'), older.id);
  assert.equal(data.resolveUrl('https://example.invalid/nothing'), undefined);
});

test('voice labels', () => {
  for (const link of data.links)
    assert.equal(link.voice === null, !link.hasNote, link.id);
  assert.equal(data.voiceOf('', 2020), null);
  assert.equal(data.voiceOf('> A quotation.', 2020), 'excerpt');
  assert.equal(data.voiceOf('Mine.\n\n> Theirs.', 2020), 'mixed');
  assert.equal(data.voiceOf('“A quotation.”', 2020), 'excerpt');
  assert.equal(data.voiceOf('The page says this.', 2012), 'excerpt');
  assert.equal(data.voiceOf('I think this.', 2020), 'jamie');
  assert.equal(data.voiceOf('A del.icio.us description.', 2005), 'jamie');
});

test('hosts', () => {
  for (const host of data.hosts) {
    assert.ok(host.host && host.host === host.host.toLowerCase());
    assert.ok(!host.host.startsWith('www.'), host.host);
    assert.ok(host.first <= host.last);
  }
  const counts = data.hosts.map((host) => host.count);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
  );
});

// The same cases as tests/test_urls.py, so both sides of a join agree.
const cases = [
  ['https://WWW.Example.COM/Path', 'example.com/Path'],
  ['https://www.www.example.com/', 'www.example.com/'],
  ['https://www2.example.com/', 'www2.example.com/'],
  ['https://blog.www.example.com/', 'blog.www.example.com/'],
  ['https://example.com/A/b', 'example.com/A/b'],
  ['HTTPS://example.com/a', 'example.com/a'],
  ['//example.com/a', 'example.com/a'],
  ['https://example.com/a/', 'example.com/a'],
  ['https://lookbusy.app//', 'lookbusy.app/'],
  ['https://example.com/a//', 'example.com/a'],
  ['https://example.com', 'example.com/'],
  ['https://example.com/', 'example.com/'],
  ['https://example.com?q=1', 'example.com/?q=1'],
  [
    'https://example.com/a?z=1&utm_source=x&b=2&utm_medium=y&ref=hn&a=3',
    'example.com/a?z=1&b=2&a=3',
  ],
  ...[
    'ref',
    'source',
    'mc_cid',
    'mc_eid',
    'fbclid',
    'gclid',
    'utm_campaign',
    'utm_',
  ].map((name) => [`https://example.com/?${name}=v`, 'example.com/']),
  ['https://example.com/?ref', 'example.com/'],
  [
    'https://example.com/?references=1&sources=2',
    'example.com/?references=1&sources=2',
  ],
  [
    'https://example.com/?UTM_source=x&Ref=y',
    'example.com/?UTM_source=x&Ref=y',
  ],
  ['https://www.tldraw.com/?ref=DenseDiscovery-376', 'tldraw.com/'],
  ['https://example.com/?q=a%20b&r=c+d', 'example.com/?q=a%20b&r=c+d'],
  ['https://example.com/?b=2&a=1', 'example.com/?b=2&a=1'],
  ['https://example.com/a?', 'example.com/a'],
  ['https://example.com/a?x=1&&y=2&', 'example.com/a?x=1&y=2'],
  ['https://example.com/a?utm_source=x', 'example.com/a'],
  ['https://example.com/a#section', 'example.com/a'],
  ['https://example.com/a/#', 'example.com/a'],
  ['https://example.com/a?x=1#y?z=2', 'example.com/a?x=1'],
  ['https://example.com/caf%C3%A9', 'example.com/café'],
  ['https://example.com/café', 'example.com/café'],
  ['https://example.com/a%20b', 'example.com/a b'],
  ['https://example.com/a%2Fb%2F', 'example.com/a/b'],
  ['https://example.com/%ZZ', 'example.com/%ZZ'],
  ['https://example.com/%C3', `example.com/${String.fromCharCode(0xfffd)}`],
  ['https://example.com/a+b', 'example.com/a+b'],
  ['  https://example.com/a  ', 'example.com/a'],
  ['https://exa\tmple.com/a\n', 'example.com/a'],
  ['https://www.example.com:8080/a', 'example.com:8080/a'],
  ['https://User@www.Example.com/a', 'user@www.example.com/a'],
  [' http://[::1/a ', 'http://[::1/a'],
  ['example.com/a/', 'example.com/a'],
  ['mailto:jamie@example.com', 'jamie@example.com'],
];

test('normalisation, as docs/DATA.md defines it', () => {
  for (const [url, expected] of cases)
    assert.equal(normalizeUrl(url), expected, JSON.stringify(url));
  assert.equal(
    normalizeUrl('http://wheregoes.com/'),
    normalizeUrl('https://wheregoes.com/'),
  );
});

test('normalisation agrees with tools/linking/urls.py on every URL', () => {
  const urls = [
    ...raw.map((link) => link.url),
    ...rawIssues.flatMap((issue) => issue.links.map((row) => row.url)),
    ...cases.map(([url]) => url),
  ];
  const python = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      [
        'import json, sys',
        "sys.path.insert(0, 'tools')",
        'from linking.urls import normalise',
        'print(json.dumps([normalise(u) for u in json.load(sys.stdin)]))',
      ].join('\n'),
    ],
    { input: JSON.stringify(urls), encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  assert.equal(python.status, 0, python.stderr);
  const expected = JSON.parse(python.stdout);
  const differ = urls
    .map((url, i) => [url, normalizeUrl(url), expected[i]])
    .filter(([, ours, theirs]) => ours !== theirs);
  assert.deepEqual(differ.slice(0, 10), []);
});

test('the pick of the day is the same all day, in Central', () => {
  const pool = data.links.slice(0, 1000);
  // 11:00 UTC on the 23rd and 04:00 UTC on the 24th are both October 23 in
  // Central.
  const morning = day.ofTheDay(pool, new Date('2026-10-23T11:00:00Z'));
  const evening = day.ofTheDay(pool, new Date('2026-10-24T04:00:00Z'));
  assert.equal(morning, evening);
  const days = new Set(
    Array.from({ length: 30 }, (_, i) =>
      day.ofTheDay(pool, new Date(Date.UTC(2026, 9, 1 + i, 18))),
    ),
  );
  assert.ok(days.size > 1, 'another pick on other days');
  assert.equal(day.ofTheDay([]), undefined);
  // The browser's Central date (day.ts) is the build's (data.ts), across
  // both clock changes of 2026 and every saved time.
  const instants = [
    '2026-03-08T07:59:59Z',
    '2026-03-08T08:00:00Z',
    '2026-11-01T05:59:59Z',
    '2026-11-01T06:00:00Z',
    ...data.links.map((link) => link.saved),
  ];
  const differ = instants.filter(
    (iso) => day.centralDate(new Date(iso)) !== data.centralDay(iso),
  );
  assert.deepEqual(differ, []);
});
