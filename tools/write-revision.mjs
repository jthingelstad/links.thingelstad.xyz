// dist/revision.json: which commit and which Pinboard sync a build is, and the
// header rules it was published under (tools/delivery-plan.mjs). The deploy
// uploads it last and reads the live copy to decide whether stored headers
// are current. Run after npm run build.
import fs from 'node:fs/promises';
import { validateRelease } from './publication-context.mjs';
import { headersFingerprint } from './delivery-plan.mjs';

const sync = JSON.parse(await fs.readFile('data/sync.json', 'utf8'));
let release = null;
try {
  release = validateRelease(
    JSON.parse(await fs.readFile('publisher-release.json', 'utf8')),
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const records = JSON.parse(await fs.readFile('dist/links.json', 'utf8'));
await fs.writeFile(
  'dist/revision.json',
  JSON.stringify({
    commit: release?.commit ?? process.env.GITHUB_SHA ?? 'local',
    ...(release ? { release: release.id } : {}),
    builtAt: new Date().toISOString(),
    pinboardUpdated: sync.updated,
    links: records.links.length,
    headers: headersFingerprint,
  }) + '\n',
);
