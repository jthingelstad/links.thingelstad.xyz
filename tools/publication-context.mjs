// Publication authority comes from the single CodeBuild role and the approved
// versioned source package. GitHub's OIDC role can promote packages, never site
// objects. An obsolete package stops before each publication group.
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';

export const RELEASE_KEY = 'releases/current.zip';

export function validateRelease(value) {
  if (
    value?.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.commit ?? '') ||
    !new RegExp(`^${value.commit}-[0-9]+-[0-9]+$`).test(value.id ?? '') ||
    !/^(?:|[0-9]+)$/.test(value.allowRemovals ?? 'invalid')
  )
    throw new Error('Invalid approved publisher release');
  return value;
}

export function publisherIdentity(config, identity, env = process.env) {
  const project = `arn:aws:codebuild:${config.region}:${config.account}:build/${config.publisherProject}:`;
  const role = config.publisherRoleArn?.split('/').at(-1);
  if (
    identity.Account !== config.account ||
    !role ||
    !identity.Arn?.startsWith(
      `arn:aws:sts::${config.account}:assumed-role/${role}/`,
    ) ||
    !env.CODEBUILD_BUILD_ARN?.startsWith(project)
  )
    throw new Error('Only the Linking Things AWS publisher can deploy');
}

export function currentRelease(release, metadata) {
  validateRelease(release);
  if (metadata?.release !== release.id)
    throw new Error('Refusing to publish a superseded approved release');
}

export function completedPublication(
  release,
  captures,
  revision,
  fact,
  success,
) {
  const known = new Set(fact?.bookmark_captures ?? []);
  return (
    success?.version === 1 &&
    revision?.release === release.id &&
    success.release === release.id &&
    JSON.stringify(success.captures) === JSON.stringify(captures) &&
    captures.every((id) => known.has(id))
  );
}

export async function publicationContext(config, identity) {
  publisherIdentity(config, identity);
  const release = validateRelease(
    JSON.parse(await fs.readFile('publisher-release.json', 'utf8')),
  );
  const s3 = new S3Client({ region: config.region, maxAttempts: 3 });
  const assertCurrent = async () => {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: config.publisherBucket,
        Key: RELEASE_KEY,
      }),
    );
    currentRelease(release, head.Metadata);
  };
  await assertCurrent();
  return {
    release,
    assertCurrent,
    run: process.env.CODEBUILD_BUILD_ARN.split('/').at(-1).replace(':', '-'),
  };
}
