// Browser checks: a route of each kind renders without console or page
// errors at desktop and phone widths, with a main landmark, a title and no
// horizontal scroll; a search finds records, shows the one moved to in the
// preview pane on the desktop (and asks for no twin on a phone), and kind:
// links its page; /surprise/ lands on a record and Back returns to the
// front page; the box suggests a site for site: and the keyboard takes it;
// the front page is the sky: Surprise me opens a star in place, Find lights
// stars with up to five links under the box, the keyboard opens one on the
// sky, the card's way out stands back to what Find lit, Enter stays and the
// address carries the words, the last row searches on /search/, and a site
// taken there is not offered again; Enter takes an unknown site as it
// stands, lighting nothing; Doors from the whole sky puts its star in the
// address and says what Doors is; Full screen plays the sky alone; a video
// facade asks nothing of YouTube
// or Vimeo until it is clicked, then becomes the player; /sky/#<id> opens on
// that link (in the sky on the desktop, or Doors where the browser has no
// WebGL; Doors on a phone), a door walks to a neighbour and Back returns, the
// address following; a lens page (an issue, a link, a topic, a year) opens
// beside the sky without the header, lights what it lists, takes Find with the
// words in the address, opens a chosen star's page, whose doors walk on, and a
// topic's name opens the topic; a year opens in Time (or, without WebGL, is the
// plain page with the header); and no request reaches Tinylytics.
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
  '/sky/',
  '/topics/',
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

  // A search from the address: Pagefind loads and lists records. On the
  // desktop the first one shows in the preview pane from its twin, and the
  // pane follows the down arrow; the phone has no pane and asks for no twin.
  const twins = [];
  const twinRequest = (request) => {
    if (/\/links\/[0-9a-f]{12}\.json$/.test(new URL(request.url()).pathname))
      twins.push(request.url());
  };
  page.on('request', twinRequest);
  const query = `/search/?q=${encodeURIComponent('weekly')}`;
  await page.goto(base + query, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-search-results] li a[href*="/links/"]', {
    timeout: 15000,
  });
  const titles = page.locator('[data-search-results] a.title');
  const pane = page.locator('[data-search-preview]');
  if (name === 'desktop') {
    await pane.locator('.preview-facts').waitFor({ timeout: 15000 });
    assert.equal(
      await pane.locator('.preview-title').textContent(),
      await titles.first().textContent(),
      'the pane shows the first result',
    );
    assert.equal(await pane.getAttribute('aria-busy'), null);
    await page.locator('[data-search-query]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const second = (await titles.nth(1).textContent()) ?? '';
    await pane
      .locator('.preview-title', { hasText: second })
      .waitFor({ timeout: 15000 });
    await pane.locator('.preview-facts').waitFor({ timeout: 15000 });
    assert.equal(
      await page.locator('[data-search-results] li.previewing').count(),
      1,
    );
    assert.ok(twins.length >= 2, 'each result previewed asks for its twin');
    // A result rested on while the next search loads belongs to the last
    // one: when the new results come, the pane shows their first. Pagefind
    // is slowed until the old results are gone; a request the page has
    // given up on by then needs nothing more.
    let hold = true;
    await page.route('**/pagefind/**', (route) =>
      new Promise((done) => setTimeout(done, hold ? 1500 : 0))
        .then(() => route.continue())
        .catch(() => {}),
    );
    await page.locator('[data-search-query]').fill(word);
    await page.locator('h1').click();
    await page.waitForTimeout(400);
    const old = await page
      .locator('[data-search-results] li')
      .nth(2)
      .elementHandle();
    await old.hover();
    await page.waitForTimeout(300);
    await page.mouse.move(0, 0);
    await page.waitForFunction((row) => !row.isConnected, old, {
      timeout: 15000,
    });
    hold = false;
    const first = page.locator('[data-search-results] li').first();
    await first.locator('a.title').waitFor({ timeout: 15000 });
    await pane
      .locator('.preview-title', {
        hasText: (await first.locator('a.title').textContent()) ?? '',
      })
      .waitFor({ timeout: 15000 });
    assert.match(
      (await first.getAttribute('class')) ?? '',
      /previewing/,
      'a result rested on during a search gives way to the new first',
    );
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  } else {
    assert.ok(await pane.isHidden(), 'no pane on a phone');
    assert.deepEqual(twins, [], 'and no twin asked for');
  }
  page.off('request', twinRequest);
  await page.screenshot({ path: shot(name, query) });

  // kind: with no other words links the kind's page.
  await page.goto(`${base}/search/?q=kind%3Avideo`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-search-status] a[href="/kinds/video/"]', {
    timeout: 15000,
  });

  // /surprise/ (the plain front door's Surprise me) lands on one record and
  // replaces itself, so Back is the front page again.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.goto(`${base}/surprise/`);
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

  // The front page is the sky, standing back over the whole of it (Doors on
  // a phone or without WebGL, on the newest link with a note). Surprise me
  // opens a star in place, the address following.
  const landing = async (query = '') => {
    await page.goto(`${base}/${query}`, { waitUntil: 'networkidle' });
    await page.locator('[data-sky][data-view]').waitFor({ timeout: 15000 });
    await page
      .locator('.sky-loading')
      .waitFor({ state: 'detached', timeout: 15000 });
    return page.locator('[data-sky]').getAttribute('data-view');
  };
  const sky = await landing();
  assert.ok(
    await page.locator('[data-sky-plain]').isHidden(),
    'the sky, not the plain door',
  );
  const starCard = sky === 'doors' ? '.doors-page' : '.sky-card';
  const opens = async (href) => {
    await page.waitForURL((url) => url.hash === `#${href.split('/')[2]}`);
    assert.equal(
      new URL(page.url()).pathname,
      '/',
      'the star opens on the front page',
    );
    await page
      .locator(`${starCard} .sky-card-title a[href="${href}"]`)
      .waitFor({ timeout: 5000 });
  };
  if (sky === 'sky') {
    assert.equal(new URL(page.url()).hash, '', 'the whole sky, no star');
    assert.ok(await page.locator('.sky-home [data-home-about]').isVisible());
  }
  await page.screenshot({ path: shot(name, '/sky-landing') });
  // (Doors already has a star in the address.)
  const before = new URL(page.url()).hash;
  await page.locator('[data-surprise]:visible').first().click();
  await page.waitForURL(
    (url) => /^#[0-9a-f]{12}$/.test(url.hash) && url.hash !== before,
  );
  await opens(`/links/${new URL(page.url()).hash.slice(1)}/`);

  // Find: a word lights stars, brings up to five links and a last row for the
  // search page, and goes in the address; the down arrow and Enter open a
  // link on the sky; its card's way out stands back to what was lit.
  await landing();
  const find = page.locator('#sky-find');
  const found = page.locator('#sky-results .suggest-link');
  const rows = page.locator('#sky-results [role="option"]');
  await find.click();
  await find.pressSequentially(word);
  await found.first().waitFor({ timeout: 15000 });
  assert.ok((await found.count()) <= 5, 'five links at most');
  assert.equal(
    (await page
      .locator('#sky-results .suggest-all .suggest-insert')
      .textContent()) ?? '',
    `Search the notes for “${word}”`,
  );
  await page.waitForURL((url) => url.searchParams.get('q') === word);
  if (sky === 'sky') {
    const lit = page.locator('.sky-home [data-home-find]');
    assert.equal(await lit.locator('.sky-home-title').textContent(), word);
    assert.match(
      (await lit.locator('.sky-home-lede').textContent()) ?? '',
      /^(One link|[\d,]+ links), (in|from) \d{4}/,
    );
  }
  await page.screenshot({ path: shot(name, '/sky-find') });
  const at = await rows.evaluateAll((all) =>
    all.findIndex((option) => option.classList.contains('suggest-link')),
  );
  for (let i = 0; i <= at; i++) await find.press('ArrowDown');
  const href = await rows.nth(at).locator('a').getAttribute('href');
  assert.match(href ?? '', /^\/links\/[0-9a-f]{12}\/$/);
  await find.press('Enter');
  await opens(href);
  assert.equal(
    new URL(page.url()).searchParams.get('q'),
    word,
    'Find stays lit',
  );
  if (sky === 'sky') {
    const out = page.locator('.sky-card .sky-out');
    assert.equal(await out.textContent(), `All of “${word}”`);
    await out.click();
    await page.waitForURL((url) => !url.hash);
    assert.ok(await page.locator('.sky-home [data-home-find]').isVisible());
    // Enter with nothing chosen stays on the sky.
    await find.click();
    await find.press('Enter');
    assert.equal(new URL(page.url()).pathname, '/', 'Enter stays on the sky');
  }

  // The address is shareable: the words come back lit.
  await landing(`?q=${encodeURIComponent(word)}`);
  assert.equal(await find.inputValue(), word);
  if (sky === 'sky')
    assert.equal(
      await page
        .locator('.sky-home [data-home-find] .sky-home-title')
        .textContent(),
      word,
    );
  // The last row takes the words to /search/, notes and all.
  await find.click();
  await find.press('End');
  await find.pressSequentially(' ');
  // Past Find's pause, so the rows are the ones the keys move through.
  await page.waitForTimeout(500);
  await found.first().waitFor({ timeout: 15000 });
  const all = await rows.evaluateAll((list) =>
    list.findIndex((option) => option.classList.contains('suggest-all')),
  );
  for (let i = 0; i <= all; i++) await find.press('ArrowDown');
  await Promise.all([page.waitForURL(/\/search\/\?q=/), find.press('Enter')]);

  // A site taken in Find: the list that reopens with its links starts with
  // them, not with the suggestion just taken.
  await landing();
  await find.click();
  await find.pressSequentially(`site:${host.slice(0, -1)}`);
  await rows
    .first()
    .locator('.suggest-insert', { hasText: `site:${host}` })
    .waitFor({ timeout: 15000 });
  await find.press('ArrowDown');
  await find.press('Enter');
  assert.equal(await find.inputValue(), `site:${host} `);
  await found.first().waitFor({ timeout: 15000 });
  assert.ok(
    await rows.first().evaluate((o) => o.classList.contains('suggest-link')),
    'the taken site is not offered again',
  );

  // Enter takes the words as they stand: a site no link is from lights
  // nothing, in place of what was lit before.
  const nowhere = 'site:nowhere.invalid';
  await landing(`?q=${encodeURIComponent(word)}`);
  await find.fill(nowhere);
  await find.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('q') === nowhere);
  if (sky === 'sky') {
    assert.equal(
      await page
        .locator('.sky-home [data-home-find] .sky-home-lede')
        .textContent(),
      'No titles or sites have those words.',
    );
    // Doors from the whole sky takes a star, and the address says which.
    await landing();
    await page.locator('[data-toggle-view]').click();
    await page.waitForURL((url) => /^#[0-9a-f]{12}$/.test(url.hash));
    assert.ok(
      await page.locator('.doors-about').isVisible(),
      'Doors says what it is',
    );
    // Full screen is the sky alone, flying itself.
    await landing();
    await page.locator('[data-full]').click();
    await page.waitForFunction(() =>
      document.fullscreenElement?.matches(
        '[data-sky][data-fullscreen][data-playing]',
      ),
    );
    // A touch on the sky takes the controls back, in full screen too.
    await page.locator('.sky-gl').click({ position: { x: 40, y: 200 } });
    assert.equal(
      await page.locator('[data-sky]').getAttribute('data-playing'),
      null,
      'a click on the sky stops Play',
    );
    await page.evaluate(() => document.exitFullscreen());
  } else
    assert.ok(
      await page.locator('.doors-about').isVisible(),
      'Doors says what it is',
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

  // The sky: the address is the star in view.
  await page.goto(`${base}/sky/#${record.id}`, { waitUntil: 'networkidle' });
  const stage = page.locator('[data-sky][data-view]');
  await stage.waitFor({ timeout: 15000 });
  const view = await stage.getAttribute('data-view');
  if (name === 'phone') assert.equal(view, 'doors', 'a phone gets Doors');
  const card = view === 'doors' ? '.doors-page' : '.sky-card';
  // Doors turns the page after a short animation, so wait for the card.
  const shows = (href) =>
    page
      .locator(`${card} .sky-card-title a[href="${href}"]`)
      .waitFor({ timeout: 5000 });
  await shows(path(record.record));
  await page
    .locator(view === 'doors' ? '.door' : '.sky-door')
    .first()
    .dispatchEvent('click');
  await page.waitForURL((url) => url.hash && url.hash !== `#${record.id}`);
  const near = new URL(page.url()).hash.slice(1);
  assert.match(near, /^[0-9a-f]{12}$/, 'a door walks to a neighbour');
  await shows(`/links/${near}/`);
  await page.locator(`${card} .sky-back`).click();
  await page.waitForURL((url) => url.hash === `#${record.id}`);
  await shows(path(record.record));
  await page.screenshot({ path: shot(name, '/sky/walk') });

  // Lens pages (src/components/Lens.astro): where the script and WebGL are,
  // an issue opens beside the sky, at night, with no site header, and the
  // sky lights the links it lists; Find lights over the lens with the words
  // in the address, and clearing it gives the lens back; a star chosen there
  // opens its page, which stands on its link with its neighbours as doors; a
  // year opens in Time. Without WebGL it is the plain page with the header.
  const lensAt = async (route) => {
    await page.goto(base + route, { waitUntil: 'networkidle' });
    await page
      .locator('[data-sky][data-view], [data-sky][hidden]')
      .waitFor({ state: 'attached', timeout: 15000 });
    return page.evaluate(() =>
      document.documentElement.hasAttribute('data-lens'),
    );
  };
  const issueLens = path(record.issues[0].page);
  if (await lensAt(issueLens)) {
    assert.ok(
      await page.locator('.site-header').isHidden(),
      'a lens has no site header',
    );
    assert.match(
      (await page.locator('.sky-lens-now').textContent()) ?? '',
      /Lens: /,
      'the gold chip names the lens',
    );
    const lit = page.locator('.sky-found[data-star]');
    await lit.first().waitFor({ state: 'attached', timeout: 15000 });
    const lensFind = page.locator('#sky-find');
    await lensFind.fill(word);
    await page.waitForURL((url) => url.searchParams.get('q') === word);
    assert.equal(
      new URL(page.url()).pathname,
      issueLens,
      'Find stays on the lens',
    );
    await lensFind.fill('');
    await page.waitForURL((url) => !url.searchParams.has('q'));
    await lit.first().waitFor({ state: 'attached', timeout: 15000 });
    await page.screenshot({ path: shot(name, `${issueLens}lens`) });
    await lit.first().dispatchEvent('click');
    await page.waitForURL((url) =>
      /^\/links\/[0-9a-f]{12}\/$/.test(url.pathname),
    );
    const chosen = new URL(page.url()).pathname;
    assert.ok(
      await lensAt(chosen),
      'a star chosen on a lens opens its page as a lens',
    );
    assert.match(
      (await page.locator('.sky-lens-now').textContent()) ?? '',
      /Nearest to /,
      'the lens on a link is its nearest',
    );
    const lensDoor = page.locator('.sky-door');
    await lensDoor.first().waitFor({ state: 'attached', timeout: 15000 });
    await page.screenshot({ path: shot(name, `${chosen}lens`) });
    await lensDoor.first().dispatchEvent('click');
    await page.waitForURL(
      (url) =>
        /^\/links\/[0-9a-f]{12}\/$/.test(url.pathname) &&
        url.pathname !== chosen,
    );
    // A topic's name on the sky opens the topic, a lens too.
    await page.locator('.sky-topic').first().dispatchEvent('click');
    await page.waitForURL((url) =>
      /^\/topics\/[a-z0-9-]+\/$/.test(url.pathname),
    );
    assert.ok(await lensAt(new URL(page.url()).pathname), 'a topic is a lens');
    await page
      .locator('.sky-found[data-star]')
      .first()
      .waitFor({ state: 'attached', timeout: 15000 });
    const year = `/years/${record.saved.slice(0, 4)}/`;
    const month = `#${record.saved.slice(0, 7)}`;
    assert.ok(await lensAt(year + month), 'a year is a lens');
    assert.equal(new URL(page.url()).hash, month, 'and keeps its month');
    const timeButton = page.locator('[data-layout="time"]');
    assert.equal(
      await timeButton.getAttribute('aria-pressed'),
      'true',
      'a year opens in Time',
    );
    assert.equal(new URL(page.url()).search, '', 'with nothing to say so');
    await page.locator('[data-layout="meaning"]').click();
    await page.waitForURL(
      (url) => url.searchParams.get('view') === 'meaning' && url.hash === month,
    );
  } else {
    assert.ok(
      await page.locator('.site-header').isVisible(),
      'without the sky a lens page keeps its header',
    );
    assert.ok(await page.locator('[data-sky]').isHidden(), 'and shows no sky');
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
  `Checked ${routes.length} routes, a search and its preview pane, a kind: search, /surprise/, a site: suggestion, the sky on the front page (Surprise me, Find, the address), a walk at /sky/ and the lens pages at desktop and phone widths${video ? ', the video facade' : ' (no video facts to check the facade on)'}${edge ? ', /links.db, the redirects and the 404' : ''}; evidence in ${output}`,
);
