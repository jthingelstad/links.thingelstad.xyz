// /sky/stars.json: the names of the stars the sky draws (src/lib/stars.ts),
// their titles, sites, kinds, issues and neighbours; /sky/places.json has
// where they are. The page's own file and not part of the dataset. No build
// time in it, so it uploads only when the stars change.
import type { APIRoute } from 'astro';
import { skyFiles } from '../../lib/stars';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(skyFiles().names), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
