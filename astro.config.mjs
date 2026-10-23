import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

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
  // The sitemap lists pages; the .json and .md twins are not pages.
  integrations: [sitemap({ filter: (page) => page.endsWith('/') })],
});
