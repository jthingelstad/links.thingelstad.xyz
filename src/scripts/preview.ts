// The preview pane on /search/ (Jamie, 2026-10-24: "Approved: build
// links.thingelstad.xyz search typeahead PR 3, result preview pane"). On a
// wide screen, the result moved to (the arrow keys, a pointer resting on it,
// or the first one when results come) shows beside the list from its
// record's JSON twin, about 4 kB: the note as the record renders it, the
// issues that carried it, its kind and what connects it. search.ts loads
// this module, and markdown-it with it, the first time a wide screen shows
// a result; a narrow screen never does. Everything is built with
// createElement and textContent: the note from markdown-it's tokens
// (noteTree), with only the attributes noteAttribute lets through.
import { kindWords, kinds } from '../lib/kinds.ts';
import { type NoteNode, noteTags, noteTree } from '../lib/markdown.ts';
import {
  issueLabel,
  issuePath,
  kindPath,
  linkJsonPath,
  linkPath,
} from '../lib/paths.ts';
import {
  type Section,
  type Twin,
  mentionResolver,
  noteAttribute,
  recordId,
  sections,
} from '../lib/preview.ts';
import type { Data } from './pagefind.ts';

// One fetch a record; a failed one is forgotten, so the next move tries again.
const twins = new Map<string, Promise<Twin>>();
function twinOf(id: string) {
  let twin = twins.get(id);
  if (!twin) {
    twin = fetch(linkJsonPath(id)).then((response) => {
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json() as Promise<Twin>;
    });
    twin.catch(() => twins.delete(id));
    twins.set(id, twin);
  }
  return twin;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(href: string, text: string, className?: string) {
  const a = element('a', className, text);
  a.href = href;
  return a;
}

function build(nodes: NoteNode[]): Node[] {
  return nodes.flatMap((node) => {
    if (typeof node === 'string') return [document.createTextNode(node)];
    if (!noteTags.has(node.tag)) return build(node.children);
    const built = document.createElement(node.tag);
    for (const [name, value] of node.attrs)
      if (noteAttribute(node.tag, name, value)) built.setAttribute(name, value);
    built.append(...build(node.children));
    return [built];
  });
}

// The kind, then a chip for each issue that carried it, as on the record.
function facts(twin: Twin) {
  const row = element('p', 'preview-facts');
  const kind = kinds.find((k) => k === twin.kind);
  if (kind)
    row.append(link(kindPath(kind), kindWords[kind].name, 'preview-kind'));
  for (const issue of twin.issues) {
    let href: string;
    try {
      href = issuePath(issue);
    } catch {
      continue;
    }
    row.append(link(href, `In ${issueLabel(issue)}`, 'chip'));
  }
  return row;
}

function note(twin: Twin) {
  const section = element('section', 'preview-note');
  const excerpt = twin.voice === 'excerpt';
  if (excerpt) section.append(element('h3', 'record-label', 'From the page'));
  const body = element('div', excerpt ? 'note excerpt' : 'note');
  body.append(
    ...build(noteTree(twin.note, mentionResolver(twin.connections.mentions))),
  );
  section.append(body);
  if (excerpt) section.append(element('p', 'note-cite', twin.host));
  return section;
}

function group(section: Section) {
  const block = element('section', 'preview-section');
  const heading = element('h3', 'record-label', section.heading);
  if (section.host) heading.append(' ', element('span', 'host', section.host));
  if (section.count)
    heading.append(' ', element('span', 'count', `· ${section.count}`));
  const list = element('ul', 'link-list compact');
  for (const ref of section.links) {
    const item = element('li');
    item.append(link(linkPath(ref.id), ref.title, 'title'));
    list.append(item);
  }
  block.append(heading, list);
  if (section.more) {
    const more = element('p', 'more');
    more.append(link(section.more.href, section.more.text));
    block.append(more);
  }
  return block;
}

// Shows a result: its title, site and date at once from the search's own
// data, then the rest when its twin comes, unless another result has been
// moved to by then (`current`).
export async function showPreview(
  pane: HTMLElement,
  data: Data,
  current: () => boolean,
) {
  const id = recordId(data.url);
  if (!id) return;
  const title = element('h2', 'preview-title');
  title.append(link(linkPath(id), data.meta.title ?? data.url));
  const meta = element(
    'p',
    'meta',
    [data.meta.host, data.meta.date].filter(Boolean).join(' · '),
  );
  pane.replaceChildren(title, meta);
  pane.scrollTop = 0;
  pane.hidden = false;
  pane.setAttribute('aria-busy', 'true');
  let twin: Twin;
  try {
    twin = await twinOf(id);
  } catch {
    if (!current()) return;
    pane.removeAttribute('aria-busy');
    pane.append(
      element(
        'p',
        'preview-failed',
        'Its note and connections did not load. Its record has them.',
      ),
    );
    return;
  }
  if (!current()) return;
  pane.removeAttribute('aria-busy');
  pane.append(facts(twin));
  if (twin.note.trim()) pane.append(note(twin));
  pane.append(...sections(twin).map(group));
}
