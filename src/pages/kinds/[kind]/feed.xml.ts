import type { APIRoute, GetStaticPaths } from 'astro';
import { type Kind, kinds } from '../../../lib/data';
import { kindFeed, rssFeed } from '../../../lib/feeds';

export const getStaticPaths: GetStaticPaths = () =>
  kinds.map((kind) => ({ params: { kind }, props: { kind } }));

export const GET: APIRoute = ({ props }) =>
  new Response(rssFeed(kindFeed((props as { kind: Kind }).kind)), {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
