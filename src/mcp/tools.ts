// The seven tools (docs/DIRECTION.md, "Agents and the MCP"). Each answers a
// plain object that protocol.ts sends as structuredContent and as JSON text:
// `server_version` and `notes` in every answer, one id everywhere
// (`link-<12 hex>`), a permalink to cite, dates as the UTC instant plus the
// Central calendar day the site shows. A refusal is a ToolError with a code
// and one next step.
//
// Every field comes from the three public files (dataset.ts). Nothing here
// says whether a link still works.
import { type Kind, kindWords, kinds } from '../lib/kinds.ts';
import { plainNote } from '../lib/markdown.ts';
import type { Voice } from '../lib/voice.ts';
import {
  absolute,
  hostPath,
  issuePath,
  issueTitle,
  kindPath,
  linkJsonPath,
  linkMarkdownPath,
  linkPath,
  newestPath,
  yearPath,
} from '../lib/paths.ts';
import { centralDate } from '../lib/day.ts';
import {
  type Dataset,
  type Issue,
  type Link,
  hostNamed,
  issueNamed,
  onHost,
  resolveUrl,
} from './dataset.ts';
import type { Schema } from './schema.ts';
import {
  type Engine,
  NoSuchIssue,
  type SearchArgs,
  SearchUnavailable,
  searchLinks,
} from './search.ts';
import type { Snapshot, Store } from './store.ts';

// Bumps with any change to a tool's name, arguments or result shape, so a
// client that cached tools/list knows to fetch it again.
export const SERVER_VERSION = '1.1.0';

export class ToolError extends Error {
  code: string;
  next: string;
  extra: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    next: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.next = next;
    this.extra = extra;
  }
}

export interface Context {
  snapshot: Snapshot;
  engine: Engine;
  store: Store;
  now: () => Date;
}
export type Answer = Record<string, unknown> & { notes: string[] };
// `list` names the array a too-long answer is cut from (protocol.ts).
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  idempotent: boolean;
  list?: string;
  run(args: Record<string, unknown>, context: Context): Promise<Answer>;
}

const permalink = (id: string) => absolute(linkPath(id));
const issueNumber = (issue: Issue) => issue.number ?? issue.key;
const excerptNote =
  'A note whose voice is "excerpt" is most likely a passage from the linked page, not Jamie\'s words; "mixed" is commentary around a quotation.';
const agentNote =
  'A note whose voice is "agent" is a summary an agent wrote for Jamie\'s reading queue, not Jamie\'s words.';
const voiceNotes = (links: Link[], notes: string[]) => {
  if (links.some((link) => link.voice === 'excerpt' || link.voice === 'mixed'))
    notes.push(excerptNote);
  if (links.some((link) => link.voice === 'agent')) notes.push(agentNote);
};

// A link as every list shows it.
export function record(data: Dataset, link: Link) {
  return {
    id: `link-${link.id}`,
    url: link.url,
    title: link.title,
    note: link.hasNote ? plainNote(link.note, 400) : null,
    voice: link.voice,
    saved: link.saved,
    saved_date: link.day,
    host: link.host,
    kind: link.kind,
    tags: link.tags,
    issues: (data.appearances.get(link.id) ?? []).map((a) =>
      issueNumber(a.issue),
    ),
    permalink: permalink(link.id),
  };
}

function records(data: Dataset, links: Link[], notes: string[]) {
  voiceNotes(links, notes);
  return links.map((link) => record(data, link));
}

// Ids as given: 12 hex characters, or link-<12 hex>.
export const idPattern = '^(link-)?[0-9a-f]{12}$';
export const bareId = (id: string) => id.replace(/^link-/, '');

const limit = (fallback: number, max: number): Schema => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
  description: `How many to return, 1 to ${max} (default ${fallback}).`,
});
const offset: Schema = {
  type: 'integer',
  minimum: 0,
  maximum: 20000,
  default: 0,
  description:
    'How many to skip, for the next page: pass the next_offset of the last answer.',
};
const year: Schema = {
  type: 'integer',
  minimum: 2005,
  maximum: 2100,
  description: 'A year, in US Central time (links are saved from 2005).',
};
const kind: Schema = {
  type: 'string',
  enum: kinds,
  description: `What the link is, read from its address: ${kinds.join(', ')}.`,
};
const host: Schema = {
  type: 'string',
  minLength: 1,
  maxLength: 253,
  description:
    'A host such as macstories.net (a URL works too; www. is dropped). Hosts under it count: youtube.com includes m.youtube.com.',
};
const issue: Schema = {
  anyOf: [
    { type: 'integer', minimum: 1, maximum: 9999 },
    { type: 'string', minLength: 1, maxLength: 20 },
  ],
  description:
    'A Weekly Thing issue: its number (351, "WT351") or "140-special" for the one special issue.',
};

function page(total: number, offsetValue: number, shown: number) {
  return offsetValue + shown < total ? offsetValue + shown : null;
}

function noSuchIssue(value: unknown): never {
  throw new ToolError(
    'not_found',
    `There is no Weekly Thing issue ${String(value)}.`,
    'Call links_stats for the issue count, or links_issue with "latest" for the newest issue.',
  );
}

const searchTool: Tool = {
  name: 'links_search',
  title: 'Search the links',
  description:
    'Search every public link Jamie Thingelstad has saved since 2005 (titles, notes and hosts), with the site\'s own search index and grammar. The query takes words, "quoted phrases", -word to exclude, and the operators site:host, year:yyyy, wt:351 (a Weekly Thing issue) and kind:video; the other arguments do the same and win over the query. A bare word matches by its first letters (EDI finds Editor too) and a "quoted" word only whole ("EDI" finds EDI alone); by relevance, whole-word matches come first. With no words (a host, a year or an issue alone) the answer is exact and newest first. Results are ranked by relevance unless sort says otherwise. Cite a link by its permalink.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        maxLength: 500,
        description:
          'Words to find, with "phrases" (a "quoted" word is matched whole), -word, site:, year:, wt: and kind: as on the site\'s search page.',
      },
      year,
      host,
      kind,
      issue,
      tag: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description:
          'A tag exactly as saved. The few tags are filing marks such as _brief and _feature (links_stats lists them).',
      },
      toread: {
        type: 'boolean',
        description: 'Only links marked to read later (true) or not (false).',
      },
      in_weekly_thing: {
        type: 'boolean',
        description:
          'Only links a Weekly Thing issue carried (true), or only links none did (false).',
      },
      has_note: {
        type: 'boolean',
        description: 'Only links with a note (true) or without one (false).',
      },
      sort: {
        type: 'string',
        enum: ['relevance', 'newest', 'oldest'],
        description:
          'relevance (the default with words), newest (the default without) or oldest.',
      },
      limit: limit(25, 100),
      offset,
    },
  },
  idempotent: true,
  list: 'links',
  async run(args, { snapshot, engine, store }) {
    const search = (current: Snapshot) =>
      searchLinks(current.data, current.generation, engine, {
        ...(args as unknown as SearchArgs),
      });
    let current = snapshot;
    let answer;
    try {
      answer = await search(current);
      // A record the data does not have yet: the site was deployed since the
      // last check. Check now, and search again if the data changed.
      if (answer.unknown) {
        const fresh = await store.reload();
        if (fresh.generation !== current.generation) {
          current = fresh;
          answer = await search(current);
        }
      }
    } catch (error) {
      if (error instanceof NoSuchIssue) noSuchIssue(error.message);
      if (error instanceof SearchUnavailable)
        throw new ToolError(
          'search_unavailable',
          'The search index could not be read just now.',
          'Try again in a moment; links_list and links_search with no words (a host, a year or an issue) do not need the index.',
        );
      throw error;
    }
    const notes = answer.notes;
    return {
      total: answer.total,
      total_exact: answer.exact,
      offset: args.offset,
      links: records(current.data, answer.links, notes),
      next_offset: answer.nextOffset,
      notes,
    };
  },
};

const getTool: Tool = {
  name: 'links_get',
  title: 'Get one link',
  description:
    'One saved link in full, by its id (link-<12 hex>, or the 12 hex characters) or by its URL: the note as written (Markdown) and as plain text, its voice, every Weekly Thing issue that carried it with the section, any other saving of the same address, and its JSON and Markdown twins. A URL matches exactly as saved first, then by its normalised form (scheme, www, trailing slash and tracking parameters ignored).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: {
        type: 'string',
        pattern: idPattern,
        description: 'The link id, link-<12 hex> or the 12 hex characters.',
      },
      url: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description: 'The URL of the page that was saved.',
      },
    },
  },
  idempotent: true,
  async run(args, { snapshot }) {
    const data = snapshot.data;
    const notes: string[] = [];
    if ((args.id === undefined) === (args.url === undefined))
      throw new ToolError(
        'invalid_arguments',
        'Give exactly one of id or url.',
        'Call links_get with {"id": "link-<12 hex>"} or {"url": "https://..."}.',
        { accepted_arguments: ['id', 'url'] },
      );
    let link: Link | undefined;
    let matched = 'id';
    if (typeof args.id === 'string') link = data.byId.get(bareId(args.id));
    else {
      const found = resolveUrl(data, String(args.url));
      if (found) {
        link = data.byId.get(found.id);
        matched = found.exact ? 'url' : 'normalised url';
        if (!found.exact)
          notes.push(
            'No link was saved under exactly this URL; this one normalises alike (scheme, www, trailing slash or tracking parameters differ).',
          );
      }
    }
    if (!link)
      throw new ToolError(
        'not_found',
        args.id !== undefined
          ? `No public link has the id ${String(args.id)}.`
          : 'No public link was saved under this URL or its normalised form.',
        args.id !== undefined
          ? 'Ids are the first 12 hex characters of the md5 of the URL exactly as saved; links_search finds a link by its words.'
          : 'Call links_search with words from its title or site:<host> to look for it another way.',
      );
    const appears = data.appearances.get(link.id) ?? [];
    voiceNotes([link], notes);
    const twins = (data.savedTwice.get(link.id) ?? [])
      .map((id) => data.byId.get(id)!)
      .filter(Boolean)
      .map((other) => ({
        id: `link-${other.id}`,
        url: other.url,
        title: other.title,
        saved: other.saved,
        permalink: permalink(other.id),
      }));
    return {
      matched,
      link: {
        ...record(data, link),
        note: link.hasNote ? link.note : null,
        note_text: link.hasNote ? plainNote(link.note, Infinity) : null,
        toread: link.toread,
        appearances: appears.map((a) => ({
          issue: issueNumber(a.issue),
          title: issueTitle(a.issue),
          date: a.issue.date,
          date_central: centralDate(new Date(a.issue.date)),
          section: a.section,
          position: a.position,
          url: a.issue.url,
          page: absolute(issuePath(a.issue)),
        })),
        saved_twice: twins,
        host_links: data.byHost.get(link.host)?.length ?? 1,
        host_page: absolute(hostPath(link.host)),
        markdown: absolute(linkMarkdownPath(link.id)),
        json: absolute(linkJsonPath(link.id)),
      },
      notes,
    };
  },
};

const listTool: Tool = {
  name: 'links_list',
  title: 'List links',
  description:
    'Every link of one kind of group, newest first, a page at a time: by newest (the whole collection), year (a Central calendar year), host (exactly that host, as its page on the site lists it), kind, tag, or toread. Exact counts; no index needed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['by'],
    properties: {
      by: {
        type: 'string',
        enum: ['newest', 'year', 'host', 'kind', 'tag', 'toread'],
        description:
          'The group: newest, year, host, kind, tag or toread (newest and toread take no value).',
      },
      value: {
        anyOf: [
          { type: 'integer', minimum: 2005, maximum: 2100 },
          { type: 'string', minLength: 1, maxLength: 253 },
        ],
        description:
          'The year (2012), host (macstories.net), kind (video) or tag (_feature).',
      },
      limit: limit(25, 100),
      offset,
    },
  },
  idempotent: true,
  list: 'links',
  async run(args, { snapshot }) {
    const data = snapshot.data;
    const notes: string[] = [];
    const by = String(args.by);
    const value = args.value;
    const needsValue = by !== 'newest' && by !== 'toread';
    if (needsValue && value === undefined)
      throw new ToolError(
        'invalid_arguments',
        `links_list by ${by} needs a value.`,
        `Call links_list with {"by": "${by}", "value": ...}.`,
        { accepted_arguments: ['by', 'value', 'limit', 'offset'] },
      );
    if (!needsValue && value !== undefined)
      notes.push(`by ${by} takes no value; it was ignored.`);
    let list: Link[] = [];
    let pagePath: string | undefined;
    let group: Record<string, unknown> = {};
    if (by === 'newest') {
      list = data.newest;
      pagePath = newestPath;
    } else if (by === 'toread') list = data.newest.filter((l) => l.toread);
    else if (by === 'year') {
      const y = Number(value);
      if (!Number.isInteger(y))
        throw new ToolError(
          'invalid_arguments',
          'by year needs a four-digit year.',
          'Call links_list with {"by": "year", "value": 2012}.',
        );
      list = [...(data.byYear.get(y) ?? [])].reverse();
      if (list.length) pagePath = yearPath(y);
    } else if (by === 'host') {
      const name = hostNamed(String(value));
      const facts = data.hostByName.get(name);
      list = [...(data.byHost.get(name) ?? [])].reverse();
      if (!list.length)
        throw new ToolError(
          'not_found',
          `No link was saved from ${name}.`,
          `Call links_search with {"host": "${name}"} to include hosts under it, or links_stats for the top hosts.`,
        );
      pagePath = hostPath(name);
      group = facts
        ? {
            host: {
              host: name,
              links: facts.count,
              first: facts.first,
              last: facts.last,
            },
          }
        : {};
    } else if (by === 'kind') {
      const k = String(value) as Kind;
      if (!kinds.includes(k))
        throw new ToolError(
          'invalid_arguments',
          `${String(value)} is not a kind.`,
          `Use one of ${kinds.join(', ')}.`,
        );
      list = [...data.byKind.get(k)!].reverse();
      pagePath = kindPath(k);
      group = {
        kind: { kind: k, name: kindWords[k].name, about: kindWords[k].about },
      };
    } else if (by === 'tag') {
      const tag = String(value);
      list = [...(data.byTag.get(tag) ?? [])].reverse();
      if (!list.length)
        throw new ToolError(
          'not_found',
          `No link carries the tag ${tag}.`,
          'Call links_stats for the tags in use.',
        );
    }
    const off = Number(args.offset);
    const shown = list.slice(off, off + Number(args.limit));
    return {
      by,
      ...(needsValue ? { value } : {}),
      ...group,
      total: list.length,
      offset: off,
      links: records(data, shown, notes),
      next_offset: page(list.length, off, shown.length),
      ...(pagePath ? { page: absolute(pagePath) } : {}),
      notes,
    };
  },
};

const issueTool: Tool = {
  name: 'links_issue',
  title: 'One Weekly Thing issue',
  description:
    'One issue of The Weekly Thing, Jamie\'s newsletter, and the links it carried in the order it carried them, each with its section and, where it matches a saved link, the link\'s id and permalink. Takes the number (351, "WT351"), "140-special" for the one special issue, or "latest".',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['issue'],
    properties: {
      issue: {
        ...issue,
        description: `${issue.description} "latest" is the newest issue.`,
      },
    },
  },
  idempotent: true,
  list: 'links',
  async run(args, { snapshot }) {
    const data = snapshot.data;
    const notes: string[] = [];
    const named = String(args.issue).trim().toLowerCase();
    const found =
      named === 'latest'
        ? data.issues.reduce<Issue | undefined>(
            (best, i) => (!best || i.date > best.date ? i : best),
            undefined,
          )
        : issueNamed(data, args.issue as string | number);
    if (!found) noSuchIssue(args.issue);
    const rows = [...found.links].sort((a, b) => a.position - b.position);
    const links = rows.map((row) => {
      const link = row.id ? data.byId.get(row.id) : undefined;
      return {
        position: row.position,
        text: row.text,
        url: row.url,
        section: row.section || null,
        id: link ? `link-${link.id}` : null,
        permalink: link ? permalink(link.id) : null,
      };
    });
    const unmatched = links.filter((l) => !l.id).length;
    if (unmatched)
      notes.push(
        `${unmatched} of the issue's links match no saved link (often the newsletter's own sites, or an address saved in another form); they have no id.`,
      );
    return {
      issue: {
        number: issueNumber(found),
        title: issueTitle(found),
        date: found.date,
        date_central: centralDate(new Date(found.date)),
        url: found.url,
        page: absolute(issuePath(found)),
        links: links.length,
        matched: links.length - unmatched,
      },
      links,
      notes,
    };
  },
};

const statsTool: Tool = {
  name: 'links_stats',
  title: 'The collection in numbers',
  description:
    'The shape of the whole collection: totals, links per year, every kind with what it holds, the top hosts and the tags, the Weekly Thing issue count, and when the data was generated. A good first call.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: limit(20, 100),
    },
  },
  idempotent: true,
  list: 'top_hosts',
  async run(args, { snapshot }) {
    const data = snapshot.data;
    const n = Number(args.limit);
    const tags = [...data.byTag]
      .map(([tag, list]) => ({ tag, links: list.length }))
      .sort((a, b) => b.links - a.links || (a.tag < b.tag ? -1 : 1));
    const numbered = data.issues.filter((i) => i.number !== null);
    const voices: Record<Voice, number> = {
      jamie: 0,
      mixed: 0,
      excerpt: 0,
      agent: 0,
    };
    for (const link of data.links) if (link.voice) voices[link.voice]++;
    return {
      generated: data.generated,
      totals: {
        links: data.links.length,
        hosts: data.hosts.length,
        with_note: data.links.filter((l) => l.hasNote).length,
        to_read: data.links.filter((l) => l.toread).length,
        in_weekly_thing: data.appearances.size,
        issues: data.issues.length,
        latest_issue: numbered.length
          ? Math.max(...numbered.map((i) => i.number!))
          : null,
        first_saved: data.links[0]?.saved ?? null,
        last_saved: data.links[data.links.length - 1]?.saved ?? null,
      },
      voices,
      by_year: [...data.byYear]
        .sort((a, b) => a[0] - b[0])
        .map(([y, list]) => ({
          year: y,
          links: list.length,
          page: absolute(yearPath(y)),
        })),
      kinds: kinds.map((k) => ({
        kind: k,
        name: kindWords[k].name,
        about: kindWords[k].about,
        links: data.byKind.get(k)!.length,
        page: absolute(kindPath(k)),
      })),
      tags: tags.slice(0, n),
      top_hosts: data.hosts.slice(0, n).map((h) => ({
        host: h.host,
        links: h.count,
        first: h.first,
        last: h.last,
        page: absolute(hostPath(h.host)),
      })),
      notes: [
        "Years and days are US Central time. Tags are filing marks, not topics: the newsletter's, and _agent on a note an agent wrote.",
        "voices counts the notes by who wrote them: jamie (Jamie's words), mixed (commentary around a quotation), excerpt (most likely a passage from the page), agent (a summary an agent wrote for Jamie's reading queue).",
      ],
    };
  },
};

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const daysIn = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const onThisDayTool: Tool = {
  name: 'links_on_this_day',
  title: 'Links saved on this day',
  description:
    'The links saved on one calendar day (month and day, US Central) in every year since 2005, newest first. Leave both out for today.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      month: {
        type: 'integer',
        minimum: 1,
        maximum: 12,
        description: 'The month, 1 to 12.',
      },
      day: {
        type: 'integer',
        minimum: 1,
        maximum: 31,
        description: 'The day of the month.',
      },
      limit: limit(25, 100),
      offset,
    },
  },
  idempotent: true,
  list: 'links',
  async run(args, { snapshot, now }) {
    const data = snapshot.data;
    const notes: string[] = [];
    const today = centralDate(now());
    if ((args.month === undefined) !== (args.day === undefined))
      throw new ToolError(
        'invalid_arguments',
        'Give both month and day, or neither for today.',
        'Call links_on_this_day with {"month": 10, "day": 23}, or with no arguments.',
        { accepted_arguments: ['month', 'day', 'limit', 'offset'] },
      );
    const month =
      args.month === undefined ? Number(today.slice(5, 7)) : Number(args.month);
    const day =
      args.day === undefined ? Number(today.slice(8, 10)) : Number(args.day);
    if (day > daysIn[month - 1])
      throw new ToolError(
        'invalid_arguments',
        `${months[month - 1]} has no day ${day}.`,
        `Use a day from 1 to ${daysIn[month - 1]}.`,
      );
    if (args.month === undefined)
      notes.push(`Today is ${today} in US Central time.`);
    const suffix = `-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const list = data.newest.filter((l) => l.day.endsWith(suffix));
    const off = Number(args.offset);
    const shown = list.slice(off, off + Number(args.limit));
    return {
      month,
      day,
      date_label: `${months[month - 1]} ${day}`,
      total: list.length,
      years: new Set(list.map((l) => l.year)).size,
      offset: off,
      links: records(data, shown, notes),
      next_offset: page(list.length, off, shown.length),
      notes,
    };
  },
};

const randomTool: Tool = {
  name: 'links_random',
  title: 'Random links',
  description:
    'A few links chosen at random, a different few each call, from the whole collection or from one year, kind or host.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        default: 5,
        description: 'How many, 1 to 25 (default 5).',
      },
      year,
      kind,
      host,
    },
  },
  idempotent: false,
  list: 'links',
  async run(args, { snapshot }) {
    const data = snapshot.data;
    const notes: string[] = [];
    const site =
      args.host === undefined ? undefined : hostNamed(String(args.host));
    const pool = data.links.filter(
      (l) =>
        (args.year === undefined || l.year === args.year) &&
        (args.kind === undefined || l.kind === args.kind) &&
        (!site || onHost(l.host, site)),
    );
    const picked: Link[] = [];
    const taken = new Set<number>();
    const count = Math.min(Number(args.count), pool.length);
    while (picked.length < count) {
      const at = Math.floor(Math.random() * pool.length);
      if (taken.has(at)) continue;
      taken.add(at);
      picked.push(pool[at]);
    }
    if (!pool.length) notes.push('No link fits these arguments.');
    return {
      pool: pool.length,
      links: records(data, picked, notes),
      notes,
    };
  },
};

export const tools: Tool[] = [
  searchTool,
  getTool,
  listTool,
  issueTool,
  statsTool,
  onThisDayTool,
  randomTool,
];
export const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
