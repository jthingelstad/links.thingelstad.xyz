// Titles as pages and feeds show them (src/lib/titles.ts), and the made-up
// clocks shown as a date alone (src/lib/data.ts). Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as data from '../src/lib/data.ts';
import { shownTitle, titleEndings } from '../src/lib/titles.ts';

const endings = titleEndings([
  {
    host: 'lethain.com',
    title: 'Staff engineer archetypes | Irrational Exuberance',
  },
  {
    host: 'lethain.com',
    title: 'Writing an engineering strategy | Irrational Exuberance',
  },
  { host: 'example.com', title: 'Part one - Notes' },
]);
const shown = (title, host) => shownTitle(title, host, endings);

test("a site's name on the end of a title is dropped", () => {
  assert.equal(shown("Social RSS | Seth's Blog", 'seths.blog'), 'Social RSS');
  assert.equal(
    shown('Diversity in Open Source Is Even Worse | WIRED', 'wired.com'),
    'Diversity in Open Source Is Even Worse',
  );
  assert.equal(
    shown('The Mac needs Shortcuts – Six Colors', 'sixcolors.com'),
    'The Mac needs Shortcuts',
  );
  // Shared by two links from the host, though not its name.
  assert.equal(
    shown('Staff engineer archetypes | Irrational Exuberance', 'lethain.com'),
    'Staff engineer archetypes',
  );
});

test('anything else is left as saved', () => {
  for (const [title, host] of [
    ['Part one - Notes', 'example.com'],
    ['Hello - World', 'other.org'],
    ['Apple | Apple', 'apple.com'],
    ['No separator here', 'seths.blog'],
    ['Mid-sentence hyphens-are-not-separators', 'sentence.com'],
  ])
    assert.equal(shown(title, host), title);
});

test('every link keeps its saved title, and a shown one', () => {
  for (const link of data.links) {
    assert.ok(link.shown.length > 0 || link.title.trim() === '', link.id);
    assert.ok(link.title.trim().startsWith(link.shown.trim()), link.id);
  }
});

test('a made-up clock is shown as the date alone', () => {
  const at = (saved) => data.links.find((link) => link.saved === saved);
  // 67 links an import stamped with one second.
  assert.equal(at('2010-12-05T12:21:18Z').clock, false);
  // On the hour exactly.
  assert.equal(at('2008-01-09T20:00:00Z').clock, false);
  // Real to the second, and real to the minute.
  assert.equal(at('2005-08-02T16:49:06Z').clock, true);
  assert.equal(at('2008-01-03T16:11:00Z').clock, true);
  assert.ok(data.links.filter((link) => !link.clock).length < 300);
});
