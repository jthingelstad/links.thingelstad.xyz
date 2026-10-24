// The enrichment module (src/lib/enrichment.ts) over the fixture shards in
// tests/fixtures/enrichment: facts only, never whether a link works, and a
// missing shard, record or field is "not observed". Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.LINKS_ENRICHMENT = 'tests/fixtures/enrichment';
const e = await import('../src/lib/enrichment.ts');
const { linkById } = await import('../src/lib/data.ts');
const { linkJson, linkMarkdown } = await import('../src/lib/twins.ts');

// Words that would say whether a link or a host works.
const liveness =
  /"(alive|status|final_url|redirects|redirects_http|reachable|resolves|dns|https|error|content_type)"|does not resolve|Access Denied|vimeo\.com\/gone|example\.com\/moved/;

test('host facts: RDAP and the home page, nothing from dns or https', () => {
  const simon = e.hostFacts('simonwillison.net');
  assert.deepEqual(simon, {
    domain: 'simonwillison.net',
    registered: '2005-03-09',
    registrar: '123-Reg Limited',
    expires: '2028-03-09',
    homeTitle: 'Simon Willison’s Weblog',
    generator: undefined,
    feeds: [
      {
        type: 'atom',
        url: 'https://simonwillison.net/atom/everything/',
        title: 'Atom',
      },
    ],
    hcard: false,
    relMe: true,
    webmention: true,
  });
  const kottke = e.hostFacts('kottke.org');
  assert.equal(kottke.generator, 'WordPress 7.1');
  assert.equal(kottke.hcard, true);
  assert.deepEqual(kottke.feeds.map(e.feedLabel), ['RSS', 'JSON Feed']);
  // A home page that answered with an error tells nothing, and a host with
  // nothing else to show has no facts at all.
  assert.equal(e.hostFacts('nytimes.com'), undefined);
  assert.equal(e.hostFacts('example.org'), undefined);
  for (const facts of [simon, kottke])
    assert.doesNotMatch(JSON.stringify(facts), liveness);
});

test('dates: a calendar date is that day, a moment is Central, else as written', () => {
  assert.equal(e.calendarLabel('2005-03-09'), 'March 9, 2005');
  assert.equal(e.calendarLabel('2026-10-23T03:00:00Z'), 'October 22, 2026');
  assert.equal(e.calendarLabel('April 25, 2006'), 'April 25, 2006');
  assert.equal(e.calendarLabel('2006'), '2006');
  assert.equal(e.monthYearLabel('2026-03-01T03:00:00Z'), 'February 2026');
});

test('Wayback: first capture and count; the cap is a floor; none says nothing', () => {
  assert.equal(
    e.waybackLabel(e.waybackOf('2ee60e58343d')),
    'first captured March 2026, 3 captures',
  );
  assert.equal(
    e.waybackLabel(e.waybackOf('3ace28dd12ad')),
    'first captured January 2026, 10,000 or more captures',
  );
  assert.deepEqual(e.waybackOf('9207883516b6'), {
    first: undefined,
    last: undefined,
    count: 0,
    capped: false,
  });
  assert.equal(e.waybackLabel(e.waybackOf('9207883516b6')), undefined);
  assert.equal(e.waybackOf('413067378db1'), undefined);
  assert.equal(e.waybackLabel(undefined), undefined);
});

test('facts: a video is a facade with the player written from its id', () => {
  const video = e.factsOf('2ee60e58343d');
  assert.equal(video.kind, 'video');
  assert.equal(video.provider, 'youtube');
  assert.equal(
    video.embed,
    'https://www.youtube-nocookie.com/embed/1YLQPJd9OtU?autoplay=1',
  );
  // The stored thumbnail is shown only when the file is in public/.
  assert.equal(video.image, undefined);
  const vimeo = e.factsOf('8dcc2315482c');
  assert.equal(
    vimeo.embed,
    'https://player.vimeo.com/video/607528814?autoplay=1',
  );
  assert.doesNotMatch(JSON.stringify(e.factsJson(vimeo)), liveness);
  // One video saved under two addresses: each names the other.
  assert.deepEqual(
    e.alsoSavedAs(linkById.get('02088718eb1b')).map((link) => link.id),
    ['c1bd5109c817'],
  );
  assert.deepEqual(e.alsoSavedAs(linkById.get('2ee60e58343d')), []);
});

test('facts: repositories, gists, books and articles; failures are not shown', () => {
  const repo = e.factsOf('3ace28dd12ad');
  assert.equal(repo.fullName, 'Homebrew/BrewUI');
  assert.equal(repo.stars, 2712);
  assert.equal(repo.license, 'AGPL-3.0');
  assert.equal(repo.gist, false);
  const gist = e.factsOf('9207883516b6');
  assert.equal(gist.gist, true);
  assert.equal(gist.fileCount, 3);
  const book = e.factsOf('d4f3fa5ebc0b');
  assert.deepEqual(book.authors, ['Robert M. Pirsig']);
  assert.equal(book.openLibrary, 'https://openlibrary.org/isbn/0060589469');
  assert.equal(e.factsOf('d115de539ec9').title, 'Swatch Internet Time');
  // An adapter error, and a record for a link that is not public.
  assert.equal(e.factsOf('6125ba6588eb'), undefined);
  assert.equal(e.factsOf('000000000000'), undefined);
  assert.equal(e.enrichmentCounts.facts, 9);
});

test('twins carry the kind, the Wayback captures and the facts, no liveness', () => {
  const json = linkJson(linkById.get('3ace28dd12ad'));
  assert.equal(json.kind, 'repository');
  assert.deepEqual(json.wayback, {
    first: '2026-01-02T05:30:00Z',
    last: '2026-10-20T12:00:00Z',
    count: 10000,
    count_capped: true,
  });
  assert.equal(json.facts.full_name, 'Homebrew/BrewUI');
  const video = linkJson(linkById.get('02088718eb1b'));
  assert.deepEqual(
    video.connections.same_video.map((ref) => ref.id),
    ['c1bd5109c817'],
  );
  const md = linkMarkdown(linkById.get('2ee60e58343d'));
  assert.match(md, /## Facts/);
  assert.match(
    md,
    /- Kind: \[Video\]\(https:\/\/links\.thingelstad\.xyz\/kinds\/video\/\)/,
  );
  assert.match(md, /- Wayback Machine: first captured March 2026, 3 captures/);
  for (const id of [
    '2ee60e58343d',
    '3ace28dd12ad',
    '9207883516b6',
    'd4f3fa5ebc0b',
  ]) {
    const link = linkById.get(id);
    assert.doesNotMatch(JSON.stringify(linkJson(link)), liveness, id);
    assert.doesNotMatch(linkMarkdown(link), liveness, id);
  }
});
