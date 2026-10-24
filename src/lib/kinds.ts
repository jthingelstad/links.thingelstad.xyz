// Kinds (DIRECTION.md, "Special hosts and kinds"): what a link is, from its
// host and path alone, never from a fetch. Every link has exactly one; the
// first rule that matches wins, in the order of `kinds`, and "page" is
// everything else. The record shows it, Pagefind filters on it (kind:video
// in search), and /kinds/<kind>/ lists each.
//
// No Node imports: the search script imports this file in the browser.
import { hostOf } from './normalize.ts';

export const kinds = [
  'video',
  'repository',
  'book',
  'paper',
  'article',
  'newsletter',
  'podcast',
  'page',
] as const;
export type Kind = (typeof kinds)[number];

// The words the pages use: `title` heads the kind's page and its row on
// /kinds/, `name` is one link's kind on its record, `about` says what the
// kind holds.
export const kindWords: Record<
  Kind,
  { title: string; name: string; about: string }
> = {
  video: { title: 'Videos', name: 'Video', about: 'YouTube and Vimeo.' },
  repository: {
    title: 'Repositories',
    name: 'Repository',
    about: 'GitHub repositories and gists.',
  },
  book: {
    title: 'Books',
    name: 'Book',
    about: 'Amazon pages for a book, by its ISBN.',
  },
  paper: { title: 'Papers', name: 'Paper', about: 'PDF files and arXiv.' },
  article: {
    title: 'Articles',
    name: 'Article',
    about: 'Wikipedia articles.',
  },
  newsletter: {
    title: 'Newsletters',
    name: 'Newsletter',
    about: 'Substack and Buttondown.',
  },
  podcast: {
    title: 'Podcasts',
    name: 'Podcast',
    about: 'Overcast, Apple Podcasts, Pocket Casts and Castro.',
  },
  page: {
    title: 'Pages',
    name: 'Page',
    about: 'Everything else: posts, articles and pages on the open web.',
  },
};

export const isKind = (value: string): value is Kind =>
  (kinds as readonly string[]).includes(value);

// The host on its own or under it (m.youtube.com is youtube.com).
const on = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

// github.com/<owner>/<repo> is a repository unless <owner> is one of
// GitHub's own sections (github.com/blog/..., github.com/features/...).
const githubSections = new Set([
  'about',
  'apps',
  'blog',
  'collections',
  'contact',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'readme',
  'search',
  'security',
  'settings',
  'site',
  'sponsors',
  'topics',
  'trending',
  'users',
]);

// An ASIN of ten characters that starts with a digit is an ISBN-10, a book.
const bookPath =
  /\/(?:dp|gp\/product|exec\/obidos\/ASIN)\/([0-9][0-9A-Za-z]{9})(?:[/?]|$)/;

// The host as the site files it (normalize.ts), without a port, and the
// path as saved, with no query or fragment.
function partsOf(url: string) {
  const host = hostOf(url).replace(/:\d*$/, '');
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url.trim());
  return { host, path: path?.[1] ?? '' };
}

export function kindOf(url: string): Kind {
  const { host, path } = partsOf(url);
  if (on(host, 'youtube.com') || host === 'youtu.be' || on(host, 'vimeo.com'))
    return 'video';
  if (host === 'gist.github.com') return 'repository';
  if (host === 'github.com') {
    const [owner, repo] = path.split('/').filter(Boolean);
    if (owner && repo && !githubSections.has(owner.toLowerCase()))
      return 'repository';
  }
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) && bookPath.test(path)) return 'book';
  if (/\.pdf$/i.test(path) || on(host, 'arxiv.org')) return 'paper';
  if (on(host, 'wikipedia.org')) return 'article';
  if (
    host.endsWith('.substack.com') ||
    host === 'buttondown.com' ||
    host === 'buttondown.email'
  )
    return 'newsletter';
  if (
    on(host, 'overcast.fm') ||
    host === 'podcasts.apple.com' ||
    on(host, 'pocketcasts.com') ||
    on(host, 'castro.fm')
  )
    return 'podcast';
  return 'page';
}

// The URL to show for a link (never its href, never its id): an Amazon
// address without the affiliate tag it was saved with.
export function withoutAffiliateTag(url: string) {
  const { host } = partsOf(url);
  if (!/(^|\.)amazon\.[a-z.]+$/.test(host)) return url;
  return url.replace(/([?&])tag=[^&#]*&?/, '$1').replace(/[?&](#|$)/, '$1');
}
