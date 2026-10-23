import type { APIRoute } from 'astro';
import { jsonFeedText, siteFeed } from '../lib/feeds';

export const GET: APIRoute = () =>
  new Response(jsonFeedText(siteFeed), {
    headers: { 'content-type': 'application/feed+json; charset=utf-8' },
  });
