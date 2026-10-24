// The About page: content/about.md, read at build and rendered as Markdown.
// The file documents its own format at the top: a "# " title first, then
// "## " sections. Raw HTML is escaped and images are off, as in notes
// (markdown.ts), so the page fetches nothing from another host. A malformed
// file fails the build with its line number.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';

export const ABOUT_FILE = 'content/about.md';

export interface About {
  title: string;
  html: string;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.disable(['image']);
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

export function parseAbout(text: string, file = ABOUT_FILE): About {
  // Comments (the format notes) are blanked line for line, so line numbers
  // in errors still match the file.
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''))
    .split('\n');
  const fail = (n: number, why: string): never => {
    throw new Error(`${file}:${n}: ${why}`);
  };
  let title: string | undefined;
  let titleLine = -1;
  let sections = 0;
  let fenced = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !line) return;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (title === undefined) {
      if (!heading || heading[1] !== '#')
        fail(
          n,
          'the file must start with a "# " title (see the notes at the top)',
        );
      title = heading![2].trim();
      titleLine = i;
      if (!title) fail(n, 'the "# " title is empty');
      return;
    }
    if (heading?.[1] === '#') fail(n, 'a second "# " title');
    if (heading?.[1] === '##') sections += 1;
  });
  if (title === undefined) return fail(1, 'no "# " title');
  if (!sections) fail(lines.length, 'no "## " section');
  const body = lines.filter((_, i) => i !== titleLine).join('\n');
  return { title, html: md.render(body) };
}

const root = process.env.LINKS_ROOT || process.cwd();
export const about = parseAbout(readFileSync(join(root, ABOUT_FILE), 'utf8'));
