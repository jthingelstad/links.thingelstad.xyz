// Feeds, the dataset files, llms.txt and on this day (src/lib/feeds.ts,
// src/lib/dataset.ts, src/lib/data.ts), checked on the real data/. The built
// files themselves are checked by npm run validate:site.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as data from '../src/lib/data.ts';
import * as feeds from '../src/lib/feeds.ts';
import * as dataset from '../src/lib/dataset.ts';

const raw = readdirSync('data/links')
  .filter((name) => /^\d{4}\.json$/.test(name))
  .flatMap((name) => JSON.parse(readFileSync(`data/links/${name}`, 'utf8')));

test('feed dates are Central with the real offset', () => {
  // Daylight time, then standard time.
  assert.equal(
    data.rfc3339Central('2017-05-23T03:36:22Z'),
    '2017-05-22T22:36:22-05:00',
  );
  assert.equal(
    data.rfc822Central('2017-05-23T03:36:22Z'),
    'Mon, 22 May 2017 22:36:22 -0500',
  );
  assert.equal(
    data.rfc3339Central('2011-01-01T04:58:05Z'),
    '2010-12-31T22:58:05-06:00',
  );
  assert.equal(
    data.rfc822Central('2011-01-01T04:58:05Z'),
    'Fri, 31 Dec 2010 22:58:05 -0600',
  );
  // Across the spring and autumn changes, and midnight as 00, never 24.
  assert.equal(
    data.rfc3339Central('2026-03-08T07:59:59Z'),
    '2026-03-08T01:59:59-06:00',
  );
  assert.equal(
    data.rfc3339Central('2026-03-08T08:00:00Z'),
    '2026-03-08T03:00:00-05:00',
  );
  assert.equal(
    data.rfc3339Central('2026-11-01T06:30:00Z'),
    '2026-11-01T01:30:00-05:00',
  );
  assert.equal(
    data.rfc3339Central('2026-11-01T07:30:00Z'),
    '2026-11-01T01:30:00-06:00',
  );
  assert.equal(
    data.rfc822Central('2026-10-23T05:00:00Z'),
    'Fri, 23 Oct 2026 00:00:00 -0500',
  );
  for (const link of data.links.slice(-200))
    assert.equal(
      Date.parse(data.rfc3339Central(link.saved)),
      Date.parse(link.saved),
    );
});

test('paths come from data.ts', () => {
  assert.equal(data.feedPath('rss'), '/feed.xml');
  assert.equal(data.feedPath('json'), '/feed.json');
  assert.equal(
    data.feedPath('rss', data.hostPath('feedbin.com')),
    '/hosts/feedbin.com/feed.xml',
  );
  assert.equal(data.onThisDayPath(), '/on-this-day/');
  assert.equal(data.onThisDayPath('10-23'), '/on-this-day/10-23/');
  assert.equal(data.datasetPath.links, '/links.json');
});

test('the site feed is the newest 50 links', () => {
  assert.equal(feeds.siteFeed.links.length, feeds.FEED_SIZE);
  assert.deepEqual(
    feeds.siteFeed.links.map((link) => link.id),
    data.newest.slice(0, 50).map((link) => link.id),
  );
  const feed = feeds.jsonFeed(feeds.siteFeed);
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(feed.feed_url, 'https://links.thingelstad.xyz/feed.json');
  const [first] = feed.items;
  const link = feeds.siteFeed.links[0];
  assert.equal(first.id, `https://links.thingelstad.xyz/links/${link.id}/`);
  assert.equal(first.url, first.id);
  assert.equal(first.external_url, link.url);
  assert.ok(
    first.content_html.includes(`href="${link.url.replace(/&/g, '&amp;')}"`),
  );
  assert.ok(first.content_text.startsWith(link.url));
  const rss = feeds.rssFeed(feeds.siteFeed);
  assert.ok(
    rss.startsWith(
      '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"',
    ),
  );
  assert.equal(rss.match(/<item>/g)?.length, 50);
  assert.ok(
    rss.includes(
      '<atom:link href="https://links.thingelstad.xyz/feed.xml" rel="self"',
    ),
  );
});

test('a host feed is that host, newest first, with record links absolute', () => {
  const host = data.hostByName.get('macdrifter.com');
  const feed = feeds.hostFeed(host);
  assert.equal(feed.page, '/hosts/macdrifter.com/');
  assert.equal(feed.links.length, Math.min(50, host.count));
  assert.ok(feed.links.every((link) => link.host === 'macdrifter.com'));
  for (let i = 1; i < feed.links.length; i++)
    assert.ok(feed.links[i - 1].saved >= feed.links[i].saved);
  // The macdrifter note links to the Feedbin JSON Feed record.
  const item = feeds
    .jsonFeed(feed)
    .items.find((i) => i.id.endsWith('/links/c440292ac432/'));
  assert.ok(
    item.content_html.includes(
      'href="https://links.thingelstad.xyz/links/8a9eb5b9974b/"',
    ),
  );
  assert.ok(!item.content_html.includes('href="/links/'));
  assert.ok(feeds.feedHosts.length === data.hosts.length);
  assert.deepEqual(
    feeds.feedAlternates(feed).map((alt) => [alt.type, alt.href]),
    [
      ['application/rss+xml', '/hosts/macdrifter.com/feed.xml'],
      ['application/feed+json', '/hosts/macdrifter.com/feed.json'],
    ],
  );
});

test('feed text is escaped for XML', () => {
  const link = {
    ...data.links[0],
    id: 'aaaaaaaaaaaa',
    title: 'Fish & Chips <b>\u0007',
    url: 'https://example.com/?a=1&b=2',
    note: '',
    hasNote: false,
    voice: null,
    tags: [],
  };
  const rss = feeds.rssFeed({ ...feeds.siteFeed, links: [link] });
  assert.ok(rss.includes('<title>Fish &amp; Chips &lt;b&gt;</title>'));
  assert.ok(rss.includes('a=1&amp;amp;b=2'));
});

test('on this day groups by Central calendar day', () => {
  const total = [...data.linksByMonthDay.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  );
  assert.equal(total, data.links.length);
  assert.deepEqual(data.monthDays, [...data.monthDays].sort());
  // 04:58 UTC on New Year's Day 2011 is December 31 in Central.
  assert.ok(
    data.linksByMonthDay
      .get('12-31')
      .some((link) => link.id === '698e834d2c11'),
  );
  assert.equal(data.monthDayLabel('02-29'), 'February 29');
  assert.equal(data.monthDayLabel('10-03'), 'October 3');
});

test('links.json is every record exactly as data/links has it', () => {
  const doc = JSON.parse(dataset.linksDocument('2026-10-23T00:00:00.000Z'));
  assert.deepEqual(Object.keys(doc), ['site', 'generated', 'count', 'links']);
  assert.equal(doc.count, raw.length);
  const byId = new Map(raw.map((link) => [link.id, link]));
  for (const row of doc.links) {
    const { permalink, ...mirror } = row;
    assert.deepEqual(mirror, byId.get(row.id));
    assert.deepEqual(Object.keys(mirror), Object.keys(byId.get(row.id)));
    assert.equal(permalink, `https://links.thingelstad.xyz/links/${row.id}/`);
  }
  assert.deepEqual(
    doc.links.map((row) => row.id),
    data.newest.map((link) => link.id),
  );
});

test('hosts.json and issues.json', () => {
  const hosts = JSON.parse(dataset.hostsDocument('x'));
  assert.equal(hosts.count, data.hosts.length);
  assert.deepEqual(Object.keys(hosts.hosts[0]), [
    'host',
    'count',
    'first',
    'last',
    'url',
  ]);
  const issues = JSON.parse(dataset.issuesDocument('x'));
  const derived = JSON.parse(
    readFileSync('data/derived/issues.json', 'utf8'),
  ).issues;
  assert.equal(issues.count, derived.length);
  issues.issues.forEach((issue, i) => {
    const { page, links, ...rest } = issue;
    assert.deepEqual(
      { ...rest, links: links.map(({ permalink: _, ...row }) => row) },
      derived[i],
    );
    assert.ok(page.startsWith('https://links.thingelstad.xyz/issues/'));
  });
});

test('llms.txt has the llmstxt.org shape', () => {
  const text = dataset.llmsTxt();
  const lines = text.split('\n');
  assert.equal(lines[0], '# Linking Things');
  assert.ok(lines[2].startsWith('> '));
  for (const path of [
    '/links.json',
    '/hosts.json',
    '/issues.json',
    '/feed.json',
    '/llms-full.txt',
  ])
    assert.ok(text.includes(`(https://links.thingelstad.xyz${path})`), path);
  assert.ok(text.includes('`/links/<id>.md`'));
  // No em-dash (U+2014) anywhere, and no Pinboard in what readers see.
  assert.ok(!text.includes('\u2014'));
  assert.ok(!/pinboard/i.test(text));
});
