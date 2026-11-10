// The sites strip (src/lib/sites.ts): the shared sites in file order, this
// site current, and All Things after them, read from strip_all. The contract
// is thingelstad.com's AGENTS.md, "The sites strip". Run: npm test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseSites,
  sitesStrip,
  sitesStripAll,
  stripAll,
} from '../src/lib/sites.ts';

const text = readFileSync('shared/sites.json', 'utf8');
const data = JSON.parse(text);

test('the strip lists the shared sites in file order, Linking Things current', () => {
  const wanted = data.sites.filter((site) => site.in_sites_strip);
  assert.deepEqual(
    sitesStrip.map((item) => item.id),
    wanted.map((site) => site.id),
  );
  for (const [index, site] of wanted.entries()) {
    assert.equal(sitesStrip[index].label, site.strip_label);
    assert.equal(sitesStrip[index].href, `${site.url}?ref=sites-strip-links`);
  }
  assert.deepEqual(
    sitesStrip.filter((item) => item.current).map((item) => item.id),
    ['links'],
  );
});

test('All Things ends the strip, from strip_all, with this site ref', () => {
  assert.deepEqual(stripAll, {
    href: 'https://thingelstad.xyz/all/?ref=sites-strip-links',
    label: 'All Things',
    description: data.strip_all.description,
  });
  assert.ok(stripAll.description.length > 0);
  assert.equal(
    sitesStripAll(data.strip_all, 'weekly').href,
    'https://thingelstad.xyz/all/?ref=sites-strip-weekly',
  );
});

test('sites.json without a usable strip_all fails the build', () => {
  assert.deepEqual(parseSites(text).strip_all, data.strip_all);
  const without = (strip_all) => JSON.stringify({ ...data, strip_all });
  assert.throws(() => parseSites(without(undefined)), /has no strip_all/);
  for (const field of ['label', 'url', 'description'])
    assert.throws(
      () => parseSites(without({ ...data.strip_all, [field]: '' })),
      new RegExp(`strip_all has no ${field}`),
    );
  assert.throws(
    () =>
      parseSites(
        without({ ...data.strip_all, url: 'http://thingelstad.xyz/all/' }),
      ),
    /must be HTTPS/,
  );
});
