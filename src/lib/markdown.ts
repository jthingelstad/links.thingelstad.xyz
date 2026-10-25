// Notes are Pinboard's `extended` field: Markdown from WT Builder since 2017
// and, since the 2026-10-24 cleanup at the source, Markdown blockquotes for
// the page excerpts the bookmarklet saved before that (a few HTML blockquotes
// from 2012 remain and read the same). They render here, and nowhere else. Raw HTML is escaped (html: false), images are
// off (nothing is fetched from another host when a page is served), and
// headings sit below the record's own. noteTree is the same reading as a tree
// of elements and text, for the search page's preview pane, which builds it
// with createElement in the browser rather than parsing HTML; its HTML is
// renderNote's for every note (tests/preview.test.mjs).
import MarkdownIt, { type Token } from 'markdown-it';

export interface Resolved {
  path: string;
  title: string;
}
type Resolver = (href: string) => Resolved | null;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.disable(['image']);
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
const headingLevel = (tag: string) =>
  `h${Math.min(6, Number(tag.slice(1)) + 2)}`;

md.renderer.rules.heading_open = (tokens, i, options, _env, self) => {
  tokens[i].tag = headingLevel(tokens[i].tag);
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.heading_close = (tokens, i, options, _env, self) => {
  tokens[i].tag = tokens[i - 2]?.tag ?? tokens[i].tag;
  return self.renderToken(tokens, i, options);
};

// A link in a note that points at another saved link becomes a record link.
function recordLink(token: Token, resolve: Resolver | undefined) {
  const hit = resolve?.(String(token.attrGet('href') ?? ''));
  if (hit) {
    token.attrSet('href', hit.path);
    token.attrJoin('class', 'record-link');
    token.attrSet('title', `Also saved here: ${hit.title}`);
  }
}
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  recordLink(tokens[i], (env as { resolve?: Resolver }).resolve);
  return self.renderToken(tokens, i, options);
};

// <blockquote> HTML (192 notes from 2012) becomes a Markdown quote, so it
// renders as a quotation rather than escaped tags.
export function prepare(note: string) {
  return note
    .replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, inner: string) =>
        `\n\n${inner
          .trim()
          .split('\n')
          .map((line) => (line.trim() ? `> ${line.trim()}` : '>'))
          .join('\n')}\n\n`,
    )
    .replace(/<\/?blockquote[^>]*>/gi, '\n\n')
    .trim();
}

// Every link target in a note, in order, as markdown-it reads them (Markdown
// links, autolinks and bare http(s) URLs).
export function noteLinks(note: string): string[] {
  const hrefs: string[] = [];
  const walk = (tokens: ReturnType<typeof md.parse>) => {
    for (const token of tokens) {
      if (token.type === 'link_open')
        hrefs.push(String(token.attrGet('href') ?? ''));
      if (token.children) walk(token.children);
    }
  };
  walk(md.parse(prepare(note), {}));
  return hrefs.filter(Boolean);
}

export function renderNote(note: string, resolve: Resolver) {
  return md.render(prepare(note), { resolve });
}

// An element of a note, or its text. Only these tags and attributes come out
// of markdown-it as it is set up here (raw HTML and images are off).
export interface NoteElement {
  tag: string;
  attrs: [string, string][];
  children: NoteNode[];
}
export type NoteNode = NoteElement | string;
export const noteTags = new Set([
  'p',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'em',
  'strong',
  's',
  'code',
  'pre',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);

export function noteTree(note: string, resolve?: Resolver): NoteNode[] {
  const root: NoteElement = { tag: '', attrs: [], children: [] };
  const open = [root];
  const add = (node: NoteNode) => open[open.length - 1].children.push(node);
  const element = (tag: string, attrs: [string, string][] = []) => ({
    tag,
    attrs,
    children: [],
  });
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      // A paragraph in a tight list is its text alone.
      if (token.hidden) continue;
      if (token.type === 'inline') walk(token.children ?? []);
      else if (token.nesting === 1) {
        if (token.type === 'link_open') recordLink(token, resolve);
        const tag =
          token.type === 'heading_open' ? headingLevel(token.tag) : token.tag;
        const next: NoteElement = element(
          tag,
          (token.attrs ?? []).map(([name, value]) => [name, String(value)]),
        );
        add(next);
        open.push(next);
      } else if (token.nesting === -1) open.pop();
      else if (token.type === 'text') add(token.content);
      else if (token.type === 'softbreak') add('\n');
      else if (token.type === 'hardbreak') add(element('br'));
      else if (token.type === 'hr') add(element('hr'));
      else if (token.type === 'code_inline')
        add({ ...element('code'), children: [token.content] });
      else if (token.type === 'code_block' || token.type === 'fence') {
        const language = token.info.trim().split(/\s+/)[0];
        add({
          ...element('pre'),
          children: [
            {
              ...element(
                'code',
                language ? [['class', `language-${language}`]] : [],
              ),
              children: [token.content],
            },
          ],
        });
      } else add(token.content);
    }
  };
  walk(md.parse(prepare(note), {}));
  return root.children;
}

const entities: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

// A block-level tag's boundary becomes a space; every other tag is an inline
// one (a link, bold, code) and is removed outright, so no space is left before
// the punctuation that follows it ("Dunbar's number, and", not "number , and").
const blockTag =
  /<\/?(?:p|div|blockquote|ul|ol|li|dl|dt|dd|h[1-6]|pre|hr|br|table|thead|tbody|tfoot|tr|td|th)\b[^>]*>/g;
// Tags are removed until none is left, so no tag can be left behind by a pass
// (CodeQL's incomplete-multi-character-sanitization). Only the renderer's own
// tags reach here: raw HTML in a note is escaped (html: false) and comes out as
// text.
const stripTags = (html: string) => {
  let text = html.replace(blockTag, ' ');
  for (let before = ''; before !== text;) {
    before = text;
    text = text.replace(/<[^>]*>/g, '');
  }
  return text;
};
// The innermost blockquote: one with no blockquote inside it.
const innermostQuote =
  /<blockquote>((?:(?!<blockquote>)[\s\S])*?)<\/blockquote>/;

// The note as one line of text, for descriptions and result snippets. A
// quotation keeps its boundary, set in curly quotes, so commentary and the
// page's words do not run together.
export function plainNote(note: string, max = 200) {
  let html = md.render(prepare(note));
  for (let m = innermostQuote.exec(html); m; m = innermostQuote.exec(html)) {
    const quoted = stripTags(m[1]).replace(/\s+/g, ' ').trim();
    html = `${html.slice(0, m.index)} “${quoted}” ${html.slice(m.index + m[0].length)}`;
  }
  const text = stripTags(html)
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => entities[entity])
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6))}…`;
}
