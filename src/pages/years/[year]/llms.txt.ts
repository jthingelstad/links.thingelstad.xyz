// Every record saved in one year, for language models (src/lib/dataset.ts):
// /years/<yyyy>/llms.txt, listed in /llms.txt.
import type { APIRoute, GetStaticPaths } from 'astro';
import { type LlmsYear, llmsYears } from '../../../lib/dataset';

export const getStaticPaths: GetStaticPaths = () =>
  llmsYears().map((file) => ({
    params: { year: String(file.year) },
    props: { file },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response((props as { file: LlmsYear }).file.text, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
