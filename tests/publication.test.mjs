import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentRelease,
  completedPublication,
  publisherIdentity,
  validateRelease,
} from '../tools/publication-context.mjs';

const config = {
  account: '999153317627',
  region: 'us-east-1',
  publisherProject: 'links-publisher',
  publisherRoleArn:
    'arn:aws:iam::999153317627:role/links-publisher-PublisherRole-example',
};
const identity = {
  Account: config.account,
  Arn: 'arn:aws:sts::999153317627:assumed-role/links-publisher-PublisherRole-example/build',
};
const env = {
  CODEBUILD_BUILD_ARN:
    'arn:aws:codebuild:us-east-1:999153317627:build/links-publisher:123',
};
const release = {
  version: 1,
  commit: 'a'.repeat(40),
  id: `${'a'.repeat(40)}-12-1`,
  allowRemovals: '',
};

test('publication requires the actual publisher role and project', () => {
  publisherIdentity(config, identity, env);
  for (const changed of [
    { Account: '111111111111' },
    {
      Arn: identity.Arn.replace(
        'PublisherRole-example',
        'DeploymentRole-example',
      ),
    },
  ])
    assert.throws(
      () => publisherIdentity(config, { ...identity, ...changed }, env),
      /Only the Linking Things AWS publisher/,
    );
  assert.throws(
    () =>
      publisherIdentity(config, identity, {
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: release.commit,
      }),
    /Only the Linking Things AWS publisher/,
  );
  assert.throws(
    () =>
      publisherIdentity(config, identity, {
        CODEBUILD_BUILD_ARN: env.CODEBUILD_BUILD_ARN.replace(
          'links-publisher:',
          'other:',
        ),
      }),
    /Only the Linking Things AWS publisher/,
  );
});

test('an approved package binds the commit and run and refuses superseded publication', () => {
  assert.equal(validateRelease(release), release);
  currentRelease(release, { release: release.id });
  for (const metadata of [undefined, {}, { release: `${release.commit}-13-1` }])
    assert.throws(() => currentRelease(release, metadata), /superseded/);
  for (const patch of [
    { version: 2 },
    { commit: 'main' },
    { id: `${'b'.repeat(40)}-12-1` },
    { allowRemovals: '-1' },
    { allowRemovals: 'all' },
  ])
    assert.throws(
      () => validateRelease({ ...release, ...patch }),
      /Invalid approved/,
    );
});

test('only complete publication can skip a retry, including after code or inbox changes', () => {
  const revision = { release: release.id };
  const fact = { bookmark_captures: ['a', 'b'] };
  const success = { version: 1, release: release.id, captures: ['a', 'b'] };
  assert.equal(
    completedPublication(release, ['a', 'b'], revision, fact, success),
    true,
  );
  assert.equal(
    completedPublication(release, ['a', 'b'], revision, fact, null),
    false,
  );
  assert.equal(
    completedPublication(release, ['a', 'b', 'c'], revision, fact, success),
    false,
  );
  assert.equal(
    completedPublication(
      release,
      ['a', 'b'],
      revision,
      { bookmark_captures: ['a'] },
      success,
    ),
    false,
  );
  assert.equal(
    completedPublication(
      { ...release, id: 'new' },
      ['a', 'b'],
      revision,
      fact,
      success,
    ),
    false,
  );
});
