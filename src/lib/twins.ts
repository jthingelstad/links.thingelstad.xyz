// The machine twins of a record, /links/<id>.json and /links/<id>.md: the
// same facts as the page, the Things I've built pattern. Every URL comes from
// data.ts; the enrichment comes through enrichment.ts, so no liveness field
// can reach a twin.
import {
  type Link,
  absolute,
  appearances,
  connectionsOf,
  dateLabel,
  hostPath,
  issueLabel,
  issuePath,
  issueTitle,
  kindPath,
  linkJsonPath,
  linkMarkdownPath,
  linkPath,
  waybackUrl,
} from './data.ts';
import {
  type Facts,
  alsoSavedAs,
  calendarLabel,
  factsJson,
  factsOf,
  providerName,
  waybackLabel,
  waybackOf,
} from './enrichment.ts';
import { kindWords } from './kinds.ts';

const ref = (link: Link) => ({
  id: link.id,
  title: link.title,
  url: link.url,
  record: absolute(linkPath(link.id)),
});

// The Wayback Machine's captures as the twin carries them; count_capped
// only when the count is the CDX cap, a floor rather than a count.
function waybackJson(id: string) {
  const w = waybackOf(id);
  if (!w) return {};
  return {
    wayback: {
      first: w.first ?? null,
      last: w.last ?? null,
      count: w.count,
      ...(w.capped ? { count_capped: true } : {}),
    },
  };
}

export function linkJson(link: Link) {
  const c = connectionsOf(link);
  const facts = factsOf(link.id);
  return {
    id: link.id,
    url: link.url,
    title: link.title,
    note: link.note,
    voice: link.voice,
    saved: link.saved,
    host: link.host,
    kind: link.kind,
    tags: link.tags,
    record: absolute(linkPath(link.id)),
    markdown: absolute(linkMarkdownPath(link.id)),
    issues: (appearances.get(link.id) ?? []).map((a) => ({
      number: a.issue.number,
      slug: a.issue.slug,
      title: a.issue.title,
      date: a.issue.date,
      section: a.section,
      position: a.position,
      url: a.issue.url,
      page: absolute(issuePath(a.issue)),
    })),
    connections: {
      same_host: {
        count: c.sameHost.total,
        page: absolute(hostPath(link.host)),
        nearest: c.sameHost.nearest.map(ref),
      },
      same_week: {
        count: c.sameWeek.total,
        nearest: c.sameWeek.nearest.map(ref),
      },
      mentions: c.mentions.map(ref),
      mentioned_by: c.mentionedBy.map(ref),
      saved_twice: c.savedTwice.map(ref),
      ...(facts?.kind === 'video'
        ? { same_video: alsoSavedAs(link).map(ref) }
        : {}),
    },
    ...waybackJson(link.id),
    ...(facts ? { facts: factsJson(facts) } : {}),
    elsewhere: {
      wayback: waybackUrl(link.url),
    },
  };
}

const item = (link: Link) =>
  `- [${link.title.replace(/[\\[\]]/g, '\\$&')}](${absolute(linkPath(link.id))}) (${link.host}, ${dateLabel(link.saved)})`;

// The card's facts as Markdown lines.
function factLines(f: Facts) {
  const and = (names: string[]) =>
    names.length < 3
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const parts = (list: (string | false | undefined)[]) =>
    list.filter(Boolean).join(', ');
  switch (f.kind) {
    case 'video':
      return [
        `- Video: ${parts([f.title && `"${f.title}"`, f.author && `by ${f.author}`, providerName[f.provider]])} (id ${f.videoId})`,
      ];
    case 'repository': {
      const about = parts([
        f.language,
        f.stars !== undefined && `${f.stars.toLocaleString('en-US')} stars`,
        f.license,
        f.pushed && `last push ${dateLabel(f.pushed)}`,
        f.archived && 'archived',
        f.fork && 'a fork',
      ]);
      return [
        `- ${f.gist ? 'Gist' : 'Repository'}: ${f.fullName}${f.description ? `: ${f.description}` : ''}`,
        ...(about ? [`- About the repository: ${about}`] : []),
        ...(f.homepage ? [`- Homepage: <${f.homepage}>`] : []),
      ];
    }
    case 'book':
      return [
        `- Book: ${parts([f.title, f.authors.length > 0 && `by ${and(f.authors)}`, f.published && `published ${calendarLabel(f.published)}`, f.isbn && `ISBN ${f.isbn}`])}`,
        ...(f.openLibrary ? [`- Open Library: <${f.openLibrary}>`] : []),
      ];
    case 'article':
      return [`- From Wikipedia: ${parts([f.title, f.description])}`];
  }
}

export function linkMarkdown(link: Link) {
  const c = connectionsOf(link);
  const appears = appearances.get(link.id) ?? [];
  const out = [
    `# ${link.title}`,
    '',
    `<${link.url}>`,
    '',
    `- Host: [${link.host}](${absolute(hostPath(link.host))})`,
    `- Saved: ${dateLabel(link.saved)} (${link.saved})`,
    `- Record: ${absolute(linkPath(link.id))}`,
    `- JSON: ${absolute(linkJsonPath(link.id))}`,
  ];
  if (link.hasNote) {
    out.push(
      '',
      link.voice === 'excerpt'
        ? "## From the page (probably an excerpt, not Jamie's words)"
        : link.voice === 'agent'
          ? "## From an agent (a summary for Jamie's reading queue, not Jamie's words)"
          : '## What Jamie wrote',
      '',
      link.note.trim(),
    );
  }
  const facts = factsOf(link.id);
  const wayback = waybackLabel(waybackOf(link.id));
  out.push(
    '',
    '## Facts',
    '',
    `- Kind: [${kindWords[link.kind].name}](${absolute(kindPath(link.kind))})`,
    ...(facts ? factLines(facts) : []),
    ...(wayback ? [`- Wayback Machine: ${wayback}`] : []),
  );
  if (appears.length) {
    out.push('', '## Appears in', '');
    for (const a of appears)
      out.push(
        `- [${issueLabel(a.issue)}: ${issueTitle(a.issue)}](${a.issue.url})${a.section ? `, ${a.section}` : ''}`,
      );
  }
  const rows: [string, Link[]][] = [
    ['Also saved as', alsoSavedAs(link)],
    ['Saved twice', c.savedTwice],
    ['Mentions', c.mentions],
    ['Mentioned by', c.mentionedBy],
    ['Same host', c.sameHost.nearest],
    ['Saved the same week', c.sameWeek.nearest],
  ];
  for (const [heading, list] of rows) {
    if (list.length) out.push('', `## ${heading}`, '', ...list.map(item));
  }
  out.push(
    '',
    '## Elsewhere',
    '',
    `- Wayback Machine: ${waybackUrl(link.url)}`,
  );
  return `${out.join('\n')}\n`;
}
