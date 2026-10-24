// /search/suggest.json: what the search box suggests from (src/lib/suggest.ts).
// Every host with its count, every issue with its title, Central date and the
// saved links it carried, and each year's and kind's count. The search page
// fetches it on the first keystroke; about 57 KB gzipped. No build time in
// it, so it uploads only when the data changes.
import type { APIRoute } from 'astro';
import {
  type Issue,
  appearances,
  hosts,
  issueKey,
  issues,
  kinds,
  linksByKind,
  linksByYear,
  shortDateLabel,
  years,
} from '../../lib/data';
import type { SuggestData } from '../../lib/suggest';

export function suggestDocument(): SuggestData {
  const carried = new Map<Issue, number>();
  for (const list of appearances.values())
    for (const { issue } of list)
      carried.set(issue, (carried.get(issue) ?? 0) + 1);
  return {
    hosts: hosts.map((host) => [host.host, host.count]),
    issues: [...issues]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((issue) => [
        issueKey(issue),
        issue.title,
        shortDateLabel(issue.date),
        carried.get(issue) ?? 0,
      ]),
    years: [...years]
      .reverse()
      .map((year) => [year, linksByYear.get(year)?.length ?? 0]),
    kinds: kinds.map((kind) => [kind, linksByKind.get(kind)?.length ?? 0]),
  };
}

export const GET: APIRoute = () =>
  new Response(JSON.stringify(suggestDocument()), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
