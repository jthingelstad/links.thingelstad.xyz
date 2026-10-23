import type { APIRoute, GetStaticPaths } from 'astro';
import { type Link, links } from '../../lib/data';
import { linkJson } from '../../lib/twins';

export const getStaticPaths: GetStaticPaths = () =>
  links.map((link) => ({ params: { id: link.id }, props: { link } }));

export const GET: APIRoute = ({ props }) =>
  new Response(
    `${JSON.stringify(linkJson((props as { link: Link }).link), null, 2)}\n`,
    {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
