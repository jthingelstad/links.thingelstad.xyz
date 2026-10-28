import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unindexed } from './src/lib/data.ts';
import { lastmodOf } from './src/lib/lastmod.ts';

// Static pages only: nothing answers a visitor but files. Pagefind writes its
// index into dist/pagefind/ after the build (npm run build).
export default defineConfig({
  site: 'https://links.thingelstad.xyz',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  // One stylesheet for every page, cached once, rather than a copy in each.
  build: { inlineStylesheets: 'never' },
  vite: {
    server: {
      // The raw Pinboard export and the 70 GB page archive stay out of the
      // dev server's file watcher.
      watch: { ignored: ['**/pinboard/**', '**/archive/**'] },
    },
  },
  // The sitemap lists pages, /newest/ among them. The feeds, the .json and
  // .md twins, /links.json, /hosts.json, /issues.json and the llms files
  // are not pages, and none of them ends in a slash. Pages marked noindex
  // (data.ts, unindexed) are left out too. Every page carries the date its
  // content last changed (src/lib/lastmod.ts), and the index each chunk's
  // newest.
  integrations: [
    sitemap({
      filter: (page) => page.endsWith('/') && !unindexed.has(page),
      serialize: (item) => ({ ...item, lastmod: lastmodOf(item.url) }),
    }),
  ],
});
