// A record's share card (Jamie, 2026-10-25: "Linking Things link cards with
// Jamie-voice notes only"), drawn by cards.thingelstad.com from the record
// page itself: its h-entry gives the title (p-name), the host (p-host), the
// day saved (dt-published), the issues that carried it (p-issue) and, only
// when the note is Jamie's own words (p-voice "jamie"), the note (e-content).
// An excerpt, a mixed note or an agent's summary is never on the card.
//
// The page names its card as its og:image, with v a hash of what the card
// shows, so a record that changes gets a new card. The card maker draws only
// at the v the page names, so this is the only place it is computed. Every
// other page keeps the one share image (Layout.astro).
import { createHash } from 'node:crypto';
import {
  type Link,
  appearances,
  dateLabel,
  issueLabel,
  linkPath,
  noteText,
} from './data.ts';

export const CARDS = 'https://cards.thingelstad.com';

export interface Card {
  url: string;
  alt: string;
}

/** The note the card shows: Jamie's own words, or none. */
export const cardNote = (link: Link) =>
  link.hasNote && link.voice === 'jamie' ? noteText(link) : '';

export function cardOf(link: Link): Card {
  const issues = (appearances.get(link.id) ?? []).map((a) =>
    issueLabel(a.issue),
  );
  const saved = dateLabel(link.saved);
  const note = cardNote(link);
  const shown = [link.shown, link.host, saved, issues, note];
  const v = createHash('sha256')
    .update(JSON.stringify(shown))
    .digest('hex')
    .slice(0, 10);
  // /links/<id>/ is /links/links/<id>.png: the site's id, then the page's path.
  const url = `${CARDS}/links${linkPath(link.id).replace(/\/$/, '')}.png?v=${v}`;
  const alt = [
    `${link.shown}, a link from ${link.host} saved by Jamie Thingelstad on ${saved}`,
    issues.length ? `, in ${issues.join(', ')}` : '',
    note ? ", with Jamie's note" : '',
  ].join('');
  return { url, alt };
}
