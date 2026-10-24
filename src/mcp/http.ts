// The HTTP side (node:http, no framework). Routes:
//
//   POST /mcp          one JSON-RPC message, answered as JSON (no sessions,
//                      no event stream); a notification or a response is 202
//   GET  /mcp          a short page for a person, or 405 to an event-stream
//                      request, since the server never streams
//   OPTIONS /mcp       CORS preflight
//   GET /health, /mcp/health   the data the server holds, as JSON
//
// Everything else is 404. CloudFront sends /mcp* here (infra/site.json), so
// /mcp/health is the public address of the health check. Bodies are capped
// at 64 KB. One JSON log line per request: the method, path, JSON-RPC method,
// tool, status, duration and request id, never a body or an argument.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mcpPage, styleHash } from './page.ts';
import { PROTOCOL_VERSIONS, handle } from './protocol.ts';
import type { Engine } from './search.ts';
import type { Store } from './store.ts';
import { SERVER_VERSION } from './tools.ts';

export const MAX_BODY_BYTES = 64 * 1024;

export interface ServerOptions {
  site: string;
  store: Store;
  engine: Engine;
  code?: string;
  now?: () => Date;
  log?: (line: Record<string, unknown>) => void;
}

const cors = {
  'access-control-allow-origin': '*',
};
const preflight = {
  ...cors,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
  'access-control-max-age': '86400',
};
const plain = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY_BYTES)
    return Promise.reject(new BodyError(413, 'The body is over 64 KB.'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError(413, 'The body is over 64 KB.'));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

export function createHandler(options: ServerOptions) {
  const { site, store, engine } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const page = mcpPage(site);
  const deps = {
    context: async () => ({ snapshot: await store.get(), engine, store, now }),
    resources: { store, snapshot: () => store.get() },
  };

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const started = performance.now();
    const requestId =
      (req.headers['lambda-web-request-id'] as string | undefined) ||
      randomUUID();
    const line: Record<string, unknown> = {
      event: 'request',
      method: req.method,
      request_id: requestId,
    };
    const send = (
      status: number,
      headers: Record<string, string>,
      body?: string,
    ) => {
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      line.status = status;
    };
    let id: string | number | null = null;
    const json = (status: number, value: unknown, extra = {}) =>
      send(
        status,
        {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...cors,
          ...plain,
          ...extra,
        },
        JSON.stringify(value),
      );
    try {
      let path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path.length > 1) path = path.replace(/\/+$/, '');
      line.path = path.length > 64 ? `${path.slice(0, 64)}…` : path;

      if (path === '/health' || path === '/mcp/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD')
          return json(
            405,
            { error: 'method_not_allowed' },
            { allow: 'GET, HEAD' },
          );
        const snapshot = await store.get().catch((error: unknown) => {
          line.error = error instanceof Error ? error.message : String(error);
          return undefined;
        });
        const data = snapshot?.data;
        return json(snapshot ? 200 : 503, {
          ok: !!snapshot,
          server_version: SERVER_VERSION,
          code: options.code ?? null,
          data: snapshot
            ? {
                generated: data!.generated,
                links: data!.links.length,
                issues: data!.issues.length,
                hosts: data!.hosts.length,
                loaded_at: snapshot.loadedAt,
                checked_at: snapshot.checkedAt,
              }
            : null,
        });
      }
      if (path !== '/mcp')
        return json(404, {
          error: 'not_found',
          next: `The MCP server is at ${site}/mcp.`,
        });

      if (req.method === 'OPTIONS') return send(204, { ...preflight });
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (String(req.headers.accept ?? '').includes('text/event-stream'))
          return json(
            405,
            rpcError(
              null,
              -32000,
              'This server does not stream; send each message as a POST.',
            ),
            { allow: 'POST, OPTIONS' },
          );
        return send(
          200,
          {
            'content-type': 'text/html; charset=utf-8',
            // A browser may keep it; the edge may not, since its cache key
            // has no Accept and an event-stream GET must get its 405.
            'cache-control': 'public, max-age=300, s-maxage=0',
            'content-security-policy': `default-src 'none'; style-src '${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            'x-frame-options': 'DENY',
            ...plain,
          },
          page,
        );
      }
      if (req.method !== 'POST')
        return json(
          405,
          rpcError(
            null,
            -32000,
            'Send each message as a POST; there are no sessions to end.',
          ),
          { allow: 'GET, POST, OPTIONS' },
        );

      const version = req.headers['mcp-protocol-version'];
      if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version))
        return json(
          400,
          rpcError(
            null,
            -32600,
            `Unsupported MCP-Protocol-Version; this server speaks ${PROTOCOL_VERSIONS.join(' and ')}.`,
          ),
        );
      const type = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim();
      if (type !== 'application/json')
        return json(
          415,
          rpcError(null, -32600, 'Send the message as application/json.'),
        );

      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof BodyError)
          return json(error.status, rpcError(null, -32600, error.message), {
            connection: 'close',
          });
        return json(400, rpcError(null, -32700, 'Parse error'));
      }
      if (Array.isArray(body))
        return json(
          400,
          rpcError(
            null,
            -32600,
            'Batches are not supported; send one message per request.',
          ),
        );
      const message = body as Record<string, unknown>;
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0')
        return json(400, rpcError(null, -32600, 'Invalid request'));
      const hasId = Object.hasOwn(message, 'id');
      if (typeof message.method !== 'string') {
        // A client's response to a request this server never sends.
        if (hasId && ('result' in message || 'error' in message))
          return send(202, { ...cors, 'cache-control': 'no-store' });
        return json(400, rpcError(null, -32600, 'Invalid request'));
      }
      line.rpc = message.method.slice(0, 64);
      if (!hasId) return send(202, { ...cors, 'cache-control': 'no-store' });
      if (typeof message.id !== 'string' && typeof message.id !== 'number')
        return json(
          400,
          rpcError(null, -32600, 'The id must be a string or a number.'),
        );
      id = message.id;
      const params = message.params ?? {};
      if (
        typeof params !== 'object' ||
        Array.isArray(params) ||
        params === null
      )
        return json(200, rpcError(id, -32602, 'Invalid params'));

      const outcome = await handle(
        message.method,
        params as Record<string, unknown>,
        deps,
      );
      if (outcome.tool) line.tool = outcome.tool;
      if (outcome.toolError) line.tool_error = outcome.toolError;
      if (outcome.error) line.rpc_error = outcome.error.code;
      return json(
        200,
        outcome.error
          ? { jsonrpc: '2.0', id, error: outcome.error }
          : { jsonrpc: '2.0', id, result: outcome.result },
      );
    } catch (error) {
      line.error = error instanceof Error ? error.name : 'Error';
      if (!res.headersSent) json(500, rpcError(id, -32603, 'Internal error'));
      else res.destroy();
    } finally {
      line.ms = Math.round(performance.now() - started);
      log(line);
    }
  };
}
