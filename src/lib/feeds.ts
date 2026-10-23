// RSS 2.0 and JSON Feed 1.1 (DIRECTION.md, "Feeds"): the newest links for the
// site, and the same pair for every host. An item is the record: its
// permalink is the item's link and id, the destination URL opens the content,
// and the note follows, rendered as on the record page with record links made
// absolute. Dates are Central with their real offset. Every feed path comes
// from data.ts.
import {
  type FeedKind,
  type Host,
  type Link,
  absolute,
  feedPath,
  hostPath,
  hosts,
  linksByHost,
  newest,
  noteHtml,
  rfc3339Central,
  rfc822Central,
  linkPath,
} from './data.ts';
import { prepare } from './markdown.ts';
import { owner } from './sites.ts';

export const FEED_SIZE = 50;
const SITE_NAME = 'Linking Things';

export interface Feed {
  title: string;
  description: string;
  // The path of the page the feed follows; the feed files sit under it.
  page: string;
  // Newest first, at most FEED_SIZE.
  links: Link[];
}

export const siteFeed: Feed = {
  title: SITE_NAME,
  description:
    'The newest links Jamie Thingelstad has saved to Pinboard, with what Jamie wrote about them.',
  page: '/',
  links: newest.slice(0, FEED_SIZE),
};

// Every host page has its pair.
export const feedHosts: Host[] = hosts;
const withFeed = new Set(feedHosts.map((host) => host.host));
export const hasHostFeed = (host: string) => withFeed.has(host);

export function hostFeed(host: Host): Feed {
  return {
    title: `${host.host} · ${SITE_NAME}`,
    description: `Links Jamie Thingelstad has saved from ${host.host}, newest first.`,
    page: hostPath(host.host),
    links: [...(linksByHost.get(host.host) ?? [])]
      .reverse()
      .slice(0, FEED_SIZE),
  };
}

// <link rel="alternate"> entries for a page's <head>.
export const feedAlternates = (feed: Feed) =>
  (['rss', 'json'] as FeedKind[]).map((kind) => ({
    type: kind === 'rss' ? 'application/rss+xml' : 'application/feed+json',
    title: feed.title,
    href: feedPath(kind, feed.page),
  }));
export const siteFeedAlternates = feedAlternates(siteFeed);

const itemTitle = (link: Link) => link.title.trim() || link.url;

// XML 1.0 has no place for most control characters; drop them, then escape.
const xmlText = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const EXCERPT_LABEL = "From the page (probably an excerpt, not Jamie's words):";

// One item's content, rendered once however many feeds carry it.
const contents = new Map<string, { html: string; text: string }>();
function contentOf(link: Link) {
  let content = contents.get(link.id);
  if (content) return content;
  const html = [
    `<p><a href="${xmlText(link.url)}">${xmlText(link.url)}</a></p>`,
  ];
  const text = [link.url];
  if (link.hasNote) {
    if (link.voice === 'excerpt') {
      html.push(`<p>${xmlText(EXCERPT_LABEL)}</p>`);
      text.push(EXCERPT_LABEL);
    }
    html.push(noteHtml(link, true).trim());
    text.push(prepare(link.note));
  }
  content = { html: html.join('\n'), text: text.join('\n\n') };
  contents.set(link.id, content);
  return content;
}

export function rssFeed(feed: Feed) {
  const self = absolute(feedPath('rss', feed.page));
  const updated = feed.links[0]?.saved;
  const items = feed.links.map((link) => {
    const permalink = absolute(linkPath(link.id));
    return [
      '    <item>',
      `      <title>${xmlText(itemTitle(link))}</title>`,
      `      <link>${xmlText(permalink)}</link>`,
      `      <guid isPermaLink="true">${xmlText(permalink)}</guid>`,
      `      <pubDate>${rfc822Central(link.saved)}</pubDate>`,
      ...link.tags.map((tag) => `      <category>${xmlText(tag)}</category>`),
      `      <description>${xmlText(contentOf(link).html)}</description>`,
      '    </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlText(feed.title)}</title>`,
    `    <link>${xmlText(absolute(feed.page))}</link>`,
    `    <description>${xmlText(feed.description)}</description>`,
    '    <language>en-us</language>',
    // The newest item's date, so an unchanged feed builds to the same bytes.
    ...(updated
      ? [`    <lastBuildDate>${rfc822Central(updated)}</lastBuildDate>`]
      : []),
    '    <docs>https://www.rssboard.org/rss-specification</docs>',
    `    <atom:link href="${xmlText(self)}" rel="self" type="application/rss+xml"/>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

export function jsonFeed(feed: Feed) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.title,
    home_page_url: absolute(feed.page),
    feed_url: absolute(feedPath('json', feed.page)),
    description: feed.description,
    authors: [{ name: owner.name, url: owner.url }],
    language: 'en-US',
    items: feed.links.map((link) => {
      const permalink = absolute(linkPath(link.id));
      const { html, text } = contentOf(link);
      return {
        id: permalink,
        url: permalink,
        external_url: link.url,
        title: itemTitle(link),
        content_html: html,
        content_text: text,
        date_published: rfc3339Central(link.saved),
        ...(link.tags.length ? { tags: link.tags } : {}),
      };
    }),
  };
}

export const jsonFeedText = (feed: Feed) =>
  `${JSON.stringify(jsonFeed(feed), null, 2)}\n`;
