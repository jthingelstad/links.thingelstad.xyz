// The viewer-request and viewer-response functions in infra/site.json, run
// in Node exactly as written for CloudFront (tools/edge-function.mjs). Run:
// npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  crawlerFunction,
  indexFunction,
  viewerRequest,
  viewerResponse,
} from '../tools/edge-function.mjs';

const handler = await indexFunction();
const run = (target) => handler(viewerRequest(target));
const served = (target) => {
  const result = run(target);
  assert.ok(!result.statusCode, `${target} is not redirected`);
  return result.uri;
};
const redirected = (target) => {
  const result = run(target);
  assert.equal(result.statusCode, 301, `${target} redirects`);
  return result.headers.location.value;
};

test('directory routes are served from index.html', () => {
  assert.equal(served('/'), '/index.html');
  assert.equal(
    served('/links/0123456789ab/'),
    '/links/0123456789ab/index.html',
  );
  assert.equal(served('/hosts/obsidian.md/'), '/hosts/obsidian.md/index.html');
  assert.equal(served('/search/?q=dns'), '/search/index.html');
});

test('files pass through', () => {
  for (const target of [
    '/links/0123456789ab.json',
    '/links/0123456789ab.md',
    '/robots.txt',
    '/sitemap-index.xml',
    '/years/2008/llms.txt',
    '/pagefind/pagefind-entry.json?ts=1761200000000',
    '/_astro/Layout.Bx3k.css',
  ])
    assert.equal(served(target), target.split('?')[0]);
});

test('a route without its trailing slash redirects, keeping the query', () => {
  assert.equal(redirected('/links/0123456789ab'), '/links/0123456789ab/');
  assert.equal(redirected('/search'), '/search/');
  assert.equal(redirected('/search?q=x'), '/search/?q=x');
  assert.equal(
    redirected('/search?q=site%3Akottke.org&year=2012'),
    '/search/?q=site%3Akottke.org&year=2012',
  );
  assert.equal(redirected('/search?tag=a&tag=b'), '/search/?tag=a&tag=b');
  assert.equal(redirected('/years/2012'), '/years/2012/');
});

test('a host name with a dot is a page, not a file', () => {
  assert.equal(redirected('/hosts/obsidian.md'), '/hosts/obsidian.md/');
  assert.equal(redirected('/hosts/kottke.org'), '/hosts/kottke.org/');
});

test('a page asked for by its index.html redirects to its route', () => {
  assert.equal(redirected('/index.html'), '/');
  assert.equal(redirected('/hosts/index.html'), '/hosts/');
  assert.equal(
    redirected('/hosts/kottke.org/index.html'),
    '/hosts/kottke.org/',
  );
  assert.equal(
    redirected('/links/0123456789ab/index.html'),
    '/links/0123456789ab/',
  );
  assert.equal(redirected('/search/index.html?q=x'), '/search/?q=x');
  // A file that only ends like one is a file.
  assert.equal(served('/years/2008/llms.txt'), '/years/2008/llms.txt');
});

const crawlers = await crawlerFunction();
const robots = (uri, type) =>
  crawlers(viewerResponse(uri, type)).headers['x-robots-tag']?.value;

test('only HTML pages may be indexed', () => {
  assert.equal(
    robots('/links/0123456789ab/index.html', 'text/html; charset=utf-8'),
    undefined,
  );
  assert.equal(robots('/404.html', 'text/html; charset=utf-8'), undefined);
  for (const [uri, type] of [
    ['/links/0123456789ab.json', 'application/json'],
    ['/links/0123456789ab.md', 'text/markdown; charset=utf-8'],
    ['/feed.xml', 'application/rss+xml; charset=utf-8'],
    ['/feed.json', 'application/feed+json; charset=utf-8'],
    ['/llms.txt', 'text/plain; charset=utf-8'],
    ['/links.db', 'application/vnd.sqlite3'],
    ['/media/youtube/abc.jpg', 'image/jpeg'],
    ['/sitemap-index.xml', 'application/xml; charset=utf-8'],
    ['/odd', undefined],
  ])
    assert.equal(robots(uri, type), 'noindex', uri);
});
