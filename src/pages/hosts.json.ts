import type { APIRoute } from 'astro';
import { hostsDocument } from '../lib/dataset';

export const GET: APIRoute = () =>
  new Response(hostsDocument(), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
