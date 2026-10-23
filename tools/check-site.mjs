// Browser checks: a route of each kind renders without console or page
// errors at desktop and phone widths, with a main landmark, a title and no
// horizontal scroll; a search finds records; and no request reaches
// Tinylytics. SITE_TEST_URL defaults to the dev server; tools/test-built-site.mjs
// runs this against dist/ behind the edge function (SITE_TEST_EDGE=1), which
// adds the redirect and 404 checks. Evidence goes to SITE_QA_DIR
// (/tmp/links-site-qa by default).
//
// Tinylytics requests are answered in the browser with an empty script, so no
// hit or kudos ever leaves. On the production host the embed must be requested
// (and is stubbed); everywhere else it must not be requested at all.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.SITE_TEST_URL || 'http://127.0.0.1:4321';
const output = process.env.SITE_QA_DIR || '/tmp/links-site-qa';
const production = new URL(base).hostname === 'links.thingelstad.xyz';
const edge = production || process.env.SITE_TEST_EDGE === '1';
await fs.mkdir(output, { recursive: true });

// One route of each kind, chosen from the build's own JSON twins (the first
// record that appeared in a Weekly Thing), so the list never goes stale.
const twins = (await fs.readdir('dist/links'))
  .filter((name) => name.endsWith('.json'))
  .sort();
let record;
for (const name of twins) {
  record = JSON.parse(await fs.readFile(`dist/links/${name}`, 'utf8'));
  if (record.issues.length) break;
}
const path = (url) => new URL(url).pathname;
const routes = [
  '/',
  '/search/',
  '/hosts/',
  '/issues/',
  '/years/',
  path(record.record),
  path(record.connections.same_host?.page ?? `${base}/hosts/`),
  `/years/${record.saved.slice(0, 4)}/`,
  ...record.issues.slice(0, 1).map((issue) => path(issue.page)),
];
const host = record.host;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const errors = [];
const analytics = [];
const shot = (name, route) =>
  `${output}/${name}${route.replace(/[/?=&]+/g, '_') || '_'}.png`;
for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
]) {
  const context = await browser.newContext({ viewport });
  await context.route(
    /^https:\/\/([a-z0-9-]+\.)*tinylytics\.app\//,
    (route) => {
      analytics.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: '',
      });
    },
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error}`));
  page.on('console', (msg) => {
    // The 404 check below asks for a missing page on purpose.
    if (msg.type() === 'error' && !/status of 404/.test(msg.text()))
      errors.push(`${name}: ${msg.text()}`);
  });
  for (const route of routes) {
    const response = await page.goto(base + route, {
      waitUntil: 'networkidle',
    });
    assert.equal(response?.status(), 200, `${route} responds 200`);
    assert.ok(
      await page.locator('main').count(),
      `${route} has a main landmark`,
    );
    assert.ok((await page.title()).length > 0, `${route} has a title`);
    const { overflow, height } = await page.evaluate(() => ({
      overflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      height: document.documentElement.scrollHeight,
    }));
    assert.ok(!overflow, `${route} has no horizontal scroll at ${name}`);
    // A year page lists thousands of links; its first screen is evidence enough.
    await page.screenshot({
      path: shot(name, route),
      fullPage: height <= 12000,
    });
  }

  // A search from the address: Pagefind loads and lists records.
  const query = `/search/?q=${encodeURIComponent('weekly')}`;
  await page.goto(base + query, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-search-results] li a[href*="/links/"]', {
    timeout: 15000,
  });
  await page.screenshot({ path: shot(name, query) });

  if (edge) {
    const missing = await page.goto(`${base}/links/not-a-link/`);
    assert.equal(missing?.status(), 404, 'a missing page is a 404');
    assert.ok(await page.locator('main').count(), 'the 404 page is served');
  }
  await context.close();
}
await browser.close();

if (edge)
  for (const [from, to] of [
    [`/links/${record.id}`, `/links/${record.id}/`],
    [`/hosts/${host}`, `/hosts/${host}/`],
    ['/search?q=dns&year=2012', '/search/?q=dns&year=2012'],
  ]) {
    const response = await fetch(base + from, { redirect: 'manual' });
    assert.equal(response.status, 301, `${from} redirects`);
    assert.equal(response.headers.get('location'), to, `${from} goes to ${to}`);
  }

assert.deepEqual(errors, [], 'no console or page errors');
if (production)
  assert.ok(
    analytics.length > 0,
    'the Tinylytics embed is requested (stubbed)',
  );
else assert.deepEqual(analytics, [], 'no Tinylytics requests during QA');
console.log(
  `Checked ${routes.length} routes and a search at desktop and phone widths${edge ? ', the redirects and the 404' : ''}; evidence in ${output}`,
);
