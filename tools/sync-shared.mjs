// npm run sites:sync | npm run sites:check
// Vendors thingelstad.com's shared/ into shared/, byte for byte: sites.json (the
// sites strip, the footer h-card and the rel=me links), tokens.css and the
// fonts it loads (the type Jamie's sites share). CI checks out only this
// repository, so the copies are committed. Where the sibling checkout is absent
// the check says so and checks only that the committed copies are complete.
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = process.env.SHARED_SOURCE || '../thingelstad.com/shared';
const target = 'shared';
const wanted = (dir) => [
  'sites.json',
  'tokens.css',
  ...readdirSync(join(dir, 'fonts'))
    .filter((name) => /\.(woff2|txt)$/.test(name))
    .map((name) => `fonts/${name}`),
];
const list = (dir) =>
  existsSync(join(dir, 'fonts')) ? wanted(dir).sort() : ['sites.json'];

async function run(check) {
  if (!existsSync(source)) {
    if (!check) throw new Error(`${source} is not in this checkout.`);
    const fonts = (await readFile(join(target, 'tokens.css'), 'utf8')).match(
      /fonts\/[\w.-]+\.woff2/g,
    );
    const missing = [...new Set(fonts)].filter(
      (font) => !existsSync(join(target, font)),
    );
    JSON.parse(await readFile(join(target, 'sites.json'), 'utf8'));
    if (missing.length)
      throw new Error(`${target} lacks ${missing.join(', ')}`);
    return `${source} is not in this checkout; ${target}/ checked as committed.`;
  }
  const files = list(source);
  const leftover = existsSync(target)
    ? list(target).filter((file) => !files.includes(file))
    : [];
  if (!check) {
    await mkdir(join(target, 'fonts'), { recursive: true });
    for (const file of files)
      await writeFile(join(target, file), await readFile(join(source, file)));
    for (const file of leftover) await rm(join(target, file));
    return `Copied ${files.length} files from ${source} to ${target}/.`;
  }
  for (const file of files) {
    const want = await readFile(join(source, file));
    const have = await readFile(join(target, file)).catch(() => null);
    if (!have || !want.equals(have))
      throw new Error(`${target}/${file} is stale. Run npm run sites:sync.`);
  }
  if (leftover.length)
    throw new Error(
      `${target}/ has ${leftover.join(', ')}, which ${source} does not.`,
    );
  return `${target}/ matches ${source} (${files.length} files).`;
}

try {
  console.log(await run(process.argv.includes('--check')));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
