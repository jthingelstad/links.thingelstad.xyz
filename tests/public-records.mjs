// Independent Python reader used by both record and feed contract tests.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
export function publicRecords() {
  const result = spawnSync(
    'python3',
    [
      '-c',
      "import sys,json; sys.path.insert(0,'tools'); from linking.hosts import load_links; print(json.dumps(load_links('data/links')))",
    ],
    { encoding: 'utf8', maxBuffer: 32_000_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
