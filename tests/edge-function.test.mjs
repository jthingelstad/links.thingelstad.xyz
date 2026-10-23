// The viewer-request function in infra/site.json, run in Node exactly as
// written for CloudFront (tools/edge-function.mjs). Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexFunction, viewerRequest } from '../tools/edge-function.mjs';

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
    '/hosts/index.html',
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
  // Deeper paths with a dot are files.
  assert.equal(
    served('/hosts/kottke.org/index.html'),
    '/hosts/kottke.org/index.html',
  );
});
