// A record's share card (Jamie, 2026-10-25: "Linking Things link cards with
// Jamie-voice notes only"), drawn by cards.thingelstad.com from the record
// page itself: its h-entry gives the title (p-name), the host (p-host), the
// day saved (dt-published), the issues that carried it (p-issue) and, only
// when the note is Jamie's own words (p-voice "jamie"), the note (e-content).
// An excerpt, a mixed note or an agent's summary is never on the card.
//
// The page names its card as its og:image, with v a hash of what the card
// shows, so a record that changes gets a new card. The card maker draws only
// at the v the page names, so this is the only place it is computed.
//
// A lens page (an issue, a year, a site, a kind, a topic, /topics/, a day),
// the front page and /sky/ name a sky card (skyCardOf; Jamie, 2026-10-31:
// "Approved: build Linking Things sky cards (a sky layout on
// cards.thingelstad.com, then og:image on every lens page), counts on issues
// and finished years only, the whole-sky card on the front page and
// /sky/"), which the card maker draws from the page's h-feed (Layout.astro)
// over /sky/card.json: its kicker, its name, a count where the number is
// fixed, and the links it lists lit. About, Search, Newest and Stats keep
// the one share image (Layout.astro).
import { createHash } from 'node:crypto';
import {
  type Issue,
  type Link,
  appearances,
  dateLabel,
  issueLabel,
  issueTitle,
  linkPath,
  noteText,
  skyLayout,
  stars,
} from './data.ts';

export const CARDS = 'https://cards.thingelstad.com';

export interface Card {
  url: string;
  alt: string;
}

/** The note the card shows: Jamie's own words, or none. */
export const cardNote = (link: Link) =>
  link.hasNote && link.voice === 'jamie' ? noteText(link) : '';

const hash = (shown: unknown) =>
  createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 10);

export function cardOf(link: Link): Card {
  const issues = (appearances.get(link.id) ?? []).map((a) =>
    issueLabel(a.issue),
  );
  const saved = dateLabel(link.saved);
  const note = cardNote(link);
  const shown = [link.shown, link.host, saved, issues, note];
  const v = hash(shown);
  // /links/<id>/ is /links/links/<id>.png: the site's id, then the page's path.
  const url = `${CARDS}/links${linkPath(link.id).replace(/\/$/, '')}.png?v=${v}`;
  const alt = [
    `${link.shown}, a link from ${link.host} saved by Jamie Thingelstad on ${saved}`,
    issues.length ? `, in ${issues.join(', ')}` : '',
    note ? ", with Jamie's note" : '',
  ].join('');
  return { url, alt };
}

// What a lens card says (Layout.astro writes it into the page's h-feed).
export interface SkyCardFacts {
  // Small capitals above the name: "Weekly Thing 354 · October 24, 2026".
  kicker: string;
  headline: string;
  // Only where the number is fixed: an issue, a finished year.
  count?: number;
  // The links the page lists, which the card lights.
  ids?: string[];
}
export interface SkyCard extends Card, SkyCardFacts {
  count: number;
}

// The whole sky, on the front page and /sky/.
export const WHOLE_SKY: SkyCardFacts = {
  kicker: 'Every link since 2005',
  headline: 'Linking Things',
};

/** A lens page's card at path (the page's own, "/issues/354/"). Its v is a
 * hash of what the card shows: the words, the count, and the lit links with
 * a star (a link the nightly has not placed yet is not in the sky), in the
 * sky's layout, so a page that changes, or a sky laid out afresh, gets a new
 * card. */
export function skyCardOf(path: string, facts: SkyCardFacts): SkyCard {
  const { kicker, headline } = facts;
  const count = facts.count && facts.count > 0 ? facts.count : 0;
  const lit = [...new Set(facts.ids ?? [])]
    .filter((id) => stars.has(id))
    .sort();
  const v = hash([kicker, headline, count, skyLayout, lit]);
  // / is /links/index.png, /issues/354/ is /links/issues/354.png.
  const url = `${CARDS}/links${path === '/' ? '/index' : path.replace(/\/$/, '')}.png?v=${v}`;
  const alt = [
    `${kicker}: ${headline}`,
    count
      ? `, ${count.toLocaleString('en-US')} ${count === 1 ? 'link' : 'links'}`
      : '',
    lit.length
      ? ', lit as stars in the sky of every link Jamie Thingelstad has saved'
      : ', the sky of every link Jamie Thingelstad has saved',
  ].join('');
  return { url, alt, kicker, headline, count, ids: lit };
}

// An issue's subject, from "WT354 — A museum for nnxyz art", "Weekly Thing
// #200 / Developers, Org Design, Types", "Weekly Thing 300 / Traceroute" or
// "Special Thing #140 / Matching Donations": the words after the number.
const SUBJECT = /^(?:WT\d+ — |(?:Weekly|Special) Thing #?[^\s/]+ \/ )(.+)$/;
// A subject that is only a date ("Apr 21, 2018"), or an early issue's
// "Weekly Thing for May 13, 2017".
const DATED = /^(?:Weekly Thing for )?[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}$/;

/** An issue card's words: the issue and its day as the kicker and the
 * subject as the name, or, for an issue titled only with its day, the issue
 * as the kicker and the day as the name. */
export function issueCard(issue: Issue) {
  const name =
    issue.number === null ? 'Special Thing' : `Weekly Thing ${issue.number}`;
  const day = dateLabel(issue.date);
  const title = issueTitle(issue).trim();
  const subject = SUBJECT.exec(title)?.[1]?.trim() ?? title;
  if (!subject || DATED.test(subject)) return { kicker: name, headline: day };
  return { kicker: `${name} · ${day}`, headline: subject };
}
