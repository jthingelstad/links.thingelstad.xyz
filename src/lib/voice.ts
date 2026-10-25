// Who the note speaks for (docs/DIRECTION.md, "Voice"), read from the note's
// form alone: bare text is Jamie's commentary ("jamie"); a `>` blockquote is
// the page's words ("excerpt"); a blockquote inside Jamie's text is
// commentary around a quotation ("mixed"). The notes saved before the Weekly
// Thing years used to need a year rule, because the bookmarklet stored the
// page's own words as bare text; on 2026-10-24 those notes were quoted at
// the source, so one rule covers every year. The one reading left is a note
// of a single paragraph that opens with a quote mark, taken as a quotation.
// "agent" is provenance, not a reading: the agent tags a bookmark whose note
// it writes (~/.openclaw/workspace/skills/pinboard-enrichment), and the label
// is read from that tag alone, never from the text.
//
// data.ts labels every link with it at build; the MCP server (src/mcp/)
// labels the rows of /links.json the same way, since links.json does not
// carry it.
import { prepare } from './markdown.ts';

export type Voice = 'jamie' | 'mixed' | 'excerpt' | 'agent';

// The tag the agent leaves on a bookmark whose note it wrote.
export const AGENT_TAG = '_agent';

export function voiceOf(
  note: string,
  tags: readonly string[] = [],
): Voice | null {
  const text = prepare(note);
  if (!text) return null;
  if (tags.includes(AGENT_TAG)) return 'agent';
  const blocks = text.split(/\n\s*\n/).filter((block) => block.trim());
  const quoted = blocks.filter((block) => block.trimStart().startsWith('>'));
  if (quoted.length === blocks.length) return 'excerpt';
  // A quotation set inside other text is Jamie quoting something.
  if (quoted.length) return 'mixed';
  if (/^["“‘«„]/.test(text)) return blocks.length > 1 ? 'mixed' : 'excerpt';
  return 'jamie';
}
