// The front page's quote of the day (src/lib/quotes.ts, content/quotes.md).
// Run: npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseQuotes,
  quoteOfTheDay,
  quotes,
  QUOTES_FILE,
} from '../src/lib/quotes.ts';

test('content/quotes.md parses; with no entries there is no quote', () => {
  assert.deepEqual(quotes, parseQuotes(readFileSync(QUOTES_FILE, 'utf8')));
  if (!quotes.length) assert.equal(quoteOfTheDay(), undefined);
  else assert.ok(quotes.includes(quoteOfTheDay()));
});

test('entries: a blockquote, then Who and Source', () => {
  const text = [
    '# Quotes',
    '',
    '<!--',
    '> An example inside the notes is not a quote.',
    'Who: Nobody',
    '-->',
    '',
    '> The first words',
    '> run on.',
    '>',
    '> A second paragraph.',
    '',
    'Who: Someone',
    'Source: https://example.com/a',
    '',
    '> Another.',
    'Who: Someone Else',
    'Source: http://example.org/b?c=d',
  ].join('\n');
  assert.deepEqual(parseQuotes(text), [
    {
      words: ['The first words run on.', 'A second paragraph.'],
      who: 'Someone',
      source: 'https://example.com/a',
    },
    {
      words: ['Another.'],
      who: 'Someone Else',
      source: 'http://example.org/b?c=d',
    },
  ]);
  assert.deepEqual(parseQuotes(''), []);
  assert.deepEqual(parseQuotes('# Quotes\n\n<!-- notes -->\n'), []);
});

test('a malformed entry fails with its line', () => {
  for (const [text, why] of [
    ['> Words\nSource: https://example.com/', /:2: the quote has no "Who:"/],
    ['> Words\nWho: A', /:2: the quote has no "Source:"/],
    ['> Words\nWho: A\nSource: ftp://example.com/', /:3: "Source:" is not/],
    ['Who: A', /:1: "Who:" before any quoted words/],
    ['Some words', /:1: not part of a quote/],
    ['> Words\nWho:\nSource: https://example.com/', /:2: "Who:" is empty/],
    ['> W\nWho: A\nWho: B\nSource: https://e.com/', /:3: a second "Who:"/],
  ])
    assert.throws(() => parseQuotes(text), why);
});

test('a quote is the same all day, in Central', () => {
  // quoteOfTheDay picks from the file's entries with ofTheDay (day.ts).
  const day = quoteOfTheDay(new Date('2026-10-23T11:00:00Z'));
  assert.equal(day, quoteOfTheDay(new Date('2026-10-24T04:00:00Z')));
});
