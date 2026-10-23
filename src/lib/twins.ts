// The machine twins of a record, /links/<id>.json and /links/<id>.md: the
// same facts as the page, the Things I've built pattern. Every URL comes from
// data.ts.
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
  linkJsonPath,
  linkMarkdownPath,
  linkPath,
  waybackUrl,
} from './data.ts';

const ref = (link: Link) => ({
  id: link.id,
  title: link.title,
  url: link.url,
  record: absolute(linkPath(link.id)),
});

export function linkJson(link: Link) {
  const c = connectionsOf(link);
  return {
    id: link.id,
    url: link.url,
    title: link.title,
    note: link.note,
    voice: link.voice,
    saved: link.saved,
    host: link.host,
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
    },
    elsewhere: {
      wayback: waybackUrl(link.url),
    },
  };
}

const item = (link: Link) =>
  `- [${link.title.replace(/[\\[\]]/g, '\\$&')}](${absolute(linkPath(link.id))}) (${link.host}, ${dateLabel(link.saved)})`;

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
        : '## What Jamie wrote',
      '',
      link.note.trim(),
    );
  }
  if (appears.length) {
    out.push('', '## Appears in', '');
    for (const a of appears)
      out.push(
        `- [${issueLabel(a.issue)}: ${issueTitle(a.issue)}](${a.issue.url})${a.section ? `, ${a.section}` : ''}`,
      );
  }
  const rows: [string, Link[]][] = [
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
