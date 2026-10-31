// /sky/places.json: where the stars are (src/lib/stars.ts), their days,
// notes and topics, which is all the sky needs to draw; it loads first, and
// /sky/stars.json with the names after it. The page's own file and not part
// of the dataset. No build time in it, so it uploads only when the stars
// change.
import type { APIRoute } from 'astro';
import { skyFiles } from '../../lib/stars';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(skyFiles().places), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
