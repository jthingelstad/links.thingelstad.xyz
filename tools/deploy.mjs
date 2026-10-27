// Publish dist/ to the web bucket and refresh CloudFront.
//
//   node tools/deploy.mjs            publish: main in GitHub Actions only, with
//                                    the OIDC deployment role (infra/delivery.json)
//   node tools/deploy.mjs --dry-run  list the bucket and print the plan; writes
//                                    nothing (any identity in the account)
//
// The rules live in tools/delivery-plan.mjs; docs/deployment.md has the policy.
// 1. Hash every built file (md5) and list the bucket (ListObjectsV2, 1,000 keys
//    a page); upload only keys whose ETag differs, or every key when the live
//    revision.json was written under other header rules.
// 2. Upload in publication order (assets, then what pages name, then pages,
//    then revision.json), checking before each group that this commit is still
//    the head of main.
// 3. Remove page keys the build no longer has (a link made private must leave
//    the site), invalidate, and only then remove stale content-addressed
//    assets, so a cached page never names a missing stylesheet.
// 4. Fetch a few routes from CloudFront and compare bytes and Content-Type with
//    the build.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
  waitUntilInvalidationCompleted,
} from '@aws-sdk/client-cloudfront';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  bookmarkAbsences,
  publicFact,
  reportArrivals,
} from './sync-receipt.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  contentType,
  eachLimit,
  etag,
  headersFingerprint,
  invalidationPaths,
  isHashedAsset,
  keyFor,
  normalizeEtag,
  objectHeaders,
  planSync,
  publicationGroups,
  removalLimit,
  shadowedByRedirect,
} from './delivery-plan.mjs';

const REPOSITORY = 'jthingelstad/links.thingelstad.xyz';
const DIST = 'dist';
const CONCURRENCY = 32;
const dryRun = process.argv.includes('--dry-run');
const config = JSON.parse(await fs.readFile('infra/deployment.json', 'utf8'));
const Bucket = config.siteBucket;

if (
  !dryRun &&
  (process.env.GITHUB_REPOSITORY !== REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ''))
)
  throw new Error('Only this repository main branch can publish');
if (
  !dryRun &&
  (!config.distributionId || !config.deploymentRoleArn || !config.deliveryUrl)
)
  throw new Error(
    'infra/deployment.json is not complete; run the infrastructure bootstrap first',
  );

const settings = { region: config.region, maxAttempts: 5 };
const identity = await new STSClient(settings).send(
  new GetCallerIdentityCommand({}),
);
if (identity.Account !== config.account)
  throw new Error(`Unexpected AWS account ${identity.Account}`);
if (
  !dryRun &&
  !identity.Arn.includes(
    `:assumed-role/${config.deploymentRoleArn.split('/').at(-1)}/`,
  )
)
  throw new Error('Unexpected deployment identity');

async function assertCurrentHead() {
  if (dryRun) return;
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`,
    {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (
    !response.ok ||
    (await response.json()).object.sha !== process.env.GITHUB_SHA
  )
    throw new Error('Refusing to publish a superseded main revision');
}

async function builtKeys(folder) {
  const keys = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const name = path.join(folder, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symlink in the build: ${name}`);
    if (entry.isDirectory()) keys.push(...(await builtKeys(name)));
    else keys.push(keyFor(path.relative(DIST, name)));
  }
  return keys;
}

// Everything is checked before anything is written.
await assertCurrentHead();
const revision = JSON.parse(
  await fs.readFile(path.join(DIST, 'revision.json'), 'utf8'),
);
if (!dryRun && revision.commit !== process.env.GITHUB_SHA)
  throw new Error('Build artifact does not match this commit');
if (revision.headers !== headersFingerprint)
  throw new Error(
    'dist/revision.json was not written by this checkout (npm run revision)',
  );
const keys = (await builtKeys(DIST)).sort();
for (const key of keys) objectHeaders(key); // throws on an unknown extension
const shadowed = keys.filter(shadowedByRedirect);
if (shadowed.length)
  throw new Error(`The edge function redirects these: ${shadowed.join(', ')}`);
const local = new Map();
await eachLimit(keys, 64, async (key) =>
  local.set(key, etag(await fs.readFile(path.join(DIST, key)))),
);

const s3 = new S3Client(settings);
const remote = new Map();
let bucketExists = true;
try {
  for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket }))
    for (const item of page.Contents || []) remote.set(item.Key, item.ETag);
} catch (error) {
  if (!(dryRun && error.name === 'NoSuchBucket')) throw error;
  bucketExists = false;
}
let live = null;
if (bucketExists)
  try {
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket, Key: 'revision.json' }),
    );
    live = JSON.parse(await Body.transformToString());
  } catch (error) {
    if (error.name !== 'NoSuchKey' && !(error instanceof SyntaxError))
      throw error;
  }
const headersChanged = live?.headers !== headersFingerprint;
const plan = planSync(local, remote, { force: headersChanged });
const stalePages = plan.stale.filter((key) => !isHashedAsset(key));
const staleAssets = plan.stale.filter(isHashedAsset);
const livePages = [...remote.keys()].filter((key) => !isHashedAsset(key));
const limit = removalLimit(livePages.length);
const paths = invalidationPaths([...plan.upload, ...stalePages]);
const summary = {
  commit: dryRun ? revision.commit : process.env.GITHUB_SHA,
  bucket: bucketExists ? Bucket : `${Bucket} (does not exist yet)`,
  built: keys.length,
  live: remote.size,
  headersChanged,
  upload: plan.upload.length,
  unchanged: plan.unchanged,
  removePages: stalePages.length,
  removeAssets: staleAssets.length,
  invalidate: paths.length === 1 && paths[0] === '/*' ? '/*' : paths.length,
};
const refusal =
  stalePages.length > limit &&
  process.env.DEPLOY_ALLOW_REMOVALS !== String(stalePages.length)
    ? `Refusing to remove ${stalePages.length} pages (limit ${limit}), first ${stalePages.slice(0, 5).join(', ')}. ` +
      `If that is intended, run the workflow by hand with allow_removals=${stalePages.length}.`
    : null;
if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
  for (const [label, list] of [
    ['upload', plan.upload],
    ['remove', plan.stale],
  ])
    if (list.length)
      console.log(
        `${label}: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', ...' : ''}`,
      );
  if (refusal) console.log(refusal);
  process.exit(0);
}
if (refusal) throw new Error(refusal);

const receiptBus = process.env.SYNC_RECEIVED_BUS || '';
const beforeReceipt = receiptBus
  ? await publicFact(config.productionUrl)
  : null;
const builtReceipt = receiptBus
  ? JSON.parse(await fs.readFile(path.join(DIST, 'sync-fact.json'), 'utf8'))
  : null;
const bookmarkAbsent = receiptBus
  ? await bookmarkAbsences(builtReceipt, config.productionUrl)
  : [];

async function put(key) {
  const Body = await fs.readFile(path.join(DIST, key));
  const response = await s3.send(
    new PutObjectCommand({ Bucket, Key: key, Body, ...objectHeaders(key) }),
  );
  if (normalizeEtag(response.ETag) !== etag(Body))
    throw new Error(`S3 reports another ETag for ${key}`);
}
async function remove(list) {
  for (let i = 0; i < list.length; i += 1000) {
    const { Errors } = await s3.send(
      new DeleteObjectsCommand({
        Bucket,
        Delete: {
          Objects: list.slice(i, i + 1000).map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    if (Errors?.length)
      throw new Error(
        `${Errors.length} keys not removed, first ${Errors[0].Key}: ${Errors[0].Code}`,
      );
  }
}

for (const group of publicationGroups(plan.upload)) {
  if (!group.length) continue;
  await assertCurrentHead();
  await eachLimit(group, CONCURRENCY, put);
}
// Versioning keeps a removed object's last version for 30 days
// (infra/storage.json); the deployment role cannot delete versions.
await remove(stalePages);

const cdn = new CloudFrontClient(settings);
let invalidation = null;
if (paths.length) {
  ({ Invalidation: invalidation } = await cdn.send(
    new CreateInvalidationCommand({
      DistributionId: config.distributionId,
      InvalidationBatch: {
        CallerReference: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
        Paths: { Quantity: paths.length, Items: paths },
      },
    }),
  ));
  await waitUntilInvalidationCompleted(
    { client: cdn, maxWaitTime: 600, minDelay: 10 },
    { DistributionId: config.distributionId, Id: invalidation.Id },
  );
}
await remove(staleAssets);

// What CloudFront serves must be the build, with the right Content-Type.
const record = keys
  .find((key) => /^links\/[0-9a-f]{12}\/index\.html$/.test(key))
  ?.split('/')[1];
const checks = ['index.html', 'revision.json'];
if (record)
  checks.push(
    `links/${record}/index.html`,
    `links/${record}.json`,
    `links/${record}.md`,
  );
for (const key of checks) {
  const route =
    key === 'index.html'
      ? '/'
      : key.endsWith('/index.html')
        ? `/${key.slice(0, -'index.html'.length)}`
        : `/${key}`;
  const response = await fetch(new URL(route, config.deliveryUrl), {
    signal: AbortSignal.timeout(30000),
  });
  const delivered = Buffer.from(await response.arrayBuffer());
  const built = await fs.readFile(path.join(DIST, key));
  if (!response.ok || !delivered.equals(built))
    throw new Error(`Published bytes differ: ${route}`);
  const type = response.headers.get('content-type');
  if (type !== contentType(key))
    throw new Error(`${route} is served as ${type}`);
}
if (record) {
  const response = await fetch(
    new URL(`/links/${record}`, config.deliveryUrl),
    { redirect: 'manual', signal: AbortSignal.timeout(30000) },
  );
  if (
    response.status !== 301 ||
    response.headers.get('location') !== `/links/${record}/`
  )
    throw new Error(`/links/${record} does not redirect to its record`);
}
console.log(
  JSON.stringify({
    ...summary,
    invalidation: invalidation?.Id ?? null,
    url: config.deliveryUrl,
  }),
);
if (receiptBus) {
  try {
    const built = JSON.parse(
      await fs.readFile(path.join(DIST, 'sync-fact.json'), 'utf8'),
    );
    await reportArrivals({
      bus: receiptBus,
      before: beforeReceipt,
      built,
      absent: bookmarkAbsent,
      base: config.productionUrl,
    });
  } catch {
    console.warn(
      'Sync receipt evidence was unavailable; polling remains the backstop.',
    );
  }
}
