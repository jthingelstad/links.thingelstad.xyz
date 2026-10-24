// MCP over JSON-RPC, stateless (Streamable HTTP with single JSON responses,
// no sessions, no server-sent events): initialize, ping, tools/list,
// tools/call, resources/list, resources/templates/list and resources/read.
// http.ts handles the transport; this file turns one JSON-RPC message into
// its answer.
import { RpcError } from './rpc.ts';
import { ArgumentError, validate } from './schema.ts';
import {
  type Answer,
  type Context,
  SERVER_VERSION,
  type Tool,
  ToolError,
  toolByName,
  tools,
} from './tools.ts';
import {
  type ResourceContext,
  readResource,
  resourceTemplates,
  resources,
} from './resources.ts';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
export const MAX_RESULT_CHARS = 48_000;

export const INSTRUCTIONS =
  'Linking Things: every public link Jamie Thingelstad has saved since 2005, with his notes and the Weekly Thing issues that carried them. Read only. Start with links_stats for the shape of the collection, links_search to find links by words or by site:, year:, wt: and kind:, links_get for one link in full by id or URL, links_list for a whole year, host, kind or tag, and links_issue for a newsletter issue. One id everywhere: link-<12 hex>. Cite each link by its permalink. Dates are UTC instants with the US Central calendar day beside them. A note whose voice is "excerpt" is most likely a passage from the page, not Jamie\'s words; one whose voice is "agent" is a summary an agent wrote for Jamie\'s reading queue. Repeat a result\'s notes[] when they bear on the answer. When server_version in a result differs from serverInfo.version, fetch tools/list again.';

// The tool specs as tools/list publishes them.
export function toolList() {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: tool.idempotent,
      openWorldHint: false,
    },
  }));
}

const accepted = (tool: Tool) => Object.keys(tool.inputSchema.properties ?? {});

// An answer cut to fit: whole items dropped from the end of its list until
// the JSON is at most MAX_RESULT_CHARS, with a `truncated` block saying how
// many were left out and how to get them.
export function fitToCap(answer: Answer, list?: string): Answer {
  const size = (value: unknown) => JSON.stringify(value).length;
  if (size(answer) <= MAX_RESULT_CHARS) return answer;
  const items = list ? answer[list] : undefined;
  if (!Array.isArray(items)) {
    // Only a single record can be this large: its note is cut instead.
    const link = answer.link as Record<string, unknown> | undefined;
    if (link && typeof link.note === 'string') {
      const over = size(answer) - MAX_RESULT_CHARS + 400;
      const keep = Math.max(0, (link.note as string).length - over);
      return {
        ...answer,
        link: {
          ...link,
          note: `${(link.note as string).slice(0, keep)}…`,
          note_text: null,
        },
        truncated: {
          reason: 'size',
          limit_chars: MAX_RESULT_CHARS,
          left_out: 'the end of the note and note_text',
          next: "Read the whole note in the record's Markdown twin (the markdown URL) or the links://link/{id} resource.",
        },
      };
    }
    return answer;
  }
  let low = 0;
  let high = items.length;
  const withCount = (n: number): Answer => {
    const offset = typeof answer.offset === 'number' ? answer.offset : 0;
    return {
      ...answer,
      [list!]: items.slice(0, n),
      ...('next_offset' in answer ? { next_offset: offset + n } : {}),
      truncated: {
        reason: 'size',
        limit_chars: MAX_RESULT_CHARS,
        kept: n,
        left_out: items.length - n,
        next:
          'next_offset' in answer
            ? `Ask again with offset ${offset + n} for the rest, or a smaller limit.`
            : 'Ask again with a smaller limit.',
      },
    };
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(withCount(mid)) <= MAX_RESULT_CHARS) low = mid;
    else high = mid - 1;
  }
  return withCount(low);
}

function toolResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(
  code: string,
  message: string,
  next: string,
  extra: Record<string, unknown> = {},
) {
  return toolResult(
    {
      server_version: SERVER_VERSION,
      error: { code, message, next, ...extra },
      notes: [],
    },
    true,
  );
}

export { RpcError };

export interface Dependencies {
  context: () => Promise<Context>;
  resources: ResourceContext;
}

export interface Outcome {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  tool?: string;
  toolError?: string;
}

// One JSON-RPC request (it has an id) to its result or error.
export async function handle(
  method: string,
  params: Record<string, unknown>,
  deps: Dependencies,
): Promise<Outcome> {
  try {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return {
          result: {
            protocolVersion:
              typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
                ? asked
                : PROTOCOL_VERSIONS[0],
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false, subscribe: false },
            },
            serverInfo: {
              name: 'Linking Things',
              title: 'Linking Things',
              version: SERVER_VERSION,
            },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return { result: { tools: toolList() } };
      case 'tools/call':
        return await callTool(params, deps);
      case 'resources/list':
        return { result: { resources } };
      case 'resources/templates/list':
        return { result: { resourceTemplates } };
      case 'resources/read': {
        if (typeof params.uri !== 'string')
          throw new RpcError(-32602, 'resources/read needs a uri.');
        return {
          result: { contents: await readResource(params.uri, deps.resources) },
        };
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError)
      return {
        error: {
          code: error.code,
          message: error.message,
          ...(error.data !== undefined ? { data: error.data } : {}),
        },
      };
    throw error;
  }
}

async function callTool(
  params: Record<string, unknown>,
  deps: Dependencies,
): Promise<Outcome> {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = toolByName.get(name);
  if (!tool)
    throw new RpcError(-32602, `Unknown tool: ${name || '(none)'}`, {
      tools: tools.map((t) => t.name),
    });
  let args: Record<string, unknown>;
  try {
    args = validate(params.arguments, tool.inputSchema);
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error;
    return {
      tool: name,
      toolError: 'invalid_arguments',
      result: toolError(
        'invalid_arguments',
        error.message,
        `Call ${name} with only these arguments: ${accepted(tool).join(', ') || 'none'}.`,
        { accepted_arguments: accepted(tool) },
      ),
    };
  }
  let context: Context;
  try {
    context = await deps.context();
  } catch {
    return {
      tool: name,
      toolError: 'data_unavailable',
      result: toolError(
        'data_unavailable',
        'The collection could not be loaded just now.',
        'Try again in a minute.',
      ),
    };
  }
  try {
    const answer = await tool.run(args, context);
    const payload = fitToCap(
      { server_version: SERVER_VERSION, ...answer },
      tool.list,
    );
    return { tool: name, result: toolResult(payload) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return {
      tool: name,
      toolError: error.code,
      result: toolError(error.code, error.message, error.next, error.extra),
    };
  }
}
