// Package the MCP server (src/mcp/) for its Lambda Web Function.
//
//   node tools/package-mcp.mjs                     bundle and zip into .build/mcp/; no AWS
//   node tools/package-mcp.mjs --pagefind=<file>   take Pagefind's client from elsewhere
//
// The zip holds three files: index.js (src/mcp/main.ts bundled by esbuild,
// with no runtime dependencies), package.json (so Node reads index.js as an
// ES module) and pagefind.js, Pagefind's client from the site build
// (dist/pagefind/, so run npm run build first), which the server loads to
// search the published index over HTTPS. The zip is deterministic (sorted
// entries, fixed 1980 timestamps), so the same source gives the same bytes and
// the same key, mcp/<sha256>.zip: a deploy whose key is already live has
// nothing to do (tools/deploy-mcp.mjs).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const OUT = '.build/mcp';
export const PAGEFIND = 'dist/pagefind/pagefind.js';

// 1980-01-01 00:00, the earliest DOS date, for every entry.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** A zip of the given entries, stored in name order with deflate. */
export function zip(entries) {
  const files = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const file = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(file.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, file, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode holds
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(file.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, file);
    offset += header.length + file.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** The server bundled into one ES module. */
export async function bundle() {
  const { outputFiles } = await build({
    entryPoints: ['src/mcp/main.ts'],
    bundle: true,
    write: false,
    outfile: 'index.js',
    platform: 'node',
    target: 'node24',
    format: 'esm',
    legalComments: 'none',
    logLevel: 'error',
    absWorkingDir: path.resolve('.'),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  return Buffer.from(outputFiles[0].contents);
}

export async function packageMcp({ pagefind = PAGEFIND, out = OUT } = {}) {
  let client;
  try {
    client = await fs.readFile(pagefind);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(`${pagefind} is missing; run npm run build first`, {
        cause: error,
      });
    throw error;
  }
  const entries = [
    { name: 'index.js', data: await bundle() },
    { name: 'package.json', data: Buffer.from('{"type":"module"}\n') },
    { name: 'pagefind.js', data: client },
  ];
  const archive = zip(entries);
  const digest = createHash('sha256').update(archive).digest();
  const manifest = {
    key: `mcp/${digest.toString('hex')}.zip`,
    sha256: digest.toString('hex'),
    checksumSha256: digest.toString('base64'),
    size: archive.length,
    files: entries.map(({ name, data }) => ({
      name,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'links-mcp.zip'), archive);
  await fs.writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return { ...manifest, path: path.join(out, 'links-mcp.zip') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.find((arg) => arg.startsWith('--pagefind='));
  const manifest = await packageMcp(
    flag ? { pagefind: flag.slice('--pagefind='.length) } : {},
  );
  console.log(
    JSON.stringify({
      key: manifest.key,
      size: manifest.size,
      path: manifest.path,
    }),
  );
}
