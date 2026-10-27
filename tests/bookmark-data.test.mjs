import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('the static reader publishes fast arrivals and a later snapshot controls edits and removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'links-bookmarks-'));
  try {
    await mkdir(join(root, 'data/links'), { recursive: true });
    await mkdir(join(root, 'data/derived'), { recursive: true });
    const hash = createHash('md5')
      .update('https://example.com/new')
      .digest('hex');
    const record = {
      id: hash.slice(0, 12),
      hash,
      url: 'https://example.com/new',
      title: 'Captured',
      note: '',
      saved: '2026-10-27T10:00:00Z',
      tags: [],
      toread: false,
      meta: 'a'.repeat(32),
    };
    const state = {
      updated: '2026-10-26T10:00:00Z',
      fetched_at: '2026-10-26T10:01:00Z',
      public: 0,
      total: 1,
    };
    const json = (name, data) =>
      writeFile(join(root, name), JSON.stringify(data));
    await json('data/links/2026.json', []);
    await json('data/sync.json', state);
    await json('data/derived/issues.json', { issues: [] });
    await json('data/derived/bookmarks.json', {
      version: 1,
      captures: {
        ['b'.repeat(64)]: {
          id: '123',
          url: record.url,
          link_id: record.id,
          observed_at: '2026-10-27T11:00:00Z',
          imported: true,
          record,
        },
      },
    });
    const read = () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {links,bookmarkStars,importedChange} from './src/lib/data.ts'; console.log(JSON.stringify({links,bookmarkStars,importedChange}));",
        ],
        { env: { ...process.env, LINKS_ROOT: root }, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(read().links[0].title, 'Captured');
    assert.equal(read().bookmarkStars[0].id, '123');
    assert.equal(read().importedChange, state.updated);
    await json('data/links/2026.json', [{ ...record, title: 'Edited later' }]);
    assert.equal(read().links[0].title, 'Edited later');
    await json('data/links/2026.json', []);
    await json('data/sync.json', {
      ...state,
      fetched_at: '2026-10-28T10:01:00Z',
    });
    assert.deepEqual(read().links, []);
    assert.deepEqual(read().bookmarkStars, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
