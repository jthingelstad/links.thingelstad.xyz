// Rehearse the intended first import offline, including the entire suite's
// data assumptions. The generated fixture is restored even on test failure.
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ledger = 'data/derived/bookmarks.json';
let before = null;
try {
  before = await fs.readFile(ledger);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const inbox = await fs.mkdtemp(path.join(tmpdir(), 'links-capture-test-'));
try {
  const state = JSON.parse(await fs.readFile('data/sync.json', 'utf8'));
  const at = new Date(
    Math.max(Date.now(), Date.parse(state.fetched_at ?? 0) + 1000),
  )
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const url = 'https://bookmark-import.example.test/offline-rehearsal';
  const body = JSON.stringify({
    version: 1,
    star: { id: '999999999999999999', url },
    observed_at: at,
    post: {
      href: url,
      description: 'Offline bookmark import fixture',
      extended: '',
      meta: 'a'.repeat(32),
      hash: createHash('md5').update(url).digest('hex'),
      time: '2026-10-27T14:24:12Z',
      shared: 'yes',
      toread: 'no',
      tags: '',
    },
  });
  await fs.writeFile(
    path.join(inbox, `${createHash('sha256').update(body).digest('hex')}.json`),
    body,
  );
  const commands = [
    ['python3', ['tools/import_bookmarks.py', '--inbox', inbox]],
    ['npm', ['test']],
    ['npm', ['run', 'validate:data']],
  ];
  if (process.argv.includes('--build'))
    commands.push(
      ...['build', 'validate:site', 'test:ci-browser'].map((name) => [
        'npm',
        ['run', name],
      ]),
    );
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0)
      throw new Error('The offline bookmark import rehearsal failed');
  }
} finally {
  if (before) await fs.writeFile(ledger, before);
  else await fs.rm(ledger, { force: true });
  await fs.rm(inbox, { force: true, recursive: true });
}
