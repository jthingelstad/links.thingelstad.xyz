// The whole public dataset as files (DIRECTION.md, "If Pinboard went away"
// and "The Librarian"): /links.json, /hosts.json and /issues.json, and the
// doorway for language models, /llms.txt (https://llmstxt.org), with every
// record in a file per year, /years/<yyyy>/llms.txt. Every URL comes from
// data.ts.
//
// links.json keeps each record exactly as data/links/<yyyy>.json has it,
// Pinboard's fields in Pinboard's order, plus its permalink, so the site is a
// lossless, Pinboard-shaped copy of every public bookmark.
import {
  type Link,
  type MirrorLink,
  absolute,
  appearances,
  counts,
  datasetPath,
  dateLabel,
  feedPath,
  hostPath,
  hosts,
  issueLabel,
  issuePath,
  issues,
  issueTitle,
  linkJsonPath,
  linkMarkdownPath,
  linkPath,
  links,
  newest,
  number,
  plural,
  site,
  yearLlmsPath,
  years,
} from './data.ts';
import { FEED_SIZE } from './feeds.ts';

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

// Every record for language models, in a file per year: the year's links
// newest first, each a few lines (title, URL, date and host, tags, the Weekly
// Thing issues it was in, its permalink) and then the note in full. The
// connections a twin lists (same host, same week) are left out; the twin at
// /links/<id>.md has them. Measured 2026-10-23, the largest year (2008) is
// 0.8 MB and all of them 10.5 MB; npm run validate:site fails a year past
// 4 MB, the size at which a year would be split by month instead.
export interface LlmsYear {
  year: number;
  path: string;
  links: Link[]; // newest first
  text: string;
  bytes: number;
}

const EXCERPT = "From the page (probably an excerpt, not Jamie's words):";

export function llmsRecord(link: Link) {
  const lines = [
    `## ${link.title.trim() || link.url}`,
    '',
    `- <${link.url}>`,
    `- Saved ${dateLabel(link.saved)}, ${link.host}`,
  ];
  if (link.tags.length) lines.push(`- Tags: ${link.tags.join(', ')}`);
  for (const a of appearances.get(link.id) ?? [])
    lines.push(
      `- In [${issueLabel(a.issue)}: ${issueTitle(a.issue)}](${a.issue.url})${a.section ? `, ${a.section}` : ''}`,
    );
  lines.push(`- Record: ${absolute(linkPath(link.id))}`);
  if (link.hasNote) {
    lines.push('');
    if (link.voice === 'excerpt') lines.push(EXCERPT, '');
    lines.push(link.note.trim());
  }
  return `${lines.join('\n')}\n`;
}

export function llmsYearText(year: number, list: Link[]) {
  const header = [
    `# Linking Things: ${year}`,
    '',
    `> The ${plural(list.length, 'link')} Jamie Thingelstad saved in ${year}, newest first. Each record gives its URL, the date saved (US Central) and host, its tags, the Weekly Thing issues it was in, its permalink, and then the note in full. The record's Markdown twin, \`/links/<id>.md\`, adds its connections. Every year is listed in [llms.txt](${absolute(datasetPath.llms)}).`,
    '',
  ].join('\n');
  return `${header}\n${list.map(llmsRecord).join('\n')}`;
}

// Built once, newest year first: llms.txt states each file's size.
let built: LlmsYear[] | undefined;
export function llmsYears(): LlmsYear[] {
  built ??= [...years].reverse().map((year) => {
    const list = newest.filter((link) => link.year === year);
    const text = llmsYearText(year, list);
    return {
      year,
      path: yearLlmsPath(year),
      links: list,
      text,
      bytes: Buffer.byteLength(text),
    };
  });
  return built;
}

export const sizeLabel = (bytes: number) =>
  bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

export function llmsTxt() {
  const a = absolute;
  const example = links[0];
  const files = llmsYears().map(
    (file) =>
      `- [${file.year}](${a(file.path)}): ${plural(file.links.length, 'link')}, ${sizeLabel(file.bytes)}`,
  );
  return `${[
    '# Linking Things',
    '',
    `> Every public link Jamie Thingelstad has saved since 2005, as a static database: ${number(counts.links)} links from ${number(counts.hosts)} hosts, ${span()}, one page per link and what connects them. Times are US Central.`,
    '',
    "Each link's record is at `/links/<id>/`, where `<id>` is the first 12 hex characters of the md5 of the URL exactly as saved, so anyone can compute it from a URL; a 404 means the link was never saved or is not public. Every record has a JSON twin at `/links/<id>.json` and a Markdown twin at `/links/<id>.md`. Notes from 2007 to 2016 are mostly excerpts from the page, not Jamie's words; the JSON twin carries that label as `voice`, and the files below mark each such note.",
    '',
    '## Data',
    '',
    `- [Every link](${a(datasetPath.links)}): ${number(counts.links)} public links, newest first, with every field as saved (id, hash, url, title, note, saved, tags, toread, meta) and the permalink`,
    `- [Hosts](${a(datasetPath.hosts)}): every host with its number of links, the first and latest saved, and its page`,
    `- [Weekly Thing issues](${a(datasetPath.issues)}): the links each of ${number(counts.issues)} issues of The Weekly Thing carried, joined to the saved links`,
    `- [JSON Feed](${a(feedPath('json'))}) and [RSS](${a(feedPath('rss'))}): the newest ${FEED_SIZE} links; every host page has its own pair at \`feed.json\` and \`feed.xml\` under its path, as in \`/hosts/<host>/feed.json\``,
    '',
    '## Every record, by year',
    '',
    `Each file holds the links saved that year, newest first: title, URL, date and host, tags, the Weekly Thing issues, the permalink, and the note in full. Newest year first.`,
    '',
    ...files,
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
    `- [Issues](${a('/issues/')}): every Weekly Thing issue and the links it carried`,
    `- [Hosts](${a('/hosts/')}): the sites linked most; every host has a page at \`/hosts/<host>/\``,
    '',
    '## Optional',
    '',
    `- [Sitemap](${a('/sitemap-index.xml')}): every page`,
  ].join('\n')}\n`;
}
