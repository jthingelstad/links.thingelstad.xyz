// The one place the site's URLs are formed. data.ts re-exports all of it for
// the pages; the MCP server (src/mcp/) imports it directly, since it cannot
// read data/. Permalinks and twins depend on these never changing.
//
// No Node imports and no data: pure functions of what they are given.
import type { Kind } from './kinds.ts';

// What the paths need of an issue (data.ts has the whole Issue).
export interface IssueFacts {
  number: number | null;
  slug: string;
  title: string;
  subject: string;
  url: string;
}

export const site = 'https://links.thingelstad.xyz';
export const linkPath = (id: string) => `/links/${id}/`;
export const linkJsonPath = (id: string) => `/links/${id}.json`;
export const linkMarkdownPath = (id: string) => `/links/${id}.md`;
export const hostPath = (host: string) => `/hosts/${host}/`;
export const kindsPath = '/kinds/';
// Surprise me: a door that sends the reader to one record at random
// (src/pages/surprise.astro). Never indexed.
export const surprisePath = '/surprise/';
export const kindPath = (kind: Kind) => `${kindsPath}${kind}/`;

// An issue's key is its segment on weekly.thingelstad.com (/archive/<key>/):
// the number, or 140-special for the one special issue. /issues/<key>/ mirrors
// it (DIRECTION.md, "Pages").
export function issueKey(issue: Pick<IssueFacts, 'number' | 'slug' | 'url'>) {
  const key = /^https:\/\/weekly\.thingelstad\.com\/archive\/([^/]+)\/$/.exec(
    issue.url,
  )?.[1];
  if (!key || (issue.number !== null && key !== String(issue.number)))
    throw new Error(`issue ${issue.slug}: url ${issue.url} has no archive key`);
  return key;
}
export const issuePath = (issue: Pick<IssueFacts, 'number' | 'slug' | 'url'>) =>
  `/issues/${issueKey(issue)}/`;
export const yearPath = (year: number | string) => `/years/${year}/`;
export const monthAnchor = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, '0')}`;
export const monthPath = (year: number, month: number) =>
  `${yearPath(year)}#${monthAnchor(year, month)}`;
export const absolute = (path: string) => new URL(path, site).href;
// Feeds: the site's pair at the root, and every host's pair under its page
// (DIRECTION.md, "Pages"). `under` is the path of the page a feed follows.
export type FeedKind = 'rss' | 'json';
export const feedPath = (kind: FeedKind, under = '/') =>
  `${under}${kind === 'rss' ? 'feed.xml' : 'feed.json'}`;
// The whole public dataset and the doorway for language models.
export const datasetPath = {
  links: '/links.json',
  hosts: '/hosts.json',
  issues: '/issues.json',
  llms: '/llms.txt',
  // The SQLite file, built by tools/build_db.py into public/ (npm run db).
  db: '/links.db',
} as const;
// The list the search box suggests from (src/lib/suggest.ts): the search
// page's own file, shaped for it, not part of the dataset.
export const suggestPath = '/search/suggest.json';
// The MCP server, served by its own CloudFront behaviour (infra/site.json,
// /mcp*) rather than from the site bucket.
export const mcpPath = '/mcp';
export const aboutPath = '/about/';
// Every record for language models, a file per year beside the year's page
// (dataset.ts).
export const yearLlmsPath = (year: number) => `${yearPath(year)}llms.txt`;
// The newest links as a page, the site feed's links.
export const newestPath = '/newest/';

// Elsewhere: the Wayback Machine's copies of the destination.
export const waybackUrl = (url: string) =>
  `https://web.archive.org/web/*/${url}`;

// Issues are named like WT350; the one special issue has no number.
export const issueLabel = (issue: Pick<IssueFacts, 'number'>) =>
  issue.number === null ? 'Special' : `WT${issue.number}`;
// The issue as it was titled when it went out: its subject line, from
// "Weekly Thing for May 13, 2017" to "WT350 — Builders Puzzlers And Agents".
export const issueTitle = (issue: Pick<IssueFacts, 'subject' | 'title'>) =>
  issue.subject || issue.title;
