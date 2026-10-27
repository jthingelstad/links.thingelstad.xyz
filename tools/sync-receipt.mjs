// Pure public build comparison; the transport is optional and best effort.
export function instant(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  )
    return null;
  try {
    return new Date(value).toISOString().replace('.000Z', 'Z') === value
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

export async function reportArrivals({
  bus,
  before,
  built,
  base,
  get = fetch,
  put,
  now = () => new Date(),
  warn = console.warn,
}) {
  if (!bus) return 0;
  try {
    const served = await publicFact(base, get);
    const entries = arrivals(
      before,
      built,
      served,
      now()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    );
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
