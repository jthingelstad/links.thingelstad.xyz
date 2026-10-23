// The whole public dataset as files (DIRECTION.md, "If Pinboard went away"
// and "The Librarian"): /links.json, /hosts.json and /issues.json, and the
// doorway for language models, /llms.txt and /llms-full.txt
// (https://llmstxt.org). Every URL comes from data.ts.
//
// links.json keeps each record exactly as data/links/<yyyy>.json has it,
// Pinboard's fields in Pinboard's order, plus its permalink, so the site is a
// lossless, Pinboard-shaped copy of every public bookmark.
import {
  type MirrorLink,
  absolute,
  counts,
  datasetPath,
  dateLabel,
  feedPath,
  hostPath,
  hosts,
  issuePath,
  issues,
  linkJsonPath,
  linkMarkdownPath,
  linkPath,
  links,
  newest,
  number,
  onThisDayPath,
  site,
} from './data.ts';
import { FEED_SIZE } from './feeds.ts';
import { linkMarkdown } from './twins.ts';

// Pinboard's fields, in the order the mirror writes them (docs/DATA.md).
const mirrorFields: (keyof MirrorLink)[] = [
  'id',
  'hash',
  'url',
  'title',
  'note',
  'saved',
  'tags',
  'toread',
  'meta',
];

// A JSON object with one row of its list per line: valid JSON that greps,
// diffs and streams well at sixteen thousand rows.
function rowsDocument(
  head: Record<string, unknown>,
  key: string,
  rows: unknown[],
) {
  const opening = JSON.stringify(head).slice(0, -1);
  const body = rows.map((row) => JSON.stringify(row)).join(',\n');
  return `${opening},${JSON.stringify(key)}:[\n${body}\n]}\n`;
}

// One build time for the three files.
const builtAt = new Date().toISOString();
const envelope = (generated: string, count: number) => ({
  site,
  generated,
  count,
});

// Newest first, as Pinboard's own posts/all returns them.
export function linksDocument(generated = builtAt) {
  const rows = newest.map((link) => ({
    ...Object.fromEntries(mirrorFields.map((field) => [field, link[field]])),
    permalink: absolute(linkPath(link.id)),
  }));
  return rowsDocument(envelope(generated, rows.length), 'links', rows);
}

// Most links first, as /hosts/ lists them.
export function hostsDocument(generated = builtAt) {
  const rows = hosts.map((host) => ({
    host: host.host,
    count: host.count,
    first: host.first,
    last: host.last,
    url: absolute(hostPath(host.host)),
  }));
  return rowsDocument(envelope(generated, rows.length), 'hosts', rows);
}

// The join, as data/derived/issues.json has it, with `page` for the issue's
// page here and `permalink` for each link that was saved (null when the issue
// link is not in Pinboard). `url` stays the issue on weekly.thingelstad.com.
export function issuesDocument(generated = builtAt) {
  const rows = issues.map((issue) => ({
    number: issue.number,
    slug: issue.slug,
    title: issue.title,
    subject: issue.subject,
    date: issue.date,
    url: issue.url,
    page: absolute(issuePath(issue)),
    links: issue.links.map((row) => ({
      ...row,
      permalink: row.id ? absolute(linkPath(row.id)) : null,
    })),
  }));
  return rowsDocument(
    {
      ...envelope(generated, rows.length),
      source: 'weekly.thingelstad.com archive front matter',
    },
    'issues',
    rows,
  );
}

const span = () =>
  `${dateLabel(counts.first ?? '')} to ${dateLabel(counts.last ?? '')}`;

export function llmsTxt() {
  const a = absolute;
  const example = links[0];
  const megabytes = Buffer.byteLength(llmsFullTxt()) / 1e6;
  const size = ` (${megabytes.toFixed(0)} MB)`;
  return `${[
    '# Linking Things',
    '',
    `> Every public link Jamie Thingelstad has saved since 2005, as a static database: ${number(counts.links)} links from ${number(counts.hosts)} hosts, ${span()}, one page per link and what connects them. Times are US Central.`,
    '',
    "Each link's record is at `/links/<id>/`, where `<id>` is the first 12 hex characters of the md5 of the URL exactly as saved, so anyone can compute it from a URL; a 404 means the link was never saved or is not public. Every record has a JSON twin at `/links/<id>.json` and a Markdown twin at `/links/<id>.md`. Notes from 2007 to 2016 are mostly excerpts from the page, not Jamie's words; the JSON twin carries that label as `voice`.",
    '',
    '## Data',
    '',
    `- [Every link](${a(datasetPath.links)}): ${number(counts.links)} public links, newest first, with every field as saved (id, hash, url, title, note, saved, tags, toread, meta) and the permalink`,
    `- [Hosts](${a(datasetPath.hosts)}): every host with its number of links, the first and latest saved, and its page`,
    `- [Weekly Thing issues](${a(datasetPath.issues)}): the links each of ${number(counts.issues)} issues of The Weekly Thing carried, joined to the saved links`,
    `- [JSON Feed](${a(feedPath('json'))}) and [RSS](${a(feedPath('rss'))}): the newest ${FEED_SIZE} links; every host page has its own pair at \`feed.json\` and \`feed.xml\` under its path, as in \`/hosts/<host>/feed.json\``,
    `- [Every record in full](${a(datasetPath.llmsFull)}): each record's Markdown twin, newest first, in one file${size}`,
    '',
    '## Records',
    '',
    `- [The first link saved](${a(linkPath(example.id))}), [as JSON](${a(linkJsonPath(example.id))}) and [as Markdown](${a(linkMarkdownPath(example.id))}): the shape of every record`,
    '',
    '## Pages',
    '',
    `- [Home](${a('/')}): a search box, the numbers, the newest links`,
    `- [Search](${a('/search/')}): full-text search over titles, notes and hosts, with \`site:\`, \`year:\` and \`wt:\``,
    `- [Years](${a('/years/')}): the links saved each year, by month`,
    `- [On this day](${a(onThisDayPath())}): the links saved on each calendar day, across the years`,
    `- [Issues](${a('/issues/')}): every Weekly Thing issue and the links it carried`,
    `- [Hosts](${a('/hosts/')}): the sites linked most; every host has a page at \`/hosts/<host>/\``,
    '',
    '## Optional',
    '',
    `- [Sitemap](${a('/sitemap-index.xml')}): every page`,
  ].join('\n')}\n`;
}

// Built once: llms.txt states its size.
let full: string | undefined;
export function llmsFullTxt() {
  if (full !== undefined) return full;
  const header = [
    '# Linking Things: every record',
    '',
    `> Every public link Jamie Thingelstad has saved, ${number(counts.links)} records, newest first, ${span()}. Each record below is its Markdown twin, the same text as \`/links/<id>.md\`. Times are US Central. The index is [llms.txt](${absolute(datasetPath.llms)}).`,
    '',
  ].join('\n');
  full = `${header}\n${newest.map((link) => linkMarkdown(link)).join('\n')}`;
  return full;
}
