// The deploy's rules (tools/delivery-plan.mjs), with no AWS calls: which key
// a built file becomes, the headers it is stored with, what a deploy uploads,
// removes and invalidates. Run: npm test.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  cacheControl,
  cachePolicies,
  contentType,
  contentTypes,
  eachLimit,
  etag,
  headersFingerprint,
  invalidationLimit,
  invalidationPaths,
  isHashedAsset,
  keyFor,
  normalizeEtag,
  objectHeaders,
  planSync,
  publicationGroups,
  removalLimit,
  sampleKeys,
  shadowedByRedirect,
} from '../tools/delivery-plan.mjs';

test('a path under dist/ becomes a relative key with forward slashes', () => {
  assert.equal(keyFor('index.html'), 'index.html');
  assert.equal(
    keyFor(['links', '0123456789ab', 'index.html'].join(path.sep)),
    'links/0123456789ab/index.html',
  );
  assert.equal(
    keyFor('hosts/obsidian.md/index.html'),
    'hosts/obsidian.md/index.html',
  );
  for (const unsafe of [
    '',
    '/index.html',
    'links//index.html',
    './index.html',
    'links/../index.html',
    'links/',
    'a\\b.html',
  ])
    assert.throws(() => keyFor(unsafe), /Unsafe object key/, unsafe);
});

test('each built file type has its Content-Type', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('links/0123456789ab.json'), 'application/json');
  assert.equal(
    contentType('links/0123456789ab.md'),
    'text/markdown; charset=utf-8',
  );
  // A host page is a directory named like a file; its index is still HTML.
  assert.equal(
    contentType('hosts/obsidian.md/index.html'),
    'text/html; charset=utf-8',
  );
  assert.equal(
    contentType('sitemap-index.xml'),
    'application/xml; charset=utf-8',
  );
  assert.equal(contentType('robots.txt'), 'text/plain; charset=utf-8');
  assert.equal(contentType('feed.xml'), 'application/rss+xml; charset=utf-8');
  assert.equal(
    contentType('hosts/obsidian.md/feed.json'),
    'application/feed+json; charset=utf-8',
  );
  assert.equal(contentType('hosts.json'), 'application/json');
  assert.equal(contentType('_astro/font.abc123.woff2'), 'font/woff2');
  assert.equal(
    contentType('pagefind/pagefind.js'),
    'text/javascript; charset=utf-8',
  );
  assert.equal(
    contentType('pagefind/fragment/en_1a2b3c.pf_fragment'),
    'application/octet-stream',
  );
  assert.equal(
    contentType('pagefind/wasm.en.pagefind'),
    'application/octet-stream',
  );
  assert.throws(() => contentType('notes.docx'), /No Content-Type/);
  assert.throws(() => contentType('LICENSE'), /No Content-Type/);
});

test('cache rules: hashed assets for a year, documents revalidate', () => {
  for (const key of [
    '_astro/Layout.Bx3k.css',
    '_astro/font.abc123.woff2',
    'pagefind/fragment/en_1a2b3c.pf_fragment',
    'pagefind/index/en_9f8e.pf_index',
    'pagefind/filter/en_77aa.pf_filter',
    'pagefind/pagefind.en_1234.pf_meta',
  ]) {
    assert.ok(isHashedAsset(key), key);
    assert.equal(cacheControl(key), cachePolicies.immutable, key);
  }
  for (const key of [
    'index.html',
    'links/0123456789ab/index.html',
    'links/0123456789ab.json',
    'links/0123456789ab.md',
    'sitemap-0.xml',
    'robots.txt',
    'revision.json',
    // Pagefind's entry file and scripts name the current chunks.
    'pagefind/pagefind-entry.json',
    'pagefind/pagefind.js',
    'pagefind/wasm.en.pagefind',
  ]) {
    assert.ok(!isHashedAsset(key), key);
    assert.equal(cacheControl(key), cachePolicies.revalidate, key);
  }
  assert.equal(cacheControl('favicon.svg'), cachePolicies.hour);
  assert.deepEqual(objectHeaders('links/0123456789ab.md'), {
    ContentType: 'text/markdown; charset=utf-8',
    CacheControl: cachePolicies.revalidate,
  });
});

test('the header fingerprint reaches every content type and cache policy', () => {
  const types = new Set(sampleKeys.map(contentType));
  assert.deepEqual(
    [...types].sort(),
    [...new Set(Object.values(contentTypes))].sort(),
  );
  const policies = new Set(sampleKeys.map(cacheControl));
  assert.deepEqual([...policies].sort(), Object.values(cachePolicies).sort());
  assert.match(headersFingerprint, /^[0-9a-f]{16}$/);
});

test('ETags compare as md5, quotes stripped', () => {
  assert.equal(etag(Buffer.from('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(
    normalizeEtag('"d41d8cd98f00b204e9800998ecf8427e"'),
    'd41d8cd98f00b204e9800998ecf8427e',
  );
  assert.equal(normalizeEtag(undefined), '');
});

test('a deploy uploads changed keys and lists keys no longer built', () => {
  const a = etag(Buffer.from('a'));
  const b = etag(Buffer.from('b'));
  const local = new Map([
    ['index.html', a],
    ['links/0123456789ab/index.html', b],
    ['links/0123456789ab.json', a],
    ['links/new000000000/index.html', a],
  ]);
  const remote = new Map([
    ['index.html', `"${a}"`],
    ['links/0123456789ab/index.html', `"${a}"`],
    // A multipart ETag never equals an md5, so the object is replaced.
    ['links/0123456789ab.json', `"${a}-2"`],
    ['links/gone00000000/index.html', `"${a}"`],
    ['_astro/old.css', `"${b}"`],
  ]);
  assert.deepEqual(planSync(local, remote), {
    upload: [
      'links/0123456789ab.json',
      'links/0123456789ab/index.html',
      'links/new000000000/index.html',
    ],
    unchanged: 1,
    stale: ['_astro/old.css', 'links/gone00000000/index.html'],
  });
  // New header rules upload everything, unchanged bodies included.
  const forced = planSync(local, remote, { force: true });
  assert.equal(forced.upload.length, local.size);
  assert.equal(forced.unchanged, 0);
  // A first deploy into an empty bucket uploads everything, removes nothing.
  assert.deepEqual(planSync(local, new Map()).stale, []);
});

test('publication order: assets, then what pages name, then pages, revision last', () => {
  assert.deepEqual(
    publicationGroups([
      'revision.json',
      'index.html',
      'links/0123456789ab.md',
      '_astro/Layout.Bx3k.css',
      'pagefind/pagefind-entry.json',
      'pagefind/fragment/en_1a2b.pf_fragment',
      'links/0123456789ab/index.html',
    ]),
    [
      ['_astro/Layout.Bx3k.css', 'pagefind/fragment/en_1a2b.pf_fragment'],
      ['links/0123456789ab.md', 'pagefind/pagefind-entry.json'],
      ['index.html', 'links/0123456789ab/index.html'],
      ['revision.json'],
    ],
  );
});

test('the removal guard scales with the site', () => {
  assert.equal(removalLimit(0), 100);
  assert.equal(removalLimit(1000), 100);
  assert.equal(removalLimit(57000), 1140);
});

test('a small deploy invalidates its paths; a large one invalidates /*', () => {
  assert.deepEqual(
    invalidationPaths([
      'index.html',
      'links/0123456789ab/index.html',
      'links/0123456789ab.json',
      '_astro/Layout.Bx3k.css',
      'pagefind/fragment/en_1a2b.pf_fragment',
      'hosts/café.example/index.html',
      'revision.json',
    ]),
    [
      '/',
      '/hosts/caf%C3%A9.example/',
      '/hosts/caf%C3%A9.example/index.html',
      '/index.html',
      '/links/0123456789ab.json',
      '/links/0123456789ab/',
      '/links/0123456789ab/index.html',
      '/revision.json',
    ],
  );
  assert.deepEqual(invalidationPaths([]), []);
  const many = Array.from(
    { length: invalidationLimit + 1 },
    (_, i) => `links/${String(i).padStart(12, '0')}.md`,
  );
  assert.deepEqual(invalidationPaths(many), ['/*']);
  assert.equal(
    invalidationPaths(many.slice(0, invalidationLimit)).length,
    invalidationLimit,
  );
  // Content-addressed assets never count toward the limit.
  assert.deepEqual(
    invalidationPaths(
      Array.from({ length: 500 }, (_, i) => `_astro/a${i}.css`),
    ),
    [],
  );
});

test('a year llms file is plain text that revalidates', () => {
  // /years/<yyyy>/llms.txt sits beside the year page (src/lib/dataset.ts).
  for (const key of ['years/2008/llms.txt', 'years/2026/llms.txt']) {
    assert.equal(contentType(key), 'text/plain; charset=utf-8', key);
    assert.equal(cacheControl(key), cachePolicies.revalidate, key);
    assert.ok(!isHashedAsset(key), key);
    assert.ok(!shadowedByRedirect(key), key);
    assert.deepEqual(publicationGroups([key]), [[], [key], [], []]);
  }
  assert.deepEqual(invalidationPaths(['years/2008/llms.txt']), [
    '/years/2008/llms.txt',
  ]);
});

test('only the hosts index may sit directly under hosts/', () => {
  assert.ok(!shadowedByRedirect('hosts/index.html'));
  assert.ok(!shadowedByRedirect('hosts/obsidian.md/index.html'));
  assert.ok(shadowedByRedirect('hosts/obsidian.md'));
  assert.ok(shadowedByRedirect('hosts/feed.xml'));
});

test('eachLimit bounds concurrency and stops after a failure', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(n);
    running--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  const started = [];
  await assert.rejects(
    eachLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(started, [1, 2]);
  await eachLimit([], 4, async () => assert.fail('no items'));
});
