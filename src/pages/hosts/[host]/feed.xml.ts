import type { APIRoute, GetStaticPaths } from 'astro';
import type { Host } from '../../../lib/data';
import { feedHosts, hostFeed, rssFeed } from '../../../lib/feeds';

export const getStaticPaths: GetStaticPaths = () =>
  feedHosts.map((host) => ({ params: { host: host.host }, props: { host } }));

export const GET: APIRoute = ({ props }) =>
  new Response(rssFeed(hostFeed((props as { host: Host }).host)), {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
