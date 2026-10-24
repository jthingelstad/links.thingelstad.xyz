// The search page's preview pane (src/lib/preview.ts, src/scripts/preview.ts)
// on the real data/: every note it builds is the note its record renders,
// its record links included, and what connects a link comes in the record's
// order. Run: npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as data from '../src/lib/data.ts';
import { noteTags, noteTree } from '../src/lib/markdown.ts';
import {
  mentionResolver,
  noteAttribute,
  recordId,
  sections,
  voiceLabels,
} from '../src/lib/preview.ts';
import { linkJson } from '../src/lib/twins.ts';

const escape = (text) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const html = (nodes) =>
  nodes
    .map((node) =>
      typeof node === 'string'
        ? escape(node)
        : `<${node.tag}${node.attrs.map(([name, value]) => ` ${name}="${escape(value)}"`).join('')}>` +
          (['br', 'hr'].includes(node.tag)
            ? ''
            : `${html(node.children)}</${node.tag}>`),
    )
    .join('');
// markdown-it puts a line break after its block tags; the tree has none.
const tidy = (text) => text.replace(/\n*(<\/?[a-z][^>]*>)\n*/g, '$1').trim();

const noted = data.links.filter((link) => link.hasNote);

test('the pane builds every note as its record renders it', () => {
  const differ = noted.filter(
    (link) =>
      tidy(html(noteTree(link.note, data.noteResolver(link)))) !==
      tidy(data.noteHtml(link)),
  );
  assert.ok(noted.length > 12000);
  assert.deepEqual(
    differ.slice(0, 3).map((link) => link.id),
    [],
    `${differ.length} notes differ`,
  );
});

test("the twin's mentions make the same record links the build does", () => {
  const mentioning = noted.filter(
    (link) => linkJson(link).connections.mentions.length,
  );
  assert.ok(mentioning.length > 150);
  for (const link of mentioning)
    assert.equal(
      html(
        noteTree(
          link.note,
          mentionResolver(linkJson(link).connections.mentions),
        ),
      ),
      html(noteTree(link.note, data.noteResolver(link))),
      link.id,
    );
});

test('every tag and attribute a note gives is one the pane sets', () => {
  const tags = new Set();
  const refused = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      tags.add(node.tag);
      for (const [name, value] of node.attrs)
        if (!noteAttribute(node.tag, name, value))
          refused.add(`${node.tag} ${name}=${value.slice(0, 40)}`);
      walk(node.children);
    }
  };
  for (const link of noted) walk(noteTree(link.note, data.noteResolver(link)));
  assert.deepEqual(
    [...tags].filter((tag) => !noteTags.has(tag)),
    [],
  );
  assert.deepEqual([...refused], []);
  // And what it refuses.
  assert.equal(noteAttribute('a', 'href', 'javascript:alert(1)'), false);
  assert.equal(noteAttribute('a', 'href', '//evil.example/'), false);
  assert.equal(noteAttribute('a', 'onclick', 'x'), false);
  assert.equal(noteAttribute('p', 'style', 'x'), false);
  assert.equal(noteAttribute('a', 'href', '/links/0123456789ab/'), true);
});

test('what connects a link comes in the record order, three to a group', () => {
  assert.equal(recordId('/links/0123456789ab/'), '0123456789ab');
  assert.equal(recordId('/links/0123456789ab/x'), undefined);
  const ref = (id) => ({ id, title: id, url: `https://example.com/${id}` });
  const twin = {
    id: 'aaaaaaaaaaaa',
    host: 'example.com',
    saved: '2019-01-01T03:00:00Z',
    connections: {
      same_host: { count: 8, nearest: ['b', 'c', 'd', 'e', 'f'].map(ref) },
      same_week: { count: 2, nearest: ['g', 'h'].map(ref) },
      mentions: [],
      mentioned_by: ['i', 'j', 'k', 'l'].map(ref),
      saved_twice: [ref('m')],
      same_video: [ref('m'), ref('n')],
    },
  };
  assert.deepEqual(
    sections(twin).map((s) => [
      s.heading,
      s.host,
      s.count,
      s.links.map((l) => l.id).join(''),
      s.more?.href,
      s.more?.text,
    ]),
    [
      ['Also saved as', undefined, undefined, 'n', undefined, undefined],
      ['Saved twice', undefined, undefined, 'm', undefined, undefined],
      [
        'Mentioned by',
        undefined,
        undefined,
        'ijk',
        '/links/aaaaaaaaaaaa/',
        'All 4 on its record',
      ],
      [
        'More from',
        'example.com',
        '9 links',
        'bcd',
        '/hosts/example.com/',
        'All 9 links from example.com',
      ],
      // Saved on New Year's Eve in Central.
      ['Saved the same week', undefined, '3 links', 'gh', undefined, undefined],
    ],
  );
  twin.connections.same_week = {
    count: 6,
    nearest: ['g', 'h', 'o', 'p'].map(ref),
  };
  assert.deepEqual(sections(twin).at(-1).more, {
    href: '/years/2018/#2018-12',
    text: 'Everything saved in December 2018',
  });
});

test('the search page loads the pane only on a wide screen, and builds it as text', () => {
  const search = readFileSync('src/scripts/search.ts', 'utf8');
  const pane = readFileSync('src/scripts/preview.ts', 'utf8');
  const page = readFileSync('src/pages/search.astro', 'utf8');
  assert.match(search, /import\('\.\/preview\.ts'\)/);
  assert.doesNotMatch(search, /^import .*preview/m);
  assert.match(search, /matchMedia\('\(min-width: 60rem\)'\)/);
  assert.match(page, /<aside[^>]*data-search-preview/);
  for (const source of [search, pane])
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(pane, /noteAttribute\(/);
});

test("the pane labels a note's voice in the record's words", () => {
  const record = readFileSync('src/pages/links/[id].astro', 'utf8').replace(
    /\s+/g,
    ' ',
  );
  for (const [voice, { heading, label }] of Object.entries(voiceLabels)) {
    assert.ok(record.includes(`'${voice}'`), voice);
    for (const words of [heading, label].filter(Boolean))
      assert.ok(record.includes(words), words);
  }
});
