import { fileURLToPath } from 'node:url';

// A committed join is not proof of publication. An unknown public revision
// needs the normal CI/deploy path too, so retries can recover a lost dispatch.
export function publicationNeeded(commit, revision) {
  return !/^[a-f0-9]{40}$/.test(commit || '') || revision?.commit !== commit;
}

export async function publicRevision(get = fetch) {
  try {
    const response = await get('https://links.thingelstad.xyz/revision.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    String(publicationNeeded(process.env.JOIN_COMMIT, await publicRevision())),
  );
}
