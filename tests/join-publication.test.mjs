import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicationNeeded,
  publicRevision,
} from '../tools/join-publication.mjs';

const committed = 'a'.repeat(40),
  earlier = 'b'.repeat(40);
test('a committed but unpublished join is dispatched again on a repeated delivery', () => {
  assert.equal(publicationNeeded(committed, { commit: earlier }), true);
  assert.equal(publicationNeeded(committed, null), true);
  assert.equal(publicationNeeded(committed, {}), true);
  assert.equal(publicationNeeded(committed, { commit: committed }), false);
});
test('an unavailable public revision cannot hide a missed publication', async () => {
  const revision = await publicRevision(async () => {
    throw new Error('private-canary');
  });
  assert.equal(revision, null);
  assert.equal(publicationNeeded(committed, revision), true);
});
