// The names of the sky's topics: content/topics.md, read at build. The file
// documents its own format at the top: a "## " heading per family (the topics
// that share a colour in the sky, in the order the colours are given out),
// then one "- <id>: <name>" line per topic. Which link belongs to which topic
// is data (data/derived/sky/, made by tools/one-shot/sky_layout.py); this file
// only names them. A malformed file, or one that does not name every topic
// the sky has exactly once, fails the build with its line number.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Topics {
  families: string[];
  // Topic id to its name and its family's index.
  topics: Map<number, { name: string; family: number }>;
}

export const TOPICS_FILE = 'content/topics.md';

export function parseTopics(text: string, file = TOPICS_FILE): Topics {
  // Comments (the format notes) are blanked line for line, so line numbers
  // in errors still match the file.
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''))
    .split('\n');
  const families: string[] = [];
  const topics = new Map<number, { name: string; family: number }>();
  const lineOf = new Map<number, number>();
  const empty: [string, number][] = [];
  const fail = (n: number, why: string): never => {
    throw new Error(`${file}:${n}: ${why}`);
  };
  let titled = false;
  let members = 0;
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line) return;
    if (/^# \S/.test(line)) {
      if (titled || families.length) fail(n, 'a second "# " title');
      titled = true;
      return;
    }
    const family = /^## (.+)$/.exec(line);
    if (family) {
      if (families.length && !members) empty.push([families.at(-1)!, n]);
      families.push(family[1].trim());
      members = 0;
      return;
    }
    const topic = /^- (\d+): (.+)$/.exec(line);
    if (!topic) return fail(n, 'not a "## " family or a "- <id>: <name>" line');
    if (!families.length) fail(n, 'a topic before the first "## " family');
    const id = Number(topic[1]);
    if (topics.has(id))
      fail(n, `topic ${id} is named again (first on line ${lineOf.get(id)})`);
    topics.set(id, { name: topic[2].trim(), family: families.length - 1 });
    lineOf.set(id, n);
    members += 1;
  });
  if (families.length && !members) empty.push([families.at(-1)!, lines.length]);
  for (const [name, n] of empty) fail(n, `the family "${name}" names no topic`);
  if (!families.length) fail(lines.length, 'no "## " family');
  return { families, topics };
}

// Every topic the sky has, 0 to count - 1, named once, and nothing else.
export function checkTopics(parsed: Topics, count: number, file = TOPICS_FILE) {
  const unknown = [...parsed.topics.keys()].filter((id) => id >= count);
  if (unknown.length)
    throw new Error(
      `${file}: names topic ${unknown.join(', ')}, which the sky does not have (it has ${count})`,
    );
  const missing = [];
  for (let id = 0; id < count; id++)
    if (!parsed.topics.has(id)) missing.push(id);
  if (missing.length)
    throw new Error(`${file}: no name for topic ${missing.join(', ')}`);
  return parsed;
}

const root = process.env.LINKS_ROOT || process.cwd();
export const topicNames = parseTopics(
  readFileSync(join(root, TOPICS_FILE), 'utf8'),
);
