// /sky/: the pure helpers the page draws with (src/lib/sky.ts), the topic
// names (src/lib/topics.ts, content/topics.md) and the stars file as the
// build writes it (src/lib/stars.ts). Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cut,
  dayLabel,
  dayOf,
  distribute,
  lookAt,
  multiply,
  nextStop,
  nextTopic,
  perspective,
  project,
  reason,
  shift,
  staggered,
  yearOf,
} from '../src/lib/sky.ts';
import { checkTopics, parseTopics } from '../src/lib/topics.ts';
import { constellations, skyDocument } from '../src/lib/stars.ts';
import { skyTopics, stars } from '../src/lib/data.ts';

test('the morph: every star leaves at 0 and arrives at 1, the early years first', () => {
  for (const delay of [0, 0.3, 1]) {
    assert.equal(staggered(0, delay), 0);
    assert.equal(staggered(1, delay), 1);
  }
  assert.ok(staggered(0.4, 0) > staggered(0.4, 1));
  let last = 0;
  for (let mix = 0; mix <= 1; mix += 0.05) {
    const t = staggered(mix, 0.5);
    assert.ok(t >= last);
    last = t;
  }
});

test('days: Central calendar days as numbers, years as decimals', () => {
  assert.equal(dayOf('1970-01-02'), 1);
  assert.equal(yearOf(dayOf('2015-01-01')), 2015);
  assert.ok(Math.abs(yearOf(dayOf('2015-07-02')) - 2015.5) < 0.01);
  assert.equal(dayLabel(dayOf('2026-10-24')), 'Oct 24, 2026');
});

test('the camera: what it looks at lands where the lens shift puts it', () => {
  const view = lookAt([0, 0, 10], [0, 0, 0]);
  const at = { x: 0, y: 0, w: 0, behind: false };
  const centred = multiply(perspective(1, 2, 0.1, 100), view);
  project(centred, [0, 0, 0], 800, 400, at);
  assert.deepEqual(
    [Math.round(at.x), Math.round(at.y), at.behind],
    [400, 200, false],
  );
  assert.ok(Math.abs(at.w - 10) < 1e-4);
  const moved = multiply(
    shift(perspective(1, 2, 0.1, 100), 480, 150, 800, 400),
    view,
  );
  project(moved, [0, 0, 0], 800, 400, at);
  assert.deepEqual([Math.round(at.x), Math.round(at.y)], [480, 150]);
  // Up is up, and a point behind the camera says so.
  project(moved, [0, 1, 0], 800, 400, at);
  assert.ok(at.y < 150);
  project(moved, [0, 0, 20], 800, 400, at);
  assert.ok(at.behind);
});

test('doors: each on the side where it lies, top, right, bottom, left', () => {
  const at = (angle, name) => ({ angle, name });
  const names = (sides) => sides.map((side) => side.map((door) => door.name));
  const up = -Math.PI / 2;
  assert.deepEqual(
    names(
      distribute(
        [at(Math.PI, 'left'), at(0, 'right'), at(up, 'up'), at(-up, 'down')],
        [5, 3, 5, 3],
      ),
    ),
    [['up'], ['right'], ['down'], ['left']],
  );
  // Six above with room for five: one moves to a side next to it.
  const six = [-2, -1.9, -1.7, -1.5, -1.3, -1.2].map((a, k) => at(a, `${k}`));
  const sides = distribute(six, [5, 3, 5, 3]);
  assert.equal(sides[0].length, 5);
  assert.equal(sides[1].length + sides[3].length, 1);
  assert.equal(sides[2].length, 0);
  // Read left to right along the top.
  assert.deepEqual(
    sides[0].map((d) => d.angle),
    [...sides[0].map((d) => d.angle)].sort((a, b) => a - b),
  );
  // On a phone every door goes in one list.
  assert.equal(distribute(six, [6, 0, 0, 0])[0].length, 6);
});

test('Play: hops far along the neighbours, and jumps every fifth hop or when it has seen them all', () => {
  const distance = (star) => star;
  const random = () => 0;
  assert.deepEqual(nextStop([1, 2, 3, 4, 5], new Set(), 5, distance, random), {
    jump: true,
  });
  assert.deepEqual(nextStop([1, 2], new Set([1, 2]), 1, distance, random), {
    jump: true,
  });
  for (const r of [0, 0.5, 0.99]) {
    const stop = nextStop([1, 2, 3, 4, 5], new Set([5]), 1, distance, () => r);
    assert.ok([4, 3, 2].includes(stop.hop), `hop ${stop.hop}`);
  }
  assert.equal(
    nextStop([1, 2, 3, 4, 5], new Set([5]), 1, distance, random).hop,
    4,
  );
});

test('Play: crosses to a constellation it has not visited, never the one it leaves', () => {
  const sizes = [100, 4, 9, 1];
  for (const r of [0, 0.3, 0.6, 0.999]) {
    const t = nextTopic(sizes, 0, new Set([2]), () => r);
    assert.ok([1, 3].includes(t), `topic ${t}`);
  }
  for (const r of [0, 0.5, 0.999])
    assert.notEqual(
      nextTopic(sizes, 1, new Set([0, 1, 2, 3]), () => r),
      1,
    );
});

test('the reason beside a door: a shared issue, then the same site', () => {
  const sky = { host: [0, 0, 1], issues: { 0: [12, 300], 2: [300] } };
  assert.equal(reason(sky, 0, 2), 'same issue, WT300');
  assert.equal(reason(sky, 0, 1), 'same site');
  assert.equal(reason(sky, 1, 2), '');
  assert.equal(cut('A short title', 40), 'A short title');
  assert.equal(
    cut('Words that run on past the room there is', 20),
    'Words that run on…',
  );
});

test('content/topics.md: families and names, and errors with their line', () => {
  const text = [
    '# Topics',
    '<!--',
    '- 9: an example inside the notes',
    '-->',
    '## Making',
    '- 0: Woodworking',
    '- 2: 3D printing',
    '## Reading',
    '- 1: Books',
  ].join('\n');
  const parsed = parseTopics(text, 'topics.md');
  assert.deepEqual(parsed.families, ['Making', 'Reading']);
  assert.deepEqual(parsed.topics.get(2), { name: '3D printing', family: 0 });
  assert.equal(parsed.topics.get(1).family, 1);
  assert.equal(parsed.topics.has(9), false);
  assert.equal(checkTopics(parsed, 3, 'topics.md'), parsed);
  assert.throws(
    () => checkTopics(parsed, 2, 'topics.md'),
    /names topic 2, which the sky does not have/,
  );
  assert.throws(
    () => checkTopics(parsed, 4, 'topics.md'),
    /no name for topic 3/,
  );
  const fails = (lines, pattern) =>
    assert.throws(() => parseTopics(lines.join('\n'), 'topics.md'), pattern);
  fails(
    ['# Topics', '## A', '- 0: x', '# Again'],
    /topics\.md:4: a second "# " title/,
  );
  fails(['## A', '- 0: x', 'stray words'], /topics\.md:3: not a "## " family/);
  fails(
    ['# Topics', '- 0: x'],
    /topics\.md:2: a topic before the first "## " family/,
  );
  fails(
    ['## A', '- 0: x', '- 0: y'],
    /topics\.md:3: topic 0 is named again \(first on line 2\)/,
  );
  fails(['## A', '## B', '- 0: x'], /the family "A" names no topic/);
  fails(['# Topics', ''], /no "## " family/);
  // Comments are blanked line for line, so a line number still points at the file.
  fails(['<!--', 'notes', '-->', '## A', 'stray'], /topics\.md:5:/);
});

test('/sky/stars.json: one star per placed link, every index in range', () => {
  const sky = skyDocument();
  const n = sky.ids.length;
  assert.equal(n, stars.size);
  assert.equal(new Set(sky.ids).size, n);
  for (const key of ['titles', 'host', 'day', 'note', 'topic', 'neighbors'])
    assert.equal(sky[key].length, n, key);
  assert.equal(sky.meaning.length, 3 * n);
  assert.equal(sky.time.length, 2 * n);
  assert.ok(sky.host.every((h) => h >= 0 && h < sky.hosts.length));
  assert.ok(sky.topic.every((t) => t >= 0 && t < sky.topics.length));
  assert.ok(sky.note.every((v) => v === 0 || v === 1));
  sky.neighbors.forEach((near, i) => {
    assert.ok(near.length <= 10);
    assert.ok(near.every((j) => j >= 0 && j < n && j !== i));
  });
  assert.equal(
    sky.topics.reduce((sum, t) => sum + t.size, 0),
    n,
  );
  assert.ok(
    Object.keys(sky.issues).every((i) => Number(i) < n && sky.issues[i].length),
  );
  // Places to a tenth, small enough to send.
  assert.ok(sky.meaning.every((v) => Math.round(v * 10) / 10 === v));
});

test('the constellations list every topic once, in its family, with links from it', () => {
  const listed = constellations().flatMap(({ topics }) => topics);
  assert.equal(listed.length, skyTopics.length);
  assert.equal(new Set(listed.map((t) => t.name)).size, skyTopics.length);
  for (const topic of listed) {
    assert.ok(topic.links.length > 0 && topic.links.length <= 3, topic.name);
    const id = skyTopics.findIndex((t) => t.name === topic.name);
    assert.equal(stars.get(topic.centre.id).topic, id, topic.name);
    for (const link of topic.links)
      assert.equal(stars.get(link.id).topic, id, topic.name);
  }
});
