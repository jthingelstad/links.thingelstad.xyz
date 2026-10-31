// /sky/stars.json: the stars /sky/ draws (src/lib/stars.ts), the page's own
// file and not part of the dataset. No build time in it, so it uploads only
// when the stars change.
import type { APIRoute } from 'astro';
import { skyDocument } from '../../lib/stars';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(skyDocument()), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
