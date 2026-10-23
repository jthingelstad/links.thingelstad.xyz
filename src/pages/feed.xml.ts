import type { APIRoute } from 'astro';
import { rssFeed, siteFeed } from '../lib/feeds';

export const GET: APIRoute = () =>
  new Response(rssFeed(siteFeed), {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
