import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plainNote } from '../src/lib/markdown.ts';

// plainNote is the note as one line: note_text in the MCP, descriptions and
// snippets on the site. An inline element leaves no space behind, a quotation
// keeps its boundary.
test('an inline link, bold or code leaves no space before the punctuation', () => {
  assert.equal(
    plainNote(
      "Mentions [Dunbar's number](https://example.com/dunbar), and more.",
    ),
    "Mentions Dunbar's number, and more.",
  );
  assert.equal(
    plainNote('These need to be **hard** limits.'),
    'These need to be hard limits.',
  );
  assert.equal(
    plainNote('See [webmention.io](https://webmention.io).'),
    'See webmention.io.',
  );
  assert.equal(
    plainNote('Run `npm test` first; it is *quick*.'),
    'Run npm test first; it is quick.',
  );
  assert.equal(
    plainNote('Hard caps (see <https://example.com/caps>), not soft.'),
    'Hard caps (see https://example.com/caps), not soft.',
  );
});

test('a blockquote is set in curly quotes, so commentary and quotation stay apart', () => {
  assert.equal(
    plainNote(
      'I smiled.\n\n> **default hard budget caps**. These need to be **hard** limits.\n\nBy the way.',
    ),
    'I smiled. “default hard budget caps. These need to be hard limits.” By the way.',
  );
  // A quotation of several paragraphs is one quotation.
  assert.equal(plainNote('> One.\n>\n> Two.'), '“One. Two.”');
  // The 2012 HTML form reads the same.
  assert.equal(
    plainNote('<blockquote>The page said this.</blockquote>'),
    '“The page said this.”',
  );
  // Nested quotations keep their own marks.
  assert.equal(
    plainNote('> Outer\n>\n> > Inner\n\nMine.'),
    '“Outer “Inner”” Mine.',
  );
  // Two quotations around commentary.
  assert.equal(
    plainNote('> First.\n\nThen:\n\n> Second.'),
    '“First.” Then: “Second.”',
  );
});

test('blocks become spaces, entities are decoded, and the cut keeps a whole word', () => {
  assert.equal(
    plainNote('- a\n- b\n\n## Heading\n\nText.'),
    'a b Heading Text.',
  );
  assert.equal(plainNote('Tom & Jerry <3 "quotes"'), 'Tom & Jerry <3 "quotes"');
  assert.equal(plainNote('```\nnpm test\n```\n\nRuns.'), 'npm test Runs.');
  assert.equal(
    plainNote('The quick brown fox jumps over the lazy dog.', 20),
    'The quick brown fox…',
  );
  assert.equal(plainNote(''), '');
  assert.equal(plainNote('   \n  '), '');
});

// The shape of link-81b68c5ee25b: Jamie's sentence, a quoted passage with
// bold and straight quotes of its own, then Jamie again.
test('a mixed-voice note reads as commentary, quotation, commentary', () => {
  const note = [
    "I read this with a smile; I've added this to every agentic workload I run.",
    '',
    '> Here’s a product feature the world needs: **default hard budget caps**. Let me say “after $X/month, cut this off”. These need to be **hard** limits.',
    '',
    'By the way you can do this with the agentic loop having awareness.',
  ].join('\n');
  assert.equal(
    plainNote(note, Infinity),
    "I read this with a smile; I've added this to every agentic workload I run. “Here’s a product feature the world needs: default hard budget caps. Let me say “after $X/month, cut this off”. These need to be hard limits.” By the way you can do this with the agentic loop having awareness.",
  );
});

test('raw HTML in a note is text, never markup, and no tag survives the strip', () => {
  // The renderer escapes raw HTML, so a note's own tags come out as the words
  // they are; the renderer's tags are stripped to the last one.
  assert.equal(
    plainNote('A **bold** claim, <scr<script>ipt>alert(1)</script> said.'),
    'A bold claim, <scr<script>ipt>alert(1)</script> said.',
  );
  assert.equal(plainNote('> One\n>\n> > Two'), '“One “Two””');
});
