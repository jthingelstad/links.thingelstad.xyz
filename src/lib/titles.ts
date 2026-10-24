// A title as the site shows it: the page's own title without the site's name
// on the end ("Social RSS | Seth's Blog" is shown "Social RSS"), since the
// host sits right under it (Jamie, 2026-10-24). The data, the twins and the
// MCP server keep the title exactly as saved; only pages and feeds trim it.
//
// The last part after a separator is a site's name when its letters are in
// the host's ("Seth's Blog" on seths.blog), or when two or more links from the
// host end the same way ("Irrational Exuberance" on lethain.com). A part that
// only contains the host's name ("Videos from CNN.com") counts when it is no
// longer than the rest and the rest does not name the site too: "Panic Blog »
// Panic State of the Union" is the site first and the article after. A home
// page keeps its title, since there the site is the subject. What is left must
// still read as a title. No Node imports.

const separator = /\s+(?:\||-|–|—|·|::|»|•)\s+/g;
const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

function split(title: string): [string, string] | null {
  const text = title.trim();
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(separator)) last = match;
  if (!last || last.index === undefined) return null;
  return [text.slice(0, last.index), text.slice(last.index + last[0].length)];
}

// Each host's title endings, counted.
export function titleEndings(links: { host: string; title: string }[]) {
  const endings = new Map<string, Map<string, number>>();
  for (const link of links) {
    const parts = split(link.title);
    if (!parts) continue;
    const counts = endings.get(link.host) ?? new Map<string, number>();
    counts.set(parts[1], (counts.get(parts[1]) ?? 0) + 1);
    endings.set(link.host, counts);
  }
  return endings;
}

export function shownTitle(
  title: string,
  host: string,
  endings: Map<string, Map<string, number>>,
  home = false,
): string {
  const parts = split(title);
  if (!parts || home) return title;
  const [head, tail] = parts;
  if (head.trim().length < 8) return title;
  const name = letters(tail);
  const site = letters(host.replace(/\.[^.]+$/, ''));
  const named = name !== '' && letters(host).includes(name);
  const contains =
    site.length >= 3 &&
    name.includes(site) &&
    tail.length <= head.length &&
    !letters(head).includes(site);
  const shared = (endings.get(host)?.get(tail) ?? 0) >= 2;
  return named || contains || shared ? head.trim() : title;
}
