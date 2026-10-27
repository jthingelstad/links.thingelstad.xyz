// Read only the dedicated private inbox; no Pinboard token or raw export.
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import path from 'node:path';

const bucket = 'links-storage-inbox-999153317627';
const folder = '.build/bookmark-inbox';
const client = new S3Client({ region: 'us-east-1' });
let known = {};
try {
  known = JSON.parse(
    await fs.readFile('data/derived/bookmarks.json', 'utf8'),
  ).captures;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await fs.rm(folder, { recursive: true, force: true });
await fs.mkdir(folder, { recursive: true });
let token;
let count = 0;
do {
  const page = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'bookmarks/',
      ContinuationToken: token,
    }),
  );
  for (const object of page.Contents ?? []) {
    const match = /^bookmarks\/([a-f0-9]{64})\.json$/.exec(object.Key);
    if (!match || object.Size > 128_000)
      throw new Error('Invalid bookmark inbox object');
    if (known[match[1]]) continue;
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: object.Key }),
    );
    await fs.writeFile(
      path.join(folder, `${match[1]}.json`),
      await result.Body.transformToByteArray(),
      { mode: 0o600 },
    );
    count++;
  }
  token = page.NextContinuationToken;
} while (token);
console.log(`Read ${count} public bookmark captures.`);
