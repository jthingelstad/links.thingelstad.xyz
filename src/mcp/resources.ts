// The resources: one record as its Markdown twin (links://link/{id}, the
// same text as /links/<id>.md) and the site's map for language models
// (links://llms.txt, /llms.txt). Both are read from the site as published,
// so a resource is never ahead of or behind the page.
import { datasetPath, linkMarkdownPath } from '../lib/paths.ts';
import type { Snapshot, Store } from './store.ts';
import { RpcError } from './rpc.ts';

export const resources = [
  {
    uri: 'links://llms.txt',
    name: 'llms.txt',
    title: 'Linking Things for language models',
    description:
      "The site's map for language models: what it holds, the data files, the record shape and the pages.",
    mimeType: 'text/markdown',
  },
];

export const resourceTemplates = [
  {
    uriTemplate: 'links://link/{id}',
    name: 'link',
    title: 'One saved link',
    description:
      'One link as Markdown, the same as its Markdown twin on the site. {id} is link-<12 hex> or the 12 hex characters.',
    mimeType: 'text/markdown',
  },
];

export interface ResourceContext {
  store: Store;
  snapshot: () => Promise<Snapshot>;
}

const notFound = (uri: string) =>
  new RpcError(-32002, 'Resource not found', { uri });

export async function readResource(uri: string, context: ResourceContext) {
  let path: string;
  if (uri === 'links://llms.txt') path = datasetPath.llms;
  else {
    const id = /^links:\/\/link\/(?:link-)?([0-9a-f]{12})$/.exec(uri)?.[1];
    if (!id) throw notFound(uri);
    const { data } = await context.snapshot();
    if (!data.byId.has(id)) throw notFound(uri);
    path = linkMarkdownPath(id);
  }
  let text: string | undefined;
  try {
    text = await context.store.text(path);
  } catch {
    throw new RpcError(
      -32603,
      'The site could not be read just now; try again shortly.',
      { uri },
    );
  }
  if (text === undefined) throw notFound(uri);
  return [{ uri, mimeType: 'text/markdown', text }];
}
