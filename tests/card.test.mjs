// A record's share card (src/lib/card.ts): its URL, and the rule that only
// Jamie's own words reach it. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardNote, cardOf } from '../src/lib/card.ts';
import { appearances, links } from '../src/lib/data.ts';

const byVoice = (voice) => links.find((link) => link.voice === voice);

test('every record names its own card', () => {
  for (const link of links) {
    const { url, alt } = cardOf(link);
    assert.match(
      url,
      new RegExp(
        `^https://cards\\.thingelstad\\.com/links/links/${link.id}\\.png\\?v=[0-9a-f]{10}$`,
      ),
    );
    assert.ok(
      alt.startsWith(`${link.shown}, a link from ${link.host}`),
      link.id,
    );
  }
});

test("only Jamie's own words are on the card", () => {
  for (const voice of ['mixed', 'excerpt', 'agent']) {
    const link = byVoice(voice);
    assert.ok(link, voice);
    assert.equal(cardNote(link), '', voice);
    // A note the card doesn't show doesn't change it.
    assert.equal(
      cardOf({ ...link, note: `${link.note} more` }).url,
      cardOf(link).url,
      voice,
    );
    assert.ok(!cardOf(link).alt.includes("Jamie's note"), voice);
  }
  const jamie = byVoice('jamie');
  assert.ok(cardNote(jamie).length > 0);
  assert.ok(cardOf(jamie).alt.endsWith(", with Jamie's note"));
  assert.notEqual(
    cardOf({ ...jamie, note: `${jamie.note} more` }).url,
    cardOf(jamie).url,
  );
  const bare = links.find((link) => !link.hasNote);
  assert.equal(cardNote(bare), '');
});

test('the card changes with what it shows', () => {
  const link = links.find((one) => (appearances.get(one.id) ?? []).length > 0);
  const { url, alt } = cardOf(link);
  assert.match(alt, /, in (WT\d+|Special)/);
  assert.notEqual(cardOf({ ...link, shown: `${link.shown}!` }).url, url);
  assert.notEqual(cardOf({ ...link, host: `x.${link.host}` }).url, url);
  assert.notEqual(cardOf({ ...link, saved: '2005-01-01T12:00:00Z' }).url, url);
  // The card names its issues, so the same link out of them is another card.
  assert.notEqual(
    cardOf({ ...link, id: 'ffffffffffff' }).url.split('?')[1],
    url.split('?')[1],
  );
});
