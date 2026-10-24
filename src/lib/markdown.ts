// Notes are Pinboard's `extended` field: Markdown from WT Builder since 2017,
// plain page excerpts before that, and HTML blockquotes around 2012. They
// render here, and nowhere else. Raw HTML is escaped (html: false), images are
// off (nothing is fetched from another host when a page is served), and
// headings sit below the record's own.
import MarkdownIt from 'markdown-it';

export interface Resolved {
  path: string;
  title: string;
}
type Resolver = (href: string) => Resolved | null;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.disable(['image']);
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

md.renderer.rules.heading_open = (tokens, i, options, _env, self) => {
  const level = Math.min(6, Number(tokens[i].tag.slice(1)) + 2);
  tokens[i].tag = `h${level}`;
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.heading_close = (tokens, i, options, _env, self) => {
  tokens[i].tag = tokens[i - 2]?.tag ?? tokens[i].tag;
  return self.renderToken(tokens, i, options);
};

// A link in a note that points at another saved link becomes a record link.
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const token = tokens[i];
  const resolve = (env as { resolve?: Resolver }).resolve;
  const hit = resolve?.(String(token.attrGet('href') ?? ''));
  if (hit) {
    token.attrSet('href', hit.path);
    token.attrJoin('class', 'record-link');
    token.attrSet('title', `Also saved here: ${hit.title}`);
  }
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
