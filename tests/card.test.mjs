// A record's share card (src/lib/card.ts): its URL, and the rule that only
// Jamie's own words reach it; and a lens page's sky card: its URL, its v and
// an issue's words. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WHOLE_SKY,
  cardNote,
  cardOf,
  issueCard,
  skyCardOf,
} from '../src/lib/card.ts';
import { appearances, issues, links, stars } from '../src/lib/data.ts';

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

test('a lens page names its sky card at its own path', () => {
  const at = (path) => skyCardOf(path, WHOLE_SKY).url.split('?')[0];
  assert.equal(at('/'), 'https://cards.thingelstad.com/links/index.png');
  assert.equal(at('/sky/'), 'https://cards.thingelstad.com/links/sky.png');
  assert.equal(
    at('/issues/140-special/'),
    'https://cards.thingelstad.com/links/issues/140-special.png',
  );
  assert.equal(
    at('/hosts/www.nytimes.com/'),
    'https://cards.thingelstad.com/links/hosts/www.nytimes.com.png',
  );
  assert.match(skyCardOf('/', WHOLE_SKY).url, /\?v=[0-9a-f]{10}$/);
});

test("a sky card's v follows what it shows, and only that", () => {
  const placed = links.filter((link) => stars.has(link.id)).slice(0, 5);
  const ids = placed.map((link) => link.id);
  const facts = { kicker: 'Year', headline: '2012', count: 12, ids };
  const card = skyCardOf('/years/2012/', facts);
  const v = (f) => skyCardOf('/years/2012/', f).url;
  assert.deepEqual(card.ids, [...ids].sort());
  assert.equal(card.count, 12);
  assert.ok(card.alt.includes('Year: 2012, 12 links'), card.alt);
  // The same stars in another order, twice, or with a link not yet in the
  // sky draw the same card.
  assert.equal(v({ ...facts, ids: [...ids].reverse() }), card.url);
  assert.equal(v({ ...facts, ids: [...ids, ids[0]] }), card.url);
  assert.equal(v({ ...facts, ids: [...ids, '000000000000'] }), card.url);
  for (const other of [
    { ...facts, kicker: 'Years' },
    { ...facts, headline: '2013' },
    { ...facts, count: 13 },
    { ...facts, count: 0 },
    { ...facts, ids: ids.slice(1) },
  ])
    assert.notEqual(v(other), card.url, JSON.stringify(other).slice(0, 60));
  // No count, or none above zero, is none.
  assert.equal(skyCardOf('/years/2026/', { ...facts, count: -1 }).count, 0);
  assert.equal(skyCardOf('/', WHOLE_SKY).count, 0);
  assert.ok(!skyCardOf('/', WHOLE_SKY).alt.includes('links,'));
});

test("an issue's card: its number and day, then what it was about", () => {
  const by = (number) => issues.find((issue) => issue.number === number);
  const card = (issue, title) =>
    issueCard({
      ...issue,
      subject: title,
      title,
      date: '2026-10-24T12:00:00Z',
    });
  const one = by(354);
  assert.deepEqual(card(one, 'WT354 — A museum for nnxyz art'), {
    kicker: 'Weekly Thing 354 · October 24, 2026',
    headline: 'A museum for nnxyz art',
  });
  assert.equal(
    card(one, 'Weekly Thing #200 / Developers, Org Design').headline,
    'Developers, Org Design',
  );
  assert.equal(
    card(one, 'Weekly Thing 300 / Traceroute, Typst').headline,
    'Traceroute, Typst',
  );
  assert.equal(
    card(one, 'Weekly Thing #2^7 / Powers of Two').headline,
    'Powers of Two',
  );
  // Titled only with its day: the day is the name, once.
  for (const title of [
    'Weekly Thing #50 / Apr 21, 2018',
    'Weekly Thing for May 13, 2017',
  ])
    assert.deepEqual(card(one, title), {
      kicker: 'Weekly Thing 354',
      headline: 'October 24, 2026',
    });
  // The special issue has no number.
  assert.equal(
    card({ ...one, number: null }, 'Special Thing #140 / Matching Donations')
      .kicker,
    'Special Thing · October 24, 2026',
  );
  // Every issue gets words, and no title's number is left in its name.
  for (const issue of issues) {
    const { kicker, headline } = issueCard(issue);
    assert.ok(kicker && headline, issue.slug);
    assert.ok(!/^(WT\d|(Weekly|Special) Thing #?\d)/.test(headline), headline);
  }
});
