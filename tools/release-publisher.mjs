// GitHub main promotes a package only after every CI gate passed. This uses
// the workflow's existing short-lived OIDC credentials, and holds no AWS key.
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
} from '@aws-sdk/client-codebuild';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { zip } from './package-mcp.mjs';
import { RELEASE_KEY, validateRelease } from './publication-context.mjs';

const config = JSON.parse(await fs.readFile('infra/deployment.json', 'utf8'));
const env = process.env;
if (
  env.GITHUB_REPOSITORY !== 'jthingelstad/links.thingelstad.xyz' ||
  env.GITHUB_REF !== 'refs/heads/main'
)
  throw new Error('Only GitHub main can promote an approved publisher release');
const release = validateRelease({
  version: 1,
  commit: env.GITHUB_SHA,
  id: `${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  allowRemovals: env.DEPLOY_ALLOW_REMOVALS || '',
});
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8_000_000 }).trim();
if (
  git('rev-parse', 'HEAD') !== release.commit ||
  git('status', '--porcelain', '--untracked-files=no')
)
  throw new Error('Release source must be the clean tested commit');
const verified = JSON.parse(await fs.readFile('dist/revision.json', 'utf8'));
if (verified.commit !== release.commit)
  throw new Error('The verified build is from another commit');
const settings = { region: config.region, maxAttempts: 3 };
const identity = await new STSClient(settings).send(
  new GetCallerIdentityCommand({}),
);
if (
  identity.Account !== config.account ||
  !identity.Arn.includes(
    `:assumed-role/${config.deploymentRoleArn.split('/').at(-1)}/`,
  )
)
  throw new Error('Unexpected release promotion identity');
const files = [];
for (const entry of git('ls-tree', '-r', '-z', 'HEAD')
  .split('\0')
  .filter(Boolean)) {
  const [header, name] = entry.split('\t');
  if (header.startsWith('120000 ')) continue; // documentation aliases, never build inputs
  if (
    !header.startsWith('100') ||
    name.startsWith('pinboard/') ||
    name.startsWith('archive/') ||
    name
      .split('/')
      .some((part) => part.startsWith('.env') && part !== '.env.example')
  )
    throw new Error('Private or unsupported file in the release source');
  files.push({ name, data: await fs.readFile(name) });
}
files.push({
  name: 'publisher-release.json',
  data: Buffer.from(JSON.stringify(release) + '\n'),
});
const Body = zip(files);
const checksum = createHash('sha256').update(Body).digest('base64');
// Check main immediately before promotion; queued older CI must not replace a
// newer package. The workflow serializes all promotions in one concurrency group.
const head = await fetch(
  'https://api.github.com/repos/jthingelstad/links.thingelstad.xyz/git/ref/heads/main',
  {
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15000),
  },
);
if (!head.ok || (await head.json()).object.sha !== release.commit)
  throw new Error('Refusing to promote a superseded main revision');
const uploaded = await new S3Client(settings).send(
  new PutObjectCommand({
    Bucket: config.publisherBucket,
    Key: RELEASE_KEY,
    Body,
    ContentType: 'application/zip',
    Metadata: { release: release.id },
    ChecksumAlgorithm: 'SHA256',
    ChecksumSHA256: checksum,
  }),
);
if (!uploaded.VersionId)
  throw new Error('Publisher package bucket must be versioned');
console.log(
  JSON.stringify({
    release: release.id,
    version: uploaded.VersionId,
    bytes: Body.length,
  }),
);
const builds = new CodeBuildClient(settings);
let build;
for (let attempt = 0; !build && attempt < 120; attempt++) {
  try {
    const result = await builds.send(
      new StartBuildCommand({ projectName: config.publisherProject }),
    );
    build = result.build;
  } catch (error) {
    if (error.name !== 'AccountLimitExceededException') throw error;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
if (!build?.id)
  throw new Error(
    'Publisher was busy; the approved package is retained for retry',
  );
console.log(`AWS publication ${build.id}`);
for (let attempt = 0; attempt < 180; attempt++) {
  const result = await builds.send(
    new BatchGetBuildsCommand({ ids: [build.id] }),
  );
  const current = result.builds?.[0];
  if (!current) throw new Error('Publisher build was not found');
  if (current.buildComplete) {
    if (current.buildStatus !== 'SUCCEEDED')
      throw new Error(
        `AWS publication ${current.buildStatus}: ${current.logs?.deepLink ?? build.id}`,
      );
    console.log('AWS publication succeeded.');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
throw new Error(
  'Timed out watching the AWS publisher; inspect the retained build',
);
