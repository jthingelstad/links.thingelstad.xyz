// The search grammar both searches share (src/lib/search-grammar.ts): the
// site's /search/ page in the browser and the MCP server's links_search.
// Run: npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  isCandidate,
  kindNamed,
  matcher,
  parse,
  searchTerm,
  units,
  wholeWords,
} from '../src/lib/search-grammar.ts';

const found = (title, host, content = '') => ({
  content,
  meta: { title, host },
});

test('words and phrases go to Pagefind; operators come out', () => {
  assert.deepEqual(parse('kubb "planet kubb" notation'), {
    text: 'kubb "planet kubb" notation',
    exclude: [],
  });
  assert.deepEqual(
    parse(
      'dns site:https://www.Example.com/path year:2012 wt:WT351 kind:video',
    ),
    {
      text: 'dns',
      site: 'example.com',
      year: '2012',
      issue: '351',
      kind: 'video',
      exclude: [],
    },
  );
  assert.equal(parse('SITE:MacStories.net').site, 'macstories.net');
  assert.equal(parse('wt:140-special').issue, '140-special');
});

test('-word and -"phrase" are exclusions, even an operator', () => {
  assert.deepEqual(parse('kubb -lawn -"Lawn Games" -site:x.com'), {
    text: 'kubb',
    exclude: ['lawn', 'lawn games', 'site:x.com'],
  });
});

test('a year that is not four digits and an unknown kind are dropped', () => {
  const query = parse('year:12 kind:nonsense dns');
  assert.equal(query.year, undefined);
  assert.equal(query.kind, undefined);
  assert.equal(query.text, 'dns');
});

test('kind: takes the kind or its title, and keeps the constant', () => {
  assert.equal(kindNamed('video'), 'video');
  assert.equal(kindNamed('videos'), 'video');
  assert.equal(kindNamed('repositories'), 'repository');
  assert.equal(kindNamed('Video'), undefined, 'parse lower-cases first');
  assert.equal(kindNamed('vid'), undefined);
});

test('the host is searched as words too, so site: alone finds its links', () => {
  assert.equal(
    searchTerm({ text: 'shortcuts', site: 'macstories.net' }),
    'shortcuts macstories net',
  );
  assert.equal(
    searchTerm({ text: '', site: 'macstories.net' }),
    'macstories net',
  );
  assert.equal(searchTerm({ text: 'dns' }), 'dns');
});

test('a candidate matched in the text, the title or the host', () => {
  assert.ok(isCandidate({ words: [3] }));
  assert.ok(isCandidate({ words: [], matchedMetaFields: ['title'] }));
  assert.ok(isCandidate({ words: [], matchedMetaFields: ['host'] }));
  assert.ok(!isCandidate({ words: [], matchedMetaFields: ['date', 'issue'] }));
  assert.ok(!isCandidate({ words: [] }));
});

test("each typed word's first three letters must start a word", () => {
  const kubb = found('Kubb tournament final', 'youtube.com', 'Lawn game.');
  assert.ok(matcher({ text: 'kubb', exclude: [] })(kubb));
  assert.ok(matcher({ text: 'kubbs tournaments', exclude: [] })(kubb));
  // Pagefind's fallback to a shorter prefix is refused here.
  assert.ok(!matcher({ text: 'kuzzzz', exclude: [] })(kubb));
  assert.ok(!matcher({ text: 'zxqvbnmw', exclude: [] })(kubb));
  // Inside a word does not count.
  assert.ok(!matcher({ text: 'ubb', exclude: [] })(kubb));
  // A "phrase" must appear whole, every word of it.
  assert.ok(!matcher({ text: 'kubb of "never seen"', exclude: [] })(kubb));
  // The host counts as text.
  assert.ok(matcher({ text: 'youtube', exclude: [] })(kubb));
  // Letters beyond ASCII.
  assert.ok(
    matcher({ text: 'über', exclude: [] })(found('Über alles', 'x.de')),
  );
});

test('site: is exact: the host or a host under it', () => {
  const on = (host, site) =>
    matcher({ text: '', site, exclude: [] })(found('t', host));
  assert.ok(on('youtube.com', 'youtube.com'));
  assert.ok(on('m.youtube.com', 'youtube.com'));
  assert.ok(!on('notyoutube.com', 'youtube.com'));
  assert.ok(!on('youtube.com.evil.net', 'youtube.com'));
  assert.ok(!on(undefined, 'youtube.com'));
  assert.ok(on(undefined, undefined));
});

test('-word excludes on the title, host and text', () => {
  const match = matcher({ text: 'kubb', exclude: ['lawn', 'youtube'] });
  assert.ok(!match(found('Kubb', 'x.com', 'A lawn game')));
  assert.ok(!match(found('Kubb', 'youtube.com')));
  assert.ok(match(found('Kubb', 'x.com', 'A garden game')));
});

test('the browser search uses this grammar rather than its own', () => {
  const script = readFileSync('src/scripts/search.ts', 'utf8');
  assert.match(script, /from '\.\.\/lib\/search-grammar\.ts'/);
  assert.doesNotMatch(script, /function parse\(|function matcher\(/);
  const server = readFileSync('src/mcp/search.ts', 'utf8');
  assert.match(server, /from '\.\.\/lib\/search-grammar\.ts'/);
});

test('a "quoted" word must appear whole; a bare word by its first three letters', () => {
  const editor = found('Editor.js', 'editorjs.io', 'A block-styled editor.');
  const edi = found('EDI/AS2 Components', 'nsoftware.com', 'For EDI and AS2.');
  assert.ok(matcher({ text: 'edi', exclude: [] })(editor));
  assert.ok(matcher({ text: 'edi', exclude: [] })(edi));
  assert.ok(!matcher({ text: '"edi"', exclude: [] })(editor));
  assert.ok(matcher({ text: '"EDI"', exclude: [] })(edi));
  // Every word of a phrase, whole; a mixed query needs both rules.
  const chain = found('Supply chains', 'x.com', 'The supply chain.');
  assert.ok(matcher({ text: '"supply chain"', exclude: [] })(chain));
  assert.ok(
    !matcher({ text: '"supply chains"', exclude: [] })(
      found('Supply chain', 'x.com'),
    ),
  );
  assert.ok(
    !matcher({ text: '"edi" supply', exclude: [] })(
      found('Editor supply', 'x.com'),
    ),
  );
  assert.ok(
    matcher({ text: '"edi" supply', exclude: [] })(
      found('EDI supply', 'x.com'),
    ),
  );
});

test('wholeWords: every typed word whole, bare or quoted; units as typed', () => {
  const whole = wholeWords('EDI components');
  assert.ok(whole(found('EDI/AS2 Components', 'nsoftware.com')));
  assert.ok(!whole(found('Editor components', 'x.com')));
  assert.ok(!whole(found('EDI', 'x.com', 'component')));
  assert.ok(wholeWords('go')(found('Go by example', 'x.com')));
  assert.ok(!wholeWords('go')(found('Google', 'x.com')));
  assert.ok(
    wholeWords('"supply chain" edi')(found('EDI supply chain', 'x.com')),
  );
  assert.deepEqual(units('EDI "supply chain" as2'), [
    'EDI',
    '"supply chain"',
    'as2',
  ]);
  assert.deepEqual(units(''), []);
});
