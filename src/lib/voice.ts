// Who the note speaks for, by heuristic, never asserted (docs/DIRECTION.md,
// "Voice"): "jamie" is Jamie's commentary; "mixed" is commentary around a
// quotation; "excerpt" is most likely a passage from the page, which is what
// the bookmarklet captured before the Weekly Thing years.
//
// data.ts labels every link with it at build; the MCP server (src/mcp/)
// labels the rows of /links.json the same way, since links.json does not
// carry it.
import { prepare } from './markdown.ts';

export type Voice = 'jamie' | 'mixed' | 'excerpt';

export function voiceOf(note: string, year: number): Voice | null {
  const text = prepare(note);
  if (!text) return null;
  const blocks = text.split(/\n\s*\n/).filter((block) => block.trim());
  const quoted = blocks.filter((block) => block.trimStart().startsWith('>'));
  if (quoted.length === blocks.length) return 'excerpt';
  // A quotation set inside other text is Jamie quoting something.
  if (quoted.length) return 'mixed';
  if (/^["“‘«„]/.test(text)) return blocks.length > 1 ? 'mixed' : 'excerpt';
  // Before the Weekly Thing (2017) the bookmarklet saved the page's own words;
  // the earliest years (2005 and 2006, from del.icio.us) are short
  // descriptions in Jamie's words.
  if (year >= 2007 && year <= 2016) return 'excerpt';
  return 'jamie';
}
