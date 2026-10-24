// Kinds (src/lib/kinds.ts): what a link is, from its host and path alone,
// and the Amazon display URL without its affiliate tag. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isKind,
  kindOf,
  kindWords,
  kinds,
  withoutAffiliateTag,
} from '../src/lib/kinds.ts';
import { kindPath, links, linksByKind } from '../src/lib/data.ts';

const cases = {
  video: [
    'https://www.youtube.com/watch?v=1YLQPJd9OtU',
    'https://m.youtube.com/watch?v=1YLQPJd9OtU',
    'https://youtu.be/1YLQPJd9OtU',
    'https://vimeo.com/607528814',
    'https://player.vimeo.com/video/607528814',
  ],
  repository: [
    'https://github.com/Homebrew/BrewUI',
    'https://github.com/Homebrew/BrewUI/issues/1',
    'https://www.github.com/unclebob/swarm-forge',
    'https://gist.github.com/aparente/e48c353755958621b3c0004593105a90',
  ],
  book: [
    'http://www.amazon.com/Zen-Art-Motorcycle-Maintenance-Inquiry/dp/0060589469',
    'https://www.amazon.com/gp/product/0060589469/ref=x',
    'https://www.amazon.co.uk/exec/obidos/ASIN/0060589469',
    'https://smile.amazon.com/dp/0060589469?tag=x-20',
  ],
  paper: [
    'https://arxiv.org/abs/2512.14012',
    'https://export.arxiv.org/pdf/2503.20821',
    'https://example.com/files/Report.PDF',
    'https://example.com/paper.pdf?download=1',
  ],
  article: [
    'https://en.wikipedia.org/wiki/Swatch_Internet_Time',
    'https://en.m.wikipedia.org/wiki/Fear_of_missing_out',
  ],
  newsletter: [
    'https://willd10.substack.com/p/what-is-linkedin',
    'https://buttondown.com/someone/archive/one/',
    'https://buttondown.email/someone/archive/one/',
  ],
  podcast: [
    'https://overcast.fm/+XutSdXfoA',
    'https://podcasts.apple.com/us/podcast/id123',
    'https://pocketcasts.com/podcast/x',
    'https://castro.fm/episode/x',
  ],
  page: [
    'https://github.com/blog/2392-introducing-code-owners',
    'https://github.com/features/actions',
    'https://github.com/mcp',
    'https://github.com/',
    'https://www.amazon.com/Echo-Dot/dp/B07XJ8C8F5',
    'https://www.amazon.com/',
    'https://substack.com/home',
    'https://kottke.org/26/10/a-post',
    'https://notyoutube.com/watch?v=x',
    'https://example.com/pdf/viewer',
    'not a url',
  ],
};

test('each rule, and everything else is a page', () => {
  for (const [kind, urls] of Object.entries(cases))
    for (const url of urls) assert.equal(kindOf(url), kind, url);
});

test('every kind has its words, a page and a place in the order', () => {
  assert.deepEqual(Object.keys(kindWords).sort(), [...kinds].sort());
  assert.equal(kinds.at(-1), 'page');
  for (const kind of kinds) {
    assert.ok(isKind(kind));
    assert.equal(kindPath(kind), `/kinds/${kind}/`);
    for (const word of Object.values(kindWords[kind]))
      assert.doesNotMatch(word, /pinboard/i);
  }
  assert.ok(!isKind('videos'));
});

test('every link has exactly one kind, and the kinds hold them all', () => {
  let total = 0;
  for (const kind of kinds) {
    const list = linksByKind.get(kind);
    assert.ok(list.every((link) => link.kind === kind));
    total += list.length;
  }
  assert.equal(total, links.length);
  for (const link of links) assert.equal(link.kind, kindOf(link.url));
});

test('the Amazon display URL drops the affiliate tag, nothing else', () => {
  assert.equal(
    withoutAffiliateTag('https://www.amazon.com/dp/0060589469?tag=jamie-20'),
    'https://www.amazon.com/dp/0060589469',
  );
  assert.equal(
    withoutAffiliateTag(
      'https://www.amazon.com/dp/0060589469?ie=UTF8&tag=jamie-20&linkCode=as2',
    ),
    'https://www.amazon.com/dp/0060589469?ie=UTF8&linkCode=as2',
  );
  assert.equal(
    withoutAffiliateTag(
      'https://www.amazon.com/dp/0060589469?ie=UTF8&tag=jamie-20',
    ),
    'https://www.amazon.com/dp/0060589469?ie=UTF8',
  );
  assert.equal(
    withoutAffiliateTag('https://www.amazon.com/dp/0060589469?tag=jamie-20#x'),
    'https://www.amazon.com/dp/0060589469#x',
  );
  // Not Amazon, or no tag: as saved.
  for (const url of [
    'https://example.com/?tag=keep',
    'https://www.amazon.com/dp/0060589469',
    'https://www.amazon.com/dp/0060589469?hashtag=keep',
  ])
    assert.equal(withoutAffiliateTag(url), url);
});
