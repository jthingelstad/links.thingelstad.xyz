import type { APIRoute, GetStaticPaths } from 'astro';
import { type Kind, kinds } from '../../../lib/data';
import { jsonFeedText, kindFeed } from '../../../lib/feeds';

export const getStaticPaths: GetStaticPaths = () =>
  kinds.map((kind) => ({ params: { kind }, props: { kind } }));

export const GET: APIRoute = ({ props }) =>
  new Response(jsonFeedText(kindFeed((props as { kind: Kind }).kind)), {
    headers: { 'content-type': 'application/feed+json; charset=utf-8' },
  });
