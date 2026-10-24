// Where the server's dataset comes from: the site's own public files, fetched
// over HTTPS (the server never reads the site bucket or data/). Loaded on the
// first request that needs it, then revalidated with If-None-Match at most
// every ten minutes; a request that finds it stale waits for the (usually
// 304) check. A failed load keeps the data already held and is tried again a
// minute later. One check runs at a time, whoever asks.
//
// `reload()` is for a search that met a record the data does not have yet
// (the site was deployed since the last check): it checks at once, at most
// once a minute.
import {
  type Dataset,
  type Files,
  type LinkRow,
  buildDataset,
} from './dataset.ts';

export type Fetch = typeof fetch;

const names = ['links', 'issues', 'hosts'] as const;
type Name = (typeof names)[number];

interface Held {
  etag: string | null;
  body: unknown;
}

export interface StoreOptions {
  site: string;
  fetch?: Fetch;
  now?: () => number;
  revalidateMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

export interface Snapshot {
  data: Dataset;
  // Changes whenever links.json does, so the search knows to start a fresh
  // Pagefind instance.
  generation: number;
  loadedAt: string;
  checkedAt: string;
}

export class Store {
  #site: string;
  #fetch: Fetch;
  #now: () => number;
  #revalidateMs: number;
  #retryMs: number;
  #timeoutMs: number;
  #held = new Map<Name, Held>();
  #snapshot: Snapshot | undefined;
  #checked = 0;
  #failedAt = 0;
  #forcedAt = -Infinity;
  #pending: Promise<Snapshot> | undefined;
  lastError: string | undefined;

  constructor(options: StoreOptions) {
    this.#site = options.site.replace(/\/$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#revalidateMs = options.revalidateMs ?? 10 * 60_000;
    this.#retryMs = options.retryMs ?? 60_000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  get snapshot() {
    return this.#snapshot;
  }

  // The data, loading or revalidating first when due.
  async get(): Promise<Snapshot> {
    const now = this.#now();
    const held = this.#snapshot;
    if (held && now - this.#checked < this.#revalidateMs) return held;
    if (held && now - this.#failedAt < this.#retryMs) return held;
    return this.#check();
  }

  // Checks now, at most once a minute; otherwise answers with what it holds.
  async reload(): Promise<Snapshot> {
    const now = this.#now();
    if (this.#snapshot && now - this.#forcedAt < this.#retryMs)
      return this.#snapshot;
    this.#forcedAt = now;
    return this.#check();
  }

  #check(): Promise<Snapshot> {
    this.#pending ??= this.#load().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #load(): Promise<Snapshot> {
    try {
      const answers = await Promise.all(names.map((name) => this.#one(name)));
      const changed = answers.some(Boolean);
      const now = this.#now();
      this.#checked = now;
      this.lastError = undefined;
      const at = new Date(now).toISOString();
      if (this.#snapshot && !changed) {
        this.#snapshot = { ...this.#snapshot, checkedAt: at };
        return this.#snapshot;
      }
      const files = Object.fromEntries(
        names.map((name) => [name, this.#held.get(name)!.body]),
      ) as unknown as Files;
      const data = buildDataset(files);
      const generation =
        (this.#snapshot?.generation ?? 0) +
        (answers[0] || !this.#snapshot ? 1 : 0);
      this.#snapshot = { data, generation, loadedAt: at, checkedAt: at };
      return this.#snapshot;
    } catch (error) {
      this.#failedAt = this.#now();
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.#snapshot) return this.#snapshot;
      throw error;
    }
  }

  // Fetches one file, conditionally once it is held. True when it changed.
  async #one(name: Name): Promise<boolean> {
    const held = this.#held.get(name);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (held?.etag) headers['if-none-match'] = held.etag;
    const response = await this.#fetch(`${this.#site}/${name}.json`, {
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 304 && held) return false;
    if (!response.ok)
      throw new Error(`/${name}.json answered ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(body[name]) || typeof body.generated !== 'string')
      throw new Error(`/${name}.json has no ${name} list`);
    // Only the fields a result can show are kept (dataset.ts, LinkRow).
    if (name === 'links')
      body.links = (body.links as LinkRow[]).map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title,
        note: row.note,
        saved: row.saved,
        tags: row.tags,
        toread: row.toread,
        kind: row.kind,
      }));
    this.#held.set(name, { etag: response.headers.get('etag'), body });
    return true;
  }

  // A file of the site as text (a record's Markdown twin, llms.txt), for the
  // resources. Undefined when the site has no such file.
  async text(path: string): Promise<string | undefined> {
    const response = await this.#fetch(`${this.#site}${path}`, {
      headers: { accept: 'text/markdown, text/plain' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.text();
  }
}
