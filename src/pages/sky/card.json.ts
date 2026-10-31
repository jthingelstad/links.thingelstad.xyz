// /sky/card.json: the sky a lens page's share card is drawn over
// (src/lib/stars.ts, cardSky), which only cards.thingelstad.com reads. The
// page's own file and not part of the dataset. No build time in it, so it
// uploads only when the stars change.
import type { APIRoute } from 'astro';
import { cardSky } from '../../lib/stars';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(cardSky()), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
