// The MCP server (src/mcp/), offline: a fixture collection served by a fake
// fetch, a fake Pagefind, and the real HTTP handler on 127.0.0.1. Covers the
// transport, the protocol, every tool, the size cap, and what readers see.
// Run: npm test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { hostOf } from '../src/lib/normalize.ts';
import { llmsTxt } from '../src/lib/dataset.ts';
import { buildDataset } from '../src/mcp/dataset.ts';
import { createHandler } from '../src/mcp/http.ts';
import { mcpPage, styleHash } from '../src/mcp/page.ts';
import {
  INSTRUCTIONS,
  MAX_RESULT_CHARS,
  PROTOCOL_VERSIONS,
  fitToCap,
  toolList,
} from '../src/mcp/protocol.ts';
import { resourceTemplates, resources } from '../src/mcp/resources.ts';
import { Engine, SearchUnavailable } from '../src/mcp/search.ts';
import { Store } from '../src/mcp/store.ts';
import { SERVER_VERSION, tools } from '../src/mcp/tools.ts';

const SITE = 'https://links.thingelstad.xyz';
const NOW = new Date('2026-10-24T17:00:00Z'); // noon in Central
const idOf = (url) => createHash('md5').update(url).digest('hex').slice(0, 12);

// Six links. The extra fields on A stand for what links.json must never
// carry into a result (and does not publish): the store drops them.
const rows = {
  A: {
    url: 'https://www.macstories.net/stories/shortcuts-guide/',
    title: 'The Shortcuts Guide',
    note: 'A great guide to **Shortcuts** automation.',
    saved: '2019-03-02T15:00:00Z',
    tags: ['_feature'],
    toread: false,
    hash: 'f00',
    meta: 'shared',
    enrichment: { status: 404 },
    alive: false,
  },
  B: {
    url: 'http://macstories.net/stories/shortcuts-guide',
    title: 'Shortcuts guide, again',
    note: '',
    saved: '2020-01-05T12:00:00Z',
    tags: [],
    toread: false,
  },
  // 02:30 UTC on the 14th is the evening of the 13th in Central.
  C: {
    url: 'https://www.youtube.com/watch?v=kubb1',
    title: 'Kubb tournament final',
    note: '> The final of the national kubb championship.',
    saved: '2012-07-14T02:30:00Z',
    tags: [],
    toread: false,
  },
  D: {
    url: 'https://github.com/jthingelstad/kubb-score',
    title: 'kubb-score',
    note: 'Planet Kubb notation, as a grammar.',
    saved: '2024-10-24T14:00:00Z',
    tags: ['_brief'],
    toread: false,
    kind: 'repository',
  },
  E: {
    url: 'https://m.youtube.com/watch?v=lawn',
    title: 'Lawn games on video',
    note: '',
    saved: '2023-10-24T18:00:00Z',
    tags: [],
    toread: false,
  },
  F: {
    url: 'https://example.com/first',
    title: 'The first save',
    note: 'Where it started.',
    saved: '2005-10-24T16:00:00Z',
    tags: [],
    toread: true,
  },
};
const id = Object.fromEntries(
  Object.entries(rows).map(([name, row]) => [name, idOf(row.url)]),
);
const linkRows = Object.entries(rows).map(([name, row]) => ({
  id: id[name],
  ...row,
}));

function hostsOf(links) {
  const hosts = new Map();
  for (const link of links) {
    const host = hostOf(link.url);
    const held = hosts.get(host) ?? {
      host,
      count: 0,
      first: link.saved,
      last: link.saved,
    };
    held.count++;
    if (link.saved < held.first) held.first = link.saved;
    if (link.saved > held.last) held.last = link.saved;
    hosts.set(host, held);
  }
  return [...hosts.values()];
}

function fixtureFiles(links = linkRows) {
  return {
    links: { generated: '2026-10-24T05:00:00Z', links },
    issues: {
      generated: '2026-10-24T05:00:00Z',
      issues: [
        {
          number: null,
          slug: '140-special',
          title: 'Special Issue',
          subject: '',
          date: '2020-02-01T13:00:00Z',
          url: 'https://weekly.thingelstad.com/archive/140-special/',
          links: [
            {
              position: 1,
              id: id.B,
              url: rows.B.url,
              text: 'again',
              section: null,
            },
          ],
        },
        {
          number: 351,
          slug: 'wt351',
          title: 'WT351',
          subject: 'WT351: Kubb And Shortcuts',
          date: '2024-10-26T13:00:00Z',
          url: 'https://weekly.thingelstad.com/archive/351/',
          links: [
            {
              position: 2,
              id: id.A,
              url: rows.A.url,
              text: 'The Shortcuts Guide',
              section: 'Briefly',
            },
            {
              position: 1,
              id: id.D,
              url: rows.D.url,
              text: 'kubb-score',
              section: 'Notable',
            },
            {
              position: 3,
              id: null,
              url: 'https://weekly.thingelstad.com/',
              text: 'The Weekly Thing',
              section: 'Outro',
            },
          ],
        },
        // No archive key: left out of the dataset, never "latest".
        {
          number: 352,
          slug: 'wt352',
          title: 'WT352',
          subject: 'WT352',
          date: '2024-11-02T13:00:00Z',
          url: 'https://example.com/nope/',
          links: [],
        },
      ],
    },
    hosts: { generated: '2026-10-24T05:00:00Z', hosts: hostsOf(links) },
  };
}

// The site, as the server reaches it over HTTPS: the three files with ETags
// (304 to a matching If-None-Match), each record's Markdown twin, llms.txt.
function fakeSite(files = fixtureFiles()) {
  const state = {
    files,
    version: { links: 1, issues: 1, hosts: 1 },
    calls: [],
    fail: false,
    failPaths: new Set(),
  };
  state.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const inm = init.headers?.['if-none-match'];
    state.calls.push({ path, inm });
    if (state.fail || state.failPaths.has(path))
      throw new TypeError('fetch failed');
    const file = /^\/(links|issues|hosts)\.json$/.exec(path)?.[1];
    if (file) {
      const etag = `"${file}-${state.version[file]}"`;
      if (inm === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify(state.files[file]), {
        headers: { 'content-type': 'application/json', etag },
      });
    }
    const md = /^\/links\/([0-9a-f]{12})\.md$/.exec(path)?.[1];
    if (md) {
      const link = state.files.links.links.find((row) => row.id === md);
      return link
        ? new Response(`# ${link.title}\n\n<${link.url}>\n`)
        : new Response('Not found', { status: 404 });
    }
    if (path === '/llms.txt') return new Response('# Linking Things\n');
    return new Response('Not found', { status: 404 });
  };
  state.change = (name, value) => {
    state.files[name] = value;
    state.version[name]++;
  };
  return state;
}

// Pagefind, loosely: a record is a candidate when any word's first letter
// starts a word in it (looser than the real index, so the server's own check
// is what keeps a result honest). Filters and sort are recorded, not applied:
// the server checks every result against the dataset itself.
function fakePagefind(index) {
  const state = {
    index,
    searches: [],
    fragments: 0,
    instances: 0,
    destroyed: 0,
    failures: 0,
  };
  const text = (row) =>
    `${row.title} ${hostOf(row.url)} ${row.note}`.toLowerCase();
  state.createInstance = ({ basePath }) => {
    state.instances++;
    state.basePath = basePath;
    return {
      init() {},
      async search(term, { filters, sort }) {
        state.searches.push({ term, filters, sort });
        if (state.failures > 0) {
          state.failures--;
          throw new Error('index chunk failed');
        }
        // A "phrase" is exact, each word whole, as Pagefind has it; a bare
        // word matches on its first letter alone.
        const phrases = [...term.matchAll(/"([^"]*)"/g)].map((m) =>
          m[1].toLowerCase().split(/\s+/).filter(Boolean),
        );
        const firsts = term
          .replace(/"[^"]*"/g, ' ')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w[0]);
        const hits = state.index.filter(
          (row) =>
            phrases.every((words) =>
              words.every((w) =>
                new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`).test(text(row)),
              ),
            ) &&
            (firsts.length === 0 ||
              firsts.some((letter) =>
                new RegExp(`(^|[^a-z0-9])${letter}`).test(text(row)),
              )),
        );
        return {
          results: hits.map((row) => ({
            id: `en_${row.id}`,
            words: [0],
            data: async () => {
              state.fragments++;
              return {
                url: `${SITE}/links/${row.id}/`,
                content: row.note.replace(/[>*]/g, '').trim(),
                meta: { title: row.title, host: hostOf(row.url) },
              };
            },
          })),
        };
      },
      destroy() {
        state.destroyed++;
      },
    };
  };
  return state;
}

// A server on a free loopback port, with its own site, index and log.
async function harness({ files, index, code } = {}) {
  const site = fakeSite(files);
  const pagefind = fakePagefind(index ?? [...linkRows]);
  const clock = { ms: NOW.getTime() };
  const store = new Store({
    site: SITE,
    fetch: site.fetch,
    now: () => clock.ms,
  });
  const engine = new Engine({
    basePath: `${SITE}/pagefind/`,
    load: async () => pagefind.createInstance,
  });
  const lines = [];
  const server = createServer(
    createHandler({
      site: SITE,
      store,
      engine,
      code,
      now: () => NOW,
      log: (line) => lines.push(line),
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  let next = 1;
  const post = (body, headers = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const rpc = async (method, params, headers) => {
    const response = await post(
      { jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) },
      headers,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  // A tool's answer; its text content is the same JSON as structuredContent.
  const call = async (name, args = {}) => {
    const body = await rpc('tools/call', { name, arguments: args });
    assert.ok(body.result, JSON.stringify(body));
    const { content, structuredContent, isError } = body.result;
    assert.equal(content.length, 1);
    assert.deepEqual(JSON.parse(content[0].text), structuredContent);
    assert.equal(structuredContent.server_version, SERVER_VERSION);
    assert.ok(Array.isArray(structuredContent.notes), 'notes in every answer');
    return { ...structuredContent, isError: !!isError };
  };
  return { site, pagefind, clock, store, engine, lines, base, post, rpc, call };
}

const main = await harness({ code: `mcp/${'a'.repeat(64)}.zip` });
const { call, rpc, post, base } = main;
const ids = (answer) => answer.links.map((link) => link.id);
const linkId = (name) => `link-${id[name]}`;

// The dataset, as the server builds it from the three files.

test('the dataset reads the published files the way the site does', () => {
  const data = buildDataset(fixtureFiles());
  assert.equal(data.links.length, 6);
  assert.deepEqual(
    data.newest.map((l) => l.id),
    [id.D, id.E, id.B, id.A, id.C, id.F],
  );
  const c = data.byId.get(id.C);
  assert.equal(c.day, '2012-07-13', 'the Central calendar day');
  assert.equal(c.year, 2012);
  assert.equal(c.voice, 'excerpt');
  assert.equal(c.kind, 'video');
  assert.equal(c.host, 'youtube.com');
  assert.equal(data.byId.get(id.D).voice, 'jamie');
  assert.equal(data.byId.get(id.A).host, 'macstories.net');
  assert.deepEqual(data.savedTwice.get(id.A), [id.B]);
  assert.deepEqual(
    data.issues.map((i) => i.key),
    ['140-special', '351'],
  );
  assert.deepEqual(
    data.appearances.get(id.D).map((a) => [a.issue.key, a.section]),
    [['351', 'Notable']],
  );
});

// The store: the site's files over HTTPS, revalidated, never data/.

test('the store loads once, revalidates with ETags, and bumps the generation only for links.json', async () => {
  const site = fakeSite();
  const clock = { ms: 0 };
  const store = new Store({
    site: SITE,
    fetch: site.fetch,
    now: () => clock.ms,
  });
  const [first, again] = await Promise.all([store.get(), store.get()]);
  assert.equal(first, again, 'one load for concurrent callers');
  assert.deepEqual(site.calls.map((c) => c.path).sort(), [
    '/hosts.json',
    '/issues.json',
    '/links.json',
  ]);
  assert.equal(first.generation, 1);

  clock.ms = 5 * 60_000;
  assert.equal(await store.get(), first, 'fresh enough: no request');
  assert.equal(site.calls.length, 3);

  clock.ms = 11 * 60_000;
  const checked = await store.get();
  assert.deepEqual(
    site.calls
      .slice(3)
      .map((c) => c.inm)
      .sort(),
    ['"hosts-1"', '"issues-1"', '"links-1"'],
  );
  assert.equal(checked.data, first.data, '304s keep the data');
  assert.equal(checked.generation, 1);
  assert.equal(checked.loadedAt, first.loadedAt);
  assert.notEqual(checked.checkedAt, first.checkedAt);

  const files = fixtureFiles();
  site.change('issues', {
    ...files.issues,
    issues: files.issues.issues.slice(1),
  });
  clock.ms = 22 * 60_000;
  const issuesOnly = await store.get();
  assert.equal(issuesOnly.generation, 1, 'the index is the same build');
  assert.deepEqual(
    issuesOnly.data.issues.map((i) => i.key),
    ['351'],
  );

  site.change('links', { ...files.links, links: linkRows.slice(1) });
  clock.ms = 33 * 60_000;
  const newer = await store.get();
  assert.equal(newer.generation, 2, 'a new links.json is a new build');
  assert.equal(newer.data.links.length, 5);
});

test('the data held keeps only the fields a result shows', async () => {
  const site = fakeSite();
  const store = new Store({ site: SITE, fetch: site.fetch });
  const { data } = await store.get();
  for (const link of data.links)
    for (const field of ['hash', 'meta', 'enrichment', 'alive'])
      assert.ok(!(field in link), `${field} is dropped`);
});

test('a failed check keeps the data held and waits a minute to retry', async () => {
  const site = fakeSite();
  const clock = { ms: 0 };
  const store = new Store({
    site: SITE,
    fetch: site.fetch,
    now: () => clock.ms,
  });
  const held = await store.get();
  site.fail = true;
  clock.ms = 11 * 60_000;
  assert.equal(await store.get(), held);
  assert.equal(store.lastError, 'fetch failed');
  const calls = site.calls.length;
  clock.ms += 30_000;
  assert.equal(await store.get(), held);
  assert.equal(site.calls.length, calls, 'no retry inside the minute');
  site.fail = false;
  clock.ms += 31_000;
  await store.get();
  assert.equal(store.lastError, undefined);
});

test('a check that fails halfway keeps nothing of it, so the retry sees the change', async () => {
  const site = fakeSite();
  const clock = { ms: 0 };
  const store = new Store({
    site: SITE,
    fetch: site.fetch,
    now: () => clock.ms,
  });
  const first = await store.get();
  // links.json changes, and issues.json is unreachable on the check that
  // sees the change.
  const files = fixtureFiles();
  site.change('links', { ...files.links, links: linkRows.slice(1) });
  site.failPaths.add('/issues.json');
  clock.ms = 11 * 60_000;
  assert.equal(await store.get(), first, 'the data held serves on');
  assert.equal(store.lastError, 'fetch failed');
  // issues.json is back. Had the new links.json and its ETag been kept,
  // every file would answer 304 now and the old data would serve on.
  site.failPaths.clear();
  clock.ms += 61_000;
  const recovered = await store.get();
  const links = site.calls.filter((c) => c.path === '/links.json');
  assert.equal(links.at(-1).inm, '"links-1"', 'the failed check kept no ETag');
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.data.links.length, 5);
  assert.equal(store.lastError, undefined);
});

test('a first load that fails is an error, and so is a file without its list', async () => {
  const offline = fakeSite();
  offline.fail = true;
  await assert.rejects(
    new Store({ site: SITE, fetch: offline.fetch }).get(),
    /fetch failed/,
  );
  const odd = fakeSite();
  odd.files.links = { generated: 'x', items: [] };
  await assert.rejects(
    new Store({ site: SITE, fetch: odd.fetch }).get(),
    /links\.json has no links list/,
  );
});

test('reload checks at once, then at most once a minute', async () => {
  const site = fakeSite();
  const clock = { ms: 0 };
  const store = new Store({
    site: SITE,
    fetch: site.fetch,
    now: () => clock.ms,
  });
  await store.get();
  await store.reload();
  assert.equal(site.calls.length, 6);
  clock.ms = 30_000;
  await store.reload();
  assert.equal(site.calls.length, 6);
  clock.ms = 61_000;
  await store.reload();
  assert.equal(site.calls.length, 9);
});

// The search engine: one Pagefind instance per build.

test('a new generation starts a fresh Pagefind and a fresh fragment cache', async () => {
  const pagefind = fakePagefind([...linkRows]);
  const engine = new Engine({
    basePath: `${SITE}/pagefind/`,
    load: async () => pagefind.createInstance,
  });
  const [result] = await engine.search(1, 'kubb', {});
  await engine.data(result);
  await engine.data(result);
  assert.equal(pagefind.fragments, 1, 'a fragment is read once');
  assert.equal(pagefind.basePath, `${SITE}/pagefind/`);
  await engine.search(1, 'kubb', {});
  assert.equal(pagefind.instances, 1);
  const [fresh] = await engine.search(2, 'kubb', {});
  assert.equal(pagefind.instances, 2);
  await engine.data(fresh);
  assert.equal(pagefind.fragments, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pagefind.destroyed, 1);
});

test('an index error is tried once more on a fresh instance', async () => {
  const pagefind = fakePagefind([...linkRows]);
  const engine = new Engine({
    basePath: '/',
    load: async () => pagefind.createInstance,
  });
  pagefind.failures = 1;
  assert.ok((await engine.search(1, 'kubb', {})).length > 0);
  assert.equal(pagefind.instances, 2);
  pagefind.failures = 2;
  await assert.rejects(engine.search(1, 'kubb', {}), SearchUnavailable);
});

// The transport.

test('initialize names the server and agrees a protocol version', async () => {
  const { result } = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.deepEqual(result.serverInfo, {
    name: 'Linking Things',
    title: 'Linking Things',
    version: SERVER_VERSION,
  });
  assert.deepEqual(result.capabilities, {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
  });
  assert.equal(result.instructions, INSTRUCTIONS);
  const newer = await rpc('initialize', { protocolVersion: '2099-01-01' });
  assert.equal(newer.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.deepEqual((await rpc('ping')).result, {});
});

test('tools/list: seven read-only tools with closed schemas', async () => {
  const { result } = await rpc('tools/list');
  assert.deepEqual(
    result.tools.map((t) => t.name),
    [
      'links_search',
      'links_get',
      'links_list',
      'links_issue',
      'links_stats',
      'links_on_this_day',
      'links_random',
    ],
  );
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.idempotentHint, tool.name !== 'links_random');
    assert.ok(tool.description.length > 40, tool.name);
  }
});

test('JSON-RPC errors: an unknown method, an unknown tool, bad params', async () => {
  assert.equal((await rpc('sampling/createMessage')).error.code, -32601);
  const unknown = await rpc('tools/call', { name: 'links_delete' });
  assert.equal(unknown.error.code, -32602);
  assert.equal(unknown.error.data.tools.length, 7);
  const listed = await post({
    jsonrpc: '2.0',
    id: 'x',
    method: 'tools/list',
    params: [1],
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).error.code, -32602);
  const read = await rpc('resources/read', {});
  assert.equal(read.error.code, -32602);
});

test('bad arguments are a tool error that lists the accepted ones', async () => {
  const answer = await call('links_search', { query: 'kubb', page: 2 });
  assert.equal(answer.isError, true);
  assert.equal(answer.error.code, 'invalid_arguments');
  assert.match(answer.error.message, /Unknown argument "page"/);
  assert.deepEqual(answer.error.accepted_arguments, [
    'query',
    'year',
    'host',
    'kind',
    'issue',
    'tag',
    'toread',
    'in_weekly_thing',
    'has_note',
    'sort',
    'limit',
    'offset',
  ]);
  assert.match(
    answer.error.next,
    /^Call links_search with only these arguments/,
  );
  const tooMany = await call('links_list', { by: 'newest', limit: 101 });
  assert.equal(tooMany.error.code, 'invalid_arguments');
  assert.match(tooMany.error.message, /limit must be from 1 to 100/);
  const required = await call('links_issue', {});
  assert.match(required.error.message, /issue is required/);
  const pattern = await call('links_get', { id: 'not-an-id' });
  assert.equal(pattern.error.code, 'invalid_arguments');
  const digits = await call('links_list', { by: 'newest', limit: '2' });
  assert.equal(digits.links.length, 2, 'a digit string is read as the integer');
});

test('the transport refuses what it does not speak', async () => {
  const version = await post(
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { 'mcp-protocol-version': '1999-01-01' },
  );
  assert.equal(version.status, 400);
  assert.equal((await version.json()).error.code, -32600);
  const known = await post(
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { 'mcp-protocol-version': '2025-03-26' },
  );
  assert.equal(known.status, 200);
  const text = await post('{}', { 'content-type': 'text/plain' });
  assert.equal(text.status, 415);
  const parse = await post('{"jsonrpc":');
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);
  const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(batch.status, 400);
  assert.match((await batch.json()).error.message, /Batches are not supported/);
  const big = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    params: { pad: 'x'.repeat(70_000) },
  });
  assert.equal(big.status, 413);
  const badId = await post({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' });
  assert.equal(badId.status, 400);
  const notRpc = await post({ id: 1, method: 'ping' });
  assert.equal(notRpc.status, 400);
});

test('a notification or a client response is accepted with 202 and no body', async () => {
  for (const message of [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 9, result: {} },
  ]) {
    const response = await post(message);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
  }
});

test('GET /mcp is a page for a person; an event stream is refused', async () => {
  const page = await fetch(`${base}/mcp`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(
    page.headers.get('content-security-policy'),
    /default-src 'none'/,
  );
  assert.ok(page.headers.get('content-security-policy').includes(styleHash));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(
    page.headers.get('cache-control'),
    'public, max-age=300, s-maxage=0',
    'never kept at the edge, whose cache key has no Accept',
  );
  const html = await page.text();
  assert.ok(html.includes(`${SITE}/mcp`));
  assert.equal(
    (await fetch(`${base}/mcp/`)).status,
    200,
    'a trailing slash is the same',
  );
  const head = await fetch(`${base}/mcp`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const stream = await fetch(`${base}/mcp`, {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(stream.status, 405);
  assert.equal(stream.headers.get('allow'), 'POST, OPTIONS');
  const remove = await fetch(`${base}/mcp`, { method: 'DELETE' });
  assert.equal(remove.status, 405);
  assert.equal(remove.headers.get('allow'), 'GET, POST, OPTIONS');
});

test('CORS: any origin may call it, and preflight names the MCP headers', async () => {
  const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(
    preflight.headers.get('access-control-allow-headers'),
    /MCP-Protocol-Version/,
  );
  assert.equal(
    preflight.headers.get('access-control-allow-methods'),
    'GET, POST, OPTIONS',
  );
  const answer = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(answer.headers.get('access-control-allow-origin'), '*');
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
});

test('anything outside /mcp is 404, and the health check reports the data held', async () => {
  const missing = await fetch(`${base}/links.json`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: 'not_found',
    next: `The MCP server is at ${SITE}/mcp.`,
  });
  for (const path of ['/mcp/health', '/health']) {
    const health = await fetch(`${base}${path}`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.server_version, SERVER_VERSION);
    assert.equal(body.code, `mcp/${'a'.repeat(64)}.zip`);
    assert.deepEqual(
      { ...body.data, loaded_at: undefined, checked_at: undefined },
      {
        generated: '2026-10-24T05:00:00Z',
        links: 6,
        issues: 2,
        hosts: 5,
        loaded_at: undefined,
        checked_at: undefined,
      },
    );
  }
  assert.equal(
    (await fetch(`${base}/mcp/health`, { method: 'POST' })).status,
    405,
  );
});

test('with no data the health check is 503 and a tool says so', async () => {
  const down = await harness();
  down.site.fail = true;
  const health = await fetch(`${down.base}/mcp/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).ok, false);
  const answer = await down.call('links_stats');
  assert.equal(answer.isError, true);
  assert.equal(answer.error.code, 'data_unavailable');
});

test('one log line per request, with no argument in it', async () => {
  const quiet = await harness();
  await quiet.call('links_search', { query: 'secretword kubb' });
  await quiet.call('links_get', { url: 'https://private.example/secret' });
  const [search, get] = quiet.lines;
  assert.equal(quiet.lines.length, 2);
  assert.equal(search.rpc, 'tools/call');
  assert.equal(search.tool, 'links_search');
  assert.equal(search.status, 200);
  assert.equal(search.path, '/mcp');
  assert.equal(typeof search.ms, 'number');
  assert.equal(get.tool_error, 'not_found');
  assert.doesNotMatch(JSON.stringify(quiet.lines), /secret/);
});

// The tools.

test('links_stats: the shape of the collection', async () => {
  const answer = await call('links_stats');
  assert.deepEqual(answer.totals, {
    links: 6,
    hosts: 5,
    with_note: 4,
    to_read: 1,
    in_weekly_thing: 3,
    issues: 2,
    latest_issue: 351,
    first_saved: rows.F.saved,
    last_saved: rows.D.saved,
  });
  assert.deepEqual(answer.voices, { jamie: 3, mixed: 0, excerpt: 1, agent: 0 });
  assert.deepEqual(
    answer.by_year.map((y) => [y.year, y.links]),
    [
      [2005, 1],
      [2012, 1],
      [2019, 1],
      [2020, 1],
      [2023, 1],
      [2024, 1],
    ],
  );
  assert.equal(answer.by_year[0].page, `${SITE}/years/2005/`);
  assert.equal(answer.kinds.length, 8);
  assert.equal(answer.kinds.find((k) => k.kind === 'video').links, 2);
  assert.deepEqual(answer.tags, [
    { tag: '_brief', links: 1 },
    { tag: '_feature', links: 1 },
  ]);
  assert.equal(answer.top_hosts[0].host, 'macstories.net');
  assert.equal(answer.top_hosts[0].page, `${SITE}/hosts/macstories.net/`);
  const one = await call('links_stats', { limit: 1 });
  assert.equal(one.top_hosts.length, 1);
  assert.equal(one.tags.length, 1);
});

test('links_search: words go to the index and every result is checked', async () => {
  const answer = await call('links_search', { query: 'kubb' });
  assert.deepEqual(ids(answer), [linkId('C'), linkId('D')]);
  assert.equal(answer.total, 2);
  assert.equal(answer.total_exact, true);
  assert.equal(answer.next_offset, null);
  assert.deepEqual(main.pagefind.searches.at(-1), {
    term: 'kubb',
    filters: {},
    sort: undefined,
  });
  const [c] = answer.links;
  assert.equal(c.permalink, `${SITE}/links/${id.C}/`);
  assert.equal(c.saved_date, '2012-07-13');
  assert.equal(c.voice, 'excerpt');
  assert.ok(answer.notes.some((n) => /voice is "excerpt"/.test(n)));
  assert.deepEqual(answer.links[1].issues, [351]);
});

test("links_search: Pagefind's loose prefix matches are refused", async () => {
  const answer = await call('links_search', { query: 'kuzzzz' });
  assert.equal(answer.total, 0);
  assert.deepEqual(answer.links, []);
  assert.ok(answer.notes.some((n) => n.startsWith('Nothing matched.')));
});

test('links_search: filters reach the index and the dataset alike', async () => {
  const year = await call('links_search', { query: 'kubb', year: 2012 });
  assert.deepEqual(ids(year), [linkId('C')]);
  assert.deepEqual(main.pagefind.searches.at(-1).filters, { year: '2012' });
  const issue = await call('links_search', { query: 'kubb wt:351' });
  assert.deepEqual(ids(issue), [linkId('D')]);
  assert.deepEqual(main.pagefind.searches.at(-1).filters, { issue: '351' });
  const special = await call('links_search', {
    query: 'shortcuts',
    issue: 'special',
  });
  assert.deepEqual(ids(special), [linkId('B')]);
  assert.deepEqual(main.pagefind.searches.at(-1).filters, { issue: 'special' });
  const flags = await call('links_search', {
    query: 'kubb',
    in_weekly_thing: true,
    has_note: true,
  });
  assert.deepEqual(ids(flags), [linkId('D')]);
  assert.deepEqual(main.pagefind.searches.at(-1).filters, {
    wt: 'yes',
    note: 'yes',
  });
  const kind = await call('links_search', { query: 'kubb kind:repositories' });
  assert.deepEqual(ids(kind), [linkId('D')]);
  const newest = await call('links_search', { query: 'kubb', sort: 'newest' });
  assert.deepEqual(main.pagefind.searches.at(-1).sort, { date: 'desc' });
  assert.equal(newest.total, 2);
  const excluded = await call('links_search', { query: 'kubb -championship' });
  assert.deepEqual(ids(excluded), [linkId('D')]);
});

test('links_search: an argument wins over the same operator, with a note', async () => {
  const answer = await call('links_search', {
    query: 'kubb site:youtube.com',
    host: 'https://www.github.com/x',
  });
  assert.deepEqual(ids(answer), [linkId('D')]);
  assert.equal(main.pagefind.searches.at(-1).term, 'kubb github com');
  assert.ok(
    answer.notes.includes(
      "The query's site: was replaced by the host argument.",
    ),
  );
  const kind = await call('links_search', { query: 'kubb kind:gif' });
  assert.ok(kind.notes.some((n) => n.startsWith('kind: names one of video')));
  const year = await call('links_search', { query: 'kubb year:12' });
  assert.ok(
    year.notes.includes(
      'year: takes four digits; the one in the query was ignored.',
    ),
  );
});

test('links_search: with no words it is exact, newest first, and needs no index', async () => {
  const before = main.pagefind.searches.length;
  const site = await call('links_search', { query: 'site:macstories.net' });
  assert.deepEqual(ids(site), [linkId('B'), linkId('A')]);
  assert.equal(site.total_exact, true);
  const youtube = await call('links_search', { host: 'youtube.com' });
  assert.deepEqual(
    ids(youtube),
    [linkId('E'), linkId('C')],
    'hosts under it count',
  );
  const tagged = await call('links_search', { tag: '_feature' });
  assert.deepEqual(ids(tagged), [linkId('A')]);
  const toread = await call('links_search', { toread: true });
  assert.deepEqual(ids(toread), [linkId('F')]);
  const ranked = await call('links_search', { year: 2012, sort: 'relevance' });
  assert.deepEqual(ids(ranked), [linkId('C')]);
  assert.ok(
    ranked.notes.includes(
      'With no words to rank by, the links are newest first.',
    ),
  );
  const oldest = await call('links_search', {
    query: 'site:macstories.net',
    sort: 'oldest',
  });
  assert.deepEqual(ids(oldest), [linkId('A'), linkId('B')]);
  const excluded = await call('links_search', {
    host: 'youtube.com',
    query: '-lawn',
  });
  assert.deepEqual(ids(excluded), [linkId('C')]);
  assert.equal(main.pagefind.searches.length, before);
});

test('links_search: pages, and an issue that does not exist', async () => {
  const first = await call('links_search', { query: 'kubb', limit: 1 });
  assert.deepEqual(ids(first), [linkId('C')]);
  assert.equal(first.next_offset, 1);
  assert.equal(first.total, 2);
  const second = await call('links_search', {
    query: 'kubb',
    limit: 1,
    offset: first.next_offset,
  });
  assert.deepEqual(ids(second), [linkId('D')]);
  assert.equal(second.next_offset, null);
  const missing = await call('links_search', { query: 'kubb', issue: 999 });
  assert.equal(missing.error.code, 'not_found');
  assert.match(missing.error.next, /links_stats/);
});

test('links_search: a record the data does not have yet reloads the data and searches again', async () => {
  const G = {
    id: idOf('https://example.org/kubb-rules'),
    url: 'https://example.org/kubb-rules',
    title: 'Kubb rules',
    note: '',
    saved: '2026-10-23T12:00:00Z',
    tags: [],
    toread: false,
  };
  const later = await harness({ index: [...linkRows, G] });
  await later.call('links_stats');
  later.site.change('links', {
    generated: '2026-10-24T06:00:00Z',
    links: [...linkRows, G],
  });
  const answer = await later.call('links_search', { query: 'kubb' });
  assert.deepEqual(ids(answer), [linkId('C'), linkId('D'), `link-${G.id}`]);
  assert.equal(later.pagefind.instances, 2, 'a fresh index for the new build');
});

test('links_search: an unreadable index is a tool error with a way round it', async () => {
  const broken = await harness();
  broken.pagefind.failures = 2;
  const answer = await broken.call('links_search', { query: 'kubb' });
  assert.equal(answer.error.code, 'search_unavailable');
  assert.match(answer.error.next, /links_list/);
  const wordless = await broken.call('links_search', { year: 2012 });
  assert.deepEqual(ids(wordless), [linkId('C')]);
});

test('links_get: one link in full, by id or by URL', async () => {
  for (const given of [
    { id: id.A },
    { id: linkId('A') },
    { url: rows.A.url },
  ]) {
    const answer = await call('links_get', given);
    assert.equal(answer.link.id, linkId('A'));
    assert.equal(answer.matched, given.url ? 'url' : 'id');
  }
  const { link, notes } = await call('links_get', { id: id.A });
  assert.equal(link.note, rows.A.note, 'the note as written');
  assert.equal(link.note_text, 'A great guide to Shortcuts automation.');
  assert.equal(link.voice, 'jamie');
  assert.equal(link.toread, false);
  assert.deepEqual(link.tags, ['_feature']);
  assert.deepEqual(link.appearances, [
    {
      issue: 351,
      title: 'WT351: Kubb And Shortcuts',
      date: '2024-10-26T13:00:00Z',
      date_central: '2024-10-26',
      section: 'Briefly',
      position: 2,
      url: 'https://weekly.thingelstad.com/archive/351/',
      page: `${SITE}/issues/351/`,
    },
  ]);
  assert.deepEqual(
    link.saved_twice.map((t) => t.id),
    [linkId('B')],
  );
  assert.equal(link.host_links, 2);
  assert.equal(link.host_page, `${SITE}/hosts/macstories.net/`);
  assert.equal(link.markdown, `${SITE}/links/${id.A}.md`);
  assert.equal(link.json, `${SITE}/links/${id.A}.json`);
  assert.deepEqual(notes, []);
});

test('links_get: a URL that only normalises alike says so', async () => {
  const answer = await call('links_get', {
    url: 'https://macstories.net/stories/shortcuts-guide/?utm_source=feed',
  });
  assert.equal(
    answer.link.id,
    linkId('A'),
    'the earliest of those saved alike',
  );
  assert.equal(answer.matched, 'normalised url');
  assert.ok(
    answer.notes[0].startsWith('No link was saved under exactly this URL'),
  );
  const excerpt = await call('links_get', { id: id.C });
  assert.ok(excerpt.notes.some((n) => /voice is "excerpt"/.test(n)));
});

test('links_get: exactly one of id or url, and a clear miss', async () => {
  for (const args of [{}, { id: id.A, url: rows.A.url }]) {
    const answer = await call('links_get', args);
    assert.equal(answer.error.code, 'invalid_arguments');
    assert.deepEqual(answer.error.accepted_arguments, ['id', 'url']);
  }
  const missing = await call('links_get', { id: '000000000000' });
  assert.equal(missing.error.code, 'not_found');
  const nowhere = await call('links_get', { url: 'https://nowhere.example/' });
  assert.equal(nowhere.error.code, 'not_found');
  assert.match(nowhere.error.next, /links_search/);
});

test('links_list: every group, newest first, with exact counts', async () => {
  const newest = await call('links_list', { by: 'newest', limit: 2 });
  assert.deepEqual(ids(newest), [linkId('D'), linkId('E')]);
  assert.equal(newest.total, 6);
  assert.equal(newest.next_offset, 2);
  assert.equal(newest.page, `${SITE}/newest/`);
  const year = await call('links_list', { by: 'year', value: 2012 });
  assert.deepEqual(ids(year), [linkId('C')]);
  assert.equal(year.page, `${SITE}/years/2012/`);
  const host = await call('links_list', { by: 'host', value: 'youtube.com' });
  assert.deepEqual(
    ids(host),
    [linkId('C')],
    'exactly the host, as its page lists it',
  );
  assert.deepEqual(host.host, {
    host: 'youtube.com',
    links: 1,
    first: rows.C.saved,
    last: rows.C.saved,
  });
  const typed = await call('links_list', {
    by: 'host',
    value: 'https://www.macstories.net/stories/',
  });
  assert.deepEqual(ids(typed), [linkId('B'), linkId('A')]);
  const kind = await call('links_list', { by: 'kind', value: 'video' });
  assert.deepEqual(ids(kind), [linkId('E'), linkId('C')]);
  assert.equal(kind.kind.name, 'Video');
  assert.equal(kind.page, `${SITE}/kinds/video/`);
  const tag = await call('links_list', { by: 'tag', value: '_brief' });
  assert.deepEqual(ids(tag), [linkId('D')]);
  const toread = await call('links_list', { by: 'toread', value: 'x' });
  assert.deepEqual(ids(toread), [linkId('F')]);
  assert.ok(toread.notes.includes('by toread takes no value; it was ignored.'));
  const end = await call('links_list', { by: 'newest', offset: 5 });
  assert.equal(end.links.length, 1);
  assert.equal(end.next_offset, null);
});

test('links_list: a missing value, an unknown kind, an empty host', async () => {
  const value = await call('links_list', { by: 'year' });
  assert.equal(value.error.code, 'invalid_arguments');
  const kind = await call('links_list', { by: 'kind', value: 'gif' });
  assert.equal(kind.error.code, 'invalid_arguments');
  assert.match(kind.error.next, /video, repository/);
  const host = await call('links_list', {
    by: 'host',
    value: 'nowhere.example',
  });
  assert.equal(host.error.code, 'not_found');
  const tag = await call('links_list', { by: 'tag', value: 'kubb' });
  assert.equal(tag.error.code, 'not_found');
  const by = await call('links_list', { by: 'month', value: 3 });
  assert.equal(by.error.code, 'invalid_arguments');
});

test('links_issue: the links an issue carried, in its order', async () => {
  for (const issue of [351, '351', 'WT351', 'latest']) {
    const answer = await call('links_issue', { issue });
    assert.equal(answer.issue.number, 351, String(issue));
  }
  const answer = await call('links_issue', { issue: 351 });
  assert.deepEqual(answer.issue, {
    number: 351,
    title: 'WT351: Kubb And Shortcuts',
    date: '2024-10-26T13:00:00Z',
    date_central: '2024-10-26',
    url: 'https://weekly.thingelstad.com/archive/351/',
    page: `${SITE}/issues/351/`,
    links: 3,
    matched: 2,
  });
  assert.deepEqual(
    answer.links.map((l) => [l.position, l.section, l.id]),
    [
      [1, 'Notable', linkId('D')],
      [2, 'Briefly', linkId('A')],
      [3, 'Outro', null],
    ],
  );
  assert.equal(answer.links[0].permalink, `${SITE}/links/${id.D}/`);
  assert.ok(
    answer.notes[0].startsWith("1 of the issue's links match no saved link"),
  );
  const special = await call('links_issue', { issue: '140-special' });
  assert.equal(special.issue.number, '140-special');
  assert.equal(special.issue.title, 'Special Issue');
  assert.equal(special.issue.page, `${SITE}/issues/140-special/`);
  const missing = await call('links_issue', { issue: 352 });
  assert.equal(missing.error.code, 'not_found');
});

test('links_on_this_day: one Central calendar day in every year', async () => {
  const today = await call('links_on_this_day');
  assert.equal(today.date_label, 'October 24');
  assert.deepEqual(ids(today), [linkId('D'), linkId('E'), linkId('F')]);
  assert.equal(today.years, 3);
  assert.ok(today.notes.includes('Today is 2026-10-24 in US Central time.'));
  const evening = await call('links_on_this_day', { month: 7, day: 13 });
  assert.deepEqual(ids(evening), [linkId('C')], 'saved on the 14th in UTC');
  assert.equal(
    (await call('links_on_this_day', { month: 7, day: 14 })).total,
    0,
  );
  assert.equal(
    (await call('links_on_this_day', { month: 2, day: 29 })).total,
    0,
  );
  const impossible = await call('links_on_this_day', { month: 2, day: 30 });
  assert.equal(impossible.error.message, 'February has no day 30.');
  const half = await call('links_on_this_day', { month: 2 });
  assert.equal(half.error.code, 'invalid_arguments');
});

test('links_random: distinct links from the pool asked for', async () => {
  const some = await call('links_random', { count: 3 });
  assert.equal(some.pool, 6);
  assert.equal(new Set(ids(some)).size, 3);
  const all = await call('links_random', { count: 25 });
  assert.deepEqual(ids(all).sort(), Object.keys(id).map(linkId).sort());
  assert.equal((await call('links_random', { kind: 'video' })).pool, 2);
  assert.equal((await call('links_random', { host: 'youtube.com' })).pool, 2);
  const none = await call('links_random', { year: 2006 });
  assert.equal(none.pool, 0);
  assert.ok(none.notes.includes('No link fits these arguments.'));
});

test('resources: a record as its Markdown twin, and llms.txt', async () => {
  assert.deepEqual((await rpc('resources/list')).result.resources, resources);
  assert.deepEqual(
    (await rpc('resources/templates/list')).result.resourceTemplates,
    resourceTemplates,
  );
  const link = await rpc('resources/read', {
    uri: `links://link/${linkId('A')}`,
  });
  assert.deepEqual(link.result.contents, [
    {
      uri: `links://link/${linkId('A')}`,
      mimeType: 'text/markdown',
      text: `# ${rows.A.title}\n\n<${rows.A.url}>\n`,
    },
  ]);
  const bare = await rpc('resources/read', { uri: `links://link/${id.A}` });
  assert.ok(bare.result);
  const llms = await rpc('resources/read', { uri: 'links://llms.txt' });
  assert.equal(llms.result.contents[0].text, '# Linking Things\n');
  for (const uri of [
    'links://link/000000000000',
    'links://other',
    'https://example.com/',
  ])
    assert.equal(
      (await rpc('resources/read', { uri })).error.code,
      -32002,
      uri,
    );
});

// Every answer, whatever was asked: nothing from beyond the public contract.

test('no answer carries a field the public files leave out', async () => {
  const forbidden = new Set([
    'hash',
    'meta',
    'enrichment',
    'alive',
    'status',
    'dead',
    'broken',
    'checked',
    'wayback',
  ]);
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        keys.add(key);
        walk(inner);
      }
  };
  for (const [name, args] of [
    ['links_search', { query: 'shortcuts' }],
    ['links_search', { query: 'site:macstories.net' }],
    ['links_get', { id: id.A }],
    ['links_list', { by: 'newest', limit: 100 }],
    ['links_issue', { issue: 351 }],
    ['links_stats', {}],
    ['links_on_this_day', { month: 3, day: 2 }],
    ['links_random', { count: 25 }],
  ])
    walk(await call(name, args));
  for (const key of keys) assert.ok(!forbidden.has(key), key);
});

// The size cap.

test('a long list is cut to fit, with a truncated block and the next page', () => {
  const links = Array.from({ length: 500 }, (_, i) => ({
    id: `link-${i}`,
    title: 'x'.repeat(200),
  }));
  const answer = fitToCap(
    {
      server_version: SERVER_VERSION,
      total: 900,
      offset: 100,
      links,
      next_offset: 600,
      notes: [],
    },
    'links',
  );
  assert.ok(JSON.stringify(answer).length <= MAX_RESULT_CHARS);
  const kept = answer.links.length;
  assert.ok(kept > 100 && kept < 500);
  assert.deepEqual(answer.truncated, {
    reason: 'size',
    limit_chars: MAX_RESULT_CHARS,
    kept,
    left_out: 500 - kept,
    next: `Ask again with offset ${100 + kept} for the rest, or a smaller limit.`,
  });
  assert.equal(answer.next_offset, 100 + kept);
  assert.equal(answer.total, 900);
  const one = Array.from({ length: 2 }, () => ({
    title: 'y'.repeat(MAX_RESULT_CHARS),
  }));
  const none = fitToCap({ top_hosts: one, notes: [] }, 'top_hosts');
  assert.equal(none.top_hosts.length, 0);
  assert.equal(none.truncated.next, 'Ask again with a smaller limit.');
});

test('a single long record has its note cut instead', () => {
  const note = 'word '.repeat(20_000);
  const answer = fitToCap({
    link: { id: 'link-x', note, note_text: note },
    notes: [],
  });
  assert.ok(JSON.stringify(answer).length <= MAX_RESULT_CHARS);
  assert.ok(answer.link.note.endsWith('…'));
  assert.equal(answer.link.note_text, null);
  assert.equal(answer.truncated.reason, 'size');
  assert.match(answer.truncated.next, /Markdown twin/);
  const small = { links: [{ id: 'link-1' }], notes: [] };
  assert.equal(fitToCap(small, 'links'), small, 'under the cap: unchanged');
});

// What readers see: never the bookmarking service, never whether a link works.

const readerText = () => [
  ['tools/list', JSON.stringify(toolList())],
  ['instructions', INSTRUCTIONS],
  ['the page', mcpPage(SITE)],
  ['resources', JSON.stringify([resources, resourceTemplates])],
  ['llms.txt Agents', llmsTxt().split('## Agents')[1].split('## ')[0]],
];

test('reader-facing text never names Pinboard or says whether a link works', () => {
  for (const [where, text] of readerText()) {
    assert.doesNotMatch(text, /pinboard/i, where);
    assert.doesNotMatch(
      text,
      /\b(dead|broken|alive|unreachable|still works|link rot)\b/i,
      where,
    );
  }
  // Nor any message or note the server can send: its strings, outside comments.
  for (const file of readdirSync('src/mcp')) {
    const code = readFileSync(`src/mcp/${file}`, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(code, /pinboard/i, file);
  }
});

test('the page lists every tool, and its style is the one the CSP allows', () => {
  const html = mcpPage(SITE);
  for (const tool of tools)
    assert.ok(html.includes(`<code>${tool.name}</code>`), tool.name);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.equal(
    styleHash,
    `sha256-${createHash('sha256').update(style).digest('base64')}`,
  );
  assert.doesNotMatch(html, /<script|<img|<link /);
});

test('llms.txt points agents at /mcp and names every tool', () => {
  const agents = llmsTxt().split('## Agents')[1].split('## ')[0];
  assert.ok(agents.includes(`(${SITE}/mcp)`));
  for (const tool of tools)
    assert.ok(agents.includes(`\`${tool.name}\``), tool.name);
});

// The agent's voice is provenance, the tag it leaves on a bookmark whose note
// it wrote, never a reading of the text; an empty note still has no voice.
test('voice "agent" comes from the _agent tag, and every answer that shows one says so', async () => {
  const G = {
    id: idOf('https://example.net/open-data-mcp'),
    url: 'https://example.net/open-data-mcp',
    title: 'An MCP server for open data',
    note: "A statistics office's MCP server. Low priority unless you follow open data.",
    saved: '2026-02-19T18:36:08Z',
    tags: ['_agent'],
    toread: false,
  };
  const H = {
    ...G,
    id: idOf('https://example.net/quoted'),
    url: 'https://example.net/quoted',
    title: 'Quoted by the agent',
    note: '> The page said this.',
    saved: '2026-02-19T18:40:00Z',
  };
  const K = {
    ...G,
    id: idOf('https://example.net/bare'),
    url: 'https://example.net/bare',
    title: 'A bare save',
    note: '',
    saved: '2026-02-19T18:45:00Z',
  };
  const all = [...linkRows, G, H, K];
  const own = await harness({ files: fixtureFiles(all), index: all });
  const got = await own.call('links_get', { id: G.id });
  assert.equal(got.link.voice, 'agent');
  assert.equal(got.link.note_text, G.note);
  assert.ok(got.notes.some((n) => /voice is "agent"/.test(n)));
  assert.ok(!got.notes.some((n) => /voice is "excerpt"/.test(n)));
  const quoted = await own.call('links_get', { id: H.id });
  assert.equal(quoted.link.voice, 'agent', 'the tag wins over the heuristic');
  assert.equal((await own.call('links_get', { id: K.id })).link.voice, null);
  const list = await own.call('links_list', { by: 'year', value: 2026 });
  assert.deepEqual(
    list.links.map((l) => l.voice),
    [null, 'agent', 'agent'],
  );
  assert.ok(list.notes.some((n) => /voice is "agent"/.test(n)));
  const stats = await own.call('links_stats');
  assert.deepEqual(stats.voices, { jamie: 3, mixed: 0, excerpt: 1, agent: 2 });
  assert.deepEqual(stats.tags, [
    { tag: '_agent', links: 3 },
    { tag: '_brief', links: 1 },
    { tag: '_feature', links: 1 },
  ]);
  const search = await own.call('links_search', { query: 'open data' });
  assert.deepEqual(ids(search), [`link-${G.id}`]);
  assert.equal(search.links[0].voice, 'agent');
  assert.ok(search.notes.some((n) => /voice is "agent"/.test(n)));
});

// A short word: a bare EDI also finds Editor and Edina by its first letters,
// so whole-word matches come first; a "quoted" word is whole or nothing; and
// when every word together finds nothing, the note says which to drop.
test('links_search: whole-word matches first, "quoted" words exact, what to drop', async () => {
  const row = (path, title, note, saved) => ({
    id: idOf(`https://example.net/${path}`),
    url: `https://example.net/${path}`,
    title,
    note,
    saved,
    tags: [],
    toread: false,
  });
  const E = [
    row(
      'editor',
      'Editor.js',
      'A block-styled editor for composing content.',
      '2021-01-01T12:00:00Z',
    ),
    row(
      'descript',
      'Descript: Edit Videos Like a Doc',
      'Editing by transcript.',
      '2021-02-01T12:00:00Z',
    ),
    row(
      'edina',
      'City of Edina COVID-19 Cases',
      'A map.',
      '2021-03-01T12:00:00Z',
    ),
    row(
      'edi-as2',
      'EDI/AS2 Components',
      'Components for EDI and AS2 in supply software.',
      '2014-04-23T12:00:00Z',
    ),
    row(
      'edi-reviews',
      'Best EDI Software',
      'Reviews of EDI software for supply networks.',
      '2018-11-26T12:00:00Z',
    ),
  ];
  const of = (...rows) => rows.map((r) => `link-${r.id}`);
  const all = [...linkRows, ...E];
  const own = await harness({ files: fixtureFiles(all), index: all });

  const bare = await own.call('links_search', { query: 'EDI' });
  assert.deepEqual(ids(bare), of(E[3], E[4], E[0], E[1], E[2]));
  assert.equal(bare.total, 5);
  assert.equal(bare.total_exact, true);
  // The word was asked for as a whole word first, in Pagefind's quoted form.
  assert.deepEqual(
    own.pagefind.searches.slice(-2).map((s) => s.term),
    ['"EDI"', 'EDI'],
  );
  // The second page continues the same order.
  const page = await own.call('links_search', { query: 'EDI', limit: 2 });
  assert.deepEqual(ids(page), of(E[3], E[4]));
  assert.equal(page.next_offset, 2);
  const next = await own.call('links_search', {
    query: 'EDI',
    limit: 2,
    offset: 2,
  });
  assert.deepEqual(ids(next), of(E[0], E[1]));

  const quoted = await own.call('links_search', { query: '"EDI"' });
  assert.deepEqual(ids(quoted), of(E[3], E[4]));
  assert.equal(quoted.total, 2);
  assert.equal(own.pagefind.searches.at(-1).term, '"EDI"');

  // Several words: whole-word matches first among the checked candidates.
  const two = await own.call('links_search', { query: 'EDI components' });
  assert.deepEqual(ids(two).slice(0, 2), of(E[3], E[0]));

  // Sorted by date, the index's order stands and no second search is made.
  const dated = await own.call('links_search', {
    query: 'EDI',
    sort: 'newest',
  });
  assert.deepEqual(ids(dated), of(...E));
  assert.equal(own.pagefind.searches.at(-1).term, 'EDI');
  assert.equal(own.pagefind.searches.at(-2).term, 'EDI components');

  // Nothing has every word: the note says what dropping each word finds.
  const none = await own.call('links_search', { query: 'EDI supply chain' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.links, []);
  const note = none.notes.find((n) => n.startsWith('Nothing has every word.'));
  assert.ok(note, none.notes.join('\n'));
  assert.match(note, /Without "chain": EDI supply matches 2 links/);
  assert.ok(!/supply chain matches/.test(note), note);
  // One word, or no word to drop that helps: the rule, as before.
  const one = await own.call('links_search', { query: 'kuzzzz' });
  assert.ok(one.notes.some((n) => n.startsWith('Nothing matched. Each word')));
  const dropped = await own.call('links_search', { query: 'zzzq yyyq' });
  assert.ok(
    dropped.notes.some((n) =>
      n.startsWith('Nothing matched, even with one word dropped.'),
    ),
    dropped.notes.join('\n'),
  );
});
