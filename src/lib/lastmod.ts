// The sitemap's <lastmod> for every page (astro.config.mjs): when the page's
// content last really changed, never when it was built. Search engines ignore
// a lastmod that is always "now".
//
// A record changed when it was saved, when a Weekly Thing issue carried it, and
// when a later link that mentions it, or the same URL saved again, was saved:
// those are on its page. A page that lists links (a host, a year, a kind, the
// home page) changed when the newest row it shows did (the day saved, the first
// issue); an issue on its date or when
// the newest link it lists was saved. /stats/ and /about/ count the whole
// collection, so they also take the import's change stamp (data/sync.json),
// which moves when any bookmark is edited.
//
// The data carries no edit date per link: a note written or changed after the
// link was saved is not seen here, only in the collection's change stamp.
import {
  aboutPath,
  absolute,
  appearances,
  hostPath,
  importedChange,
  issuePath,
  issues,
  kindPath,
  kindsPath,
  linkPath,
  links,
  linksByHost,
  linksByKind,
  linksByYear,
  mentionedBy,
  newestPath,
  savedTwice,
  skyPath,
  skyTopics,
  linkById,
  calendarDays,
  dayKey,
  linksByDayOfYear,
  onPath,
  topicPath,
  topicsPath,
  yearPath,
  type Link,
} from './data.ts';
import { topicLinks } from './stars.ts';

const newest = (dates: (string | null | undefined)[]) => {
  let best = 0;
  for (const date of dates) {
    const ms = date ? Date.parse(date) : NaN;
    if (Number.isNaN(ms) && date) throw new Error(`Not a date: ${date}`);
    if (ms > best) best = ms;
  }
  return best;
};
const savedOf = (ids: string[] | undefined) =>
  (ids ?? []).map((id) => linkById.get(id)?.saved);

const linkDate = new Map<string, number>(
  links.map((link) => [
    link.id,
    newest([
      link.saved,
      ...(appearances.get(link.id) ?? []).map((a) => a.issue.date),
      ...savedOf(mentionedBy.get(link.id)),
      ...savedOf(savedTwice.get(link.id)),
    ]),
  ]),
);
// A list's row shows the link, the day saved and the first issue that
// carried it (LinkList.astro).
const rowDate = new Map<string, number>(
  links.map((link) => [
    link.id,
    newest([link.saved, appearances.get(link.id)?.[0]?.issue.date]),
  ]),
);
const listDate = (list: Link[]) =>
  Math.max(0, ...list.map((link) => rowDate.get(link.id)!));

const everything = Math.max(
  listDate(links),
  newest(issues.map((issue) => issue.date)),
);
const collection = Math.max(everything, newest([importedChange]));

const pages = new Map<string, number>([
  ['/', everything],
  [newestPath, everything],
  ['/search/', everything],
  [skyPath, everything],
  ['/hosts/', everything],
  [kindsPath, everything],
  ['/years/', everything],
  ['/issues/', newest(issues.map((issue) => issue.date))],
  ['/stats/', collection],
  [aboutPath, collection],
]);
for (const link of links) pages.set(linkPath(link.id), linkDate.get(link.id)!);
for (const [host, list] of linksByHost)
  pages.set(hostPath(host), listDate(list));
for (const [year, list] of linksByYear)
  pages.set(yearPath(year), listDate(list));
pages.set(topicsPath, everything);
for (const { month, day } of calendarDays) {
  const list = linksByDayOfYear.get(dayKey(month, day)) ?? [];
  pages.set(onPath(month, day), list.length ? listDate(list) : everything);
}
for (const topic of skyTopics) {
  const list = topicLinks(topic.id);
  if (list.length) pages.set(topicPath(topic.name), listDate(list));
}
for (const [kind, list] of linksByKind)
  pages.set(kindPath(kind), list.length ? listDate(list) : everything);
for (const issue of issues)
  pages.set(
    issuePath(issue),
    newest([
      issue.date,
      ...issue.links.map((row) =>
        row.id ? linkById.get(row.id)?.saved : null,
      ),
    ]),
  );

// W3C datetime, UTC, to the second.
export const w3c = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The lastmod of an absolute page URL. A page the sitemap lists that has no
// date here is a bug: the build fails rather than leave it undated.
export const pageLastmod = new Map(
  [...pages].map(([path, ms]) => [absolute(path), w3c(ms)]),
);
export function lastmodOf(url: string) {
  const lastmod = pageLastmod.get(url);
  if (!lastmod || lastmod.startsWith('1970'))
    throw new Error(`No content date for sitemap page ${url}`);
  return lastmod;
}
