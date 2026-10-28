// IndexNow (tools/indexnow.mjs): which URLs a deploy submits, the request
// bodies, and that a failed ping never throws. No network. Run: npm test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  INDEXNOW_KEY,
  INDEXNOW_KEY_FILE,
  changedUrls,
  pageUrl,
  payloads,
  sitemapUrls,
  submit,
} from '../tools/indexnow.mjs';
import { contentType } from '../tools/delivery-plan.mjs';

const base = 'https://links.thingelstad.xyz/';
const quiet = { log() {}, warn() {} };

test('the key file ships from public/ as the key alone, served as plain text', () => {
  assert.match(INDEXNOW_KEY, /^[A-Za-z0-9-]{8,128}$/);
  assert.equal(
    fs.readFileSync(
      new URL(`../public/${INDEXNOW_KEY_FILE}`, import.meta.url),
      'utf8',
    ),
    INDEXNOW_KEY,
  );
  assert.equal(contentType(INDEXNOW_KEY_FILE), 'text/plain; charset=utf-8');
});

test('the sitemap gives its <loc> URLs, decoded and normalised', () => {
  const xml =
    '<?xml version="1.0"?><urlset><url><loc>https://links.thingelstad.xyz/</loc></url>' +
    '<url><loc>https://links.thingelstad.xyz/hosts/obsidian.md/</loc></url>' +
    '<url><loc> https://links.thingelstad.xyz/search/?a=1&amp;b=2 </loc></url></urlset>';
  assert.deepEqual(
    [...sitemapUrls(xml)],
    [
      'https://links.thingelstad.xyz/',
      'https://links.thingelstad.xyz/hosts/obsidian.md/',
      'https://links.thingelstad.xyz/search/?a=1&b=2',
    ],
  );
});

test('only index.html keys are pages, served at their directory', () => {
  assert.equal(pageUrl('index.html', base), base);
  assert.equal(
    pageUrl('links/0123456789ab/index.html', base),
    `${base}links/0123456789ab/`,
  );
  for (const key of [
    'links/0123456789ab.json',
    'links/0123456789ab.md',
    'feed.xml',
    '404.html',
    'sitemap-0.xml',
    INDEXNOW_KEY_FILE,
  ])
    assert.equal(pageUrl(key, base), null, key);
});

test('changed sitemap pages and removed pages are submitted, nothing else', () => {
  const indexable = new Set([
    base,
    `${base}links/aaaaaaaaaaaa/`,
    `${base}links/bbbbbbbbbbbb/`,
    `${base}hosts/obsidian.md/`,
  ]);
  const urls = changedUrls({
    changed: [
      'index.html',
      'links/aaaaaaaaaaaa/index.html',
      // twins, feeds and assets change with their page but are not pages
      'links/aaaaaaaaaaaa.json',
      'links/aaaaaaaaaaaa.md',
      'feed.xml',
      '_astro/Layout.abc.css',
      // a noindex page (not in the sitemap) is left out
      'links/cccccccccccc/index.html',
      'surprise/index.html',
    ],
    removed: ['links/dddddddddddd/index.html', 'links/dddddddddddd.json'],
    indexable,
    base,
  });
  assert.deepEqual(urls, [
    base,
    `${base}links/aaaaaaaaaaaa/`,
    `${base}links/dddddddddddd/`,
  ]);
  assert.deepEqual(
    changedUrls({ changed: [], removed: [], indexable, base }),
    [],
  );
});

test('a request carries host, key, keyLocation and at most 10,000 URLs', () => {
  const urls = Array.from(
    { length: 10001 },
    (_, i) => `${base}links/${String(i).padStart(12, '0')}/`,
  );
  const bodies = payloads(urls, base);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].urlList.length, 10000);
  assert.deepEqual(bodies[1], {
    host: 'links.thingelstad.xyz',
    key: INDEXNOW_KEY,
    keyLocation: `${base}${INDEXNOW_KEY_FILE}`,
    urlList: [urls[10000]],
  });
  assert.deepEqual(payloads([], base), []);
});

test('nothing changed, nothing sent', async () => {
  const result = await submit([], base, {
    post: () => assert.fail('no request when nothing changed'),
    log: quiet,
  });
  assert.deepEqual(result, { sent: 0, ok: true });
});

test('200 and 202 are accepted; a refusal or network failure never throws', async () => {
  const calls = [];
  const ok = await submit([base], base, {
    post: async (url, init) => {
      calls.push([url, JSON.parse(init.body)]);
      return { status: 202 };
    },
    log: quiet,
  });
  assert.deepEqual(ok, { sent: 1, ok: true });
  assert.equal(calls[0][0], 'https://api.indexnow.org/indexnow');
  assert.deepEqual(calls[0][1].urlList, [base]);

  const refused = await submit([base], base, {
    post: async () => ({ status: 403 }),
    log: quiet,
  });
  assert.deepEqual(refused, { sent: 0, ok: false, status: 403 });

  const failed = await submit([base], base, {
    post: async () => {
      throw new TypeError('fetch failed');
    },
    log: quiet,
  });
  assert.deepEqual(failed, { sent: 0, ok: false });
});
