// Pure public build comparison; the transport is optional and best effort.
export function instant(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  )
    return null;
  try {
    return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') ===
      value.replace(/\.\d+Z$/, 'Z')
      ? value
      : null;
  } catch {
    return null;
  }
}

export function arrivals(before, built, served, at) {
  if (
    ![before, built, served].every((fact) => fact?.version === 1) ||
    !instant(at)
  )
    return [];
  return ['link', 'issue'].flatMap((kind) => {
    const old = before[kind],
      next = built[kind],
      live = served[kind];
    if (
      !old ||
      !next ||
      !live ||
      live.id !== next.id ||
      live.at !== next.at ||
      !instant(next.at)
    )
      return [];
    if (
      kind === 'link' &&
      (!instant(old.id) || next.id !== next.at || next.id <= old.id)
    )
      return [];
    if (
      kind === 'issue' &&
      (!/^\d+$/.test(old.id) ||
        !/^\d+$/.test(next.id) ||
        !Number.isSafeInteger(Number(next.id)) ||
        Number(next.id) <= Number(old.id))
    )
      return [];
    return [
      {
        Source: 'links',
        DetailType: 'received',
        Time: new Date(at),
        Detail: JSON.stringify({
          system: 'links',
          kind,
          id: next.id,
          at,
          via: 'site-deploy',
        }),
      },
    ];
  });
}

export async function publicFact(base, get = fetch) {
  try {
    const response = await get(new URL('/sync-fact.json', base), {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const starKey = (star) => `${star.id}\n${star.url}\n${star.link_id}`;
const validStar = (star) =>
  /^\d+$/.test(star?.id) &&
  /^[a-f0-9]{12}$/.test(star?.link_id) &&
  /^https?:\/\//.test(star?.url);

// Only a known HTTP 404 establishes absence. A failed fetch is unknown.
export async function bookmarkAbsences(built, base, get = fetch) {
  const absent = [];
  for (const star of built?.stars ?? []) {
    if (!validStar(star)) continue;
    try {
      const response = await get(new URL(`/links/${star.link_id}.json`, base), {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) absent.push(starKey(star));
    } catch {
      /* Unknown is never absence. */
    }
  }
  return absent;
}

export async function starArrivals(
  absent,
  built,
  served,
  at,
  base,
  get = fetch,
) {
  if (built?.version !== 1 || served?.version !== 1 || !instant(at)) return [];
  const live = new Set((served.stars ?? []).filter(validStar).map(starKey));
  const missing = new Set(absent);
  const entries = [];
  for (const star of built.stars ?? []) {
    if (
      !validStar(star) ||
      !missing.has(starKey(star)) ||
      !live.has(starKey(star))
    )
      continue;
    try {
      const response = await get(new URL(`/links/${star.link_id}.json`, base), {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const record = await response.json();
      if (record.id !== star.link_id || record.url !== star.url) continue;
      entries.push({
        Source: 'links',
        DetailType: 'received',
        Time: new Date(at),
        Detail: JSON.stringify({
          system: 'links',
          kind: 'star',
          id: star.id,
          at,
          via: 'site-deploy',
        }),
      });
    } catch {
      /* Polling remains the backstop. */
    }
  }
  return entries;
}

export async function reportArrivals({
  bus,
  before,
  built,
  absent = [],
  base,
  get = fetch,
  put,
  now = () => new Date(),
  warn = console.warn,
}) {
  if (!bus) return 0;
  try {
    const served = await publicFact(base, get);
    const at = now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const entries = [
      ...arrivals(before, built, served, at),
      ...(await starArrivals(absent, built, served, at, base, get)),
    ];
    if (!entries.length) return 0;
    if (!put) {
      const { EventBridgeClient, PutEventsCommand } =
        await import('@aws-sdk/client-eventbridge');
      const client = new EventBridgeClient({
        region: 'us-east-1',
        maxAttempts: 2,
      });
      put = (Entries) =>
        client.send(new PutEventsCommand({ Entries }), {
          abortSignal: AbortSignal.timeout(5000),
        });
    }
    let acknowledged = 0;
    for (const entry of entries) {
      try {
        const result = await put([{ ...entry, EventBusName: bus }]);
        if (
          result.FailedEntryCount ||
          !result.Entries?.[0]?.EventId ||
          result.Entries[0].ErrorCode
        )
          warn(
            'Sync receipt was not acknowledged; polling remains the backstop.',
          );
        else acknowledged++;
      } catch {
        warn(
          'Sync receipt was not acknowledged; polling remains the backstop.',
        );
      }
    }
    return acknowledged;
  } catch {
    warn(
      'Sync receipt evidence was unavailable; polling remains the backstop.',
    );
    return 0;
  }
}
