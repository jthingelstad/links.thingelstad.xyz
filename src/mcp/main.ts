// The server's entry point, on Lambda Web Functions and on this Mac alike:
// an ordinary Node HTTP server on AWS_LAMBDA_HTTP_ENDPOINT (127.0.0.1:8790
// locally). It listens first and loads the data after, so start-up stays
// well inside the platform's initialization limit; the first request waits
// for the load if it is not done.
//
// LINKS_SITE is the site it reads (https://links.thingelstad.xyz). Pagefind's
// client, pagefind.js from the same build as the site, is packaged beside
// this file (tools/package-mcp.mjs); PAGEFIND_MODULE points elsewhere for a
// local run. LINKS_MCP_CODE names the package, for /health.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHandler } from './http.ts';
import { type CreateInstance, Engine } from './search.ts';
import { Store } from './store.ts';

const site = (
  process.env.LINKS_SITE || 'https://links.thingelstad.xyz'
).replace(/\/$/, '');
const module = process.env.PAGEFIND_MODULE
  ? pathToFileURL(process.env.PAGEFIND_MODULE).href
  : new URL('./pagefind.js', import.meta.url).href;

const store = new Store({ site });
const engine = new Engine({
  basePath: `${site}/pagefind/`,
  load: async () =>
    (
      (await import(/* @vite-ignore */ module)) as {
        createInstance: CreateInstance;
      }
    ).createInstance,
});
const handler = createHandler({
  site,
  store,
  engine,
  code: process.env.LINKS_MCP_CODE || undefined,
});

const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:8790';
const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
if (!match) throw new Error(`Invalid AWS_LAMBDA_HTTP_ENDPOINT: ${endpoint}`);
const server = createServer({ requestTimeout: 30_000 }, (req, res) => {
  void handler(req, res);
});
server.keepAliveTimeout = 65_000;
server.listen(Number(match[2]), match[1].replace(/^\[|\]$/g, ''), () => {
  console.log(JSON.stringify({ event: 'listening', endpoint }));
  // Start loading now; a failure here is retried by the first request.
  store.get().catch(() => {});
});

// Stop taking requests, let those in flight finish, then exit.
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
