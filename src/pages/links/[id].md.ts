import type { APIRoute, GetStaticPaths } from 'astro';
import { type Link, links } from '../../lib/data';
import { linkMarkdown } from '../../lib/twins';

export const getStaticPaths: GetStaticPaths = () =>
  links.map((link) => ({ params: { id: link.id }, props: { link } }));

export const GET: APIRoute = ({ props }) =>
  new Response(linkMarkdown((props as { link: Link }).link), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
