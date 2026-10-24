// Browser checks: a route of each kind renders without console or page
// errors at desktop and phone widths, with a main landmark, a title and no
// horizontal scroll; a search finds records and kind: links its page;
// Surprise me lands on a record and Back returns to the front page; the
// box suggests a site for site: and the keyboard takes it; the home page's
// box shows live results and Enter opens one, and a site taken there is not
// offered again; a video facade asks nothing of YouTube or Vimeo until it is
// clicked, then becomes the player; and no request reaches Tinylytics.
// SITE_TEST_URL defaults to the dev server; tools/test-built-site.mjs
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
// A record with a video card (src/lib/enrichment.ts), when the facts tool
// has observed one.
let video;
for (const name of twins) {
  const twin = JSON.parse(await fs.readFile(`dist/links/${name}`, 'utf8'));
  if (!record && twin.issues.length) record = twin;
  if (!video && twin.facts?.kind === 'video') video = twin;
  if (record && video) break;
}
const path = (url) => new URL(url).pathname;
const routes = [
  '/',
  '/search/',
  '/newest/',
  '/hosts/',
  '/issues/',
  '/years/',
  '/kinds/',
  '/kinds/video/',
  '/about/',
  path(record.record),
  path(record.connections.same_host?.page ?? `${base}/hosts/`),
  `/years/${record.saved.slice(0, 4)}/`,
  ...record.issues.slice(0, 1).map((issue) => path(issue.page)),
  ...(video ? [path(video.record)] : []),
];
const host = record.host;
// A word from the record's title, for the home page's live results.
const word =
  record.title.split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 3) ?? host;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const errors = [];
const analytics = [];
// Requests for a video player or its pieces, answered here with nothing.
const players = [];
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
  await context.route(
    /^https:\/\/([a-z0-9-]+\.)*(youtube-nocookie\.com|youtube\.com|ytimg\.com|vimeo\.com|vimeocdn\.com)\//,
    (route) => {
      players.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '' });
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

  // kind: with no other words links the kind's page.
  await page.goto(`${base}/search/?q=kind%3Avideo`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-search-status] a[href="/kinds/video/"]', {
    timeout: 15000,
  });

  // Surprise me: the front page's button lands on one record, and /surprise/
  // replaces itself, so Back is the front page again.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.click('a.home-surprise');
  await page.waitForURL(/\/links\/[0-9a-f]{12}\/$/, { timeout: 15000 });
  assert.ok(await page.locator('main').count(), 'the surprise is a record');
  await page.goBack({ waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).pathname, '/', 'Back is the front page');

  // The box suggests: site: and most of a host offers that host first, with
  // its links by year as bars; the down arrow and Enter take it, the search
  // runs on it, and year: then counts that site's years.
  await page.goto(`${base}/search/`, { waitUntil: 'networkidle' });
  const box = page.locator('[data-search-query]');
  await box.click();
  await box.pressSequentially(`site:${host.slice(0, -1)}`);
  const first = page.locator('[data-search-suggest] [role="option"]').first();
  await first.waitFor({ timeout: 15000 });
  assert.equal(
    await first.locator('.suggest-insert').textContent(),
    `site:${host}`,
    'site: suggests the host it starts',
  );
  assert.equal(await box.getAttribute('aria-expanded'), 'true');
  assert.ok(
    (await first.locator('.suggest-bars[aria-hidden="true"] .bar').count()) > 1,
    'a site row has its bars',
  );
  assert.match(
    (await first.locator('.suggest-years .sr-only').textContent()) ?? '',
    /\b\d{4}\b/,
    'and the same in words',
  );
  await box.press('ArrowDown');
  assert.equal(
    await box.getAttribute('aria-activedescendant'),
    await first.getAttribute('id'),
  );
  await page.screenshot({ path: shot(name, '/search/suggest') });
  await box.press('Enter');
  assert.equal(await box.inputValue(), `site:${host} `);
  assert.equal(await box.getAttribute('aria-expanded'), 'false');
  await page.waitForSelector(`[data-search-status] a[href="/hosts/${host}/"]`, {
    timeout: 15000,
  });
  await box.pressSequentially('year:');
  assert.ok(
    ((await first.locator('.suggest-note').textContent()) ?? '').endsWith(
      ` from ${host}`,
    ),
    'year: counts the site in the box',
  );
  await box.press('Escape');

  // The home page's box: a word brings up to five links and a row for all
  // of them; the down arrow and Enter open one; Enter with nothing chosen
  // searches on /search/.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const home = page.locator('#home-query');
  await home.click();
  await home.pressSequentially(word);
  const links = page.locator('#home-suggest .suggest-link');
  await links.first().waitFor({ timeout: 15000 });
  assert.ok((await links.count()) <= 5, 'five links at most');
  assert.match(
    (await page.locator('#home-suggest .suggest-all').textContent()) ?? '',
    /^(All|Up to) [\d,]+ links?/,
  );
  await page.screenshot({ path: shot(name, '/home-live') });
  const options = page.locator('#home-suggest [role="option"]');
  const at = await options.evaluateAll((all) =>
    all.findIndex((option) => option.classList.contains('suggest-link')),
  );
  for (let i = 0; i <= at; i++) await home.press('ArrowDown');
  const href = await options.nth(at).locator('a').getAttribute('href');
  assert.match(href ?? '', /^\/links\/[0-9a-f]{12}\/$/);
  await Promise.all([page.waitForURL(`**${href}`), home.press('Enter')]);
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await home.click();
  await home.pressSequentially(word);
  await Promise.all([page.waitForURL(/\/search\/\?q=/), home.press('Enter')]);
  // A site taken in the home box: the list that reopens with its links
  // starts with them, not with the suggestion just taken.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await home.click();
  await home.pressSequentially(`site:${host.slice(0, -1)}`);
  await options
    .first()
    .locator('.suggest-insert', { hasText: `site:${host}` })
    .waitFor({ timeout: 15000 });
  await home.press('ArrowDown');
  await home.press('Enter');
  assert.equal(await home.inputValue(), `site:${host} `);
  await links.first().waitFor({ timeout: 15000 });
  assert.ok(
    await options.first().evaluate((o) => o.classList.contains('suggest-link')),
    'the taken site is not offered again',
  );

  // The video facade: nothing from the player's host until the click.
  if (video) {
    players.length = 0;
    await page.goto(base + path(video.record), { waitUntil: 'networkidle' });
    assert.deepEqual(players, [], 'no player request before the click');
    await page.click('[data-video] button[data-embed]');
    const src = await page
      .locator('[data-video] iframe')
      .getAttribute('src', { timeout: 5000 });
    assert.match(
      src ?? '',
      /^https:\/\/(www\.youtube-nocookie\.com\/embed|player\.vimeo\.com\/video)\//,
      'the click puts the player in place',
    );
    await page.waitForTimeout(500);
    assert.ok(players.length > 0, 'the player is requested after the click');
  }

  if (edge) {
    const missing = await page.goto(`${base}/links/not-a-link/`);
    assert.equal(missing?.status(), 404, 'a missing page is a 404');
    assert.ok(await page.locator('main').count(), 'the 404 page is served');
  }
  await context.close();
}
await browser.close();

if (edge) {
  // The SQLite file, as the deploy stores it.
  const db = await fetch(`${base}/links.db`);
  assert.equal(db.status, 200, '/links.db responds 200');
  assert.equal(db.headers.get('content-type'), 'application/vnd.sqlite3');
  assert.equal(
    new TextDecoder().decode((await db.arrayBuffer()).slice(0, 15)),
    'SQLite format 3',
    '/links.db is SQLite',
  );
}

if (edge)
  for (const [from, to] of [
    [`/links/${record.id}`, `/links/${record.id}/`],
    [`/hosts/${host}`, `/hosts/${host}/`],
    ['/search?q=dns&year=2012', '/search/?q=dns&year=2012'],
  ]) {
    const response = await fetch(base + from, { redirect: 'manual' });
    assert.equal(response.status, 301, `${from} redirects`);
    // CloudFront sorts query parameters before the function sees them, so the
    // live redirect may carry them in another order. Same path, same pairs.
    const got = new URL(response.headers.get('location'), base);
    const want = new URL(to, base);
    assert.equal(got.pathname, want.pathname, `${from} goes to ${to}`);
    assert.deepEqual(
      [...got.searchParams].sort(),
      [...want.searchParams].sort(),
      `${from} keeps its query`,
    );
  }

assert.deepEqual(errors, [], 'no console or page errors');
if (production)
  assert.ok(
    analytics.length > 0,
    'the Tinylytics embed is requested (stubbed)',
  );
else assert.deepEqual(analytics, [], 'no Tinylytics requests during QA');
console.log(
  `Checked ${routes.length} routes, a search, a kind: search, Surprise me, a site: suggestion and the home page's live results at desktop and phone widths${video ? ', the video facade' : ' (no video facts to check the facade on)'}${edge ? ', /links.db, the redirects and the 404' : ''}; evidence in ${output}`,
);
