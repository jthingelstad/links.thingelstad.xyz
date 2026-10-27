import type { APIRoute } from 'astro';
import {
  bookmarkCaptureIds,
  bookmarkStars,
  importedChange,
  issues,
} from '../lib/data';

export const GET: APIRoute = () => {
  const latest = issues
    .filter((issue) => Number.isSafeInteger(issue.number))
    .toSorted((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
  return new Response(
    JSON.stringify({
      version: 1,
      link: importedChange ? { id: importedChange, at: importedChange } : null,
      issue: latest ? { id: String(latest.number), at: latest.date } : null,
      stars: bookmarkStars,
      bookmark_captures: bookmarkCaptureIds,
    }) + '\n',
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
};
