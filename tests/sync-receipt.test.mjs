import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrivals,
  bookmarkAbsences,
  starArrivals,
  reportArrivals,
  instant,
} from '../tools/sync-receipt.mjs';

const at = '2026-10-27T09:00:00Z';
const before = {
  version: 1,
  link: { id: '2026-10-26T01:00:00Z', at: '2026-10-26T01:00:00Z' },
  issue: { id: '354', at: '2026-10-24T12:00:00Z' },
};
const built = {
  version: 1,
  link: { id: '2026-10-27T01:00:00Z', at: '2026-10-27T01:00:00Z' },
  issue: { id: '355', at: '2026-10-31T12:00:00.604000Z' },
  private: 'canary',
};
test('only a known public build advancing to the verified built identities reports', () => {
  const events = arrivals(before, built, built, at);
  assert.deepEqual(
    events.map((e) => JSON.parse(e.Detail)),
    [
      {
        system: 'links',
        kind: 'link',
        id: built.link.id,
        at,
        via: 'site-deploy',
      },
      { system: 'links', kind: 'issue', id: '355', at, via: 'site-deploy' },
    ],
  );
  assert.ok(!JSON.stringify(events).includes('canary'));
  for (const old of [null, {}, built])
    assert.deepEqual(arrivals(old, built, built, at), []);
  assert.deepEqual(arrivals(before, built, before, at), []);
  assert.deepEqual(arrivals(built, before, before, at), []);
  assert.equal(instant('2026-02-30T00:00:00Z'), null);
  assert.deepEqual(arrivals(before, built, built, '2026-02-30T00:00:00Z'), []);
});
test('empty bus does no I/O; failed entries do not undo a healthy site', async () => {
  let calls = 0;
  assert.equal(
    await reportArrivals({
      bus: '',
      get: () => {
        calls++;
      },
    }),
    0,
  );
  assert.equal(calls, 0);
  const warnings = [];
  const count = await reportArrivals({
    bus: 'thingelstad-publishing',
    before,
    built,
    base: 'https://links.example/',
    now: () => new Date(at),
    get: async () => ({ ok: true, json: async () => built }),
    put: async (entries) => {
      assert.equal(entries[0].EventBusName, 'thingelstad-publishing');
      calls++;
      if (calls === 1) throw new Error('private-canary');
      return { Entries: [{ EventId: 'accepted' }], FailedEntryCount: 0 };
    },
    warn: (m) => warnings.push(m),
  });
  assert.equal(count, 1);
  assert.equal(calls, 2);
  assert.ok(!warnings.join('').includes('private-canary'));
});

test('a star requires known absence, a served provenance fact and exact public record', async () => {
  const star = {
    id: '123',
    url: 'https://example.com/article',
    link_id: 'abcdef012345',
  };
  const fact = { version: 1, stars: [star] };
  const missing = await bookmarkAbsences(
    fact,
    'https://links.example/',
    async () => ({ status: 404 }),
  );
  assert.equal(missing.length, 1);
  const exact = async () => ({
    ok: true,
    json: async () => ({ id: star.link_id, url: star.url }),
  });
  const events = await starArrivals(
    missing,
    fact,
    fact,
    at,
    'https://links.example/',
    exact,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].Detail), {
    system: 'links',
    kind: 'star',
    id: '123',
    at,
    via: 'site-deploy',
  });
  assert.deepEqual(
    await bookmarkAbsences(fact, 'https://links.example/', async () => {
      throw Error('offline');
    }),
    [],
  );
  assert.deepEqual(
    await starArrivals([], fact, fact, at, 'https://links.example/', exact),
    [],
  );
  assert.deepEqual(
    await starArrivals(
      missing,
      fact,
      { version: 1, stars: [] },
      at,
      'https://links.example/',
      exact,
    ),
    [],
  );
  assert.deepEqual(
    await starArrivals(
      missing,
      fact,
      fact,
      at,
      'https://links.example/',
      async () => ({
        ok: true,
        json: async () => ({
          id: star.link_id,
          url: 'https://example.com/different',
        }),
      }),
    ),
    [],
  );
});
