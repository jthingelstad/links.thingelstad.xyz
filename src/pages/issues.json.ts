import type { APIRoute } from 'astro';
import { issuesDocument } from '../lib/dataset';

export const GET: APIRoute = () =>
  new Response(issuesDocument(), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
