// The preview pane on /search/ (src/scripts/preview.ts), the parts that need
// no page: a record's JSON twin as the pane reads it (src/lib/twins.ts writes
// it), its note's links to other saved links, and what connects it, in the
// record page's order. No Node imports and no data: the search script loads
// this in the browser, and tests/preview.test.mjs checks it on the real data.
import { centralDate } from './day.ts';
import { normalizeUrl } from './normalize.ts';
import { hostPath, linkPath, monthPath } from './paths.ts';

export interface Ref {
  id: string;
  title: string;
  url: string;
}
export interface TwinIssue {
  number: number | null;
  slug: string;
  title: string;
  url: string;
}
export interface Twin {
  id: string;
  url: string;
  title: string;
  note: string;
  voice: string;
  saved: string;
  host: string;
  kind: string;
  issues: TwinIssue[];
  connections: {
    same_host: { count: number; nearest: Ref[] };
    same_week: { count: number; nearest: Ref[] };
    mentions: Ref[];
    mentioned_by: Ref[];
    saved_twice: Ref[];
    same_video?: Ref[];
  };
}

// Whose words a note is, labelled as its record labels them (the record page
// writes the same words; tests/preview.test.mjs holds them together). A note
// in Jamie's voice has no label.
export const voiceLabels: Record<string, { heading: string; label?: string }> =
  {
    excerpt: { heading: 'From the page' },
    agent: {
      heading: 'From an agent',
      label:
        "A summary an agent wrote for Jamie's reading queue, not Jamie's words.",
    },
  };

// A search result's address is its record's, /links/<id>/.
export const recordId = (url: string) =>
  /^\/links\/([0-9a-f]{12})\/$/.exec(url)?.[1];

// The build makes a note's link a record link when it resolves to another
// saved link (noteResolver in data.ts); those are the twin's mentions, so a
// link is one of them when it is saved under that URL or normalises alike.
export function mentionResolver(mentions: Ref[]) {
  return (href: string) => {
    const hit =
      mentions.find((ref) => ref.url === href) ??
      mentions.find((ref) => normalizeUrl(ref.url) === normalizeUrl(href));
    return hit ? { path: linkPath(hit.id), title: hit.title } : null;
  };
}

// The attributes markdown-it gives a note, as the pane sets them: a link's
// address only when it is the web, mail or this site, and nothing else that
// could carry script.
export function noteAttribute(tag: string, name: string, value: string) {
  if (tag === 'a' && name === 'href')
    return /^(https?:|mailto:|\/(?!\/)|#)/i.test(value);
  if (tag === 'a')
    return name === 'title' || (name === 'class' && value === 'record-link');
  if (tag === 'ol') return name === 'start' && /^\d+$/.test(value);
  if (tag === 'code')
    return name === 'class' && /^language-[\w+#.-]+$/.test(value);
  if (tag === 'th' || tag === 'td')
    return name === 'style' && /^text-align:(left|right|center)$/.test(value);
  return false;
}

const number = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string) =>
  `${number(n)} ${n === 1 ? one : `${one}s`}`;
const monthName = (month: number) =>
  new Date(Date.UTC(2000, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });

export interface Section {
  heading: string;
  // "More from <host>": the host is set apart, as on the record.
  host?: string;
  // The links in the group, this one among them, as the record counts them.
  count?: string;
  links: Ref[];
  more?: { href: string; text: string };
}

// What connects the link, as its record lists it, `limit` to a group. A
// group with its own page links there; one without links to the record.
export function sections(twin: Twin, limit = 3): Section[] {
  const c = twin.connections;
  const record = linkPath(twin.id);
  const twice = new Set(c.saved_twice.map((ref) => ref.id));
  const listed = (heading: string, refs: Ref[]): Section[] =>
    refs.length
      ? [
          {
            heading,
            links: refs.slice(0, limit),
            ...(refs.length > limit
              ? {
                  more: {
                    href: record,
                    text: `All ${number(refs.length)} on its record`,
                  },
                }
              : {}),
          },
        ]
      : [];
  const out = [
    ...listed(
      'Also saved as',
      (c.same_video ?? []).filter((ref) => !twice.has(ref.id)),
    ),
    ...listed('Saved twice', c.saved_twice),
    ...listed('Mentioned by', c.mentioned_by),
  ];
  const host = c.same_host;
  if (host.count > 0) {
    const links = host.nearest.slice(0, limit);
    out.push({
      heading: 'More from',
      host: twin.host,
      count: plural(host.count + 1, 'link'),
      links,
      ...(host.count > links.length
        ? {
            more: {
              href: hostPath(twin.host),
              text: `All ${plural(host.count + 1, 'link')} from ${twin.host}`,
            },
          }
        : {}),
    });
  }
  const week = c.same_week;
  if (week.count > 0) {
    const links = week.nearest.slice(0, limit);
    const [year, month] = centralDate(new Date(twin.saved))
      .split('-')
      .map(Number);
    out.push({
      heading: 'Saved the same week',
      count: plural(week.count + 1, 'link'),
      links,
      ...(week.count > links.length
        ? {
            more: {
              href: monthPath(year, month),
              text: `Everything saved in ${monthName(month)} ${year}`,
            },
          }
        : {}),
    });
  }
  return out;
}
