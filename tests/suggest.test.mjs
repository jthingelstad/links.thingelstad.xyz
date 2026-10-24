// The search box's suggestions (src/lib/suggest.ts) and the word at the
// cursor they read (tokenAt in src/lib/search-grammar.ts), on a small list
// shaped like /search/suggest.json. Run: npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, siteName, tokenAt } from '../src/lib/search-grammar.ts';
import { complete, limit, settled, suggest } from '../src/lib/suggest.ts';

const data = {
  hosts: [
    ['youtube.com', 285],
    ['kottke.org', 80],
    ['theverge.com', 60],
    ['m.youtube.com', 12],
    ['bbc.co.uk', 9],
    ['kottke.example.net', 3],
    ['blog.kottke.org', 2],
    ['once.com', 1],
  ],
  issues: [
    ['353', 'Release Notes for Every Day', 'Oct 10, 2026', 19],
    ['352', 'Interviewing Otto for the Job', 'Oct 3, 2026', 20],
    ['350', 'Builders Puzzlers And Agents', 'Sep 19, 2026', 18],
    ['140-special', 'Special Thing #140', 'Mar 23, 2020', 4],
    ['35', 'Weekly Thing for January 6, 2018', 'Jan 6, 2018', 15],
    ['3', 'Weekly Thing for May 27, 2017', 'May 27, 2017', 0],
  ],
  years: [
    [2026, 900],
    [2012, 1500],
    [2011, 1200],
    [2005, 40],
  ],
  kinds: [
    ['video', 297],
    ['repository', 120],
    ['book', 80],
    ['paper', 0],
    ['page', 15690],
  ],
};
const at = (input, caret = input.length) =>
  suggest(input, tokenAt(input, caret), data);
const inserts = (input, caret) => at(input, caret).map((s) => s.insert);

test('tokenAt finds the word at the cursor and its operator', () => {
  assert.deepEqual(tokenAt('dns site:kot', 12), {
    start: 4,
    end: 12,
    text: 'site:kot',
    operator: 'site',
    value: 'kot',
  });
  // The cursor in the middle of a word takes the whole word.
  assert.equal(tokenAt('dns site:kottke.org year:20', 7).value, 'kottke.org');
  assert.equal(tokenAt('YEAR:2012', 3).operator, 'year');
  assert.deepEqual(tokenAt('dns ', 4), {
    start: 4,
    end: 4,
    text: '',
    value: '',
  });
  assert.equal(tokenAt('topic:dns').operator, undefined, 'not an operator');
  // Inside a phrase, and an exclusion, take no suggestions.
  assert.equal(tokenAt('"open site:kot'), undefined);
  assert.equal(tokenAt('"open web" site:kot').operator, 'site');
  assert.equal(tokenAt('-site:kot'), undefined);
});

test('the grammar and the suggestions name the same operators', () => {
  for (const op of ['site', 'year', 'wt', 'kind'])
    assert.equal(tokenAt(`${op}:x`).operator, op);
  assert.equal(siteName('https://www.Kottke.org/2012/'), 'kottke.org');
  assert.equal(parse('site:https://www.Kottke.org/2012/').site, 'kottke.org');
});

test('site: suggests the host, then hosts it starts, then parts, by count', () => {
  // kottke.org itself is what was typed, so it is left out.
  assert.deepEqual(inserts('site:kottke.org'), ['site:blog.kottke.org']);
  assert.deepEqual(inserts('site:kot'), [
    'site:kottke.org',
    'site:kottke.example.net',
    'site:blog.kottke.org',
  ]);
  assert.deepEqual(inserts('site:verge'), ['site:theverge.com']);
  assert.deepEqual(inserts('site:youtube'), [
    'site:youtube.com',
    'site:m.youtube.com',
  ]);
  assert.deepEqual(inserts('site:https://www.you'), [
    'site:youtube.com',
    'site:m.youtube.com',
  ]);
  assert.equal(at('site:').length, limit, 'the most-linked sites');
  assert.equal(at('site:')[0].insert, 'site:youtube.com');
  assert.equal(at('site:kot')[0].note, '80 links');
  assert.equal(at('site:once')[0].note, '1 link');
  assert.deepEqual(inserts('site:zzzz'), []);
});

test('year:, kind: and wt: suggest what there is, newest first', () => {
  assert.deepEqual(inserts('year:201'), ['year:2012', 'year:2011']);
  assert.deepEqual(inserts('year:'), [
    'year:2026',
    'year:2012',
    'year:2011',
    'year:2005',
  ]);
  assert.equal(at('year:2012')[0]?.insert, undefined, 'already typed');
  assert.deepEqual(
    inserts('kind:'),
    ['kind:video', 'kind:repository', 'kind:book', 'kind:page'],
    'a kind with no links is left out',
  );
  assert.deepEqual(inserts('kind:vi'), ['kind:video']);
  assert.deepEqual(inserts('kind:videos'), ['kind:video']);
  assert.equal(at('kind:b')[0].note, 'Books · 80 links');
  assert.deepEqual(inserts('wt:35'), ['wt:353', 'wt:352', 'wt:350']);
  assert.deepEqual(inserts('wt:wt352'), ['wt:352']);
  assert.deepEqual(inserts('wt:otto'), ['wt:352']);
  assert.deepEqual(inserts('wt:14'), ['wt:140-special']);
  assert.deepEqual(inserts('wt:special'), ['wt:140-special']);
  assert.deepEqual(
    inserts('wt:3'),
    ['wt:353', 'wt:352', 'wt:350', 'wt:35'],
    'an issue that carried no saved link is left out',
  );
  assert.equal(at('wt:352')[0]?.insert, undefined, 'already typed');
  assert.equal(
    at('wt:otto')[0].note,
    'Interviewing Otto for the Job · Oct 3, 2026 · 20 links',
  );
});

test('with other words in the box, the counts say they are totals', () => {
  assert.equal(at('site:kot')[0].note, '80 links');
  assert.equal(at('kubb site:kot')[0].note, '80 links in all');
  assert.equal(at('site:kot kubb', 8)[0].note, '80 links in all');
  assert.equal(at('kubb year:201')[0].note, '1,500 links in all');
  assert.equal(at('kubb ki')[0].note, 'videos, books, papers and more');
  assert.equal(
    at('kubb wt:otto')[0].note,
    'Interviewing Otto for the Job · Oct 3, 2026 · 20 links in all',
  );
});

test('a plain word offers the operator it spells and what it names', () => {
  assert.deepEqual(inserts('si'), ['site:']);
  assert.deepEqual(inserts('ye'), ['year:']);
  assert.deepEqual(inserts('wt'), ['wt:']);
  assert.deepEqual(inserts('s'), [], 'one letter is too few');
  assert.deepEqual(inserts('2012'), ['year:2012']);
  assert.deepEqual(inserts('1999'), []);
  assert.deepEqual(inserts('WT352'), ['wt:352']);
  // A site's own name, for sites with more than one link, two at most.
  assert.deepEqual(inserts('kottke'), [
    'site:kottke.org',
    'site:blog.kottke.org',
  ]);
  assert.deepEqual(inserts('bbc'), ['site:bbc.co.uk']);
  assert.deepEqual(inserts('once'), [], 'one link is not a site to offer');
  assert.deepEqual(inserts('verge'), [], 'part of a name is not its name');
  assert.deepEqual(inserts('dns'), []);
  // An empty word is the operators, which the box shows only when asked.
  assert.deepEqual(inserts(''), ['site:', 'year:', 'wt:', 'kind:']);
  assert.deepEqual(inserts('"kot'), []);
});

test('a half-typed operator waits; a finished one searches', () => {
  const ready = (input, list = data) => settled(tokenAt(input), list);
  assert.ok(ready('dns'));
  assert.ok(ready('dns '));
  assert.ok(!ready('site:'));
  assert.ok(!ready('site:kot'));
  assert.ok(ready('site:kottke.org'));
  assert.ok(ready('site:example.net'), 'a parent of a host');
  assert.ok(!ready('site:kot', undefined));
  assert.ok(ready('site:kottke.org', undefined), 'looks like a host');
  assert.ok(!ready('year:20'));
  assert.ok(ready('year:2012'));
  assert.ok(!ready('kind:vi'));
  assert.ok(ready('kind:videos'));
  assert.ok(!ready('wt:'));
  assert.ok(ready('wt:35'));
  assert.ok(ready('wt:140-special'));
});

test('taking a suggestion replaces the word and places the cursor', () => {
  const token = tokenAt('dns site:kot year:2012', 12);
  assert.deepEqual(
    complete('dns site:kot year:2012', token, 'site:kottke.org'),
    {
      value: 'dns site:kottke.org year:2012',
      caret: 20,
    },
  );
  assert.deepEqual(complete('dns kot', tokenAt('dns kot'), 'site:kottke.org'), {
    value: 'dns site:kottke.org ',
    caret: 20,
  });
  // An operator waits for its value: no space, the cursor after the colon.
  assert.deepEqual(complete('dns si', tokenAt('dns si'), 'site:'), {
    value: 'dns site:',
    caret: 9,
  });
});

test('the box is a combobox over the list, and the page names the file', () => {
  const page = readFileSync('src/pages/search.astro', 'utf8');
  assert.match(page, /role="combobox"/);
  assert.match(page, /aria-controls="search-suggest"/);
  assert.match(page, /id="search-suggest"[\s\S]*role="listbox"/);
  assert.match(page, /data-suggest=\{suggestPath\}/);
  const script = readFileSync('src/scripts/suggest.ts', 'utf8');
  assert.match(script, /from '\.\.\/lib\/suggest\.ts'/);
  // Suggestions are text, never markup.
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML/);
});
