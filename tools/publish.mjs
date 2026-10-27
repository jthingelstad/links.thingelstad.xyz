// One serialized publisher handles approved code releases and content events.
// Every run starts from the approved canonical snapshot and replays the full
// durable inbox, including captures acknowledged by earlier builds.
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  completedPublication,
  publicationContext,
} from './publication-context.mjs';

const config = JSON.parse(await fs.readFile('infra/deployment.json', 'utf8'));
const identity = await new STSClient({ region: config.region }).send(
  new GetCallerIdentityCommand({}),
);
const context = await publicationContext(config, identity);
const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_TINYLYTICS_ENABLED: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed`);
};
run('node', ['tools/bookmark-inbox.mjs']);
run('python3', [
  'tools/import_bookmarks.py',
  '--inbox',
  '.build/bookmark-inbox',
]);
const ledger = JSON.parse(
  await fs.readFile('data/derived/bookmarks.json', 'utf8'),
);
// Repeated wake-ups are healthy no-ops once this release and every capture
// have landed. Read the origin, not a possibly stale CDN response.
const s3 = new S3Client({ region: config.region });
const read = async (Bucket, Key) => {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key }));
    return JSON.parse(await Body.transformToString());
  } catch (error) {
    if (error.name !== 'NoSuchKey') throw error;
    return null;
  }
};
const revision = await read(config.siteBucket, 'revision.json');
const fact = await read(config.siteBucket, 'sync-fact.json');
const success = await read(config.publisherBucket, 'publisher/success.json');
const captures = Object.keys(ledger.captures).sort();
if (completedPublication(context.release, captures, revision, fact, success)) {
  console.log('All public bookmark captures are already published.');
  process.exit(0);
}
run('npm', ['run', 'validate:data']);
run('npm', ['run', 'build']);
run('npm', ['run', 'validate:site']);
run('npm', ['run', 'revision']);
await context.assertCurrent();
run('npm', ['run', 'deploy']);
run('npm', ['run', 'mcp:package']);
run('npm', ['run', 'mcp:deploy']);
await context.assertCurrent();
await s3.send(
  new PutObjectCommand({
    Bucket: config.publisherBucket,
    Key: 'publisher/success.json',
    Body:
      JSON.stringify({
        version: 1,
        release: context.release.id,
        captures,
        at: new Date().toISOString(),
      }) + '\n',
    ContentType: 'application/json',
  }),
);
