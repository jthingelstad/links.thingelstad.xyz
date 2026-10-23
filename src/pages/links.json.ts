import type { APIRoute } from 'astro';
import { linksDocument } from '../lib/dataset';

export const GET: APIRoute = () =>
  new Response(linksDocument(), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
