// The front page's quote of the day: content/quotes.md, read at build. The
// file documents its own format at the top: each entry is a blockquote of
// the words, then a "Who:" line and a "Source:" line. One entry is shown a
// day (day.ts; the front page renders them all and shows the day's) and
// nothing when there are none. A malformed file fails the build with its
// line number, so a typo never ships quietly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ofTheDay } from './day.ts';

export interface Quote {
  // Paragraphs of plain text.
  words: string[];
  who: string;
  source: string;
}

export const QUOTES_FILE = 'content/quotes.md';

export function parseQuotes(text: string, file = QUOTES_FILE): Quote[] {
  // Comments (the format notes) are blanked line for line, so line numbers
  // in errors still match the file.
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''))
    .split('\n');
  const quotes: Quote[] = [];
  let current:
    | { words: string[][]; who?: string; source?: string; at: number }
    | undefined;
  const fail = (n: number, why: string): never => {
    throw new Error(`${file}:${n}: ${why}`);
  };
  const finish = (n: number) => {
    if (!current) return;
    const words = current.words
      .map((paragraph) => paragraph.join(' ').trim())
      .filter(Boolean);
    if (!words.length) fail(current.at, 'a quote with no words');
    if (!current.who) fail(n, 'the quote has no "Who:" line');
    if (!current.source) fail(n, 'the quote has no "Source:" line');
    quotes.push({ words, who: current.who!, source: current.source! });
    current = undefined;
  };
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line)) return;
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      // Words after a finished entry start the next one.
      if (current?.who || current?.source) finish(n);
      current ??= { words: [[]], at: n };
      if (quoted[1].trim())
        current.words[current.words.length - 1].push(quoted[1].trim());
      else current.words.push([]);
      return;
    }
    const field = /^(Who|Source):\s*(.*)$/.exec(line);
    if (!field)
      return fail(n, 'not part of a quote (see the notes at the top)');
    if (!current) return fail(n, `"${field[1]}:" before any quoted words`);
    const value = field[2].trim();
    if (!value) return fail(n, `"${field[1]}:" is empty`);
    if (field[1] === 'Who') {
      if (current.who) fail(n, 'a second "Who:" line');
      current.who = value;
    } else {
      if (current.source) fail(n, 'a second "Source:" line');
      if (!/^https?:\/\/\S+$/.test(value))
        fail(n, '"Source:" is not an http or https address');
      current.source = value;
    }
  });
  finish(lines.length);
  return quotes;
}

const root = process.env.LINKS_ROOT || process.cwd();
export const quotes = parseQuotes(
  readFileSync(join(root, QUOTES_FILE), 'utf8'),
);
export const quoteOfTheDay = (now = new Date()) => ofTheDay(quotes, now);
